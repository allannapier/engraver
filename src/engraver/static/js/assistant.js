// Assistant tab: a chat that can add and change designs and set layer settings.
// It never controls the machine; it only edits what's on the canvas and in the layer list.

import { state, on, bed, commit, select, selected, newLayer, layerById, objectById, LAYER_COLORS } from "./store.js";
import { api, post } from "./api.js";
import { h, modal, closeModal, act, toast } from "./ui.js";
import { aabb, snapshotPng, viewCenter } from "./stage.js";
import { objectFromSvgText, sanitizeSvg, contentFromSvg } from "./svgutil.js";

const panel = document.getElementById("tab-assistant");
let busy = false;
let chatBox = null;
let composer = null;
let attachBox = null;
// A picture the person attached to guide the assistant: { url, name }. It goes with every message until removed.
let reference = null;

// The chat on screen is kept by the server (~/.engraver/chats/) so it survives a reload,
// and earlier chats can be reopened. `chatId` is null until the first message is sent.
let chatId = null;
let lastChat = null; // the most recent saved chat other than this one: { id, name }

const REFERENCE_MAX_PX = 1024; // long side; plenty for a model to read, and keeps each request small

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const frontLeft = (o) => {
  const box = aabb([o]);
  return { x: box.x0, y: bed().h - box.y1, w: box.w, h: box.h };
};

const svgDocument = (o) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${o.vb.join(" ")}">${o.svg}</svg>`;

export function context() {
  const material = state.materials.find((m) => m.id === state.ui.materialId);
  const picked = selected();
  const one = picked.length === 1 ? picked[0] : null;
  return {
    material: material
      ? { name: material.name, from: material.mine ? "the person's own materials" : "generic starting points", notes: material.notes || undefined, engrave: material.engrave || null, score: material.score || null, cut: material.cut || null }
      : null,
    start_from: state.ui.originMode === "origin" ? "origin (design's front-left corner goes to the origin)" : "bed position",
    layers: state.doc.layers.map((l) => ({
      id: l.id, name: l.name, mode: l.mode, speed: l.speed, power: l.power, passes: l.passes,
      ...(l.mode === "fill" ? { interval: l.interval, image_mode: l.imageMode } : {}),
      output: l.output, designs: state.doc.objects.filter((o) => o.layerId === l.id).length,
    })),
    designs: state.doc.objects.map((o) => {
      const p = frontLeft(o);
      return {
        id: o.id, name: o.name, kind: o.kind, layer_id: o.layerId, x_mm: +p.x.toFixed(1), y_mm: +p.y.toFixed(1), width_mm: +o.w.toFixed(1), height_mm: +o.h.toFixed(1), rotation_deg: o.rot,
        ...(o.kind === "svg" && o.id !== one?.id ? { svg: svgDocument(o) } : {}),
      };
    }),
    selected: one
      ? { id: one.id, name: one.name, svg: one.kind === "image" ? "(a bitmap image; its pixels can't be edited as SVG)" : svgDocument(one) }
      : null,
    selected_ids: picked.map((o) => o.id),
  };
}

// --- applying what the assistant asked for ---------------------------------------

function layerFor(action) {
  const wanted = action.layer_id && layerById(action.layer_id);
  if (wanted) return wanted;
  const mode = action.mode === "line" ? "line" : "fill";
  const existing = state.doc.layers.find((l) => l.mode === mode);
  if (existing) return existing;
  const layer = newLayer(mode === "fill"
    ? { name: "Engrave", mode, speed: 6000, power: 40 }
    : { name: "Score", mode, speed: 3000, power: 30 });
  layer.color = LAYER_COLORS[state.doc.layers.length % LAYER_COLORS.length];
  state.doc.layers.push(layer);
  return layer;
}

function moveTo(o, x, y) {
  // x, y are the front-left corner of the design's outer box, in bed coordinates.
  const p = frontLeft(o);
  if (x !== null) o.x += x - p.x;
  if (y !== null) o.y -= y - p.y;
}

