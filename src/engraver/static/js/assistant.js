// Assistant tab: a chat that can add and change designs and set layer settings.
// It never controls the machine; it only edits what's on the canvas and in the layer list.

import { state, on, bed, commit, select, selected, newLayer, layerById, objectById, LAYER_COLORS } from "./store.js";
import { post } from "./api.js";
import { h } from "./ui.js";
import { aabb, snapshotPng, viewCenter } from "./stage.js";
import { objectFromSvgText, sanitizeSvg, contentFromSvg } from "./svgutil.js";

const panel = document.getElementById("tab-assistant");
let busy = false;
let chatBox = null;
let composer = null;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const frontLeft = (o) => {
  const box = aabb([o]);
  return { x: box.x0, y: bed().h - box.y1, w: box.w, h: box.h };
};

function context() {
  const material = state.materials.find((m) => m.id === state.ui.materialId);
  const picked = selected();
  const one = picked.length === 1 ? picked[0] : null;
  return {
    material: material ? material.name : null,
    start_from: state.ui.originMode === "origin" ? "origin (design's front-left corner goes to the origin)" : "bed position",
    layers: state.doc.layers.map((l) => ({
      id: l.id, name: l.name, mode: l.mode, speed: l.speed, power: l.power, passes: l.passes,
      ...(l.mode === "fill" ? { interval: l.interval, image_mode: l.imageMode } : {}),
      output: l.output, designs: state.doc.objects.filter((o) => o.layerId === l.id).length,
    })),
    designs: state.doc.objects.map((o) => {
      const p = frontLeft(o);
      return { id: o.id, name: o.name, kind: o.kind, layer_id: o.layerId, x_mm: +p.x.toFixed(1), y_mm: +p.y.toFixed(1), width_mm: +o.w.toFixed(1), height_mm: +o.h.toFixed(1), rotation_deg: o.rot };
    }),
    selected: one
      ? { id: one.id, name: one.name, svg: one.kind === "image" ? "(a bitmap image; its pixels can't be edited as SVG)" : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${one.vb.join(" ")}">${one.svg}</svg>` }
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

async function applyAction(a) {
  const b = bed();
  if (a.type === "add_design") {
    const o = await objectFromSvgText(String(a.svg || ""), String(a.name || "Design").slice(0, 40));
    const w = clamp(num(a.width_mm) ?? Math.min(o.w, 80), 1, b.w);
    Object.assign(o, { h: (o.h * w) / o.w, w, layerId: layerFor(a).id });
    const c = viewCenter();
    o.x = c.x - o.w / 2;
    o.y = c.y - o.h / 2;
    moveTo(o, num(a.x_mm), num(a.y_mm));
    state.doc.objects.push(o);
    select([o.id]);
    return `Added "${o.name}", ${o.w.toFixed(0)} × ${o.h.toFixed(0)} mm, on ${layerById(o.layerId).name}`;
  }
  if (a.type === "replace_design") {
    const o = objectById(a.design_id);
    if (!o) throw new Error("it pointed at a design that isn't on the canvas");
    const content = contentFromSvg(await sanitizeSvg(String(a.svg || "")));
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const h2 = (o.w * content.vb[3]) / content.vb[2];
    Object.assign(o, { kind: "svg", svg: content.svg, vb: content.vb, h: h2, x: cx - o.w / 2, y: cy - h2 / 2 });
    delete o.text;
    if (typeof a.name === "string" && a.name.trim()) o.name = a.name.trim().slice(0, 40);
    return `Updated "${o.name}"`;
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
  let changed = false;
  for (const action of actions) {
    try {
      notes.push(await applyAction(action));
      changed = true;
    } catch (error) {
      notes.push(`Skipped one change: ${error.message}`);
    }
  }
  if (changed) commit(); // one undo step for the whole reply
  return notes;
}

// --- chat -----------------------------------------------------------------------

function bubble(message) {
  return h("div", { class: `msg ${message.role}${message.error ? " error" : ""}` },
    message.content,
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
  }
  if (busy) items.push(h("div", { class: "msg assistant thinking" }, "Working on it…"));
  chatBox.replaceChildren(...items);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  state.chat.push({ role: "user", content: text });
  busy = true;
  drawChat();
  syncControls();
  try {
    const messages = state.chat.filter((m) => !m.error).map((m) => ({
      role: m.role,
      content: m.notes?.length ? `${m.content}\n[Changes applied in the app: ${m.notes.join("; ")}]` : m.content,
    }));
    const image = state.config.llm?.vision !== false && state.doc.objects.length ? await snapshotPng() : null;
    const reply = await post("/api/ai/chat", { messages, context: context(), image });
    const notes = await applyActions(reply.actions || []);
    state.chat.push({ role: "assistant", content: reply.text || "Done.", notes, undoable: notes.length > 0 });
  } catch (error) {
    state.chat.push({ role: "assistant", content: error.message, error: true });
  } finally {
    busy = false;
    drawChat();
    syncControls();
  }
}

function syncControls() {
  const hasModel = Boolean(state.config.llm?.model);
  for (const node of panel.querySelectorAll("[data-needs-model]")) node.disabled = busy || !hasModel;
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
  });
  const chip = (label, text) => h("button", { type: "button", class: "chip", dataset: { needsModel: "" }, onclick: () => send(text()) }, label);
  panel.replaceChildren(
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
    }, composer, h("button", { class: "btn primary", dataset: { needsModel: "" } }, "Send")),
  );
  drawChat();
  syncControls();
}

on("config", () => {
  drawChat();
  syncControls();
});
on("selection", syncControls);
