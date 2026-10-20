// Material areas: named pieces of material on the bed, kept in the settings file.
// The active one is outlined on the canvas, and designs can be centred on it or fitted to it.
// Areas are in machine coordinates (front-left corner, size); the canvas flips y when drawing.

import { state, emit, uid, bed, commit, selected } from "./store.js";
import { api } from "./api.js";
import { h, fill, toast, modal, closeModal, act } from "./ui.js";
import { aabb } from "./stage.js";

export const areas = () => state.config.areas || [];
export const activeArea = () => areas().find((a) => a.id === state.ui.areaId) || areas()[0] || null;

async function saveAreas(next) {
  const result = await api("/api/config", { method: "PUT", body: { areas: next } });
  state.config = result.config;
  if (!areas().some((a) => a.id === state.ui.areaId)) state.ui.areaId = areas().at(-1)?.id || "";
  emit("config");
}

/** The area as a canvas box (mm, y down). */
export function areaBox(a) {
  return { x0: a.x, y0: bed().h - a.y - a.h, w: a.w, h: a.h };
}

function target() {
  const area = activeArea();
  if (!area) throw new Error("There's no material area yet. Click Material area in the toolbar to save one.");
  const picked = selected().length ? selected() : state.doc.objects;
  const box = aabb(picked);
  if (!box) throw new Error("There's nothing on the canvas to place. Add a design first.");
  return { area: areaBox(area), picked, box };
}

export function centreOnMaterial() {
  const { area, picked, box } = target();
  const dx = area.x0 + area.w / 2 - (box.x0 + box.w / 2);
  const dy = area.y0 + area.h / 2 - (box.y0 + box.h / 2);
  for (const o of picked) { o.x += dx; o.y += dy; }
  commit();
}

/** Scale to fit inside the area (keeping proportions, never past what fits), then centre. */
export function fitToMaterial() {
  const { area, picked, box } = target();
  const s = Math.min(area.w / box.w, area.h / box.h);
  const cx = box.x0 + box.w / 2, cy = box.y0 + box.h / 2;
  const ax = area.x0 + area.w / 2, ay = area.y0 + area.h / 2;
  for (const o of picked) {
    const ox = cx + (o.x + o.w / 2 - cx) * s, oy = cy + (o.y + o.h / 2 - cy) * s;
    o.w *= s;
    o.h *= s;
    o.x = ox - o.w / 2 + (ax - cx);
    o.y = oy - o.h / 2 + (ay - cy);
  }
  commit();
}

/** Where the head is in machine coordinates (work position plus the work offset). */
function headPosition() {
  if (!state.status.connected) throw new Error("Connect the machine to use the head position, or type the numbers.");
  const [wx, wy] = state.status.wpos, [ox = 0, oy = 0] = state.status.wco || [];
  return { x: +(wx + ox).toFixed(1), y: +(wy + oy).toFixed(1) };
}

export function areaDialog() {
  return modal((form) => {
    const field = (label, value) => h("label", {}, label, h("input", { type: "number", step: "0.1", value }));
    const name = h("input", { type: "text", maxlength: 60, placeholder: "Plywood board" });
    const x0 = field("Left x", ""), y0 = field("Front y", ""), x1 = field("Right x", ""), y1 = field("Back y", "");
    const num = (f) => parseFloat(f.querySelector("input").value);
    const setCorner = (fx, fy) => () => {
      const p = headPosition();
      fx.querySelector("input").value = p.x;
      fy.querySelector("input").value = p.y;
    };
    const list = h("div", { class: "area-list" });
    const draw = () => fill(list, areas().length
      ? areas().map((a) => h("div", { class: "row" },
        h("label", {}, h("input", { type: "radio", name: "area", checked: a.id === activeArea()?.id, onchange: () => { state.ui.areaId = a.id; emit("config"); } }),
          ` ${a.name}: x ${a.x} to ${+(a.x + a.w).toFixed(1)}, y ${a.y} to ${+(a.y + a.h).toFixed(1)} mm`),
        h("button", { type: "button", class: "btn small ghost", onclick: act(async () => { await saveAreas(areas().filter((b) => b.id !== a.id)); draw(); }) }, "Delete")))
      : h("p", { class: "note" }, "No material areas saved yet."));
    draw();
    const add = act(async () => {
      const [x, y, xe, ye] = [num(x0), num(y0), num(x1), num(y1)];
      if (![x, y, xe, ye].every(Number.isFinite) || xe <= x || ye <= y) {
        throw new Error("Fill in all four edges, with the right edge past the left and the back past the front.");
      }
      const area = { id: uid("my-area"), name: name.value.trim() || "Material", x, y, w: +(xe - x).toFixed(2), h: +(ye - y).toFixed(2) };
      state.ui.areaId = area.id;
      await saveAreas([...areas(), area]);
      draw();
      name.value = "";
      toast(`Saved "${area.name}".`);
    });
    form.append(
      h("h2", {}, "Material area"),
      h("p", { class: "note" }, "Save where a piece of material sits on the bed, in mm from the front-left corner. Jog the head to a corner and use its position, or type the edges."),
      list,
      h("label", {}, "Name", name),
      h("div", { class: "row" }, x0, y0, h("button", { type: "button", class: "btn small ghost", onclick: act(async () => setCorner(x0, y0)()) }, "Front-left = head")),
      h("div", { class: "row" }, x1, y1, h("button", { type: "button", class: "btn small ghost", onclick: act(async () => setCorner(x1, y1)()) }, "Back-right = head")),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn", onclick: add }, "Save area"),
        h("button", { type: "button", class: "btn ghost", onclick: () => closeModal("close") }, "Close")),
    );
  });
}
