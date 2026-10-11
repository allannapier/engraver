// Material test: burn a card of squares across a range of speed and power (or
// passes, for cutting), then pick the square that looks best and save it to
// the person's materials.
//
// The card is built here as an ordinary job, one layer per square, so the
// server needs nothing special: it burns from the origin like any other job.

import { state, on } from "./store.js";
import { h, fill, toast, act } from "./ui.js";
import { rasterizeMarkup } from "./job.js";
import { measureMarkup } from "./svgutil.js";
import { confirmAndStart, frame, machineReady } from "./run.js";
import { selectedMaterial, saveSetting, describeSetting } from "./library.js";

const STORAGE_KEY = "engraver.test.v1";
const GAP = 2; // mm between squares
const LABEL_FONT = "Helvetica, Arial, sans-serif";

const DEFAULTS = {
  op: "engrave",
  name: "",
  engrave: { speedFrom: 2000, speedTo: 6000, speedSteps: 5, powerFrom: 20, powerTo: 100, powerSteps: 5, passes: 1, interval: 0.1 },
  score: { speedFrom: 1000, speedTo: 5000, speedSteps: 5, powerFrom: 10, powerTo: 50, powerSteps: 5, passes: 1 },
  cut: { speedFrom: 100, speedTo: 500, speedSteps: 5, power: 100, passesTo: 3 },
  cell: 8,
  labels: true,
  labelSpeed: 3000,
  labelPower: 30,
  picked: null,
};

function load() {
  const base = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") {
      for (const key of Object.keys(base)) {
        if (saved[key] === undefined || saved[key] === null) continue;
        if (base[key] && typeof base[key] === "object") Object.assign(base[key], saved[key]);
        else if (typeof saved[key] === typeof base[key]) base[key] = saved[key];
      }
      if (saved.picked && Number.isInteger(saved.picked.r) && Number.isInteger(saved.picked.c)) base.picked = { r: saved.picked.r, c: saved.picked.c };
    }
  } catch {
    /* start from the defaults */
  }
  if (!DEFAULTS[base.op]) base.op = "engrave";
  return base;
}