function layerPatch(layer, a) {
  const done = [];
  if (typeof a.name === "string" && a.name.trim()) layer.name = a.name.trim().slice(0, 40);
  if (a.mode === "line" || a.mode === "fill") layer.mode = a.mode;
  if (num(a.speed) !== null) { layer.speed = clamp(Math.round(a.speed), 10, state.machine.max_feed || 6000); done.push(`${layer.speed} mm/min`); }
  if (num(a.power) !== null) { layer.power = clamp(Math.round(a.power), 0, 100); done.push(`${layer.power}%`); }
  if (num(a.passes) !== null) { layer.passes = clamp(Math.round(a.passes), 1, 50); done.push(layer.passes === 1 ? "1 pass" : `${layer.passes} passes`); }
  if (num(a.interval) !== null) layer.interval = clamp(a.interval, 0.03, 2);
  if (["threshold", "dither", "grayscale"].includes(a.image_mode)) layer.imageMode = a.image_mode;
  return done.join(", ");
}

/**
 * Places `o` (content already set) so its viewBox units land where the same units of `partner` are.
 * Each design is cropped to its artwork, so this is what keeps parts drawn in one coordinate system together.
 */
function alignTo(o, partner) {
  const k = partner.w / partner.vb[2]; // mm per viewBox unit
  o.w = o.vb[2] * k;
  o.h = o.vb[3] * k;
  // Centres in the shared, unrotated frame, then turned about the partner's centre by its rotation.
  const pc = { x: partner.x + partner.w / 2, y: partner.y + partner.h / 2 };
  const dx = (o.vb[0] + o.vb[2] / 2 - (partner.vb[0] + partner.vb[2] / 2)) * k;
  const dy = (o.vb[1] + o.vb[3] / 2 - (partner.vb[1] + partner.vb[3] / 2)) * k;
  const t = ((partner.rot || 0) * Math.PI) / 180;
  const cx = pc.x + dx * Math.cos(t) - dy * Math.sin(t);
  const cy = pc.y + dx * Math.sin(t) + dy * Math.cos(t);
  o.x = cx - o.w / 2;
  o.y = cy - o.h / 2;
  o.rot = partner.rot || 0;
}

function partnerFor(a, added) {
  if (typeof a.align_with !== "string" || !a.align_with) return null;
  const partner = objectById(a.align_with) || added.get(a.align_with);
  if (!partner) throw new Error(`it asked to line up with "${a.align_with}", which isn't on the canvas`);
  if (partner.kind !== "svg") throw new Error("it asked to line up with a picture, which has no shared coordinates");
  return partner;
}

export async function applyAction(a, added = new Map()) {
  const b = bed();
  if (a.type === "add_design") {
    const partner = partnerFor(a, added);
    const o = await objectFromSvgText(String(a.svg || ""), String(a.name || "Design").slice(0, 40));
    o.layerId = layerFor(a).id;
    if (partner) {
      alignTo(o, partner);
    } else {
      const w = clamp(num(a.width_mm) ?? Math.min(o.w, 80), 1, b.w);
      Object.assign(o, { h: (o.h * w) / o.w, w });
      const c = viewCenter();
      o.x = c.x - o.w / 2;
      o.y = c.y - o.h / 2;
      moveTo(o, num(a.x_mm), num(a.y_mm));
    }
    state.doc.objects.push(o);
    added.set(o.name, o);
    select([o.id]);
    return `Added "${o.name}", ${o.w.toFixed(0)} × ${o.h.toFixed(0)} mm, on ${layerById(o.layerId).name}${partner ? `, lined up with "${partner.name}"` : ""}`;
  }
  if (a.type === "replace_design") {
    const o = objectById(a.design_id);
    if (!o) throw new Error("it pointed at a design that isn't on the canvas");
    const partner = partnerFor(a, added);
    if (partner === o) throw new Error("it asked a design to line up with itself");
    const content = contentFromSvg(await sanitizeSvg(String(a.svg || "")));
    if (partner) {
      Object.assign(o, { kind: "svg", svg: content.svg, vb: content.vb });
      alignTo(o, partner);
    } else {
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      const h2 = (o.w * content.vb[3]) / content.vb[2];
      Object.assign(o, { kind: "svg", svg: content.svg, vb: content.vb, h: h2, x: cx - o.w / 2, y: cy - h2 / 2 });
    }
    delete o.text;
    if (typeof a.name === "string" && a.name.trim()) o.name = a.name.trim().slice(0, 40);
    added.set(o.name, o);
    return `Updated "${o.name}"${partner ? `, lined up with "${partner.name}"` : ""}`;
  }
  if (a.type === "transform_design") {
    const o = objectById(a.design_id);
    if (!o) throw new Error("it pointed at a design that isn't on the canvas");
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const ratio = o.h / o.w;
    const w = num(a.width_mm), h2 = num(a.height_mm);
    if (w !== null || h2 !== null) {
      o.w = clamp(w ?? h2 / ratio, 0.5, 2000);
      o.h = clamp(h2 ?? o.w * ratio, 0.5, 2000);
      o.x = cx - o.w / 2;
      o.y = cy - o.h / 2;
    }
    if (num(a.rotation_deg) !== null) o.rot = ((a.rotation_deg % 360) + 360) % 360;
    moveTo(o, num(a.x_mm), num(a.y_mm));
    if (a.layer_id && layerById(a.layer_id)) o.layerId = a.layer_id;
    return `Adjusted "${o.name}"`;
  }
  if (a.type === "add_layer") {
    const layer = newLayer({ name: "Layer", color: LAYER_COLORS[state.doc.layers.length % LAYER_COLORS.length] });
    state.doc.layers.push(layer);
    const summary = layerPatch(layer, a);
    return `Added layer ${layer.name}${summary ? `: ${summary}` : ""}`;
  }
  if (a.type === "set_layer") {
    const layer = layerById(a.layer_id);
    if (!layer) throw new Error("it pointed at a layer that doesn't exist");
    const summary = layerPatch(layer, a);
    return `${layer.name}${summary ? `: ${summary}` : " updated"}`;
  }
  throw new Error("it asked for something this app can't do");
}

