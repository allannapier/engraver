// Saved designs: the canvas and its layers, kept by the server in ~/.engraver/designs/.
// Save keeps the design in the app; Open lists what's saved. Project files still work
// for moving a design to another computer.

import { state, on, loadDoc, serialize } from "./store.js";
import { api, post } from "./api.js";
import { h, toast, modal, closeModal, act, download } from "./ui.js";
import { aabb, snapshotPng } from "./stage.js";
import { sanitizeMarkup } from "./svgutil.js";

const CURRENT_KEY = "engraver.saved.v1";
const THUMB_PX = 240;

// The saved design the canvas came from, if any: { id, name, dirty }.
let current = readCurrent();
let nameBox = null;

function readCurrent() {
  try {
    const raw = JSON.parse(localStorage.getItem(CURRENT_KEY) || "null");
    if (raw && /^[a-f0-9]{16,32}$/.test(raw.id) && typeof raw.name === "string") return { id: raw.id, name: raw.name.slice(0, 80), dirty: Boolean(raw.dirty) };
  } catch {
    /* none */
  }
  return null;
}

function setCurrent(next) {
  current = next;
  try {
    if (current) localStorage.setItem(CURRENT_KEY, JSON.stringify(current));
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* browser storage off: the name just isn't remembered across reloads */
  }
  drawName();
}

function drawName() {
  if (!nameBox) return;
  nameBox.textContent = current ? `${current.name}${current.dirty ? " •" : ""}` : "";
  nameBox.title = current ? (current.dirty ? "Changed since it was saved" : "Saved") : "";
}

/** Project files and saved designs are untrusted: artwork is sanitised again on load. */
export function cleanProject(data) {
  for (const obj of data?.doc?.objects || []) if (typeof obj.svg === "string") obj.svg = sanitizeMarkup(obj.svg);
  return data;
}

async function thumbnail() {
  const box = aabb(state.doc.objects);
  if (!box) return null;
  const pad = Math.max(2, Math.max(box.w, box.h) * 0.06);
  return snapshotPng(THUMB_PX, { x: box.x0 - pad, y: box.y0 - pad, w: box.w + pad * 2, h: box.h + pad * 2 });
}

async function body(name, replace = false) {
  return { name, project: JSON.parse(serialize()), thumb: await thumbnail(), replace };
}

function askName({ title, value = "", action = "Save" }) {
  let input;
  return modal((form) => {
    input = h("input", { type: "text", name: "name", value, maxlength: 80, required: true, autocomplete: "off" });
    form.append(
      h("h1", {}, title),
      h("label", { class: "field" }, "Name", input),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => closeModal("") }, "Cancel"),
        h("button", { class: "btn primary", value: "ok", onclick: (event) => { if (!input.value.trim()) { event.preventDefault(); input.focus(); } } }, action)),
    );
    setTimeout(() => input.select(), 0);
  }).then((choice) => (choice === "ok" ? input.value.trim() : null));
}

function askReplace(name) {
  return modal((form) => form.append(
    h("h1", {}, `Replace "${name}"?`),
    h("p", { class: "note" }, "You already have a design with this name. Saving replaces it."),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn ghost", onclick: () => closeModal("") }, "Cancel"),
      h("button", { class: "btn primary", value: "replace" }, "Replace")),
  )).then((choice) => choice === "replace");
}

/** Save under a new name. Returns false if the person backed out. */
async function saveAs(suggested = "") {
  const name = await askName({ title: "Save design", value: suggested });
  if (!name) return false;
  let meta;
  try {
    meta = await post("/api/designs", await body(name));
  } catch (error) {
    if (!/already have a design/.test(error.message)) throw error;
    if (!(await askReplace(name))) return false;
    meta = await post("/api/designs", await body(name, true));
  }
  setCurrent({ id: meta.id, name: meta.name, dirty: false });
  toast(`Saved "${meta.name}".`);
  return true;
}

/** Save over the design the canvas came from, or ask for a name the first time. */
export async function saveDesign() {
  if (!current) return saveAs();
  const meta = await api(`/api/designs/${current.id}`, { method: "PUT", body: await body(current.name) });
  setCurrent({ id: meta.id, name: meta.name, dirty: false });
  toast(`Saved "${meta.name}".`);
  return true;
}

function opened(name, id = null) {
  setCurrent(id ? { id, name, dirty: false } : null);
}

async function openSaved(meta) {
  const item = await api(`/api/designs/${meta.id}`);
  loadDoc(cleanProject(item.data));
  opened(item.name, item.id);
  toast(`Opened "${item.name}". Undo brings back what was on the canvas.`);
}

