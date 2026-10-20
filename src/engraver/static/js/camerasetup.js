// Setup tab, Camera: pick the webcam, preview it, and calibrate it against the bed.
//
// Calibration: four marks at known bed positions (burned or drawn on a sheet, or
// any four points you can measure), clicked in the camera picture in order. The
// section is built once and kept, so a live preview survives the Setup tab redrawing.

import { state, on, emit, uid, newLayer, LAYER_COLORS, commit, select } from "./store.js";
import { api, post } from "./api.js";
import { h, fill, toast, act, modal, closeModal } from "./ui.js";
import {
  cameraSettings, isCalibrated, listCameras, openCamera, holdCamera, closeCamera, grabFrame,
  checkPoints, homography, defaultMarks, photographBed,
} from "./camera.js";
import { showPhoto } from "./stage.js";

const CORNERS = ["Back left", "Back right", "Front right", "Front left"];
const section = h("section", { id: "camera-section" });
let cameras = [];
let release = null; // stops holding the camera on for the preview
let builtFor = "";

async function saveCamera(patch) {
  const result = await api("/api/config", { method: "PUT", body: { camera: patch } });
  state.config = result.config;
  state.machine = result.machine;
  emit("config");
}

async function refreshCameras() {
  cameras = await listCameras().catch(() => []);
  build(true);
}

function stopPreview() {
  release?.();
  release = null;
}

async function startPreview(box) {
  const video = await openCamera();
  stopPreview();
  release = holdCamera();
  const live = h("video", { muted: true, autoplay: true, playsinline: true });
  live.muted = true;
  live.srcObject = video.srcObject;
  fill(box, live);
  box.hidden = false;
  live.play().catch(() => {});
}

/** Four crosses at the calibration positions, on their own line layer, to burn or trace. */
function addMarks(points) {
  const size = 12, half = size / 2;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs) - half, x1 = Math.max(...xs) + half;
  const y0 = Math.min(...ys) - half, y1 = Math.max(...ys) + half;
  const w = x1 - x0, hgt = y1 - y0;
  // Artwork in mm, y down from the top of the box; machine y runs up.
  const d = points.map((p) => {
    const cx = p.x - x0, cy = y1 - p.y;
    return `M${cx - half} ${cy}H${cx + half}M${cx} ${cy - half}V${cy + half}M${cx + 2} ${cy}A2 2 0 1 1 ${cx - 2} ${cy}A2 2 0 1 1 ${cx + 2} ${cy}`;
  }).join("");
  let layer = state.doc.layers.find((l) => l.name === "Calibration marks");
  if (!layer) {
    layer = newLayer({ name: "Calibration marks", mode: "line", speed: 1500, power: 20, color: LAYER_COLORS[state.doc.layers.length % LAYER_COLORS.length] });
    state.doc.layers.push(layer);
  }
  const bedH = state.machine.bed_h || 400;
  const obj = {
    id: uid("o"), kind: "shape", name: "Calibration marks", rot: 0,
    x: x0, y: bedH - y1, w, h: hgt, vb: [0, 0, w, hgt],
    svg: `<path d="${d}" fill="none" stroke="#000"/>`,
    layerId: layer.id,
  };
  state.doc.objects.push(obj);
  select([obj.id]);
  commit();
  toast("Marks added on their own layer. Burn them on a sheet covering the bed (or draw them by hand), then calibrate.");
}

function pointsOrDefaults() {
  const saved = cameraSettings().points || [];
  return saved.length === 4 ? saved.map((p) => ({ ...p })) : defaultMarks().map((p) => ({ ...p, u: null, v: null }));
}

