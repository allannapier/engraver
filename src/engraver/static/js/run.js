// Sending a job to the laser: the confirmation step and framing.
// Used by the job bar (what's on the canvas) and by the material test.

import { state } from "./store.js";
import { post } from "./api.js";
import { h, modal, fill, formatDuration } from "./ui.js";

const layerLine = (l) => `${l.name}: ${l.mode}, ${l.speed} mm/min, ${l.power}%${l.passes > 1 ? `, ${l.passes} passes` : ""}`;

/**
 * Show what is about to be burned and start it if the person confirms.
 * `lines` replaces the per-layer list when there are too many layers to read.
 * Returns true if the job was started.
 */
export async function confirmAndStart(job, warnings = [], { lines, startsFrom, summary, requestedBy } = {}) {
  summary ||= await post("/api/job/preview", { job });
  const all = [...warnings, ...summary.warnings];
  const rows = lines || job.layers.map(layerLine);
  const from = startsFrom || (job.origin_mode === "origin" ? "the origin (design's front-left corner)" : "its position on the bed");
  const answer = await modal((form) => {
    fill(form,
      h("h1", {}, "Start burning?"),
      requestedBy ? h("p", { class: "note warn" }, `${requestedBy} set this job up. It only starts if you click Start burning.`) : null,
      h("dl", { class: "facts" },
        h("dt", {}, "Size"), h("dd", {}, `${summary.width} × ${summary.height} mm`),
        h("dt", {}, "Time"), h("dd", {}, `about ${formatDuration(summary.est_seconds)}`),
        h("dt", {}, "Starts from"), h("dd", {}, from),
        ...rows.flatMap((line, i) => [h("dt", {}, i ? "" : "Layers"), h("dd", {}, line)])),
      all.length ? h("ul", {}, all.map((w) => h("li", {}, w))) : null,
      h("p", { class: "note" }, "Goggles on, material flat and in focus, and stay with the machine while it runs."),
      h("div", { class: "actions" },
        h("button", { class: "btn", value: "", autofocus: true }, "Cancel"),
        h("button", { class: "btn primary", value: "go" }, "Start burning")),
    );
  });
  if (answer !== "go") return false;
  await post("/api/job/start", { job });
  return true;
}

/** Trace the job's outline: laser off, or a faint dot if that's switched on in the Laser tab. */
export const frame = (job) => post("/api/job/frame", { job, dot_power: state.ui.frameDot ? 2 : 0 });

export const machineReady = () =>
  state.status.connected && state.status.state === "Idle" && !["running", "paused", "stopping"].includes(state.status.job?.state);
