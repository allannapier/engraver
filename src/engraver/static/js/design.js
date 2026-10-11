// Design tab: the material you're using and the laser settings for each layer.

import { state, on, commit, saveUi, newLayer, layerById, selected, LAYER_COLORS } from "./store.js";
import { h, icon, toast, fill, modal, act } from "./ui.js";
import { OPS, selectedMaterial, saveSetting, putMaterial, createMaterial, deleteMaterial, describeSetting, describeSource, today } from "./library.js";
import { showTestView, hideTestView } from "./testgrid.js";

const panel = document.getElementById("tab-design");
let builtFor = "";
let view = "layers"; // or "test": the material test takes over the tab while it's open

const material = () => selectedMaterial();
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
  const tested = preset.source === "test" || preset.source === "saved";
  toast(`${layer.name}: ${op} settings for ${material().name}.${tested ? "" : " These are untested starting points; try them on scrap first."}`);
}

async function saveLayerAs(layer, op) {
  const setting = { mode: layer.mode, speed: layer.speed, power: layer.power, passes: layer.passes, source: "saved" };
  if (layer.mode === "fill") setting.interval = layer.interval;
  const saved = await saveSetting(op, setting);
  toast(`Saved ${layer.name}'s settings as the ${op} setting for "${saved.name}".`);
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
  const title = (word) => word[0].toUpperCase() + word.slice(1);
  const presets = mat &&
    h("select", {
      "aria-label": "Presets",
      onchange: act(async (event) => {
        const [what, op] = event.target.value.split(":");
        event.target.value = "";
        if (what === "use") applyPreset(layer, op);
        else if (what === "save") await saveLayerAs(layer, op);
      }),
    },
      h("option", { value: "" }, "Presets…"),
      h("optgroup", { label: `Use from ${mat.name}` },
        OPS.map(([op]) => h("option", { value: `use:${op}`, disabled: !mat[op] }, mat[op] ? title(op) : `${title(op)} (none saved)`))),
      h("optgroup", { label: "Save this layer as" },
        OPS.filter(([, , mode]) => mode === layer.mode).map(([op]) => h("option", { value: `save:${op}` }, `${title(op)} setting`))),
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

// --- material ------------------------------------------------------------------

/** New or edit: name, notes and the three settings, typed by hand. */
async function materialDialog(existing) {
  const name = h("input", { type: "text", value: existing?.name || "", maxlength: 60, required: true, placeholder: "e.g. Birch ply 3 mm" });
  const notes = h("textarea", { rows: 2, maxlength: 500, value: existing?.notes || "", placeholder: "Supplier, thickness, anything worth remembering" });
  const inputs = {};
  const rows = OPS.map(([op, label, mode]) => {
    const s = existing?.[op];
    const field = (key, unit, attrs) => (inputs[`${op}.${key}`] = h("input", { type: "number", value: s?.[key] ?? "", "aria-label": `${label} ${unit}`, ...attrs }));
    return h("div", { class: "setting-row" },
      h("span", {}, label),
      field("speed", "mm/min", { min: 10, max: 60000, step: 10 }),
      field("power", "%", { min: 0, max: 100, step: 1 }),
      field("passes", "passes", { min: 1, max: 50, step: 1 }),
      mode === "fill" ? field("interval", "gap mm", { min: 0.03, max: 2, step: 0.01 }) : h("span"));
  });
  const answer = await modal((form) => {
    fill(form,
      h("h1", {}, existing ? "Edit material" : "New material"),
      h("label", { class: "field" }, "Name", name),
      h("label", { class: "field" }, "Notes", notes),
      h("div", { class: "field" }, "Settings (leave speed empty for none)",
        h("div", { class: "setting-row head", "aria-hidden": "true" }, h("span"), h("span", {}, "mm/min"), h("span", {}, "Power %"), h("span", {}, "Passes"), h("span", {}, "Gap mm")),
        rows),
      h("div", { class: "actions" },
        h("button", { class: "btn", value: "", formnovalidate: true }, "Cancel"),
        h("button", { class: "btn primary", value: "ok" }, existing ? "Save material" : "Add material")),
    );
    setTimeout(() => name.focus());
  });
  if (answer !== "ok" || !name.value.trim()) return;
  const settings = {};
  for (const [op, , mode] of OPS) {
    const speed = parseFloat(inputs[`${op}.speed`].value);
    if (!(speed > 0)) {
      settings[op] = null;
      continue;
    }
    const before = existing?.[op];
    const next = {
      mode,
      speed,
      power: Math.min(100, Math.max(0, parseFloat(inputs[`${op}.power`].value) || 0)),
      passes: Math.min(50, Math.max(1, Math.round(parseFloat(inputs[`${op}.passes`].value) || 1))),
    };
    if (mode === "fill") next.interval = Math.min(2, Math.max(0.03, parseFloat(inputs[`${op}.interval`].value) || 0.1));
    const same = before && ["speed", "power", "passes", "interval"].every((key) => (before[key] ?? null) === (next[key] ?? null));
    // Untouched numbers keep their history; edited ones become "saved today".
    settings[op] = same ? before : { ...next, source: "saved", date: today() };
  }
  if (existing) {
    await putMaterial({ ...existing, name: name.value, notes: notes.value, ...settings });
    toast("Material saved.");
  } else {
    const created = await createMaterial(name.value.trim(), notes.value);
    if (Object.values(settings).some(Boolean)) await putMaterial({ ...created, ...settings });
    toast(`Added "${name.value.trim()}" to your materials.`);
  }
}

async function removeMaterial(mat) {
  const answer = await modal((form) => {
    fill(form,
      h("h1", {}, `Delete "${mat.name}"?`),
      h("p", { class: "note" }, "Its saved settings go with it. This can't be undone."),
      h("div", { class: "actions" },
        h("button", { class: "btn", value: "", autofocus: true }, "Keep it"),
        h("button", { class: "btn stop", value: "delete" }, "Delete material")),
    );
  });
  if (answer !== "delete") return;
  await deleteMaterial(mat.id);
  toast(`Deleted "${mat.name}".`);
}

function materialSection() {
  const mat = material();
  const mine = state.materials.filter((m) => m.mine);
  const option = (m) => h("option", { value: m.id, selected: m.id === state.ui.materialId }, m.name);
  return h("section", {},
    h("label", { class: "field" }, "Material",
      h("select", {
        id: "material",
        onchange: (event) => {
          state.ui.materialId = event.target.value;
          saveUi();
        },
      },
        h("option", { value: "" }, "Not chosen"),
        mine.length ? h("optgroup", { label: "Your materials" }, mine.map(option)) : null,
        h("optgroup", { label: "Starting points" }, state.builtin.map(option)),
      )),
    mat && h("dl", { class: "settings-list" },
      OPS.flatMap(([op, label]) => [
        h("dt", {}, label),
        h("dd", {}, mat[op] ? [describeSetting(mat[op]), h("span", { class: `source ${mat[op].source || "starting"}` }, describeSource(mat[op]))] : h("span", { class: "source" }, mat.mine ? "nothing saved" : "not possible")),
      ])),
    mat?.notes && h("p", { class: "note", style: "margin-top:8px" }, mat.notes),
    h("div", { class: "row wrap", style: "margin-top:10px" },
      h("button", {
        type: "button", class: "btn small",
        onclick: () => {
          view = "test";
          render();
        },
      }, "Test grid"),
      h("button", { type: "button", class: "btn small", onclick: act(() => materialDialog()) }, "New material"),
      mat?.mine && h("button", { type: "button", class: "btn small", onclick: act(() => materialDialog(material())) }, "Edit"),
      mat?.mine && h("button", { type: "button", class: "btn small ghost", onclick: act(() => removeMaterial(material())) }, "Delete"),
    ),
  );
}

function build() {
  fill(panel,
    materialSection(),
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
  if (view === "test") {
    // The test view looks after itself once it's showing.
    if (builtFor !== "test") {
      builtFor = "test";
      showTestView(panel, () => {
        view = "layers";
        hideTestView();
        render();
      });
    }
    return;
  }
  // Rebuild only when the structure changes; otherwise just refresh values,
  // so typing in a field never loses focus.
  const picked = new Set(selected().map((o) => o.layerId));
  const key = JSON.stringify([
    state.doc.layers.map((l) => [l.id, l.mode, l.imageMode, state.doc.objects.filter((o) => o.layerId === l.id).length, picked.has(l.id)]),
    state.ui.materialId, state.materials.map((m) => [m.id, m.name]), material(), state.machine.max_feed,
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