async function applyActions(actions) {
  const notes = [];
  const added = new Map(); // designs added or replaced in this reply, by name, for align_with
  let changed = false;
  for (const action of actions) {
    try {
      notes.push(await applyAction(action, added));
      changed = true;
    } catch (error) {
      notes.push(`Skipped one change: ${error.message}`);
    }
  }
  if (changed) commit(); // one undo step for the whole reply
  return notes;
}

// --- reference picture ------------------------------------------------------------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Couldn't open ${file.name || "that picture"}. Try a PNG or JPEG.`)); };
    img.src = url;
  });
}

/** Scales the picture down and flattens it onto white, so transparent areas read as blank stock. */
async function shrink(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, REFERENCE_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function attach(files) {
  const file = [...files].find((f) => f.type.startsWith("image/"));
  if (!file) {
    addError("That isn't a picture. Attach a PNG, JPEG, WebP or GIF.");
    return;
  }
  try {
    reference = { url: await shrink(file), name: file.name || "Pasted picture" };
  } catch (error) {
    addError(error.message);
  }
  drawAttachment();
}

function addError(message) {
  state.chat.push({ role: "assistant", content: message, error: true });
  drawChat();
}

function drawAttachment() {
  if (!attachBox) return;
  attachBox.hidden = !reference;
  if (!reference) return attachBox.replaceChildren();
  attachBox.replaceChildren(
    h("img", { src: reference.url, alt: "" }),
    h("span", { class: "ref-text" }, h("strong", {}, reference.name), h("span", {}, "Sent with each message until you remove it.")),
    h("button", { type: "button", class: "btn ghost small", onclick: () => { reference = null; drawAttachment(); composer?.focus(); } }, "Remove"),
  );
}

// --- chat -----------------------------------------------------------------------

/** The two bits of Markdown models use anyway, as real elements. Everything else stays plain text. */
function rich(text) {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).filter(Boolean).map((part) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return h("strong", {}, part.slice(2, -2));
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return h("code", {}, part.slice(1, -1));
    return part;
  });
}

function bubble(message) {
  return h("div", { class: `msg ${message.role}${message.error ? " error" : ""}` },
    message.picture && h("img", { class: "msg-ref", src: message.picture, alt: "Reference picture" }),
    message.role === "assistant" && !message.error ? rich(message.content) : message.content,
    (message.notes || []).map((note) => h("span", { class: "did" }, note)),
    message.undoable && h("span", { class: "did" }, "Undo reverses these changes."));
}

