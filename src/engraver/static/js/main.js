// Entry point: loads state from the server, wires the top bar, toolbar,
// property bar, job bar and keyboard, and starts the panels.

import { installDiagnostics } from "./diagnostics.js";
import { state, on, emit, bed, commit, undo, redo, canUndo, canRedo, select, selected, layerById, loadDoc, storedProject, uid, setMaterials } from "./store.js";
import { api, post, connectEvents } from "./api.js";
import { h, icon, toast, modal, formatDuration, act, download } from "./ui.js";
import { initStage, fitView, zoomBy, viewCenter, aabb, isTyping, onDoubleClick, outputObjects } from "./stage.js";
import { objectFromSvgText, objectFromImage, objectFromText, objectFromShape, textContent, fitSize, FONTS } from "./svgutil.js";
import { buildJob } from "./job.js";
import { confirmAndStart, frame } from "./run.js";
import { initDesign } from "./design.js";
import { initLaser, addLog } from "./laser.js";
import { initSetup } from "./setup.js";
import { initBugReport } from "./bugreport.js";
import { initDesigns, cleanProject, saveDesign } from "./designs.js";
import { handleMcp } from "./mcp.js";
import { initBedPhoto, takePhoto } from "./bedphoto.js";

installDiagnostics(); // before anything else runs, so start-up errors are caught too

const $ = (id) => document.getElementById(id);
const jobActive = () => ["running", "paused", "stopping"].includes(state.status.job?.state);

// --- adding things to the canvas ---------------------------------------------------

function place(obj, layerMode) {
  const layer = state.doc.layers.find((l) => l.mode === layerMode) || state.doc.layers[0];
  const c = viewCenter();
  Object.assign(obj, { layerId: layer.id, x: c.x - obj.w / 2, y: c.y - obj.h / 2 });
  state.doc.objects.push(obj);
  return obj;
}

const readAs = (file, how) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
  reader[how](file);
});

async function importFiles(files) {
  const added = [];
  for (const file of files) {
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "Design";
    try {
      const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
      const obj = isSvg ? await objectFromSvgText(await readAs(file, "readAsText"), name) : await objectFromImage(await readAs(file, "readAsDataURL"), name);
      Object.assign(obj, fitSize(obj.w, obj.h, bed()));
      if (obj.backgroundRemoved) toast(`${file.name}: removed the white page background so it isn't cut as a box.`);
      // Photos engrave; drawings usually start as an engraving too. Either can be moved to another layer.
      added.push(place(obj, "fill"));
    } catch (error) {
      toast(`${file.name}: ${error.message}`, "error");
    }
  }
  if (added.length) {
    select(added.map((o) => o.id));
    commit();
  }
}

