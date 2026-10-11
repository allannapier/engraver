// App state, change notification, undo history and autosave.

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}
export function emit(event, detail) {
  for (const fn of listeners.get(event) || []) {
    try {
      fn(detail);
    } catch (error) {
      console.error(error); // one broken panel mustn't stop the others updating
    }
  }
}

export const LAYER_COLORS = ["#1f6feb", "#d1242f", "#1a7f37", "#8250df", "#bc4c00", "#0e7c86"];

let counter = 0;
export function uid(prefix) {
  counter += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${counter.toString(36)}`;
}

export function newLayer(props = {}) {
  return {
    id: uid("L"),
    name: "Layer",
    color: LAYER_COLORS[0],
    mode: "line",
    speed: 1000,
    power: 20,
    passes: 1,
    interval: 0.1,
    imageMode: "threshold",
    threshold: 128,
    minPower: 0,
    output: true,
    ...props,
  };
}

function defaultDoc() {
  return {
    layers: [
      newLayer({ name: "Engrave", mode: "fill", speed: 6000, power: 40, color: LAYER_COLORS[0] }),
      newLayer({ name: "Cut", mode: "line", speed: 300, power: 100, passes: 2, color: LAYER_COLORS[1] }),
    ],
    objects: [],
  };
}

export const state = {
  doc: defaultDoc(),
  selection: new Set(),
  status: { connected: false, state: "Disconnected", wpos: [0, 0], wco: [0, 0], settings: {}, job: null },
  config: { machine: {}, llm: {} },
  machine: { bed_w: 410, bed_h: 400, max_feed: 6000 },
  materials: [],
  never: [],
  ui: { materialId: "", originMode: "absolute", finish: "origin", frameDot: false, jogStep: 10, lockAspect: true },
  chat: [],
};

export const bed = () => ({ w: state.machine.bed_w || 410, h: state.machine.bed_h || 400 });
export const layerById = (id) => state.doc.layers.find((layer) => layer.id === id);
export const objectById = (id) => state.doc.objects.find((obj) => obj.id === id);
export const selected = () => state.doc.objects.filter((obj) => state.selection.has(obj.id));

// --- history -----------------------------------------------------------------
// Snapshots are shallow copies, so big image strings are shared, not duplicated.

const snapshot = () => ({
  layers: state.doc.layers.map((layer) => ({ ...layer })),
  objects: state.doc.objects.map((obj) => ({ ...obj, text: obj.text ? { ...obj.text } : undefined })),
});

let last = snapshot();
const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 80;

/** Call after a finished change: records an undo step, saves, and redraws. */
export function commit() {
  undoStack.push(last);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  last = snapshot();
  scheduleSave();
  emit("doc");
}

/** Redraw during a drag without recording an undo step. */
export const touch = () => emit("doc");

function restore(snap) {
  state.doc = { layers: snap.layers.map((l) => ({ ...l })), objects: snap.objects.map((o) => ({ ...o, text: o.text ? { ...o.text } : undefined })) };
  for (const id of [...state.selection]) if (!objectById(id)) state.selection.delete(id);
  scheduleSave();
  emit("doc");
  emit("selection");
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(last);
  last = undoStack.pop();
  restore(last);
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(last);
  last = redoStack.pop();
  restore(last);
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function select(ids, { add = false } = {}) {
  if (!add) state.selection.clear();
  for (const id of ids) state.selection.add(id);
  emit("selection");
}

// --- persistence -------------------------------------------------------------

const STORAGE_KEY = "engraver.project.v1";
let saveTimer = null;
let saveWarned = false;

export function serialize() {
  return JSON.stringify({ format: "engraver-project", version: 1, doc: state.doc, ui: state.ui });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serialize());
    } catch {
      // Usually the quota: a project with large photos won't fit in browser storage.
      if (!saveWarned) emit("toast", { kind: "warn", text: "This project is too big to keep automatically. Use Save to keep a copy." });
      saveWarned = true;
    }
  }, 400);
}

const finite = (value, fallback, lo = -Infinity, hi = Infinity) => (Number.isFinite(Number(value)) ? Math.min(hi, Math.max(lo, Number(value))) : fallback);
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

// A project file is outside input: keep only known fields, with sane types and ranges.
function cleanLayer(raw, index) {
  const base = newLayer();
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id.slice(0, 40) : base.id,
    name: typeof raw?.name === "string" ? raw.name.slice(0, 40) : `Layer ${index + 1}`,
    color: /^#[0-9a-f]{3,8}$/i.test(raw?.color) ? raw.color : LAYER_COLORS[index % LAYER_COLORS.length],
    mode: pick(raw?.mode, ["line", "fill"], "line"),
    speed: finite(raw?.speed, base.speed, 10, 60000),
    power: finite(raw?.power, base.power, 0, 100),
    passes: Math.round(finite(raw?.passes, 1, 1, 50)),
    interval: finite(raw?.interval, 0.1, 0.03, 2),
    imageMode: pick(raw?.imageMode, ["threshold", "dither", "grayscale"], "threshold"),
    threshold: Math.round(finite(raw?.threshold, 128, 1, 255)),
    minPower: finite(raw?.minPower, 0, 0, 100),
    output: raw?.output !== false,
  };
}

function cleanObject(raw, layerIds, fallbackLayer) {
  if (!raw || typeof raw.svg !== "string" || !Array.isArray(raw.vb) || raw.vb.length !== 4) return null;
  const vb = raw.vb.map((n) => finite(n, NaN));
  if (vb.some(Number.isNaN) || vb[2] <= 0 || vb[3] <= 0) return null;
  const obj = {
    id: typeof raw.id === "string" && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : uid("o"),
    kind: pick(raw.kind, ["svg", "image", "text", "shape"], "svg"),
    name: typeof raw.name === "string" ? raw.name.slice(0, 40) : "Design",
    layerId: layerIds.has(raw.layerId) ? raw.layerId : fallbackLayer,
    svg: raw.svg,
    vb,
    x: finite(raw.x, 0, -5000, 5000),
    y: finite(raw.y, 0, -5000, 5000),
    w: finite(raw.w, 10, 0.1, 5000),
    h: finite(raw.h, 10, 0.1, 5000),
    rot: finite(raw.rot, 0, 0, 360),
  };
  if (obj.kind === "text") {
    if (typeof raw.text?.value !== "string") obj.kind = "svg";
    else obj.text = { value: raw.text.value.slice(0, 2000), font: String(raw.text.font || "sans-serif").slice(0, 120), bold: Boolean(raw.text.bold), italic: Boolean(raw.text.italic) };
  }
  return obj;
}

/** Replace the document. `data` is a parsed project file; artwork must already be sanitised. */
export function loadDoc(data, { record = true } = {}) {
  const doc = data?.doc;
  if (!doc || !Array.isArray(doc.layers) || !Array.isArray(doc.objects)) throw new Error("That file isn't an Engraver project.");
  const layers = doc.layers.slice(0, 30).map(cleanLayer);
  if (!layers.length) layers.push(...defaultDoc().layers);
  const ids = new Set(layers.map((layer) => layer.id));
  const seen = new Set();
  const objects = doc.objects.map((raw) => cleanObject(raw, ids, layers[0].id)).filter((obj) => {
    if (!obj) return false;
    if (seen.has(obj.id)) obj.id = uid("o");
    seen.add(obj.id);
    return true;
  });
  state.doc = { layers, objects };
  state.selection.clear();
  const ui = data.ui || {};
  Object.assign(state.ui, {
    materialId: typeof ui.materialId === "string" ? ui.materialId : state.ui.materialId,
    originMode: pick(ui.originMode, ["absolute", "origin"], state.ui.originMode),
    finish: pick(ui.finish, ["origin", "stay"], state.ui.finish),
    frameDot: typeof ui.frameDot === "boolean" ? ui.frameDot : state.ui.frameDot,
    jogStep: pick(ui.jogStep, [0.1, 1, 10, 50], state.ui.jogStep),
    lockAspect: typeof ui.lockAspect === "boolean" ? ui.lockAspect : state.ui.lockAspect,
  });
  if (record) commit();
  else {
    last = snapshot();
    emit("doc");
  }
  emit("selection");
  emit("ui");
}

export function storedProject() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

export const saveUi = () => {
  scheduleSave();
  emit("ui");
};
