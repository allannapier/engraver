// The canvas: draws the bed and the designs on it, and handles selecting,
// moving, resizing, rotating, panning and zooming. One unit is one millimetre.

import { state, on, bed, commit, touch, select, selected, layerById, objectById } from "./store.js";
import { el, scopeIds } from "./svgutil.js";

const stage = document.getElementById("stage");
const bedLayer = el("g", {}, stage);
const photoNode = el("image", { class: "bed-photo", x: 0, y: 0, preserveAspectRatio: "none" });
let photo = null; // { url, at } shown on the bed, or null
const objectLayer = el("g", {}, stage);
const overlay = el("g", {}, stage);
const nodes = new Map(); // object id -> { g, art, hit, svg }
const view = { x: 0, y: 0, w: 100, h: 100 };

// --- geometry ------------------------------------------------------------------

export function corners(o) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const r = (o.rot * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const px = (sx * o.w) / 2, py = (sy * o.h) / 2;
    return [cx + px * cos - py * sin, cy + px * sin + py * cos];
  });
}

export function aabb(objects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objects) {
    for (const [x, y] of corners(o)) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return x0 > x1 ? null : { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function clientToMm(event) {
  const m = stage.getScreenCTM().inverse();
  return { x: m.a * event.clientX + m.c * event.clientY + m.e, y: m.b * event.clientX + m.d * event.clientY + m.f };
}

/** Millimetres per screen pixel at the current zoom. */
const unitsPerPx = () => {
  const ctm = stage.getScreenCTM();
  return ctm && ctm.a ? 1 / ctm.a : 1;
};

/** Designs that will actually be burned: on a layer with output on. */
export const outputObjects = () => state.doc.objects.filter((o) => layerById(o.layerId)?.output);

// --- view ----------------------------------------------------------------------

function applyView() {
  stage.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  drawOverlay();
  const upp = unitsPerPx();
  for (const label of bedLayer.querySelectorAll(".ruler")) label.setAttribute("font-size", 11 * upp);
}

export function fitView() {
  const b = bed();
  const pad = Math.max(b.w, b.h) * 0.07;
  Object.assign(view, { x: -pad * 1.4, y: -pad, w: b.w + pad * 2.4, h: b.h + pad * 2.4 });
  applyView();
}

export function zoomBy(factor, about) {
  const w = Math.min(Math.max(view.w / factor, 4), 4000);
  const k = w / view.w;
  const p = about || { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  view.x = p.x - (p.x - view.x) * k;
  view.y = p.y - (p.y - view.y) * k;
  view.w = w;
  view.h *= k;
  applyView();
}

export const viewCenter = () => {
  const b = bed();
  const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
  // If the middle of the view is off the bed, new things go to the middle of the bed.
  return cx > 0 && cx < b.w && cy > 0 && cy < b.h ? { x: cx, y: cy } : { x: b.w / 2, y: b.h / 2 };
};

// --- bed -----------------------------------------------------------------------

function drawBed() {
  const b = bed();
  bedLayer.innerHTML = "";
  el("rect", { class: "bed", x: 0, y: 0, width: b.w, height: b.h }, bedLayer);
  photoNode.setAttribute("width", b.w);
  photoNode.setAttribute("height", b.h);
  bedLayer.append(photoNode);
  drawPhoto();
  let minor = "", major = "";
  // Grid is measured from the front-left corner, the machine's origin.
  for (let x = 0; x <= b.w + 0.001; x += 10) {
    const line = `M${x} 0V${b.h}`;
    if (x % 50 === 0) major += line; else minor += line;
  }
  for (let y = 0; y <= b.h + 0.001; y += 10) {
    const line = `M0 ${b.h - y}H${b.w}`;
    if (y % 50 === 0) major += line; else minor += line;
  }
  el("path", { class: "grid-minor", d: minor, fill: "none", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }, bedLayer);
  el("path", { class: "grid-major", d: major, fill: "none", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }, bedLayer);
  for (let x = 0; x <= b.w; x += 50) {
    el("text", { class: "ruler", x, y: b.h, dy: "1.4em", "text-anchor": "middle" }, bedLayer).textContent = x;
  }
  for (let y = 50; y <= b.h; y += 50) {
    el("text", { class: "ruler", x: 0, y: b.h - y, dx: "-0.6em", dy: "0.35em", "text-anchor": "end" }, bedLayer).textContent = y;
  }
}

function drawPhoto() {
  if (photo) photoNode.setAttribute("href", photo.url);
  else photoNode.removeAttribute("href");
  photoNode.style.display = photo ? "" : "none";
  stage.classList.toggle("has-photo", !!photo);
}

/** Show a camera photo of the bed (a data URL covering the whole bed) under the grid, or null to hide it. */
export function showPhoto(next) {
  photo = next && next.url ? next : null;
  drawPhoto();
}
export const shownPhoto = () => photo;

// --- objects -------------------------------------------------------------------

const transformOf = (o) => `translate(${o.x + o.w / 2} ${o.y + o.h / 2}) rotate(${o.rot}) translate(${-o.w / 2} ${-o.h / 2})`;

/**
 * A picture on a threshold layer with its own cut-off is shown (and rasterised) as the black and white it will burn as:
 * a luminance filter on the artwork, with the filter's defs inside the node so a serialised copy carries them.
 */
function showCutoff(node, o, layer) {
  const on = o.kind === "image" && o.cutoff && layer?.mode === "fill" && layer.imageMode === "threshold";
  node.art.querySelector(":scope > defs.cutoff")?.remove();
  if (!on) return node.art.removeAttribute("filter");
  const id = `cut-${o.id}`;
  const defs = el("defs", { class: "cutoff" }, node.art);
  const filter = el("filter", { id, x: 0, y: 0, width: 1, height: 1, "color-interpolation-filters": "sRGB" }, defs);
  el("feColorMatrix", { type: "matrix", values: "0.299 0.587 0.114 0 0 0.299 0.587 0.114 0 0 0.299 0.587 0.114 0 0 0 0 0 1 0" }, filter);
  const table = el("feComponentTransfer", {}, filter);
  // Steep ramp: black below the cut-off, white above it, like the server's `pixel < threshold`.
  for (const channel of ["R", "G", "B"]) el(`feFunc${channel}`, { type: "linear", slope: 1000, intercept: (-1000 * (o.cutoff - 0.5)) / 255 }, table);
  node.art.setAttribute("filter", `url(#${id})`);
}

function drawObjects() {
  const seen = new Set();
  let previous = null;
  for (const o of state.doc.objects) {
    seen.add(o.id);
    let node = nodes.get(o.id);
    if (!node) {
      const g = el("g", { class: "obj", "data-id": o.id });
      const art = el("svg", { class: "art", x: 0, y: 0, preserveAspectRatio: "none", overflow: "visible" }, g);
      const hit = el("rect", { class: "hit", x: 0, y: 0 }, g);
      node = { g, art, hit, svg: null };
      nodes.set(o.id, node);
    }
    if (node.svg !== o.svg) {
      node.art.innerHTML = o.svg;
      scopeIds(node.art, o.id);
      node.svg = o.svg;
    }
    const layer = layerById(o.layerId);
    showCutoff(node, o, layer);
    node.g.setAttribute("class", `obj mode-${layer?.mode || "line"}${layer?.output ? "" : " off"}`);
    node.g.style.setProperty("--layer", layer?.color || "#000");
    node.g.setAttribute("transform", transformOf(o));
    node.art.setAttribute("viewBox", o.vb.join(" "));
    node.art.setAttribute("width", o.w);
    node.art.setAttribute("height", o.h);
    node.hit.setAttribute("width", o.w);
    node.hit.setAttribute("height", o.h);
    // Keep DOM order in step with the document order (later = on top).
    const expected = previous ? previous.nextSibling : objectLayer.firstChild;
    if (node.g !== expected) objectLayer.insertBefore(node.g, expected);
    previous = node.g;
  }
  for (const [id, node] of nodes) {
    if (!seen.has(id)) {
      node.g.remove();
      nodes.delete(id);
    }
  }
}

/** The live DOM node of a design's artwork (used to trace and rasterise it). */
export const artNode = (id) => nodes.get(id)?.art;
export const stageNode = () => stage;

// --- overlay -------------------------------------------------------------------

const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const CURSORS = ["nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "nwse-resize", "ns-resize", "nesw-resize", "ew-resize"];
let marquee = null;

function drawOverlay() {
  overlay.innerHTML = "";
  const upp = unitsPerPx();
  const b = bed();

  // The active material area.
  const area = state.config.areas?.find((a) => a.id === state.ui.areaId) || state.config.areas?.[0];
  if (area) {
    el("rect", { class: "material-area", x: area.x, y: b.h - area.y - area.h, width: area.w, height: area.h }, overlay);
    el("text", { class: "material-label", x: area.x, y: b.h - area.y - area.h, dy: "-0.4em", "font-size": 11 * upp }, overlay).textContent = area.name;
  }

  // Outline of the whole job, with its size: what Frame will trace.
  const job = aabb(outputObjects());
  if (job) {
    el("rect", { class: "job-frame", x: job.x0, y: job.y0, width: job.w, height: job.h }, overlay);
    const label = el("text", { class: "job-label", x: job.x0, y: job.y1, dy: "1.3em", "font-size": 11 * upp }, overlay);
    label.textContent = `${job.w.toFixed(1)} × ${job.h.toFixed(1)} mm`;
    if (state.ui.originMode === "origin") {
      const s = 9 * upp;
      el("path", { class: "origin-mark", d: `M${job.x0 - s} ${job.y1}H${job.x0 + s}M${job.x0} ${job.y1 - s}V${job.y1 + s}` }, overlay);
      el("circle", { class: "origin-mark", cx: job.x0, cy: job.y1, r: s * 0.55 }, overlay);
    }
  }

  // Where the laser head is. In "from origin" mode work zero is the job's front-left corner.
  if (state.status.connected) {
    const [wx, wy] = state.status.wpos;
    const zero = state.ui.originMode === "origin" && job ? { x: job.x0, y: job.y1 } : { x: 0, y: b.h };
    const live = state.status.state === "Run" && state.status.power > 0;
    const g = el("g", { class: `head${live ? " live" : ""}`, transform: `translate(${zero.x + wx} ${zero.y - wy})` }, overlay);
    const r = 7 * upp;
    el("circle", { r }, g);
    el("path", { d: `M${-r * 1.9} 0H${-r * 0.4}M${r * 0.4} 0H${r * 1.9}M0 ${-r * 1.9}V${-r * 0.4}M0 ${r * 0.4}V${r * 1.9}` }, g);
  }

  const picked = selected();
  if (picked.length === 1) {
    const o = picked[0];
    const g = el("g", { transform: transformOf(o) }, overlay);
    el("rect", { class: "sel-box", x: 0, y: 0, width: o.w, height: o.h }, g);
    const stem = 22 * upp;
    el("line", { class: "rot-stem", x1: o.w / 2, y1: 0, x2: o.w / 2, y2: -stem }, g);
    el("circle", { class: "handle rot", cx: o.w / 2, cy: -stem, r: 5 * upp, "data-handle": "rot" }, g);
    const s = 8 * upp;
    HANDLES.forEach(([hx, hy], i) => {
      const node = el("rect", { class: "handle", x: ((hx + 1) / 2) * o.w - s / 2, y: ((hy + 1) / 2) * o.h - s / 2, width: s, height: s, "data-handle": i }, g);
      // Cursor follows the handle as the object rotates.
      node.style.cursor = CURSORS[(i + Math.round(o.rot / 45) + 8 * 100) % 8];
    });
  } else if (picked.length > 1) {
    const box = aabb(picked);
    el("rect", { class: "sel-box", x: box.x0, y: box.y0, width: box.w, height: box.h }, overlay);
  }
  if (marquee) {
    el("rect", { class: "marquee", x: Math.min(marquee.x0, marquee.x1), y: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }, overlay);
  }
}

// --- interaction ---------------------------------------------------------------

let drag = null;
let spaceDown = false;
const MIN_SIZE = 0.2;

function startResize(o, index, point, event) {
  const [hx, hy] = HANDLES[index];
  drag = { kind: "resize", o, hx, hy, start: { ...o }, moved: false, id: event.pointerId };
}

function resize(point, event) {
  const { o, hx, hy, start } = drag;
  const r = (start.rot * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const cx = start.x + start.w / 2, cy = start.y + start.h / 2;
  // Pointer in the object's own (unrotated) frame, relative to its centre.
  const dx = point.x - cx, dy = point.y - cy;
  const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
  // The opposite handle stays where it is.
  const ax = (-hx * start.w) / 2, ay = (-hy * start.h) / 2;
  let w = hx ? Math.max(MIN_SIZE, (lx - ax) * hx) : start.w;
  let h = hy ? Math.max(MIN_SIZE, (ly - ay) * hy) : start.h;
  const corner = hx !== 0 && hy !== 0;
  // Corners keep proportions unless Shift is held or the lock is off.
  if (corner && state.ui.lockAspect !== event.shiftKey) {
    const k = Math.max(w / start.w, h / start.h);
    w = start.w * k; h = start.h * k;
  }
  const ncx = ax + (hx * w) / 2, ncy = ay + (hy * h) / 2;
  const wx = cx + ncx * cos - ncy * sin, wy = cy + ncx * sin + ncy * cos;
  Object.assign(o, { w, h, x: wx - w / 2, y: wy - h / 2 });
}

function rotate(point, event) {
  const { o } = drag;
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  let deg = (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI + 90;
  if (event.shiftKey) deg = Math.round(deg / 15) * 15;
  o.rot = +(((deg % 360) + 360) % 360).toFixed(2);
}

stage.addEventListener("pointerdown", (event) => {
  stage.focus({ preventScroll: true });
  const point = clientToMm(event);
  if (event.button === 1 || (event.button === 0 && spaceDown)) {
    drag = { kind: "pan", cx: event.clientX, cy: event.clientY, vx: view.x, vy: view.y, upp: unitsPerPx() };
    stage.classList.add("panning");
  } else if (event.button !== 0) {
    return;
  } else if (event.target.dataset.handle !== undefined) {
    const o = selected()[0];
    if (event.target.dataset.handle === "rot") drag = { kind: "rotate", o, moved: false };
    else startResize(o, Number(event.target.dataset.handle), point, event);
  } else {
    const hit = event.target.closest(".obj");
    if (hit) {
      const id = hit.dataset.id;
      if (event.shiftKey) {
        if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id);
        select([...state.selection]);
      } else if (!state.selection.has(id)) {
        select([id]);
      }
      const moving = selected();
      if (moving.length) drag = { kind: "move", from: point, items: moving.map((o) => ({ o, x: o.x, y: o.y })), moved: false };
    } else {
      if (!event.shiftKey) select([]);
      marquee = { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
      drag = { kind: "marquee", keep: new Set(state.selection) };
    }
  }
  if (drag) {
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
});

stage.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const point = clientToMm(event);
  if (drag.kind === "pan") {
    view.x = drag.vx - (event.clientX - drag.cx) * drag.upp;
    view.y = drag.vy - (event.clientY - drag.cy) * drag.upp;
    applyView();
  } else if (drag.kind === "move") {
    const dx = point.x - drag.from.x, dy = point.y - drag.from.y;
    if (!drag.moved && Math.hypot(dx, dy) < 2 * unitsPerPx()) return; // ignore click jitter
    drag.moved = true;
    for (const item of drag.items) Object.assign(item.o, { x: item.x + dx, y: item.y + dy });
    touch();
  } else if (drag.kind === "resize") {
    drag.moved = true;
    resize(point, event);
    touch();
  } else if (drag.kind === "rotate") {
    drag.moved = true;
    rotate(point, event);
    touch();
  } else if (drag.kind === "marquee") {
    marquee.x1 = point.x; marquee.y1 = point.y;
    const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
    const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
    const inside = state.doc.objects.filter((o) => {
      const box = aabb([o]);
      return box.x0 >= x0 && box.x1 <= x1 && box.y0 >= y0 && box.y1 <= y1;
    });
    select([...drag.keep, ...inside.map((o) => o.id)]);
  }
});

function endDrag(event) {
  if (!drag) return;
  const finished = drag;
  drag = null;
  marquee = null;
  stage.classList.remove("panning");
  if (event.pointerId !== undefined && stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  if (finished.moved) commit();
  else drawOverlay();
}
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);

stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  // Pinch gestures arrive as ctrl+wheel with small deltas; make them a bit stronger.
  const strength = event.ctrlKey ? 0.01 : 0.0015;
  zoomBy(Math.exp(-event.deltaY * strength), clientToMm(event));
}, { passive: false });

window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !isTyping(event)) {
    spaceDown = true;
    if (document.activeElement === stage) event.preventDefault();
  }
});
window.addEventListener("keyup", (event) => {
  if (event.code === "Space") spaceDown = false;
});
window.addEventListener("blur", () => { spaceDown = false; });

