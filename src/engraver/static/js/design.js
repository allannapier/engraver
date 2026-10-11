// Design tab: the material you're using and the laser settings for each layer.

import { state, on, commit, saveUi, newLayer, layerById, selected, LAYER_COLORS } from "./store.js";
import { h, icon, toast } from "./ui.js";

const panel = document.getElementById("tab-design");
let builtFor = "";

const material = () => state.materials.find((m) => m.id === state.ui.materialId);
const maxFeed = () => state.machine.max_feed || 6000;

const NUMBER_FIELDS = {
  speed: { label: "Speed", unit: "mm/min", min: 10, max: () => maxFeed(), step: 50 },
  power: { label: "Power", unit: "%", min: 0, max: () => 100, step: 1 },
  passes: { label: "Passes", unit: "", min: 1, max: () => 50, step: 1, integer: true },
  interval: { label: "Line gap", unit: "mm", min: 0.03, max: () => 2, step: 0.01 },
  threshold: { label: "Cut-off", unit: "0-255", min: 1, max: () => 255, step: 1, integer: true },
  minPower: { label: "Lightest", unit: "%", min: 0, max: () => 100, step: 1 },
};

function numberField(layer, key) {
  const spec = NUMBER_FIELDS[key];
  const input = h("input", {
    type: "number", min: spec.min, max: spec.max(), step: spec.step, value: layer[key],
    dataset: { layer: layer.id, field: key },
    onchange: () => {
      let value = parseFloat(input.value);
      if (!Number.isFinite(value)) value = layer[key];
      value = Math.min(spec.max(), Math.max(spec.min, value));
      if (spec.integer) value = Math.round(value);
      input.value = value;
      if (value !== layer[key]) {
        layer[key] = value;
        commit();
      }
    },
  });
  return h("label", { class: "field" }, spec.unit ? `${spec.label} (${spec.unit})` : spec.label, input);
}

function applyPreset(layer, op) {
  const preset = material()?.[op];
  if (!preset) return;
  layer.mode = preset.mode;
  layer.speed = Math.min(preset.speed, maxFeed());
  layer.power = preset.power;
  layer.passes = preset.passes;
  if (preset.interval) layer.interval = preset.interval;
  commit();
  toast(`${layer.name}: ${op} settings for ${material().name}. Test on scrap first.`);
}

function layerCard(layer) {
  const count = state.doc.objects.filter((o) => o.layerId === layer.id).length;
  const mat = material();
  const name = h("input", {
    type: "text", value: layer.name, "aria-label": "Layer name", dataset: { layer: layer.id, field: "name" },
    onchange: () => {
      layer.name = name.value.trim() || "Layer";
      commit();
    },
  });
  const modeButton = (mode, label, title) =>
    h("button", {
      type: "button", "aria-pressed": String(layer.mode === mode), title,
      onclick: () => {
        if (layer.mode === mode) return;
        layer.mode = mode;
        commit();
      },
    }, label);
  const presets = mat &&
    h("select", {
      "aria-label": "Use a preset",
      onchange: (event) => {
        applyPreset(layer, event.target.value);
        event.target.value = "";
      },
    },
      h("option", { value: "" }, "Use preset…"),
      ["engrave", "score", "cut"].map((op) => h("option", { value: op, disabled: !mat[op] }, mat[op] ? op[0].toUpperCase() + op.slice(1) : `${op[0].toUpperCase() + op.slice(1)} (not possible)`)),
    );
  const fillExtras = layer.mode === "fill" &&
    h("div", { class: "grid3" },
      numberField(layer, "interval"),
      h("label", { class: "field" }, "Shading",
        h("select", {
          dataset: { layer: layer.id, field: "imageMode" },
          onchange: (event) => {
            layer.imageMode = event.target.value;
            commit();
          },
        },
          [["threshold", "Solid"], ["dither", "Dots (photos)"], ["grayscale", "Vary power"]].map(([value, label]) => h("option", { value, selected: layer.imageMode === value }, label)),
        )),
      layer.imageMode === "threshold" ? numberField(layer, "threshold") : layer.imageMode === "grayscale" ? numberField(layer, "minPower") : h("span"),
    );
  return h("div", { class: `layer${selected().some((o) => o.layerId === layer.id) ? " target" : ""}`, dataset: { layerCard: layer.id } },
    h("div", { class: "layer-head" },
      h("span", { class: "swatch", style: `background:${layer.color}` }),
      name,
      h("span", { class: "layer-count" }, count === 1 ? "1 design" : `${count} designs`),
      h("label", { class: "check", title: "Include this layer when the job runs" },
        h("input", {
          type: "checkbox", checked: layer.output, dataset: { layer: layer.id, field: "output" },
          onchange: (event) => {
            layer.output = event.target.checked;
            commit();
          },
        }), "Burn"),
      h("button", {
        type: "button", class: "icon-btn", title: "Delete layer", "aria-label": `Delete layer ${layer.name}`,
        disabled: state.doc.layers.length < 2,
        onclick: () => deleteLayer(layer),
      }, icon("close")),
    ),
    h("div", { class: "row spread" },
      h("div", { class: "seg" },
        modeButton("line", "Line", "Trace outlines once: scoring and cutting"),
        modeButton("fill", "Fill", "Scan back and forth to engrave solid areas and photos")),
      presets,
    ),
    h("div", { class: "grid3" }, numberField(layer, "speed"), numberField(layer, "power"), numberField(layer, "passes")),
    fillExtras,
  );
}

