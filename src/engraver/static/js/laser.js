// Laser tab: moving the head, the origin, how jobs start and finish, and the console.

import { state, on, saveUi } from "./store.js";
import { post } from "./api.js";
import { h, icon, act, fill } from "./ui.js";

const panel = document.getElementById("tab-laser");
const logLines = [];
let consoleBox = null;
let builtFor = "";

const jobActive = () => ["running", "paused", "stopping"].includes(state.status.job?.state);
const canMove = () => state.status.connected && !jobActive() && ["Idle", "Jog"].includes(state.status.state);

export function addLog(entry) {
  logLines.push(entry);
  if (logLines.length > 400) logLines.shift();
  if (consoleBox) {
    const atBottom = consoleBox.scrollHeight - consoleBox.scrollTop - consoleBox.clientHeight < 30;
    consoleBox.append(h("div", { class: entry.kind }, (entry.kind === "tx" ? "> " : "") + entry.text));
    while (consoleBox.children.length > 400) consoleBox.firstChild.remove();
    if (atBottom) consoleBox.scrollTop = consoleBox.scrollHeight;
  }
}

const jog = (dx, dy) => act(() => post("/api/jog", { dx: dx * state.ui.jogStep, dy: dy * state.ui.jogStep }));

function seg(options, current, onPick) {
  return h("div", { class: "seg" },
    options.map(([value, label, title]) =>
      h("button", { type: "button", "aria-pressed": String(value === current), title, onclick: () => onPick(value) }, label)));
}