export function isTyping(event) {
  const target = event.target;
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function onDoubleClick(fn) {
  stage.addEventListener("dblclick", (event) => {
    const hit = event.target.closest(".obj");
    if (hit) fn(objectById(hit.dataset.id));
  });
}

/** The canvas as a picture. `area` ({x, y, w, h} in mm) crops it, e.g. to the designs for a thumbnail. */
export function snapshotPng(maxSide = 1024, area = null) {
  return renderBed({ maxSide, area, type: area ? "image/jpeg" : "image/png" });
}

const ARTWORK = "path,rect,circle,ellipse,line,polyline,polygon";

/** Grid lines every `step` mm and labels every `label` mm, in machine coordinates, over the given canvas area. */
function gridMarkup(b, box, scale) {
  const span = Math.max(box.w, box.h);
  const step = span > 150 ? 10 : span > 40 ? 5 : 1;
  const label = span > 150 ? 50 : span > 40 ? 10 : 5;
  const px = 1 / scale; // one output pixel in mm
  const font = 11 * px;
  let minor = "", major = "", labels = "";
  const x0 = Math.ceil(box.x / step) * step, x1 = box.x + box.w;
  for (let x = x0; x <= x1 + 1e-6; x += step) {
    const line = `M${x} ${box.y}V${box.y + box.h}`;
    if (Math.round(x) % label === 0) {
      major += line;
      labels += `<text x="${x + 2 * px}" y="${box.y + box.h - 3 * px}">${+x.toFixed(1)}</text>`;
    } else minor += line;
  }
  // Machine y runs away from the front: canvas y = bed depth - machine y.
  const my0 = Math.ceil((b.h - box.y - box.h) / step) * step, my1 = b.h - box.y;
  for (let my = my0; my <= my1 + 1e-6; my += step) {
    const y = b.h - my;
    const line = `M${box.x} ${y}H${box.x + box.w}`;
    if (Math.round(my) % label === 0) {
      major += line;
      if (my > b.h - box.y - box.h + 8 * px) labels += `<text x="${box.x + 2 * px}" y="${y - 2 * px}">${+my.toFixed(1)}</text>`;
    } else minor += line;
  }
  return `<g fill="none" stroke-width="${px}"><path d="${minor}" stroke="#fff" stroke-opacity=".22"/><path d="${major}" stroke="#ffd34d" stroke-opacity=".7"/></g>`
    + `<g font-family="sans-serif" font-size="${font}" fill="#ffd34d" stroke="#000" stroke-width="${2.5 * px}" paint-order="stroke" stroke-linejoin="round">${labels}</g>`;
}

/**
 * Draw the bed as a picture. `area` is in canvas mm and crops it; `background` is a photo
 * ({ url, x, y, w, h } in canvas mm, else white); `designs` draws what's on the canvas over it, see
 * through when there's a photo; `grid` adds millimetre lines and labels in machine coordinates.
 */
export async function renderBed({ maxSide = 1024, area = null, background = null, designs = true, grid = false, type = "image/png" } = {}) {
  const bb = bed();
  const box = area || { x: 0, y: 0, w: bb.w, h: bb.h };
  const scale = maxSide / Math.max(box.w, box.h);
  let art = "";
  if (designs) {
    const clone = objectLayer.cloneNode(true);
    for (const node of clone.querySelectorAll(".hit")) node.remove();
    art = new XMLSerializer().serializeToString(clone);
  }
  const see = background ? `.mode-fill .art{opacity:.6}` : "";
  const ground = background
    ? `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#303030"/><image href="${background.url}" x="${background.x ?? 0}" y="${background.y ?? 0}" width="${background.w ?? bb.w}" height="${background.h ?? bb.h}" preserveAspectRatio="none"/>`
    : `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#fff"/>`;
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.w} ${box.h}"><style>.mode-line .art :is(${ARTWORK}){fill:none!important;stroke:#e22!important;stroke-width:1.5px!important;vector-effect:non-scaling-stroke}${see}</style>${ground}${grid ? gridMarkup(bb, box, scale) : ""}${art}</svg>`;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.w * scale));
  canvas.height = Math.max(1, Math.round(box.h * scale));
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(type, 0.85);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- wiring --------------------------------------------------------------------

let framePending = false;
function schedule() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    drawObjects();
    drawOverlay();
  });
}

let bedKey = "";
function syncBed() {
  const b = bed();
  const key = `${b.w}x${b.h}`;
  if (key === bedKey) return;
  bedKey = key;
  drawBed();
  fitView();
}

on("doc", schedule);
on("selection", schedule);
on("status", schedule);
on("ui", schedule);
on("config", () => {
  syncBed();
  schedule();
});
new ResizeObserver(() => applyView()).observe(stage);

export function initStage() {
  syncBed();
  drawObjects();
  drawOverlay();
}
