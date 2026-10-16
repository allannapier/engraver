// A webcam looking down at the bed. The browser captures the picture (no server
// dependency, and it already has the camera permission), and four calibration points
// map it onto the bed so it lines up with the canvas in millimetres.
//
// Calibration points are stored in the settings file as { u, v, x, y }: u and v are
// fractions of the picture's width and height, x and y are machine coordinates (mm
// from the front-left corner, y away from the front), as shown everywhere else.

import { state, bed, emit } from "./store.js";

const IDLE_MS = 90_000; // turn the camera off this long after the last picture
const SETTLE_MS = 1200; // auto exposure needs a moment after the camera starts

let stream = null;
let video = null;
let openId = null;
let startedAt = 0;
let idleTimer = null;
let holders = 0;
let latest = null; // { url, at, w, h } — the last corrected photo of the whole bed

export const cameraSettings = () => state.config.camera || { device_id: "", label: "", points: [] };
export const isCalibrated = () => (cameraSettings().points || []).length === 4;
export const latestPhoto = () => latest;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Video inputs the browser knows about. Labels are empty until the camera has been allowed once. */
export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

function friendlyError(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error("Engraver isn't allowed to use the camera. Allow it in the browser's site settings for this page, then try again.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new Error("That camera isn't plugged in. Plug it in, or pick another camera in Setup.");
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return new Error("The camera is busy or not responding. Close other apps using it, then try again.");
  }
  return new Error(`The camera didn't start (${error?.message || error}).`);
}

function armIdle() {
  clearTimeout(idleTimer);
  if (holders === 0) idleTimer = setTimeout(closeCamera, IDLE_MS);
}

export function closeCamera() {
  clearTimeout(idleTimer);
  if (stream) for (const track of stream.getTracks()) track.stop();
  stream = null;
  openId = null;
  if (video) video.srcObject = null;
}

/** Start the camera (or keep the running one) and return its <video>. */
export async function openCamera(deviceId = cameraSettings().device_id) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser can't use a camera here. Open Engraver at http://127.0.0.1:8642 in Chrome, Edge or Firefox.");
  }
  const live = stream && stream.getVideoTracks().some((t) => t.readyState === "live");
  if (!live || openId !== (deviceId || "")) {
    closeCamera();
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId }, ...size } : size,
        audio: false,
      });
    } catch (error) {
      throw friendlyError(error);
    }
    openId = deviceId || "";
    video ||= Object.assign(document.createElement("video"), { muted: true, playsInline: true });
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!video.videoWidth) await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
    startedAt = Date.now();
  }
  armIdle();
  return video;
}

/** Keep the camera on while something shows it live (the Setup preview). */
export function holdCamera() {
  holders += 1;
  clearTimeout(idleTimer);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    armIdle();
  };
}

/** The current camera picture as a canvas, at the camera's full resolution. */
export async function grabFrame(deviceId) {
  const v = await openCamera(deviceId);
  const wait = SETTLE_MS - (Date.now() - startedAt);
  if (wait > 0) await sleep(wait);
  const canvas = document.createElement("canvas");
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  if (!canvas.width || !canvas.height) throw new Error("The camera isn't sending a picture. Check it's plugged in, then try again.");
  canvas.getContext("2d").drawImage(v, 0, 0);
  armIdle();
  return canvas;
}

// --- calibration maths -------------------------------------------------------------

/**
 * The 3×3 projective transform (row-major, last entry 1) taking each `from` point to
 * the matching `to` point. Exactly four pairs, no three of them in a line.
 */
export function homography(from, to) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error("Three of the calibration points are in a line. Use four points near the corners of a rectangle.");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const k = a[r][col] / a[col][col];
      if (k) for (let c = col; c < 9; c++) a[r][c] -= k * a[col][c];
    }
  }
  const h = a.map((row, i) => row[8] / row[i]);
  h.push(1);
  if (!h.every(Number.isFinite)) throw new Error("Those calibration points don't make a usable shape. Pick them again.");
  return h;
}

