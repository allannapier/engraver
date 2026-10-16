// Work asked for by an MCP client such as Claude Code. The server relays each call here
// over the live-updates socket (only to the most recently opened tab) and waits for
// the answer on /api/mcp/reply. See mcp.py for what a client can and can't do.
//
// Canvas edits go through canvasedit.js, so they're sanitised and placed
// the same way, and each call is one undo step. Starting a job only opens the usual
// confirmation: nothing burns until the person clicks Start burning.

import { state, commit, select, objectById, layerById } from "./store.js";
import { post } from "./api.js";
import { toast } from "./ui.js";
import { snapshotPng } from "./stage.js";
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

const actions = {
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
    return { text: `Framing ${summary.width} × ${summary.height} mm${state.ui.frameDot ? " with a 2% dot" : " with the laser off"}.` };
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

const NOTED = new Set(["edit", "delete_design", "save_design", "open_saved_design", "new_design", "frame_job"]);

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