function drawChat() {
  if (!chatBox) return;
  const hasModel = Boolean(state.config.llm?.model);
  const items = state.chat.map(bubble);
  if (!state.chat.length) {
    items.push(h("p", { class: "note" }, hasModel
      ? "Describe something to make, ask for a change to the selected design, or ask what settings to use for your material."
      : "Add a model and API key in Setup to switch the assistant on. It can draw designs, rework them, and suggest settings for your material."));
    if (!hasModel) items.push(h("button", { type: "button", class: "btn small", style: "align-self:flex-start", onclick: () => document.querySelector('[data-tab="setup"]').click() }, "Open Setup"));
    if (lastChat) items.push(h("button", { type: "button", class: "btn small", style: "align-self:flex-start", title: lastChat.name, onclick: act(() => openChat(lastChat.id)) }, "Back to last chat"));
  }
  if (busy) items.push(h("div", { class: "msg assistant thinking" }, "Working on it…"));
  chatBox.replaceChildren(...items);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  const picture = reference?.url || null;
  state.chat.push({ role: "user", content: text, picture });
  busy = true;
  drawChat();
  syncControls();
  try {
    const messages = state.chat.filter((m) => !m.error).map((m) => ({
      role: m.role,
      content: m.notes?.length ? `${m.content}\n[Changes applied in the app: ${m.notes.join("; ")}]` : m.content,
    }));
    const image = state.config.llm?.vision !== false && state.doc.objects.length ? await snapshotPng() : null;
    const reply = await post("/api/ai/chat", { messages, context: context(), image, reference: picture });
    const notes = await applyActions(reply.actions || []);
    state.chat.push({ role: "assistant", content: reply.text || "Done.", notes, undoable: notes.length > 0 });
  } catch (error) {
    state.chat.push({ role: "assistant", content: error.message, error: true });
  } finally {
    busy = false;
    drawChat();
    syncControls();
    saveChat();
  }
}

// --- keeping chats -----------------------------------------------------------------

const PICTURE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const newChatId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A saved chat is outside input: keep only known fields, as plain text. */
function cleanMessages(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-500).flatMap((m) => {
    if (!m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string") return [];
    return [{
      role: m.role,
      content: m.content.slice(0, 20000),
      ...(m.error ? { error: true } : {}),
      ...(typeof m.picture === "string" && PICTURE_RE.test(m.picture) ? { picture: m.picture } : {}),
      ...(Array.isArray(m.notes) ? { notes: m.notes.filter((n) => typeof n === "string").slice(0, 50).map((n) => n.slice(0, 300)) } : {}),
      ...(m.undoable ? { undoable: true } : {}),
    }];
  });
}