function newDesign() {
  loadDoc({ doc: { layers: [], objects: [] } });
  opened(null);
  toast("Started a new design. Undo brings back the last one.");
}

async function openFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't an Engraver project.");
  }
  loadDoc(cleanProject(data));
  opened(null);
  toast(`Opened ${file.name}. Save keeps it in the app.`);
}

const when = (seconds) => {
  const d = new Date(seconds * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `Today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

const fileName = () => `${(current?.name || "project").replace(/[^\w -]+/g, "").trim().replace(/\s+/g, "-") || "project"}.engraver.json`;

async function showDesigns() {
  const { designs } = await api("/api/designs");
  const filePicker = document.getElementById("file-project");
  let list;

  const row = (meta) => h("li", { class: "design-row" },
    h("div", { class: "design-thumb" }, meta.thumb && /^data:image\/(png|jpeg);base64,/.test(meta.thumb) ? h("img", { src: meta.thumb, alt: "" }) : null),
    h("div", { class: "design-text" },
      h("strong", {}, meta.name, current?.id === meta.id ? h("span", { class: "note" }, " (on the canvas)") : null),
      h("span", { class: "note" }, when(meta.updated))),
    h("button", { type: "button", class: "btn small", onclick: act(async () => { closeModal(""); await openSaved(meta); }) }, "Open"),
    h("button", {
      type: "button", class: "btn ghost small", title: `Delete "${meta.name}"`,
      onclick: act(async (event) => {
        const button = event.currentTarget;
        if (button.dataset.armed !== "yes") {
          button.dataset.armed = "yes";
          button.textContent = "Really delete?";
          return;
        }
        await api(`/api/designs/${meta.id}`, { method: "DELETE" });
        if (current?.id === meta.id) setCurrent(null);
        button.closest("li").remove();
        if (!list.children.length) list.replaceWith(h("p", { class: "note" }, "No saved designs."));
      }),
    }, "Delete"));

  await modal((form) => {
    list = h("ul", { class: "design-list" }, designs.map(row));
    form.append(
      h("h1", {}, "Designs"),
      designs.length ? list : h("p", { class: "note" }, "No saved designs yet. Use Save to keep what's on the canvas."),
      h("div", { class: "actions spread" },
        h("button", { type: "button", class: "btn ghost", onclick: () => { closeModal(""); newDesign(); } }, "New design"),
        h("button", { type: "button", class: "btn ghost", onclick: act(async () => { closeModal(""); await saveAs(current ? `${current.name} copy` : ""); }) }, "Save a copy"),
        h("button", { type: "button", class: "btn ghost", title: "Open a project file from this computer", onclick: () => { closeModal(""); filePicker.click(); } }, "Open a file"),
        h("button", { type: "button", class: "btn ghost", title: "Save what's on the canvas as a project file, to move it to another computer", onclick: () => download(fileName(), serialize(), "application/json") }, "Download file"),
        h("button", { class: "btn", value: "close" }, "Close")),
    );
  }, { wide: true });
}

// --- for MCP clients (see mcp.js): the same actions, without the dialogs ----------

/** Save over the open design, or under `name` as a new one. A name in use is replaced only when asked. */
export async function saveForTool({ name = "", replace = false } = {}) {
  name = String(name || "").trim().slice(0, 80);
  let meta;
  if (!name) {
    if (!current) throw new Error("This design hasn't been saved yet, so it needs a name.");
    meta = await api(`/api/designs/${current.id}`, { method: "PUT", body: await body(current.name) });
  } else {
    try {
      meta = await post("/api/designs", await body(name, Boolean(replace)));
    } catch (error) {
      if (/already have a design/.test(error.message)) throw new Error(`${error.message} Pass replace: true to replace it.`);
      throw error;
    }
  }
  setCurrent({ id: meta.id, name: meta.name, dirty: false });
  return meta;
}

export const openForTool = (id) => openSaved({ id: String(id || "") });
export const newForTool = () => newDesign();

export function initDesigns() {
  nameBox = document.getElementById("design-name");
  document.getElementById("project-save").addEventListener("click", act(saveDesign));
  document.getElementById("project-open").addEventListener("click", act(showDesigns));
  document.getElementById("file-project").addEventListener("change", act(async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) await openFile(file);
  }));
  // Any change after a save or open marks the design as changed. Opening fires "doc" too,
  // so `opened` runs after loadDoc and clears the mark again.
  on("doc", () => {
    if (current && !current.dirty) setCurrent({ ...current, dirty: true });
  });
  drawName();
}
