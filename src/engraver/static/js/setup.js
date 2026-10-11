// Setup tab: the assistant's provider and the machine profile.

import { state, on, emit } from "./store.js";
import { api, post } from "./api.js";
import { h, toast, act } from "./ui.js";

const panel = document.getElementById("tab-setup");
let builtFor = "";

async function save(patch) {
  const result = await api("/api/config", { method: "PUT", body: patch });
  state.config = result.config;
  state.machine = result.machine;
  emit("config");
}

function build() {
  const llm = state.config.llm || {};
  const machine = state.config.machine || {};
  const reported = state.status.settings || {};
  const travel = [Number(reported["130"]), Number(reported["131"])];
  const travelDiffers = state.status.connected && travel[0] > 0 && travel[1] > 0 && (Math.abs(travel[0] - machine.bed_w) > 0.5 || Math.abs(travel[1] - machine.bed_h) > 0.5);

  const model = h("input", { type: "text", value: llm.model || "", placeholder: "provider/model", list: "model-examples", autocomplete: "off", spellcheck: "false" });
  const key = h("input", { type: "password", value: "", placeholder: llm.api_key_set ? `Saved (${llm.api_key_hint || "hidden"}). Type to replace` : "Paste your API key", autocomplete: "off" });
  const base = h("input", { type: "url", value: llm.api_base || "", placeholder: "Only for local or self-hosted models" });
  const vision = h("input", { type: "checkbox", checked: llm.vision !== false });
  const llmValues = () => ({ model: model.value.trim(), api_key: key.value.trim(), api_base: base.value.trim(), vision: vision.checked });
  const testButton = h("button", {
    type: "button", class: "btn small",
    onclick: act(async () => {
      testButton.disabled = true;
      testButton.textContent = "Testing…";
      try {
        await save({ llm: llmValues() });
        await post("/api/ai/test");
        toast("The assistant is connected.");
      } finally {
        testButton.disabled = false;
        testButton.textContent = "Save and test";
      }
    }),
  }, "Save and test");

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
    h("section", {},
      h("h2", {}, "Assistant"),
      h("p", { class: "note", style: "margin-bottom:10px" }, "Use any provider LiteLLM supports. The key stays on this computer and is only sent to the provider you choose."),
      h("div", { style: "display:grid;gap:10px" },
        h("label", { class: "field" }, "Model", model),
        h("datalist", { id: "model-examples" },
          ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-4-5-20251001", "openai/", "gemini/", "openrouter/", "ollama/"].map((value) => h("option", { value }))),
        h("label", { class: "field" }, "API key", key),
        h("label", { class: "field" }, "Base URL", base),
        h("label", { class: "check" }, vision, "Let the assistant see the canvas"),
        h("div", { class: "row" },
          testButton,
          llm.api_key_set && h("button", {
            type: "button", class: "btn small ghost",
            onclick: act(async () => {
              await save({ llm: { clear_api_key: true } });
              toast("API key removed.");
            }),
          }, "Remove key")),
      ),
    ),
    h("section", {},
      h("h2", {}, "Machine"),
      machineForm,
      state.status.connected && h("p", { class: "note", style: "margin-top:10px" },
        `Connected: ${state.status.version || "GRBL"}. Full power is S${reported["30"] ?? "?"}, taken from the controller.`),
    ),
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
export const initSetup = () => render(true);