async function calibrate() {
  let frame = await grabFrame();
  const points = pointsOrDefaults();
  let current = points.findIndex((p) => p.u === null);
  if (current < 0) current = 0;

  const canvas = h("canvas");
  const marks = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const wrap = h("div", { class: "calib" }, canvas, marks);
  const rows = h("div", { class: "calib-points" });
  const message = h("p", { class: "note" });

  const paint = () => {
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d").drawImage(frame, 0, 0);
    marks.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
  };
  const drawMarks = () => {
    const r = Math.max(frame.width, frame.height) / 90;
    marks.innerHTML = points.map((p, i) => {
      if (p.u === null) return "";
      const x = p.u * frame.width, y = p.v * frame.height;
      return `<circle class="pt${i === current ? " next" : ""}" cx="${x}" cy="${y}" r="${r}" vector-effect="non-scaling-stroke"/>`
        + `<path class="pt" d="M${x - r * 1.8} ${y}H${x + r * 1.8}M${x} ${y - r * 1.8}V${y + r * 1.8}" vector-effect="non-scaling-stroke"/>`
        + `<text class="pt-label" x="${x + r * 1.4}" y="${y - r * 1.4}" font-size="${r * 2.2}">${i + 1}</text>`;
    }).join("");
  };
  const ready = () => state.status.connected && state.status.state === "Idle";
  const drawRows = () => {
    fill(rows,
      h("span", { class: "note" }, ""), h("span", { class: "note" }, "X (mm)"), h("span", { class: "note" }, "Y (mm)"), h("span"),
      points.flatMap((p, i) => [
        h("span", {}, `${i + 1}. ${CORNERS[i]}`),
        h("input", { type: "number", step: 0.1, value: p.x, oninput: (e) => { p.x = parseFloat(e.target.value); } }),
        h("input", { type: "number", step: 0.1, value: p.y, oninput: (e) => { p.y = parseFloat(e.target.value); } }),
        h("button", {
          type: "button", class: `btn small${i === current ? "" : " ghost"}`,
          onclick: () => { current = i; drawRows(); drawMarks(); },
        }, p.u === null ? (i === current ? "Click it" : "Pick") : (i === current ? "Click again" : "✓ Repick")),
        h("span"),
        h("div", { class: "row wrap", style: "grid-column:2 / -1" },
          h("button", {
            type: "button", class: "btn small ghost", disabled: !ready(),
            title: "Fill X and Y from where the laser head is now",
            onclick: () => {
              [p.x, p.y] = state.status.wpos.map((v) => Math.round(v * 10) / 10);
              drawRows();
            },
          }, "Use head position"),
          h("button", {
            type: "button", class: "btn small ghost", disabled: !ready() || !Number.isFinite(p.x) || !Number.isFinite(p.y),
            title: "Move the head here with the laser off",
            onclick: act(() => post("/api/goto", { x: p.x, y: p.y })),
          }, "Go to this point"),
          h("button", {
            type: "button", class: "btn small ghost", disabled: !ready() || !Number.isFinite(p.x) || !Number.isFinite(p.y),
            title: "Move the head here and show a faint 2 % dot for a second",
            onclick: act(() => post("/api/goto", { x: p.x, y: p.y, dot: true })),
          }, "Go with dot")),
      ]));
    message.textContent = current >= 0
      ? `Click the centre of mark ${current + 1} (${CORNERS[current].toLowerCase()}) in the picture.`
      : "All four picked. Check the positions, then save.";
  };
  canvas.addEventListener("click", (event) => {
    if (current < 0) return;
    const rect = canvas.getBoundingClientRect();
    points[current].u = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    points[current].v = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    const next = points.findIndex((p, i) => i > current && p.u === null);
    current = next >= 0 ? next : points.findIndex((p) => p.u === null);
    drawRows();
    drawMarks();
  });
  paint();
  drawRows();
  drawMarks();

  let wasReady = ready();
  let open = true;
  on("status", () => {
    if (!open || ready() === wasReady) return;
    wasReady = ready();
    drawRows();
  });

  let saved = null;
  const choice = await modal((form) => form.append(
    h("h1", {}, "Calibrate the camera"),
    h("p", { class: "note" }, "Move the head out of the way to take the picture. Each mark's X and Y are millimetres from the bed's front-left corner, as shown on the canvas."),
    wrap,
    message,
    rows,
    h("div", { class: "actions spread" },
      h("button", {
        type: "button", class: "btn ghost",
        onclick: act(async () => { frame = await grabFrame(); paint(); drawMarks(); }),
      }, "Retake picture"),
      h("button", { type: "button", class: "btn ghost", onclick: () => closeModal("") }, "Cancel"),
      h("button", {
        class: "btn primary", value: "save",
        onclick: (event) => {
          try {
            if (points.some((p) => p.u === null)) throw new Error("Click all four marks in the picture first.");
            if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("Every mark needs an X and a Y in mm.");
            checkPoints(points);
            homography(points.map((p) => [p.x, p.y]), points.map((p) => [p.u, p.v]));
            saved = points.map(({ u, v, x, y }) => ({ u, v, x, y }));
          } catch (error) {
            event.preventDefault();
            message.textContent = error.message;
          }
        },
      }, "Save"),
    ),
  ), { wide: true });
  open = false;
  if (choice !== "save" || !saved) return;
  await saveCamera({ points: saved });
  showPhoto(await photographBed());
  toast("Camera calibrated. The bed photo is on the canvas: check the grid lines up with the marks.");
}

