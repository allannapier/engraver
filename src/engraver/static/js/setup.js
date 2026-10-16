// Setup tab: connecting an AI client over MCP, bug reports, the machine profile and the camera.

import { state, on, emit } from "./store.js";
import { api } from "./api.js";
import { h, toast, act } from "./ui.js";
import { cameraSection, initCameraSetup } from "./camerasetup.js";

const panel = document.getElementById("tab-setup");
let builtFor = "";

async function save(patch) {
  const result = await api("/api/config", { method: "PUT", body: patch });
  state.config = result.config;
  state.machine = result.machine;
  emit("config");
}

function bugSection() {
  const bugs = state.config.bugs || {};
  const repo = h("input", { type: "text", value: bugs.repo || "", placeholder: "owner/repository", spellcheck: "false", autocomplete: "off" });
  const token = h("input", { type: "password", value: "", autocomplete: "off", placeholder: bugs.token_set ? "Saved. Type to replace" : "Optional" });
  return h("section", {},
    h("h2", {}, "Bug reports"),
    h("p", { class: "note", style: "margin-bottom:10px" }, "Report a bug files a GitHub issue here. If the gh command-line tool is signed in on this computer, no token is needed."),
    h("div", { style: "display:grid;gap:10px" },
      h("label", { class: "field" }, "Repository", repo),
      h("label", { class: "field" }, "GitHub token", token),
      h("div", { class: "row" },
        h("button", {
          type: "button", class: "btn small",
          onclick: act(async () => {
            await save({ bugs: { repo: repo.value.trim(), token: token.value.trim() } });
            toast("Bug report settings saved.");
          }),
        }, "Save"),
        bugs.token_set && h("button", {
          type: "button", class: "btn small ghost",
          onclick: act(async () => {
            await save({ bugs: { clear_token: true } });
            toast("GitHub token removed.");
          }),
        }, "Remove token")),
    ),
  );
}

function mcpSection() {
  const command = `claude mcp add --transport http engraver ${location.origin}/mcp`;
  return h("section", {},
    h("h2", {}, "AI assistant"),
    h("p", { class: "note", style: "margin-bottom:10px" },
      "Claude Code and other MCP clients can draw designs, set layers, jog and frame here while this page is open. Only you can start a job. To add Engraver to Claude Code, run:"),
    h("pre", { class: "command" }, h("code", {}, command)),
    h("div", { class: "row", style: "margin-top:8px" },
      h("button", {
        type: "button", class: "btn small",
        onclick: act(async () => {
          await navigator.clipboard.writeText(command);
          toast("Command copied.");
        }),
      }, "Copy command")),
    h("p", { class: "note", style: "margin-top:8px" }, "Clients that only start local programs can run ", h("code", {}, "engraver-mcp"), " instead."),
  );
}

function build() {
  const machine = state.config.machine || {};
  const reported = state.status.settings || {};
  const travel = [Number(reported["130"]), Number(reported["131"])];
  const travelDiffers = state.status.connected && travel[0] > 0 && travel[1] > 0 && (Math.abs(travel[0] - machine.bed_w) > 0.5 || Math.abs(travel[1] - machine.bed_h) > 0.5);

  const num = (name, step = 1) => h("input", { type: "number", step, min: 0, value: machine[name] ?? "", dataset: { machine: name } });
  const machineForm = h("form", {
    onsubmit: act(async (event) => {
      event.preventDefault();
      const values = { name: machineForm.querySelector("[data-machine=name]").value.trim() || "Laser" };
      for (const input of machineForm.querySelectorAll("input[type=number]")) {
        const value = parseFloat(input.value);
        if (!(value > 0)) throw new Error("Machine settings must be numbers above zero.");
        values[input.dataset.machine] = value;
      }
      await save({ machine: values });
      toast("Machine settings saved.");
    }),
  },
    h("label", { class: "field" }, "Name", h("input", { type: "text", value: machine.name || "", dataset: { machine: "name" } })),
    h("div", { class: "grid2", style: "margin-top:10px" },
      h("label", { class: "field" }, "Bed width (mm)", num("bed_w")),
      h("label", { class: "field" }, "Bed depth (mm)", num("bed_h")),
      h("label", { class: "field" }, "Top speed (mm/min)", num("max_feed", 100)),
      h("label", { class: "field" }, "Jog speed (mm/min)", num("jog_feed", 100)),
      h("label", { class: "field" }, "Frame speed (mm/min)", num("frame_feed", 100)),
      h("label", { class: "field" }, "Overscan (mm)", num("overscan", 0.5)),
      h("label", { class: "field" }, "Baud rate", num("baud")),
    ),
    travelDiffers && h("div", { class: "row spread", style: "margin-top:10px" },
      h("p", { class: "note" }, `The controller reports ${travel[0]} × ${travel[1]} mm of travel.`),
      h("button", {
        type: "button", class: "btn small",
        onclick: act(async () => {
          await save({ machine: { bed_w: travel[0], bed_h: travel[1] } });
          toast("Bed size updated from the controller.");
        }),
      }, "Use this")),
    h("button", { class: "btn small", style: "margin-top:12px" }, "Save machine"),
  );

  panel.replaceChildren(
    mcpSection(),
    bugSection(),
    h("section", {},
      h("h2", {}, "Machine"),
      machineForm,
      state.status.connected && h("p", { class: "note", style: "margin-top:10px" },
        `Connected: ${state.status.version || "GRBL"}. Full power is S${reported["30"] ?? "?"}, taken from the controller.`),
    ),
    cameraSection(),
  );
}

function render(force = false) {
  const reported = state.status.settings || {};
  const key = JSON.stringify([state.config, state.status.connected, reported["30"], reported["130"], reported["131"], state.status.version]);
  if (key === builtFor) return;
  // A status update mustn't wipe a half-filled form; a save rebuilds it on purpose.
  if (!force && panel.contains(document.activeElement) && builtFor) return;
  builtFor = key;
  build();
}

on("config", () => render(true));
on("status", () => render(false));
export function initSetup() {
  initCameraSetup();
  render(true);
}