export const test = load();
const remember = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(test));
  } catch {
    /* not worth interrupting anyone for */
  }
};

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** Evenly spaced values from `from` to `to`, rounded to `unit`, without repeats. */
export function spread(from, to, count, unit) {
  count = clamp(Math.round(count), 1, 8);
  const values = [];
  for (let i = 0; i < count; i += 1) {
    const raw = count === 1 ? from : from + ((to - from) * i) / (count - 1);
    const value = Math.round(raw / unit) * unit;
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * Lay the card out. Pure: no DOM. Coordinates are mm with the origin at the
 * card's top-left and Y pointing down; the server puts the front-left corner
 * of whatever burns at the machine's origin.
 */
export function gridSpec(t, maxFeed = 6000, materialName = "") {
  const p = t[t.op];
  const mode = t.op === "engrave" ? "fill" : "line";
  const cell = clamp(num(t.cell, 8), 6, 25);
  const speeds = spread(clamp(num(p.speedFrom, 1000), 10, maxFeed), clamp(num(p.speedTo, 3000), 10, maxFeed), num(p.speedSteps, 5), 10);
  let rows;
  if (t.op === "cut") {
    const power = clamp(num(p.power, 100), 1, 100);
    rows = Array.from({ length: clamp(Math.round(num(p.passesTo, 3)), 1, 6) }, (_, i) => ({ power, passes: i + 1, label: String(i + 1) }));
  } else {
    const passes = clamp(Math.round(num(p.passes, 1)), 1, 10);
    rows = spread(clamp(num(p.powerFrom, 20), 1, 100), clamp(num(p.powerTo, 100), 1, 100), num(p.powerSteps, 5), 1).map((power) => ({ power, passes, label: String(power) }));
  }
  const labels = Boolean(t.labels);
  const left = labels ? 10 : 0;
  const top = labels ? 13.5 : 0;
  const pitch = cell + GAP;
  const interval = mode === "fill" ? clamp(num(p.interval, 0.1), 0.03, 1) : undefined;

  const cells = [];
  rows.forEach((row, r) => {
    speeds.forEach((speed, c) => {
      cells.push({ r, c, x: left + c * pitch, y: top + r * pitch, size: cell, speed, power: row.power, passes: row.passes });
    });
  });

  const texts = [];
  if (labels) {
    const small = clamp(cell * 0.33, 2, 2.6);
    const down = t.op === "cut" ? "passes down" : "% down";
    const extra = t.op === "cut" ? ` at ${rows[0].power}%` : rows[0].passes > 1 ? `, ${rows[0].passes} passes` : "";
    const opName = { engrave: "Engrave", score: "Score", cut: "Cut" }[t.op];
    texts.push({ x: 0, y: 3.4, size: 3.4, anchor: "start", text: (materialName || "Material test").slice(0, 40) });
    texts.push({ x: 0, y: 7.8, size: 2.4, anchor: "start", text: `${opName}${extra}: mm/min across, ${down}` });
    speeds.forEach((speed, c) => texts.push({ x: left + c * pitch + cell / 2, y: top - 1.3, size: small, anchor: "middle", text: String(speed) }));
    rows.forEach((row, r) => texts.push({ x: left - 1.6, y: top + r * pitch + cell / 2 + small * 0.36, size: small, anchor: "end", text: row.label }));
  }
  return {
    op: t.op, mode, cell, speeds, rows, cells, texts, interval,
    width: left + speeds.length * pitch - GAP,
    height: top + rows.length * pitch - GAP,
  };
}

const escapeXml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const textMarkup = (texts, color = "#000") =>
  texts.map((t) => `<text x="${t.x}" y="${t.y}" font-family="${LABEL_FONT}" font-weight="700" font-size="${t.size}" text-anchor="${t.anchor}" fill="${color}">${escapeXml(t.text)}</text>`).join("");

/** The area the card covers, including label text that runs wider than the squares. */
function footprint(spec) {
  let x0 = 0, y0 = 0, x1 = spec.width, y1 = spec.height;
  let labelBox = null;
  if (spec.texts.length) {
    const box = measureMarkup(textMarkup(spec.texts));
    if (box) {
      const pad = 0.4;
      labelBox = { x: box[0] - pad, y: box[1] - pad, w: box[2] + pad * 2, h: box[3] + pad * 2 };
      x0 = Math.min(x0, labelBox.x); y0 = Math.min(y0, labelBox.y);
      x1 = Math.max(x1, labelBox.x + labelBox.w); y1 = Math.max(y1, labelBox.y + labelBox.h);
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, labelBox };
}

let blackPng = null;
function solidBlack() {
  if (!blackPng) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 4, 4);
    blackPng = canvas.toDataURL("image/png");
  }
  return blackPng;
}

const cellName = (cell) => `${cell.speed} mm/min, ${cell.power}%${cell.passes > 1 ? `, ${cell.passes} passes` : ""}`;

/** The card as a job: labels first, then one layer per square. */
export async function buildTestJob(spec) {
  const layers = [];
  const area = footprint(spec);
  if (area.labelBox) {
    const raster = await rasterizeMarkup(textMarkup(spec.texts), area.labelBox, 10, "Labels");
    layers.push({ name: "Labels", mode: "fill", speed: clamp(num(test.labelSpeed, 3000), 10, state.machine.max_feed || 6000), power: clamp(num(test.labelPower, 30), 1, 100), passes: 1, interval: 0.1, image_mode: "threshold", raster });
  }
  for (const cell of spec.cells) {
    const base = { name: cellName(cell), mode: spec.mode, speed: cell.speed, power: cell.power, passes: cell.passes };
    if (spec.mode === "fill") {
      layers.push({ ...base, interval: spec.interval, image_mode: "threshold", raster: { x: cell.x, y: cell.y, w: cell.size, h: cell.size, png: solidBlack() } });
    } else {
      const { x, y, size } = cell;
      layers.push({ ...base, polylines: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });
    }
  }
  return { name: "Material test", layers, origin_mode: "origin", finish: state.ui.finish };
}

// --- view --------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
let mounted = null; // { refresh, syncButtons } while the test view is showing

function settingFor(spec, picked) {
  const cell = picked && spec.cells.find((c) => c.r === picked.r && c.c === picked.c);
  if (!cell) return null;
  const setting = { mode: spec.mode, speed: cell.speed, power: cell.power, passes: cell.passes, source: "test" };
  if (spec.mode === "fill") setting.interval = spec.interval;
  return setting;
}

function previewSvg(spec, onPick) {
  const area = footprint(spec);
  const pad = 2;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "test-preview");
  svg.setAttribute("viewBox", `${area.x - pad} ${area.y - pad} ${area.w + pad * 2} ${area.h + pad * 2}`);
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Test card. Choose the square that came out best.");
  // Darker where more energy lands: a rough guide to what to expect, not a prediction.
  const energy = (cell) => (cell.power * cell.passes) / cell.speed;
  const most = Math.max(...spec.cells.map(energy));
  let markup = `<rect x="${area.x - pad}" y="${area.y - pad}" width="${area.w + pad * 2}" height="${area.h + pad * 2}" fill="#e8dcc2"/>${textMarkup(spec.texts, "#4a2f14")}`;
  for (const cell of spec.cells) {
    const strength = (0.18 + 0.82 * (energy(cell) / most)).toFixed(2);
    const chosen = test.picked && test.picked.r === cell.r && test.picked.c === cell.c;
    const paint = spec.mode === "fill" ? `fill="#2a1a10" fill-opacity="${strength}"` : `fill="#2a1a10" fill-opacity="0" stroke="#2a1a10" stroke-opacity="${strength}" stroke-width="0.5"`;
    markup += `<rect class="test-cell${chosen ? " chosen" : ""}" data-r="${cell.r}" data-c="${cell.c}" x="${cell.x}" y="${cell.y}" width="${cell.size}" height="${cell.size}" ${paint} tabindex="0" role="button" aria-pressed="${chosen}" aria-label="${escapeXml(cellName(cell))}"><title>${escapeXml(cellName(cell))}</title></rect>`;
  }
  svg.innerHTML = markup;
  const pick = (event) => {
    const target = event.target.closest(".test-cell");
    if (target) onPick({ r: Number(target.dataset.r), c: Number(target.dataset.c) });
  };
  svg.addEventListener("click", pick);
  svg.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    pick(event);
  });
  return { svg, area };
}