// Built once and kept: the preview keeps playing while the rest of the section redraws.
const picker = h("select", {
  onchange: act(async (event) => {
    const picked = cameras.find((c) => c.id === event.target.value);
    stopPreviewUi();
    // A different camera sees the bed differently: its calibration starts again.
    await saveCamera({ device_id: picked?.id || "", label: picked?.label || "", points: [] });
  }),
});
const previewBox = h("div", { class: "camera-preview", hidden: true });
const previewButton = h("button", {
  type: "button", class: "btn small",
  onclick: act(async () => {
    if (release) return stopPreviewUi();
    await startPreview(previewBox);
    previewButton.textContent = "Hide preview";
    // Camera names only show once the browser has been allowed to use one.
    await refreshCameras();
  }),
}, "Show preview");
const body = h("div", { style: "display:grid;gap:10px" });

function stopPreviewUi() {
  stopPreview();
  previewBox.hidden = true;
  previewBox.replaceChildren();
  previewButton.textContent = "Show preview";
}

function build(force = false) {
  const cam = cameraSettings();
  const key = JSON.stringify([cam, cameras.map((c) => c.id + c.label)]);
  if (!force && key === builtFor) return;
  builtFor = key;

  const known = cameras.some((c) => c.id === cam.device_id);
  fill(picker,
    h("option", { value: "" }, cameras.length ? "Any camera" : "No camera found yet"),
    cameras.map((c) => h("option", { value: c.id, selected: c.id === cam.device_id }, c.label)),
    cam.device_id && !known && h("option", { value: cam.device_id, selected: true }, cam.label || "Saved camera"),
  );
  fill(body,
    h("label", { class: "field" }, "Camera", picker),
    h("div", { class: "row wrap" },
      previewButton,
      h("button", { type: "button", class: "btn small", onclick: act(calibrate) }, isCalibrated() ? "Calibrate again" : "Calibrate"),
      h("button", {
        type: "button", class: "btn small ghost", title: "Crosses at the calibration positions, to burn or trace on a sheet",
        onclick: () => addMarks(pointsOrDefaults()),
      }, "Put marks on the canvas"),
    ),
    previewBox,
    h("p", { class: "note" }, isCalibrated()
      ? `Calibrated with four marks${cam.label ? ` on ${cam.label}` : ""}. Take a photo with the camera button beside the canvas.`
      : "Not calibrated yet. Put marks on the canvas and burn them on a sheet covering the bed (or draw crosses at measured spots), then Calibrate."),
    isCalibrated() && h("div", { class: "row" },
      h("button", {
        type: "button", class: "btn small ghost",
        onclick: act(async () => { await saveCamera({ points: [] }); toast("Camera calibration removed."); }),
      }, "Remove calibration")),
  );
}

fill(section,
  h("h2", {}, "Camera"),
  h("p", { class: "note", style: "margin-bottom:10px" },
    "A USB webcam above the bed shows the material on the canvas, and lets Claude Code see it. Mount it looking down at the whole bed."),
  body,
);

export function cameraSection() {
  build();
  return section;
}

export function initCameraSetup() {
  on("config", () => build());
  navigator.mediaDevices?.addEventListener?.("devicechange", refreshCameras);
  refreshCameras();
  // Leaving the Setup tab stops the live preview, so the camera can turn off.
  for (const tab of document.querySelectorAll(".tabs button")) {
    tab.addEventListener("click", () => {
      if (tab.dataset.tab !== "setup" && release) stopPreviewUi();
    });
  }
  window.addEventListener("pagehide", closeCamera);
}
