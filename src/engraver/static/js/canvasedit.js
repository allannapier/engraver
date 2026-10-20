// Canvas edits asked for by an MCP client such as Claude Code, and the canvas state it reads.
// Edits only change designs and layer settings: nothing here moves the head or fires the laser.
// Every SVG goes through sanitizeSvg on the way in.

import { state, bed, select, selected, newLayer, layerById, objectById, LAYER_COLORS } from "./store.js";
import { aabb, viewCenter } from "./stage.js";
import { objectFromSvgText, objectFromImage, sanitizeSvg, contentFromSvg } from "./svgutil.js";

const NO_DESIGN = "There's no design with that id on the canvas. Call get_state for the ids.";

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
  if (!partner) throw new Error(`There's no design "${a.align_with}" on the canvas to line up with.`);
  if (partner.kind !== "svg") throw new Error("A picture can't be lined up with: it has no shared coordinates.");
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
  if (a.type === "add_image") {
    // The same path as dropping a file on the page: objectFromImage checks the type and decodes it.
    const o = await objectFromImage(String(a.data_url || ""), String(a.name || "Image").slice(0, 40));
    const w = clamp(num(a.width_mm) ?? Math.min(o.w, 80), 1, b.w);
    Object.assign(o, { h: (o.h * w) / o.w, w });
    o.layerId = layerFor({ ...a, mode: "fill" }).id;
    if (layerById(o.layerId).mode !== "fill") throw new Error("Pictures engrave, so they need a fill layer. Pick a fill layer or omit layer_id.");
    if (num(a.cutoff) !== null) o.cutoff = clamp(Math.round(a.cutoff), 1, 255);
    const c = viewCenter();
    o.x = c.x - o.w / 2;
    o.y = c.y - o.h / 2;
    moveTo(o, num(a.x_mm), num(a.y_mm));
    state.doc.objects.push(o);
    added.set(o.name, o);
    select([o.id]);
    return `Added picture "${o.name}", ${o.w.toFixed(0)} × ${o.h.toFixed(0)} mm, on ${layerById(o.layerId).name}`;
  }
  if (a.type === "replace_design") {
    const o = objectById(a.design_id);
    if (!o) throw new Error(NO_DESIGN);
    const partner = partnerFor(a, added);
    if (partner === o) throw new Error("A design can't line up with itself.");
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
    if (!o) throw new Error(NO_DESIGN);
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
    if (num(a.cutoff) !== null) {
      if (o.kind !== "image") throw new Error("Only pictures have a cutoff. Use set_layer's image_mode and the layer's threshold for other designs.");
      o.cutoff = clamp(Math.round(a.cutoff), 1, 255);
    }
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
    if (!layer) throw new Error("There's no layer with that id. Call get_state for the ids.");
    const summary = layerPatch(layer, a);
    return `${layer.name}${summary ? `: ${summary}` : " updated"}`;
  }
  throw new Error(`Engraver doesn't know the edit "${a.type}".`);
}