/** Fill `panel` with the test view. `back` returns to the layer list. */
export function showTestView(panel, back) {
  const maxFeed = () => state.machine.max_feed || 6000;
  const preview = h("div", { class: "test-preview-wrap" });
  const size = h("p", { class: "note" });
  const pickedLine = h("p", { class: "note" });
  const target = h("div");
  const frameButton = h("button", { type: "button", class: "btn" }, "Frame test");
  const burnButton = h("button", { type: "button", class: "btn primary" }, "Burn test");
  const saveButton = h("button", { type: "button", class: "btn" }, "Save");
  const nameInput = h("input", { type: "text", maxlength: 60, placeholder: "e.g. Birch ply 3 mm", value: test.name });
  nameInput.addEventListener("input", () => {
    test.name = nameInput.value;
    remember();
    refresh();
  });

  const cardName = () => selectedMaterial()?.name || test.name.trim();
  const current = () => gridSpec(test, maxFeed(), cardName());

  function refresh() {
    const spec = current();
    // A pick only means something for the grid it was made on.
    if (test.picked && !spec.cells.some((c) => c.r === test.picked.r && c.c === test.picked.c)) test.picked = null;
    const { svg, area } = previewSvg(spec, (cell) => {
      test.picked = cell;
      remember();
      refresh();
      preview.querySelector(".test-cell.chosen")?.focus();
    });
    preview.replaceChildren(svg);
    size.textContent = `The card needs ${Math.ceil(area.w)} × ${Math.ceil(area.h)} mm of scrap. Its front-left corner goes at the origin: jog there and set the origin in the Laser tab first.`;

    const mat = selectedMaterial();
    const opName = { engrave: "engrave", score: "score", cut: "cut" }[spec.op];
    // Rebuilt only when the material changes, so typing a name isn't interrupted.
    const targetKey = mat ? `${mat.id}|${mat.name}` : "";
    if (target.dataset.key !== targetKey || !target.firstChild) {
      target.dataset.key = targetKey;
      fill(target,
        mat
          ? h("p", { class: "note" }, mat.mine ? `Results are saved to "${mat.name}".` : `Results are saved to your own copy of "${mat.name}".`)
          : h("label", { class: "field" }, "Material name", nameInput));
    }
    const setting = settingFor(spec, test.picked);
    pickedLine.textContent = setting
      ? `Picked: ${describeSetting(setting)}.`
      : "After it has burned, click the square that looks best.";
    saveButton.textContent = `Save as the ${opName} setting`;
    saveButton.disabled = !setting || !cardName();
    syncButtons();
  }

  function syncButtons() {
    const ready = machineReady();
    frameButton.disabled = !ready;
    burnButton.disabled = !ready;
  }

  const describeRun = (spec) => {
    const s = spec.speeds, first = spec.rows[0], last = spec.rows[spec.rows.length - 1];
    const down = spec.op === "cut" ? `1 to ${last.passes} passes at ${first.power}%` : `${first.power} to ${last.power}%`;
    const lines = [`${spec.cells.length} squares: ${s[0]} to ${s[s.length - 1]} mm/min, ${down}`];
    if (spec.texts.length) lines.push(`Labels: ${test.labelSpeed} mm/min, ${test.labelPower}%`);
    return lines;
  };

  frameButton.addEventListener("click", act(async () => {
    frameButton.disabled = true;
    try {
      await frame(await buildTestJob(current()));
    } finally {
      syncButtons();
    }
  }));
  burnButton.addEventListener("click", act(async () => {
    burnButton.disabled = true;
    try {
      const spec = current();
      await confirmAndStart(await buildTestJob(spec), [], { lines: describeRun(spec), startsFrom: "the origin (the card's front-left corner)" });
    } finally {
      syncButtons();
    }
  }));
  saveButton.addEventListener("click", act(async () => {
    const spec = current();
    const setting = settingFor(spec, test.picked);
    if (!setting) return;
    const material = await saveSetting(spec.op, setting, test.name);
    toast(`Saved to "${material.name}". Use it from a layer's Presets menu.`);
    refresh();
  }));

  // One number box bound to a value in `test`. Changing it redraws the card but
  // leaves the other boxes alone, so tabbing through the form keeps working.
  const box = (label, object, key, { min, max, step = 1 }) => {
    const input = h("input", { type: "number", min, max, step, value: object[key] });
    input.addEventListener("change", () => {
      const value = clamp(num(input.value, object[key]), min, max);
      object[key] = step >= 1 ? Math.round(value) : value;
      input.value = object[key];
      remember();
      refresh();
    });
    return h("label", { class: "field" }, label, input);
  };

  function ranges() {
    const p = test[test.op];
    const speedMax = maxFeed();
    const rows = [
      h("div", { class: "grid3" },
        box("Speed from", p, "speedFrom", { min: 10, max: speedMax, step: 10 }),
        box("to (mm/min)", p, "speedTo", { min: 10, max: speedMax, step: 10 }),
        box("Steps", p, "speedSteps", { min: 1, max: 8 })),
    ];
    if (test.op === "cut") {
      rows.push(h("div", { class: "grid3" },
        box("Power (%)", p, "power", { min: 1, max: 100 }),
        box("Passes up to", p, "passesTo", { min: 1, max: 6 }),
        box("Square (mm)", test, "cell", { min: 6, max: 25 })));
    } else {
      rows.push(h("div", { class: "grid3" },
        box("Power from", p, "powerFrom", { min: 1, max: 100 }),
        box("to (%)", p, "powerTo", { min: 1, max: 100 }),
        box("Steps", p, "powerSteps", { min: 1, max: 8 })));
      rows.push(h("div", { class: "grid3" },
        box("Passes", p, "passes", { min: 1, max: 10 }),
        test.op === "engrave" ? box("Line gap (mm)", p, "interval", { min: 0.03, max: 1, step: 0.01 }) : h("span"),
        box("Square (mm)", test, "cell", { min: 6, max: 25 })));
    }
    return rows;
  }

  const opButton = (op, label, title) =>
    h("button", {
      type: "button", "aria-pressed": String(test.op === op), title,
      onclick: () => {
        if (test.op === op) return;
        test.op = op;
        test.picked = null;
        remember();
        build();
      },
    }, label);

  function build() {
    const labelsOn = h("input", { type: "checkbox", checked: test.labels });
    labelsOn.addEventListener("change", () => {
      test.labels = labelsOn.checked;
      remember();
      build();
    });
    fill(panel,
      h("section", {},
        h("button", { type: "button", class: "btn small ghost back", onclick: back }, "Back to layers"),
        h("h2", { style: "margin-top:10px" }, "Material test"),
        h("p", { class: "note" }, "Burns a card of small squares on scrap, each at a different setting, so you can see what this material needs on your machine."),
      ),
      h("section", {},
        target,
        h("div", { class: "field", style: "margin-top:10px" }, "Test for",
          h("div", { class: "seg" },
            opButton("engrave", "Engrave", "Filled squares: find the shade you want"),
            opButton("score", "Score", "Outlined squares: find a clean surface line"),
            opButton("cut", "Cut", "Outlined squares: the ones that drop out are cut through"))),
        h("div", { style: "display:grid;gap:10px;margin-top:10px" }, ranges()),
        h("label", { class: "check", style: "margin-top:12px" }, labelsOn, "Engrave the values on the card"),
        test.labels && h("div", { class: "grid3", style: "margin-top:8px" },
          box("Label speed", test, "labelSpeed", { min: 10, max: maxFeed(), step: 10 }),
          box("Label power (%)", test, "labelPower", { min: 1, max: 100 }),
          h("span")),
      ),
      h("section", {},
        preview,
        size,
        h("div", { class: "row", style: "margin-top:10px" }, frameButton, burnButton),
      ),
      h("section", {},
        h("h2", {}, "Keep the best result"),
        pickedLine,
        h("div", { class: "row", style: "margin-top:10px" }, saveButton),
      ),
    );
    refresh();
  }

  mounted = { refresh, syncButtons };
  build();
}

export function hideTestView() {
  mounted = null;
}

on("status", () => mounted?.syncButtons());
on("config", () => mounted?.refresh());
on("ui", () => mounted?.refresh());