function chatTitle() {
  const first = state.chat.find((m) => m.role === "user")?.content || "Chat";
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

async function saveChat() {
  if (!state.chat.some((m) => m.role === "user")) return;
  chatId ||= newChatId();
  try {
    await api(`/api/chats/${chatId}`, { method: "PUT", body: { title: chatTitle(), messages: cleanMessages(state.chat) } });
  } catch (error) {
    toast(`Couldn't keep this chat: ${error.message}`, "warn");
  }
}

async function refreshLast() {
  try {
    const { chats } = await api("/api/chats");
    const other = chats.find((c) => c.id !== chatId);
    lastChat = other ? { id: other.id, name: other.name } : null;
  } catch {
    lastChat = null;
  }
  drawChat();
}

function newChat() {
  if (busy) return;
  state.chat = [];
  chatId = null;
  reference = null;
  drawAttachment();
  drawChat();
  refreshLast();
  composer?.focus();
}

async function openChat(id) {
  if (busy) return;
  const item = await api(`/api/chats/${id}`);
  state.chat = cleanMessages(item.data);
  chatId = item.id;
  reference = null;
  drawAttachment();
  drawChat();
  refreshLast();
}

const when = (seconds) => {
  const d = new Date(seconds * 1000);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

async function showChats() {
  const { chats } = await api("/api/chats");
  let list;
  const row = (c) => h("li", { class: "design-row chat-row" },
    h("div", { class: "design-text" },
      h("strong", {}, c.name, c.id === chatId ? h("span", { class: "note" }, " (open now)") : null),
      h("span", { class: "note" }, `${when(c.updated)}${c.count ? ` · ${c.count} message${c.count === 1 ? "" : "s"}` : ""}`)),
    h("button", { type: "button", class: "btn small", onclick: act(async () => { closeModal(""); await openChat(c.id); }) }, "Open"),
    h("button", {
      type: "button", class: "btn ghost small",
      onclick: act(async (event) => {
        const item = event.currentTarget.closest("li");
        await api(`/api/chats/${c.id}`, { method: "DELETE" });
        item.remove();
        if (c.id === chatId) newChat();
        else refreshLast();
        if (!list.children.length) list.replaceWith(h("p", { class: "note" }, "No earlier chats."));
      }),
    }, "Delete"));
  await modal((form) => {
    list = h("ul", { class: "design-list" }, chats.map(row));
    form.append(
      h("h1", {}, "Chats"),
      chats.length ? list : h("p", { class: "note" }, "No earlier chats. They're kept here once you send a message."),
      h("p", { class: "note" }, "The last 30 chats are kept."),
      h("div", { class: "actions" }, h("button", { class: "btn", value: "close" }, "Close")),
    );
  }, { wide: true });
}

function syncControls() {
  const hasModel = Boolean(state.config.llm?.model);
  for (const node of panel.querySelectorAll("[data-needs-model]")) node.disabled = busy || !hasModel;
  for (const node of panel.querySelectorAll("[data-needs-chat]")) node.disabled = busy;
  if (composer) composer.placeholder = selected().length === 1 ? "What should change about the selected design?" : "What would you like to make?";
}

export function initAssistant() {
  chatBox = h("div", { class: "chat", role: "log", "aria-live": "polite" });
  composer = h("textarea", {
    rows: 3, "aria-label": "Message to the assistant", dataset: { needsModel: "" },
    onkeydown: (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        const text = composer.value;
        composer.value = "";
        send(text);
      }
    },
    onpaste: (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (!files.some((f) => f.type.startsWith("image/"))) return;
      event.preventDefault();
      attach(files);
    },
  });
  const picker = h("input", {
    type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true,
    onchange: (event) => { attach(event.target.files); event.target.value = ""; },
  });
  attachBox = h("div", { class: "ref-attach", hidden: true });
  panel.addEventListener("dragover", (event) => {
    if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
  });
  panel.addEventListener("drop", (event) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    attach(event.dataTransfer.files);
  });
  const chatBar = h("div", { class: "chat-bar" },
    h("button", { type: "button", class: "btn ghost small", dataset: { needsChat: "" }, title: "Earlier chats with the assistant", onclick: act(showChats) }, "Chats"),
    h("button", { type: "button", class: "btn ghost small", dataset: { needsChat: "" }, title: "Clear the chat and start again. The old one stays under Chats.", onclick: newChat }, "New chat"));
  const chip = (label, text) => h("button", { type: "button", class: "chip", dataset: { needsModel: "" }, onclick: () => send(text()) }, label);
  panel.replaceChildren(
    chatBar,
    chatBox,
    h("div", { class: "chips" },
      chip("Recommend settings", () => {
        const material = state.materials.find((m) => m.id === state.ui.materialId);
        return material
          ? `Recommend settings for ${material.name} and apply them to my layers.`
          : "I'd like settings for my material. Ask me what it is and how thick, then apply them to my layers.";
      }),
      chip("Review my job", () => "Look over my job before I burn it: are the layer settings sensible for the material and the design? Point out anything that looks wrong."),
    ),
    h("form", {
      class: "composer",
      onsubmit: (event) => {
        event.preventDefault();
        const text = composer.value;
        composer.value = "";
        send(text);
      },
    }, attachBox, composer,
    h("div", { class: "composer-actions" },
      h("button", { type: "button", class: "btn ghost", title: "Attach a picture to guide the assistant. You can also paste or drop one here.", dataset: { needsModel: "" }, onclick: () => picker.click() }, "Add picture"),
      h("button", { class: "btn primary", dataset: { needsModel: "" } }, "Send")),
    picker),
  );
  drawChat();
  syncControls();
  restoreChat();
}

/** On load, carry on with the most recent chat. */
async function restoreChat() {
  try {
    const { chats } = await api("/api/chats");
    if (chats.length && !state.chat.length && !chatId) await openChat(chats[0].id);
  } catch {
    /* start with an empty chat */
  }
}

on("config", () => {
  drawChat();
  syncControls();
});
on("selection", syncControls);