function build() {
  const s = state.status;
  const movable = canMove();
  const settings = s.settings || {};
  const hasHoming = Number(settings["22"]) > 0;
  const offset = s.wco && (Math.abs(s.wco[0]) > 0.001 || Math.abs(s.wco[1]) > 0.001);
  const notices = [];
  if (!s.connected) {
    notices.push(h("p", { class: "note" }, "Plug the laser in by USB, pick its port at the top and connect. No laser to hand? Choose Simulator to try everything out."));
  }
  if (s.state === "Alarm") {
    notices.push(h("div", { class: "row spread" },
      h("p", { class: "note danger" }, `Locked: ${s.alarm || "the controller raised an alarm"}. Check the head is free, then unlock.`),
      h("button", { type: "button", class: "btn small", onclick: act(() => post("/api/unlock")) }, "Unlock")));
  }
  if (s.connected && Number(settings["32"]) === 0) {
    notices.push(h("p", { class: "note danger" }, "Laser mode is off on the controller ($32=0). Jobs won't start until you send $32=1 in the console below."));
  }

  const input = h("input", { type: "text", placeholder: "Send a command, e.g. $$", "aria-label": "Console command", disabled: !s.connected, style: "flex:1" });
  consoleBox = h("div", { class: "console", role: "log" }, logLines.map((entry) => h("div", { class: entry.kind }, (entry.kind === "tx" ? "> " : "") + entry.text)));

  fill(panel,
    notices.length ? h("section", {}, notices) : null,
    h("section", {},
      h("h2", {}, "Move the head"),
      h("div", { class: "row", style: "gap:16px;align-items:flex-start" },
        h("div", { class: "jog" },
          h("span"), h("button", { type: "button", title: "Away from you", "aria-label": "Move back", disabled: !movable, onclick: jog(0, 1) }, icon("up")), h("span"),
          h("button", { type: "button", "aria-label": "Move left", disabled: !movable, onclick: jog(-1, 0) }, icon("left")),
          h("button", { type: "button", class: "mid", title: "Stop moving", disabled: !s.connected, onclick: act(() => post("/api/jog/cancel")) }, "halt"),
          h("button", { type: "button", "aria-label": "Move right", disabled: !movable, onclick: jog(1, 0) }, icon("right")),
          h("span"), h("button", { type: "button", title: "Towards you", "aria-label": "Move forward", disabled: !movable, onclick: jog(0, -1) }, icon("down")), h("span"),
        ),
        h("div", { style: "display:grid;gap:10px" },
          h("div", { class: "field" }, "Step (mm)",
            seg([[0.1, "0.1"], [1, "1"], [10, "10"], [50, "50"]], state.ui.jogStep, (value) => {
              state.ui.jogStep = value;
              saveUi();
            })),
          hasHoming && h("button", { type: "button", class: "btn small", disabled: !movable && s.state !== "Alarm", onclick: act(() => post("/api/home")) }, "Home"),
        ),
      ),
    ),
    h("section", {},
      h("h2", {}, "Origin"),
      h("div", { class: "row wrap" },
        h("button", { type: "button", class: "btn small", disabled: !movable, title: "Make the head's current position X0 Y0", onclick: act(() => post("/api/origin/set")) }, "Set origin here"),
        h("button", { type: "button", class: "btn small", disabled: !movable, onclick: act(() => post("/api/origin/goto")) }, "Go to origin"),
      ),
      offset && h("div", { class: "row spread", style: "margin-top:8px" },
        h("p", { class: "note" }, `Origin is offset ${s.wco[0].toFixed(1)}, ${s.wco[1].toFixed(1)} mm from where the machine powered on. It is remembered between sessions.`),
        h("button", { type: "button", class: "btn small", disabled: !movable, onclick: act(() => post("/api/origin/clear")) }, "Clear")),
    ),
    h("section", {},
      h("h2", {}, "Job"),
      h("div", { class: "field" }, "Start from",
        seg([
          ["absolute", "Bed position", "Burn the design exactly where it sits on the canvas"],
          ["origin", "Origin", "Put the design's front-left corner at the origin, wherever it is on the canvas"],
        ], state.ui.originMode, (value) => {
          state.ui.originMode = value;
          saveUi();
        })),
      h("p", { class: "note", style: "margin:6px 0 10px" },
        state.ui.originMode === "absolute"
          ? "The canvas is the bed: the design burns where you placed it, measured from the origin."
          : "The design's front-left corner lands on the origin. Jog to the corner of your material, set the origin, then start."),
      h("label", { class: "field" }, "When finished",
        h("select", {
          onchange: (event) => {
            state.ui.finish = event.target.value;
            saveUi();
          },
        },
          h("option", { value: "origin", selected: state.ui.finish === "origin" }, "Return to the origin"),
          h("option", { value: "stay", selected: state.ui.finish === "stay" }, "Stay where the job ends"))),
      h("label", { class: "check", style: "margin-top:10px" },
        h("input", {
          type: "checkbox", checked: state.ui.frameDot,
          onchange: (event) => {
            state.ui.frameDot = event.target.checked;
            saveUi();
          },
        }), "Frame with a faint dot (2% power)"),
      state.ui.frameDot && h("p", { class: "note warn", style: "margin-top:6px" }, "The beam is on while framing. Wear your goggles; it can still mark paper and dark surfaces."),
    ),
    h("section", {},
      h("h2", {}, "Console"),
      consoleBox,
      h("form", {
        class: "row", style: "margin-top:8px",
        onsubmit: act(async (event) => {
          event.preventDefault();
          const line = input.value.trim();
          if (!line) return;
          await post("/api/command", { line });
          input.value = "";
        }),
      }, input, h("button", { class: "btn small", disabled: !s.connected }, "Send")),
    ),
  );
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function render() {
  const s = state.status;
  const key = JSON.stringify([s.connected, s.state === "Alarm", s.alarm, canMove(), s.settings?.["22"], s.settings?.["32"], s.wco, state.ui]);
  if (key === builtFor) return;
  // Don't rebuild under someone typing a console command.
  if (panel.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && document.activeElement.type === "text" && builtFor) {
    const typed = document.activeElement.value;
    builtFor = key;
    build();
    const input = panel.querySelector('input[type="text"]');
    input.value = typed;
    if (!input.disabled) input.focus();
    return;
  }
  builtFor = key;
  build();
}

on("status", render);
on("ui", render);
export const initLaser = render;
