// Turns what's on the canvas into a job for the server: line layers become
// polylines traced from the live SVG geometry, fill layers become a bitmap.

import { state, bed, layerById } from "./store.js";
import { artNode, stageNode, corners } from "./stage.js";
import { parsePath, flattenCommands, rectCommands, ellipseCommands, polyCommands } from "./flatten.js";

const GEOMETRY = "path, rect, circle, ellipse, line, polyline, polygon";
const NOT_DRAWN = "defs, clipPath, mask, pattern, marker, symbol";
const MAX_PIXELS = 60_000_000;

const mul = (m, n) => ({
  a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
});
const plain = (m) => ({ a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f });
const ownTransform = (node) => {
  const m = node.transform?.baseVal?.consolidate()?.matrix;
  return m ? plain(m) : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
};

function commandsFor(node) {
  const v = (name) => node[name]?.baseVal?.value ?? 0;
  switch (node.localName) {
    case "path": return parsePath(node.getAttribute("d") || "");
    case "rect": {
      // A single radius applies to both axes.
      const hasRx = node.hasAttribute("rx"), hasRy = node.hasAttribute("ry");
      const rx = hasRx ? v("rx") : hasRy ? v("ry") : 0;
      const ry = hasRy ? v("ry") : rx;
      return rectCommands(v("x"), v("y"), v("width"), v("height"), rx, ry);
    }
    case "circle": return ellipseCommands(v("cx"), v("cy"), v("r"), v("r"));
    case "ellipse": return ellipseCommands(v("cx"), v("cy"), v("rx"), v("ry"));
    case "line": return [["M", v("x1"), v("y1")], ["L", v("x2"), v("y2")]];
    case "polyline":
    case "polygon": return polyCommands([...node.points].map((p) => [p.x, p.y]), node.localName === "polygon");
    default: return [];
  }
}

const visible = (node) => (node.checkVisibility ? node.checkVisibility({ visibilityProperty: true }) : true);

/** Polylines (bed mm) for every outline in one design. Reports what it had to skip. */
export function traceObject(obj, skipped) {
  const art = artNode(obj.id);
  if (!art) return [];
  const toBed = stageNode().getScreenCTM().inverse();
  const matrixOf = (node) => plain(toBed.multiply(node.getScreenCTM()));
  const out = [];

  // <use> draws a copy of something defined elsewhere; follow it by hand.
  const traceCopy = (target, matrix, depth) => {
    if (depth > 6) return;
    const here = mul(matrix, ownTransform(target));
    if (target.matches(GEOMETRY)) out.push(...flattenCommands(commandsFor(target), here));
    else if (target.localName === "use") followUse(target, matrix, depth + 1);
    else for (const child of target.children) traceCopy(child, here, depth + 1);
  };
  const followUse = (use, parentMatrix, depth) => {
    const ref = (use.getAttribute("href") || "").slice(1);
    const target = ref && art.querySelector(`#${CSS.escape(ref)}`);
    if (!target) return;
    const x = use.x?.baseVal?.value || 0, y = use.y?.baseVal?.value || 0;
    const matrix = mul(mul(parentMatrix, ownTransform(use)), { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
    traceCopy(target, matrix, depth);
  };

  for (const node of art.querySelectorAll(`${GEOMETRY}, use, text, image`)) {
    if (node.closest(NOT_DRAWN) || !visible(node)) continue;
    if (node.localName === "text") skipped.text = true;
    else if (node.localName === "image") skipped.image = true;
    else if (node.localName === "use") followUse(node, plain(toBed.multiply(node.parentNode.getScreenCTM())), 0);
    else out.push(...flattenCommands(commandsFor(node), matrixOf(node)));
  }
  return out.map((path) => path.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]));
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The browser couldn't render a fill layer."));
    img.src = url;
  });
}

/** Render the designs of one fill layer to a bitmap covering just their extent. */
async function rasterize(layer, objects) {
  // Strokes spill past a shape's geometric box; leave room for them.
  const PAD = 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objects) {
    for (const [x, y] of corners(o)) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (state.ui.originMode === "absolute") {
    // Don't let the padding alone push a design that fits past the edge of the bed.
    const b = bed();
    x0 = Math.min(x0, Math.max(0, x0 - PAD)); y0 = Math.min(y0, Math.max(0, y0 - PAD));
    x1 = Math.max(x1, Math.min(b.w, x1 + PAD)); y1 = Math.max(y1, Math.min(b.h, y1 + PAD));
  } else {
    x0 -= PAD; y0 -= PAD; x1 += PAD; y1 += PAD;
  }
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const perMm = 1 / layer.interval;
  const pw = Math.max(1, Math.round(w * perMm)), ph = Math.max(1, Math.round(h * perMm));
  if (pw * ph > MAX_PIXELS) throw new Error(`"${layer.name}" is too detailed to render. Use a larger line interval or a smaller design.`);

  const serializer = new XMLSerializer();
  const parts = objects.map((o) => {
    const clone = artNode(o.id).parentNode.cloneNode(true);
    clone.querySelector(".hit")?.remove();
    clone.removeAttribute("class");
    clone.removeAttribute("style");
    return serializer.serializeToString(clone);
  });
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="${x0} ${y0} ${w} ${h}">${parts.join("")}</svg>`;
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, pw, ph);
    ctx.drawImage(img, 0, 0, pw, ph);
    return { x: +x0.toFixed(3), y: +y0.toFixed(3), w: +w.toFixed(3), h: +h.toFixed(3), png: canvas.toDataURL("image/png") };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Build the job the server turns into G-code. Returns { job, warnings }. */
export async function buildJob(name = "Job") {
  const warnings = [];
  const layers = [];
  for (const layer of state.doc.layers) {
    if (!layer.output) continue;
    const objects = state.doc.objects.filter((o) => o.layerId === layer.id);
    if (!objects.length) continue;
    const base = { id: layer.id, name: layer.name, mode: layer.mode, speed: layer.speed, power: layer.power, passes: layer.passes };
    if (layer.mode === "line") {
      const skipped = {};
      const polylines = objects.flatMap((o) => traceObject(o, skipped));
      if (skipped.text) warnings.push(`"${layer.name}" is a line layer, and text can't be traced as outlines yet. The text on it is skipped; move it to a fill layer to engrave it.`);
      if (skipped.image) warnings.push(`"${layer.name}" is a line layer, so the pictures on it are skipped. Move them to a fill layer to engrave them.`);
      if (polylines.length) layers.push({ ...base, polylines });
    } else {
      const raster = await rasterize(layer, objects);
      if (raster) {
        layers.push({ ...base, raster, interval: layer.interval, image_mode: layer.imageMode, threshold: layer.threshold, min_power: layer.minPower });
      }
    }
  }
  if (!layers.length) {
    throw new Error(state.doc.objects.length ? "Nothing to burn: every layer with a design on it has output switched off." : "Nothing to burn yet. Add a design to the bed first.");
  }
  return { job: { name, layers, origin_mode: state.ui.originMode, finish: state.ui.finish }, warnings };
}

export const layerName = (id) => layerById(id)?.name || "";
