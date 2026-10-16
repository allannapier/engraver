// The canvas: draws the bed and the designs on it, and handles selecting,
// moving, resizing, rotating, panning and zooming. One unit is one millimetre.

import { state, on, bed, commit, touch, select, selected, layerById, objectById } from "./store.js";
import { el, scopeIds } from "./svgutil.js";

const stage = document.getElementById("stage");
const bedLayer = el("g", {}, stage);
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

// --- objects -------------------------------------------------------------------

const transformOf = (o) => `translate(${o.x + o.w / 2} ${o.y + o.h / 2}) rotate(${o.rot}) translate(${-o.w / 2} ${-o.h / 2})`;

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

/** A PNG of the bed and the designs on it, for an MCP client to look at. */
/** The canvas as a picture. `area` ({x, y, w, h} in mm) crops it, e.g. to the designs for a thumbnail. */
export async function snapshotPng(maxSide = 1024, area = null) {
  const bb = bed();
  const b = area ? { w: area.w, h: area.h } : bb;
  const vx = area ? area.x : 0, vy = area ? area.y : 0;
  const clone = objectLayer.cloneNode(true);
  for (const node of clone.querySelectorAll(".hit")) node.remove();
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${b.w} ${b.h}"><style>.mode-line .art :is(path,rect,circle,ellipse,line,polyline,polygon){fill:none!important;stroke:#c22!important;stroke-width:1.5px!important;vector-effect:non-scaling-stroke}</style><rect x="${vx}" y="${vy}" width="${b.w}" height="${b.h}" fill="#fff"/>${new XMLSerializer().serializeToString(clone)}</svg>`;
  const scale = maxSide / Math.max(b.w, b.h);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(b.w * scale));
  canvas.height = Math.max(1, Math.round(b.h * scale));
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(area ? "image/jpeg" : "image/png", 0.85);
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