export function project(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** Check four points make a proper (convex, not folded) quadrilateral in both spaces. */
export function checkPoints(points) {
  if (!Array.isArray(points) || points.length !== 4) throw new Error("Calibration needs four points.");
  const convex = (pts) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4], [cx, cy] = pts[(i + 2) % 4];
      const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
      if (Math.abs(cross) < 1e-9) return false;
      if (sign && Math.sign(cross) !== sign) return false;
      sign = Math.sign(cross);
    }
    return true;
  };
  if (!convex(points.map((p) => [p.x, p.y]))) throw new Error("The four bed positions must be the corners of a shape, in order round it, with no three in a line.");
  if (!convex(points.map((p) => [p.u, p.v]))) throw new Error("The four points in the picture cross over or are in a line. Click them in the same order as the bed positions.");
}

// --- the corrected photo ----------------------------------------------------------

/**
 * Map a camera frame onto the bed. `area` is in canvas millimetres (y down from the
 * back of the bed); the result is a canvas `pxPerMm` pixels per millimetre. Parts of
 * the bed the camera can't see are dark grey.
 */
export function correctFrame(frame, points, { area = null, pxPerMm = 2 } = {}) {
  checkPoints(points);
  const b = bed();
  const box = area || { x: 0, y: 0, w: b.w, h: b.h };
  const fw = frame.width, fh = frame.height;
  // Bed (machine mm) -> picture pixels.
  const h = homography(points.map((p) => [p.x, p.y]), points.map((p) => [p.u * fw, p.v * fh]));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(box.w * pxPerMm));
  out.height = Math.max(1, Math.round(box.h * pxPerMm));
  const src = frame.getContext("2d").getImageData(0, 0, fw, fh).data;
  const ctx = out.getContext("2d");
  const img = ctx.createImageData(out.width, out.height);
  const dst = img.data;
  const sx = box.w / out.width, sy = box.h / out.height;
  for (let j = 0; j < out.height; j++) {
    const my = b.h - (box.y + (j + 0.5) * sy); // canvas y (down) -> machine y (away)
    for (let i = 0; i < out.width; i++) {
      const mx = box.x + (i + 0.5) * sx;
      const w = h[6] * mx + h[7] * my + 1;
      const u = (h[0] * mx + h[1] * my + h[2]) / w - 0.5;
      const v = (h[3] * mx + h[4] * my + h[5]) / w - 0.5;
      const o = (j * out.width + i) * 4;
      if (!(w > 0) || u < 0 || v < 0 || u > fw - 1 || v > fh - 1) {
        dst[o] = dst[o + 1] = dst[o + 2] = 48;
        dst[o + 3] = 255;
        continue;
      }
      const u0 = Math.floor(u), v0 = Math.floor(v);
      const u1 = Math.min(u0 + 1, fw - 1), v1 = Math.min(v0 + 1, fh - 1);
      const fu = u - u0, fv = v - v0;
      const p00 = (v0 * fw + u0) * 4, p10 = (v0 * fw + u1) * 4, p01 = (v1 * fw + u0) * 4, p11 = (v1 * fw + u1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[p00 + c] + (src[p10 + c] - src[p00 + c]) * fu;
        const bottom = src[p01 + c] + (src[p11 + c] - src[p01 + c]) * fu;
        dst[o + c] = top + (bottom - top) * fv;
      }
      dst[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Take a new photo of the whole bed (from `frame`, or a fresh one), keep it as the latest, and return it. */
export async function photographBed({ frame = null, pxPerMm = 2.5 } = {}) {
  if (!isCalibrated()) throw new Error("The camera isn't calibrated yet. Set it up in the Setup tab, under Camera.");
  const picture = frame || (await grabFrame());
  const out = correctFrame(picture, cameraSettings().points, { pxPerMm });
  latest = { url: out.toDataURL("image/jpeg", 0.88), at: Date.now(), w: out.width, h: out.height };
  emit("camera");
  return latest;
}

export function forgetPhoto() {
  latest = null;
  emit("camera");
}

/** Where to put the calibration marks: the corners of a rectangle inset from the bed's edges. */
export function defaultMarks() {
  const b = bed();
  const inset = Math.round(Math.min(b.w, b.h) * 0.1);
  return [
    { x: inset, y: b.h - inset }, // back left
    { x: b.w - inset, y: b.h - inset }, // back right
    { x: b.w - inset, y: inset }, // front right
    { x: inset, y: inset }, // front left
  ];
}
