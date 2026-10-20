// Work asked for by an MCP client such as Claude Code. The server relays each call here
// over the live-updates socket (only to the most recently opened tab) and waits for
// the answer on /api/mcp/reply. See mcp.py for what a client can and can't do.
//
// Canvas edits go through canvasedit.js, so they're sanitised and placed
// the same way, and each call is one undo step. Starting a job only opens the usual
// confirmation: nothing burns until the person clicks Start burning.

import { state, bed, commit, select, objectById, layerById } from "./store.js";
import { post } from "./api.js";
import { toast } from "./ui.js";
import { snapshotPng, renderBed } from "./stage.js";
import { isCalibrated, grabFrame, correctFrame, cameraSettings, photographBed } from "./camera.js";
import { buildJob } from "./job.js";
import { confirmAndStart, frame, machineReady } from "./run.js";
import { context, applyAction } from "./canvasedit.js";
import { saveForTool, openForTool, newForTool } from "./designs.js";

const dialogOpen = () => document.getElementById("dialog")?.open;

function busyCheck() {
  if (dialogOpen()) throw new Error("Engraver is showing a dialog. Ask the person to close it, then try again.");
}

async function edit(args) {
  busyCheck();
  const layersBefore = new Set(state.doc.layers.map((l) => l.id));
  const added = new Map();
  const text = await applyAction(args, added);
  commit(); // one undo step per call
  const design = [...added.values()][0];
  const layer = design ? layerById(design.layerId) : state.doc.layers.find((l) => !layersBefore.has(l.id));
  return { text, ...(design ? { design_id: design.id } : {}), ...(layer ? { layer_id: layer.id } : {}) };
}

/** The part of the bed to show, from machine coordinates, as canvas mm (y down). Null for the whole bed. */
function photoArea({ x_mm, y_mm, width_mm, height_mm }) {
  if ([x_mm, y_mm, width_mm, height_mm].every((v) => v === undefined || v === null)) return null;
  const b = bed();
  const x0 = Math.max(0, Number(x_mm) || 0), y0 = Math.max(0, Number(y_mm) || 0);
  const x1 = Math.min(b.w, width_mm > 0 ? x0 + Number(width_mm) : b.w);
  const y1 = Math.min(b.h, height_mm > 0 ? y0 + Number(height_mm) : b.h);
  if (x1 - x0 < 5 || y1 - y0 < 5) throw new Error(`That area is off the bed or smaller than 5 mm. The bed is ${b.w} × ${b.h} mm.`);
  return { x: x0, y: b.h - y1, w: x1 - x0, h: y1 - y0, machine: [x0, y0, x1 - x0, y1 - y0] };
}

async function bedPhoto({ designs = true, ...args }) {
  if (!isCalibrated()) {
    throw new Error("Engraver has no calibrated camera. Ask the person to plug in a webcam over the bed and calibrate it: Setup tab, Camera.");
  }
  const area = photoArea(args);
  const maxSide = 1024;
  const frame = await grabFrame();
  // The whole-bed photo also goes on the canvas, so the person sees what the client saw.
  const whole = await photographBed({ frame });
  let background = { url: whole.url };
  if (area) {
    const pxPerMm = Math.min(8, maxSide / Math.max(area.w, area.h));
    const crop = correctFrame(frame, cameraSettings().points, { area, pxPerMm });
    background = { url: crop.toDataURL("image/jpeg", 0.9), x: area.x, y: area.y, w: area.w, h: area.h };
  }
  const image = await renderBed({ maxSide, area, background, designs: designs !== false, grid: true, type: "image/jpeg" });
  if (!image) throw new Error("Couldn't draw the photo.");
  const where = area ? `x ${area.machine[0]} to ${area.machine[0] + area.machine[2]}, y ${area.machine[1]} to ${area.machine[1] + area.machine[3]} mm` : `the whole ${bed().w} × ${bed().h} mm bed`;
  const about = [
    `Photo of ${where}, taken just now and corrected to line up with the canvas.`,
    "Yellow grid lines are labelled in mm from the bed's front-left corner (x to the right, y away from the front), the same coordinates the design tools use. Dark grey is outside the camera's view.",
    designs !== false ? "Designs are drawn over the photo: engravings see-through, cut and score lines in red." : "Designs aren't drawn.",
    "The laser head hides whatever is under it: if it's in the way, jog it to a corner and look again.",
  ].join(" ");
  return { image, about, text: "Took a photo of the bed." };
}