/** The text settings of an object we can edit as text: ours, or <text> elements, possibly inside a group (e.g. from an MCP client). */
function textOf(obj) {
  if (obj?.kind === "text") return obj.text;
  if (obj?.kind !== "svg") return null;
  const root = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${obj.svg}</svg>`, "image/svg+xml").documentElement;
  // Look through wrapper groups (the importer wraps root-level presentation attributes in one).
  let box = root;
  while (box.children.length === 1 && box.children[0].localName === "g") box = box.children[0];
  const nodes = [...box.children];
  if (!nodes.length || nodes.some((n) => n.localName !== "text" || n.querySelector("*:not(tspan)"))) return null;
  const chain = [nodes[0]];
  for (let n = box; n; n = n.parentElement) chain.push(n);
  const inherited = (name) => chain.find((n) => n.getAttribute(name))?.getAttribute(name) || "";
  const lines = nodes.flatMap((node) => {
    const tspans = [...node.querySelectorAll("tspan")];
    return tspans.length ? tspans.map((t) => t.textContent) : [node.textContent];
  });
  return {
    value: lines.join("\n").trim(),
    font: inherited("font-family") || FONTS[0][1],
    bold: /bold|[6-9]00/.test(inherited("font-weight")),
    italic: /italic|oblique/.test(inherited("font-style")),
  };
}

async function textDialog(existing) {
  const text = existing ? { ...textOf(existing) } : { value: "", font: FONTS[0][1], bold: false, italic: false };
  const area = h("textarea", { rows: 3, value: text.value, placeholder: "Your text", required: true, style: "width:100%" });
  const builtIn = (value) => FONTS.some(([, v]) => v === value);
  const fonts = builtIn(text.font) ? FONTS : [["Current", text.font], ...FONTS];
  const font = h("select", {}, fonts.map(([label, value]) => h("option", { value, selected: value === text.font }, label)));
  // Previews come only from the built-in list, never from a font string in a loaded project.
  for (const option of font.options) if (builtIn(option.value)) option.style.fontFamily = option.value;
  const preview = () => { font.style.fontFamily = builtIn(font.value) ? font.value : ""; };
  preview();
  font.addEventListener("change", preview);
  const bold = h("input", { type: "checkbox", checked: text.bold });
  const italic = h("input", { type: "checkbox", checked: text.italic });
  const result = await modal((form) => {
    form.append(
      h("h1", {}, existing ? "Edit text" : "Add text"),
      area,
      h("div", { class: "row" }, h("label", { class: "field", style: "flex:1" }, "Typeface", font), h("label", { class: "check" }, bold, "Bold"), h("label", { class: "check" }, italic, "Italic")),
      h("p", { class: "note" }, "Text engraves on a fill layer. It can't be traced as an outline on a line layer yet."),
      h("div", { class: "actions" },
        h("button", { class: "btn", value: "", formnovalidate: true }, "Cancel"),
        h("button", { class: "btn primary", value: "ok" }, existing ? "Update text" : "Add text")),
    );
    setTimeout(() => area.focus());
  });
  if (result !== "ok" || !area.value.trim()) return;
  const next = { value: area.value.replace(/\s+$/, ""), font: font.value, bold: bold.checked, italic: italic.checked };
  if (existing) {
    const content = textContent(next);
    const cx = existing.x + existing.w / 2;
    const lines = next.value.split("\n").length, before = text.value.split("\n").length;
    const hNew = (existing.h / before) * lines;
    const wNew = (hNew * content.vb[2]) / content.vb[3];
    Object.assign(existing, { ...content, kind: "text", text: next, w: wNew, h: hNew, x: cx - wNew / 2, name: next.value.split("\n")[0].slice(0, 24) });
  } else {
    select([place(objectFromText(next), "fill").id]);
  }
  commit();
}

const TOOLS = {
  import: () => $("file-import").click(),
  text: () => textDialog(),
  rect: () => { select([place(objectFromShape("rect"), "line").id]); commit(); },
  ellipse: () => { select([place(objectFromShape("ellipse"), "line").id]); commit(); },
  undo, redo,
  duplicate: () => {
    const copies = selected().map((o) => ({ ...o, text: o.text ? { ...o.text } : undefined, id: uid("o"), x: o.x + 5, y: o.y + 5 }));
    if (!copies.length) return;
    state.doc.objects.push(...copies);
    select(copies.map((o) => o.id));
    commit();
  },
  delete: () => {
    if (!state.selection.size) return;
    state.doc.objects = state.doc.objects.filter((o) => !state.selection.has(o.id));
    select([]);
    commit();
  },
  center: () => {
    const picked = selected();
    const box = aabb(picked);
    if (!box) return;
    const b = bed();
    const dx = b.w / 2 - (box.x0 + box.w / 2), dy = b.h / 2 - (box.y0 + box.h / 2);
    for (const o of picked) { o.x += dx; o.y += dy; }
    commit();
  },
  "zoom-in": () => zoomBy(1.3),
  "zoom-out": () => zoomBy(1 / 1.3),
  fit: fitView,
  camera: takePhoto,
};

function initTools() {
  for (const button of document.querySelectorAll(".tools button")) {
    button.append(icon(button.dataset.tool));
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", act(() => TOOLS[button.dataset.tool]()));
  }
  const sync = () => {
    const any = state.selection.size > 0;
    const set = (tool, enabled) => { document.querySelector(`[data-tool="${tool}"]`).disabled = !enabled; };
    set("undo", canUndo());
    set("redo", canRedo());
    set("duplicate", any);
    set("delete", any);
    set("center", any);
    $("stage-hint").textContent = state.doc.objects.length
      ? "Scroll to zoom. Hold Space and drag to pan."
      : "Import an SVG or picture, add text or a shape, or ask Claude Code for one over MCP.";
  };
  on("doc", sync);
  on("selection", sync);
  sync();

  $("file-import").addEventListener("change", async (event) => {
    await importFiles([...event.target.files]);
    event.target.value = "";
  });
  onDoubleClick((obj) => {
    if (textOf(obj)) textDialog(obj);
  });

  // Drag files onto the canvas, or paste an SVG or picture.
  const wrap = document.querySelector(".stage-wrap");
  let depth = 0;
  wrap.addEventListener("dragenter", (event) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    depth += 1;
    $("dropzone").hidden = false;
  });
  wrap.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) $("dropzone").hidden = true;
  });
  wrap.addEventListener("dragover", (event) => event.preventDefault());
  wrap.addEventListener("drop", (event) => {
    event.preventDefault();
    depth = 0;
    $("dropzone").hidden = true;
    importFiles([...event.dataTransfer.files]);
  });
  window.addEventListener("paste", async (event) => {
    if (isTyping(event)) return;
    const files = [...event.clipboardData.files];
    if (files.length) return importFiles(files);
    const text = event.clipboardData.getData("text/plain");
    if (/<svg[\s>]/i.test(text)) {
      try {
        const obj = await objectFromSvgText(text, "Pasted design");
        Object.assign(obj, fitSize(obj.w, obj.h, bed()));
        select([place(obj, "fill").id]);
        commit();
      } catch (error) {
        toast(error.message, "error");
      }
    }
  });
}

// --- property bar ---------------------------------------------------------------------

function initProps() {
  const bar = $("prop-fields");
  const fields = { x: $("prop-x"), y: $("prop-y"), w: $("prop-w"), h: $("prop-h"), rot: $("prop-rot") };
  const layerSelect = $("prop-layer");
  const lock = $("prop-lock");

  const sync = () => {
    const picked = selected();
    bar.hidden = picked.length === 0;
    $("prop-edit-text").hidden = !(picked.length === 1 && textOf(picked[0]));
    $("stage-hint").hidden = picked.length > 0;
    if (!picked.length) return;
    const box = aabb(picked);
    const one = picked.length === 1 ? picked[0] : null;
    const values = { x: box.x0, y: bed().h - box.y1, w: one ? one.w : box.w, h: one ? one.h : box.h, rot: one ? one.rot : 0 };
    for (const [key, input] of Object.entries(fields)) {
      if (input !== document.activeElement) input.value = +values[key].toFixed(2);
      input.disabled = !one && key !== "x" && key !== "y";
    }
    lock.replaceChildren(icon(state.ui.lockAspect ? "lock" : "unlock"));
    lock.setAttribute("aria-pressed", String(state.ui.lockAspect));
    const layerIds = new Set(picked.map((o) => o.layerId));
    layerSelect.replaceChildren(
      ...(layerIds.size > 1 ? [h("option", { value: "", selected: true }, "Mixed")] : []),
      ...state.doc.layers.map((l) => h("option", { value: l.id, selected: layerIds.size === 1 && layerIds.has(l.id) }, l.name)),
    );
  };

  const change = (key) => () => {
    const picked = selected();
    const value = parseFloat(fields[key].value);
    if (!picked.length || !Number.isFinite(value)) return sync();
    const box = aabb(picked);
    const one = picked.length === 1 ? picked[0] : null;
    if (key === "x") for (const o of picked) o.x += value - box.x0;
    else if (key === "y") for (const o of picked) o.y -= value - (bed().h - box.y1);
    else if (one && (key === "w" || key === "h")) {
      const next = Math.max(0.1, value);
      const cx = one.x + one.w / 2, cy = one.y + one.h / 2;
      const ratio = one.h / one.w;
      if (key === "w") { one.w = next; if (state.ui.lockAspect) one.h = next * ratio; }
      else { one.h = next; if (state.ui.lockAspect) one.w = next / ratio; }
      // Resize about the centre, then put the front-left corner back where it was.
      one.x = cx - one.w / 2; one.y = cy - one.h / 2;
      const after = aabb([one]);
      one.x += box.x0 - after.x0; one.y += box.y1 - after.y1;
    } else if (one && key === "rot") one.rot = ((value % 360) + 360) % 360;
    commit();
  };
  for (const key of Object.keys(fields)) {
    fields[key].addEventListener("change", change(key));
    // Enter applies the value and hands the keyboard back to the canvas (arrows, Delete, undo).
    fields[key].addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      fields[key].blur();
      $("stage").focus({ preventScroll: true });
    });
  }
  $("prop-edit-text").addEventListener("click", () => textDialog(selected()[0]));
  lock.addEventListener("click", () => {
    state.ui.lockAspect = !state.ui.lockAspect;
    emit("ui");
  });
  layerSelect.addEventListener("change", () => {
    if (!layerById(layerSelect.value)) return;
    for (const o of selected()) o.layerId = layerSelect.value;
    commit();
  });
  on("doc", sync);
  on("selection", sync);
  on("ui", sync);
  on("config", sync);
  sync();
}

// --- keyboard ---------------------------------------------------------------------------

function initKeys() {
  window.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "s" && !$("dialog").open) {
      event.preventDefault(); // the browser's own Save page is never what's wanted here
      act(saveDesign)();
      return;
    }
    if (isTyping(event) || $("dialog").open) return;
    if (mod && key === "z") { event.preventDefault(); (event.shiftKey ? redo : undo)(); }
    else if (mod && key === "y") { event.preventDefault(); redo(); }
    else if (mod && key === "d") { event.preventDefault(); TOOLS.duplicate(); }
    else if (mod && key === "a") { event.preventDefault(); select(state.doc.objects.map((o) => o.id)); }
    else if (key === "delete" || key === "backspace") { event.preventDefault(); TOOLS.delete(); }
    else if (key === "escape") select([]);
    else if (key.startsWith("arrow") && state.selection.size) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
      const [dx, dy] = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[key];
      for (const o of selected()) { o.x += dx * step; o.y += dy * step; }
      commit();
    }
  });
}

// --- connection and status ------------------------------------------------------------------

let showAllPorts = false;
async function refreshPorts() {
  const { ports, hidden } = await api(`/api/ports${showAllPorts ? "?all=true" : ""}`);
  const select = $("port");
  const current = select.value;
  select.replaceChildren(...ports.map((p) => h("option", { value: p.device }, p.description && p.device !== "sim" ? `${p.device} (${p.description})` : p.description || p.device)));
  // Built-in serial ports with nothing known about them are left out unless asked for.
  if (hidden) select.append(h("option", { value: "__all__" }, `Show ${hidden} other port${hidden === 1 ? "" : "s"}…`));
  // Prefer what was chosen, then the first USB serial device, then the simulator.
  const usb = ports.find((p) => p.usb);
  select.value = ports.some((p) => p.device === current) ? current : usb ? usb.device : "sim";
}

const STATE_TEXT = { Disconnected: "Not connected", Connecting: "Connecting…", Idle: "Ready", Run: "Laser running", Hold: "Paused", Jog: "Moving", Alarm: "Locked (alarm)", Home: "Homing", Door: "Door open", Check: "Check mode", Sleep: "Asleep" };

function initStatus() {
  $("port-refresh").append(icon("refresh"));
  $("port-refresh").addEventListener("click", act(refreshPorts));
  $("port").addEventListener("change", act(async () => {
    if ($("port").value !== "__all__") return;
    showAllPorts = true;
    await refreshPorts();
  }));
  $("connect").addEventListener("click", act(async () => {
    if (state.status.connected || state.status.state === "Connecting") await post("/api/disconnect");
    else if ($("port").value !== "__all__") await post("/api/connect", { port: $("port").value });
  }));

  let lastJob = "";
  on("status", () => {
    const s = state.status;
    const connected = s.connected;
    // "Laser running" is only true for a real job: a frame or a plain move isn't burning.
    const burning = s.state === "Run" && jobActive() && s.job.kind === "job";
    const framing = s.state === "Run" && jobActive() && s.job.kind === "frame";
    const shown = s.state === "Run" && !burning ? "Jog" : s.state;
    $("machine-state").dataset.state = shown;
    $("state-text").textContent = framing ? "Framing" : STATE_TEXT[shown] || s.state;
    $("connect").textContent = connected || s.state === "Connecting" ? "Disconnect" : "Connect";
    $("port").disabled = connected || s.state === "Connecting";
    $("dro-x").textContent = connected ? s.wpos[0].toFixed(2) : "–";
    $("dro-y").textContent = connected ? s.wpos[1].toFixed(2) : "–";

    const job = s.job;
    const active = jobActive();
    const ready = connected && s.state === "Idle" && !active;
    $("job-frame").disabled = !ready;
    $("job-start").disabled = !ready;
    $("job-pause").disabled = !(active && job.state !== "stopping");
    $("job-pause").textContent = job?.state === "paused" ? "Resume" : "Pause";
    $("job-stop").disabled = !connected;
    document.querySelector(".jobbar").dataset.live = String(active && job.kind === "job");

    const bar = $("job-bar");
    if (job) {
      const shown = job.state === "done" ? 100 : Math.round((job.progress ?? (job.total ? job.acked / job.total : 0)) * 100);
      bar.firstElementChild.style.width = `${shown}%`;
      bar.setAttribute("aria-valuenow", shown);
      const label = { running: "running", paused: "paused", stopping: "stopping…", done: "finished", stopped: "stopped", error: "stopped with an error" }[job.state];
      const where = stageText(job.stage);
      $("job-title").textContent = `${job.name}: ${label}${where ? ` · ${where}` : ""}`;
      $("job-time").textContent = active || job.state === "done"
        ? `${formatDuration(job.elapsed)}${job.est_seconds && job.state !== "done" ? ` of about ${formatDuration(job.est_seconds)}` : ""}`
        : "";
      const stamp = `${job.name}|${job.state}|${job.error || ""}`;
      if (stamp !== lastJob) {
        if (lastJob) {
          if (job.state === "done" && job.kind === "job") toast(`${job.name} finished in ${formatDuration(job.elapsed)}.`);
        }
        lastJob = stamp;
      }
    } else {
      bar.firstElementChild.style.width = "0%";
      $("job-title").textContent = "No job running";
      $("job-time").textContent = "";
    }
  });
}

// --- jobs ------------------------------------------------------------------------------------

// "Cut, layer 2 of 3 · pass 4 of 6"; only the parts that have more than one.
function stageText(stage) {
  if (!stage) return "";
  const parts = [];
  if (stage.layers > 1) parts.push(`${stage.layer}, layer ${stage.layer_no} of ${stage.layers}`);
  if (stage.passes > 1) parts.push(`${stage.layers > 1 ? "" : `${stage.layer}, `}pass ${stage.pass} of ${stage.passes}`);
  return parts.join(" · ");
}

async function startJob() {
  const { job, warnings } = await buildJob("Job");
  await confirmAndStart(job, warnings);
}

async function frameJob() {
  const { job } = await buildJob("Job");
  await frame(job);
}

function initJobs() {
  const busy = (button, fn) => act(async () => {
    button.disabled = true; // building a big fill layer takes a moment; don't queue clicks
    try { await fn(); } finally { emit("status"); }
  });
  $("job-start").addEventListener("click", busy($("job-start"), startJob));
  $("job-frame").addEventListener("click", busy($("job-frame"), frameJob));
  $("job-pause").addEventListener("click", act(() => post(state.status.job?.state === "paused" ? "/api/job/resume" : "/api/job/pause")));
  $("job-stop").addEventListener("click", act(() => post("/api/job/stop")));

  $("export-gcode").addEventListener("click", act(async () => {
    const { job, warnings } = await buildJob("Job");
    const gcode = await post("/api/job/gcode", { job });
    download("engraver-job.gcode", gcode, "text/plain");
    for (const warning of warnings) toast(warning, "warn");
  }));

  const summary = () => {
    const box = aabb(outputObjects());
    $("job-summary").textContent = box ? `${box.w.toFixed(1)} × ${box.h.toFixed(1)} mm` : "";
  };
  on("doc", summary);
  summary();
}

// --- project files ---------------------------------------------------------------------------

function restoreProject() {
  const saved = storedProject();
  if (!saved) return;
  try {
    loadDoc(cleanProject(saved), { record: false });
  } catch {
    /* start fresh */
  }
}

function initTabs() {
  for (const tab of document.querySelectorAll(".tabs button")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".tabs button")) {
        const active = other === tab;
        other.setAttribute("aria-selected", String(active));
        $(`tab-${other.dataset.tab}`).hidden = !active;
      }
    });
  }
}

// --- boot ------------------------------------------------------------------------------------

async function boot() {
  on("toast", ({ kind, text }) => toast(text, kind));
  initTabs();
  restoreProject();
  initDesigns();
  try {
    const data = await api("/api/state");
    Object.assign(state, { status: data.status, config: data.config, machine: data.machine, never: data.never });
    setMaterials({ builtin: data.materials, library: data.library });
    for (const entry of data.log) addLog(entry);
  } catch (error) {
    toast(error.message, "error");
  }
  initStage();
  initTools();
  initProps();
  initKeys();
  initStatus();
  initJobs();
  initDesign();
  initLaser();
  initSetup();
  initBugReport();
  initBedPhoto();
  emit("config");
  emit("status");
  refreshPorts().catch(() => {});

  let banner = null;
  const controlBanner = (inControl) => {
    banner?.remove();
    banner = null;
    if (inControl) return;
    banner = h("div", { class: "tab-banner", role: "status" }, "Another Engraver tab is in control. Use this one by clicking in it.");
    banner.onclick = () => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); };
    document.body.prepend(banner);
  };

  connectEvents((event) => {
    if (event.type === "status") {
      state.status = event.status;
      emit("status");
    } else if (event.type === "log") {
      addLog(event);
      if (event.kind === "error") toast(event.text, "error");
    } else if (event.type === "mcp") {
      handleMcp(event);
    } else if (event.type === "control") {
      controlBanner(event.active || event.tabs < 2);
    } else if (event.type === "mcp-note") {
      toast(event.text);
    }
  }, (linked) => {
    if (!linked && state.status.connected) toast("Lost contact with Engraver's server.", "error");
  });

  // The controller's own limits (top speed, full-power value) arrive after connecting.
  let known = "";
  on("status", async () => {
    const s = state.status.settings || {};
    const stamp = `${state.status.connected}|${s["30"]}|${s["110"]}`;
    if (stamp === known) return;
    known = stamp;
    try {
      const data = await api("/api/state");
      state.machine = data.machine;
      emit("config");
    } catch {
      /* next status will retry */
    }
  });
}

boot();
