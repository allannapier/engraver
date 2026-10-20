// The camera photo shown on the canvas: the camera tool takes one, the bar under the
// canvas says how old it is and retakes or hides it. A photo taken for an MCP client
// shows here too (unless the person hid the photo), so the person sees what the client saw.

import { state, on } from "./store.js";
import { act, toast } from "./ui.js";
import { showPhoto, shownPhoto } from "./stage.js";
import { isCalibrated, photographBed, latestPhoto, forgetPhoto } from "./camera.js";

const $ = (id) => document.getElementById(id);

// Set when the person clicks Hide: photos an MCP client takes afterwards stay off the canvas
// until the person takes one themselves.
let hiddenByUser = false;

function age(at) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function sync() {
  const photo = shownPhoto();
  $("photo-bar").hidden = !photo;
  if (photo) $("photo-age").textContent = `Bed photo, ${age(photo.at)}`;
}

function openSetup() {
  document.querySelector('.tabs button[data-tab="setup"]')?.click();
  document.getElementById("camera-section")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

export async function takePhoto() {
  if (!isCalibrated()) {
    toast("Set up the camera first: Setup tab, Camera.", "warn");
    openSetup();
    return;
  }
  const button = document.querySelector('[data-tool="camera"]');
  button.disabled = true;
  hiddenByUser = false;
  try {
    showPhoto(await photographBed());
  } finally {
    button.disabled = false;
  }
  sync();
}

export function initBedPhoto() {
  $("photo-retake").addEventListener("click", act(takePhoto));
  $("photo-hide").addEventListener("click", () => {
    hiddenByUser = true;
    showPhoto(null);
    sync();
  });
  on("camera", () => {
    const latest = latestPhoto();
    if (!latest) hiddenByUser = false;
    if (latest && !hiddenByUser && shownPhoto() !== latest) showPhoto(latest);
    if (!latest && shownPhoto()) showPhoto(null);
    sync();
  });
  // Calibration or bed size changed: an old photo no longer lines up.
  let fitted = null;
  on("config", () => {
    const key = JSON.stringify([state.config.camera?.points || [], state.machine.bed_w, state.machine.bed_h]);
    if (fitted !== null && key !== fitted && latestPhoto()) forgetPhoto();
    fitted = key;
  });
  setInterval(sync, 30_000);
}