const actions = {
  bed_photo: bedPhoto,
  context: async () => context(),
  snapshot: async () => {
    const image = await snapshotPng(1024);
    if (!image) throw new Error("Couldn't draw the canvas as a picture.");
    return { image };
  },
  edit,
  delete_design: async ({ design_id }) => {
    busyCheck();
    const o = objectById(design_id);
    if (!o) throw new Error("There's no design with that id on the canvas. Call get_state for the ids.");
    state.doc.objects = state.doc.objects.filter((x) => x !== o);
    select([...state.selection].filter((id) => id !== o.id));
    commit();
    return { text: `Removed "${o.name}"` };
  },
  save_design: async ({ name, replace }) => {
    busyCheck();
    const meta = await saveForTool({ name, replace });
    return { text: `Saved "${meta.name}"`, design_id: meta.id };
  },
  open_saved_design: async ({ design_id }) => {
    busyCheck();
    if (!/^[a-f0-9]{1,64}$/.test(String(design_id || ""))) throw new Error("That isn't a saved design id. Call list_saved_designs for the ids.");
    await openForTool(design_id);
    return { text: "Opened. Undo in the app brings back what was there." };
  },
  new_design: async () => {
    busyCheck();
    newForTool();
    return { text: "Cleared the canvas. Undo in the app brings back what was there." };
  },
  frame_job: async () => {
    busyCheck();
    if (!machineReady()) throw new Error("The machine isn't ready: connect it and wait until it's idle.");
    const { job } = await buildJob("Job");
    const summary = await frame(job);
    const text = `Framing ${summary.width} × ${summary.height} mm${state.ui.frameDot ? " with a 2% dot" : " with the laser off"}.`;
    return { text: summary.origin_offset ? `${text} ${summary.warnings.at(-1)}` : text };
  },
  request_job_start: async ({ client }) => {
    busyCheck();
    if (!machineReady()) throw new Error("The machine isn't ready: connect it and wait until it's idle.");
    const { job, warnings } = await buildJob("Job");
    const summary = await post("/api/job/preview", { job });
    // Don't wait for the answer: the person may take a while, and the client can watch get_state.
    confirmAndStart(job, warnings, { summary, requestedBy: client }).catch((error) => toast(error.message, "error"));
    return {
      text: "The start confirmation is showing in Engraver. The job starts only when the person clicks Start burning; get_state shows when it is running.",
      width_mm: summary.width, height_mm: summary.height, est_seconds: Math.round(summary.est_seconds),
      warnings: [...warnings, ...summary.warnings],
    };
  },
};

const NOTED = new Set(["bed_photo", "edit", "delete_design", "save_design", "open_saved_design", "new_design", "frame_job"]);

export async function handleMcp({ id, action, args = {} }) {
  let reply;
  try {
    const run = actions[action];
    if (!run) throw new Error(`This page doesn't know how to ${action}. Reload Engraver's page.`);
    const result = await run(args);
    reply = { id, ok: true, result };
    if (NOTED.has(action) && result.text) toast(`${args.client || "An MCP client"}: ${result.text}`);
  } catch (error) {
    reply = { id, ok: false, error: `Not done: ${error.message || error}` };
  }
  try {
    await post("/api/mcp/reply", reply);
  } catch {
    /* the server went away; the client gets a timeout */
  }
}