function deleteLayer(layer) {
  const rest = state.doc.layers.filter((l) => l.id !== layer.id);
  if (!rest.length) return;
  const moved = state.doc.objects.filter((o) => o.layerId === layer.id);
  for (const o of moved) o.layerId = rest[0].id;
  state.doc.layers = rest;
  commit();
  if (moved.length) toast(`Moved ${moved.length === 1 ? "1 design" : `${moved.length} designs`} to ${rest[0].name}.`);
}

function addLayer() {
  const used = new Set(state.doc.layers.map((l) => l.color));
  const color = LAYER_COLORS.find((c) => !used.has(c)) || LAYER_COLORS[state.doc.layers.length % LAYER_COLORS.length];
  state.doc.layers.push(newLayer({ name: `Layer ${state.doc.layers.length + 1}`, color }));
  commit();
}

function build() {
  const mat = material();
  panel.replaceChildren(
    h("section", {},
      h("label", { class: "field" }, "Material",
        h("select", {
          id: "material",
          onchange: (event) => {
            state.ui.materialId = event.target.value;
            saveUi();
          },
        },
          h("option", { value: "" }, "Not chosen"),
          state.materials.map((m) => h("option", { value: m.id, selected: m.id === state.ui.materialId }, m.name)),
        )),
      mat && h("p", { class: "note", style: "margin-top:8px" }, mat.notes),
      mat && h("p", { class: "note", style: "margin-top:6px" }, "Presets are starting points for a 10 W diode. Run a small test on scrap before the real piece."),
    ),
    h("section", {},
      h("h2", {}, "Layers"),
      state.doc.layers.map(layerCard),
      h("button", { type: "button", class: "btn small", style: "margin-top:10px", onclick: addLayer }, "Add layer"),
    ),
    h("section", {},
      h("h2", {}, "Never put these under the laser"),
      h("p", { class: "note" }, state.never.map((item) => item.name).join(", ") + "."),
    ),
  );
}

function render() {
  // Rebuild only when the structure changes; otherwise just refresh values,
  // so typing in a field never loses focus.
  const picked = new Set(selected().map((o) => o.layerId));
  const key = JSON.stringify([
    state.doc.layers.map((l) => [l.id, l.mode, l.imageMode, state.doc.objects.filter((o) => o.layerId === l.id).length, picked.has(l.id)]),
    state.ui.materialId, state.materials.length, state.machine.max_feed,
  ]);
  if (key !== builtFor) {
    builtFor = key;
    build();
    return;
  }
  for (const input of panel.querySelectorAll("[data-layer]")) {
    if (input === document.activeElement) continue;
    const layer = layerById(input.dataset.layer);
    if (!layer) continue;
    const value = layer[input.dataset.field];
    if (input.type === "checkbox") input.checked = Boolean(value);
    else if (String(input.value) !== String(value)) input.value = value;
  }
}

on("doc", render);
on("selection", render);
on("ui", render);
on("config", render);
export const initDesign = render;
