// Report a bug: describe it, review exactly what will be sent, and file it as a
// GitHub issue. The server gathers its side of the diagnostics and does the filing.

import { state } from "./store.js";
import { api, post } from "./api.js";
import { h, fill, modal, toast, act, download } from "./ui.js";
import { errors, events, actions } from "./diagnostics.js";
import { selectedMaterial } from "./library.js";
import { test } from "./testgrid.js";

// Kept while the page is open, so backing out of the review step loses nothing.
const draft = { title: "", description: "", expected: "", include: { details: true, logs: true, design: true } };

function clientInfo() {
  const material = selectedMaterial();
  return {
    user_agent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    errors: errors.slice(-40),
    events: events.slice(-60),
    actions: actions.slice(-50),
    ui: { ...state.ui, material: material ? material.name : null, materialTest: { ...test, name: undefined } },
    project: draft.include.design
      ? {
          layers: state.doc.layers,
          designs: state.doc.objects.map((o) => ({
            id: o.id, name: o.name, kind: o.kind, layerId: o.layerId, x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot, vb: o.vb,
            // Pictures stay on this computer: only their place and size are reported.
            svg: o.kind === "image" ? "(picture left out)" : o.svg,
          })),
        }
      : null,
  };
}

function destination(status) {
  if (!status) return [h("p", { class: "note warn" }, "Couldn't check how reports are filed. You can still write one and review it.")];
  const how = {
    gh: `Files an issue in ${status.repo} using the gh command-line tool on this computer.`,
    token: `Files an issue in ${status.repo} using the GitHub token saved in Setup.`,
    link: `No GitHub sign-in was found, so this opens a pre-filled issue page for ${status.repo} that you submit yourself. To file in one step, sign in with gh or add a token in Setup.`,
  }[status.method];
  const lines = [h("p", { class: "note" }, how)];
  if (status.public === true) lines.push(h("p", { class: "note warn" }, "That repository is public, so anyone can read the report. You'll see the full text before anything is sent."));
  return lines;
}

async function writeStep(status) {
  const title = h("input", { type: "text", value: draft.title, required: true, minlength: 3, maxlength: 150, placeholder: "A short summary" });
  const description = h("textarea", { rows: 5, required: true, minlength: 3, maxlength: 6000, value: draft.description, placeholder: "What you did and what went wrong. The more exact, the easier it is to fix." });
  const expected = h("textarea", { rows: 2, maxlength: 3000, value: draft.expected, placeholder: "Optional" });
  const tick = (key, label) => {
    const box = h("input", { type: "checkbox", checked: draft.include[key] });
    box.addEventListener("change", () => { draft.include[key] = box.checked; });
    return h("label", { class: "check" }, box, label);
  };
  const answer = await modal((form) => {
    fill(form,
      h("h1", {}, "Report a bug"),
      h("label", { class: "field" }, "Title", title),
      h("label", { class: "field" }, "What happened", description),
      h("label", { class: "field" }, "What you expected instead", expected),
      h("div", { class: "field" }, "Include with the report",
        tick("details", "Machine state, last job and material settings"),
        tick("logs", "Console, error logs and recent clicks"),
        tick("design", "Layers and designs on the canvas (pictures left out)")),
      destination(status),
      h("div", { class: "actions" },
        h("button", { class: "btn", value: "", formnovalidate: true }, "Cancel"),
        h("button", { class: "btn primary", value: "review" }, "Review report")),
    );
    setTimeout(() => (draft.title ? description : title).focus());
  }, { wide: true });
  // Keep what was typed even if the dialog was dismissed.
  Object.assign(draft, { title: title.value, description: description.value, expected: expected.value });
  return answer === "review";
}

async function reviewStep(status, preview) {
  const body = h("textarea", { class: "report-body", value: preview.body, spellcheck: "false", "aria-label": "Report text" });
  const sendLabel = status?.method === "link" ? "Open issue page" : "Create issue";
  const answer = await modal((form) => {
    fill(form,
      h("h1", {}, "Review before sending"),
      h("p", { class: "note" }, `This is everything that will be sent, as "${preview.title}". Edit or delete anything you'd rather not share. API keys and tokens are already removed.`),
      body,
      h("div", { class: "actions" },
        h("button", { class: "btn", value: "", formnovalidate: true }, "Cancel"),
        h("button", { class: "btn", value: "back", formnovalidate: true }, "Back"),
        h("button", { class: "btn primary", value: "send" }, sendLabel)),
    );
    // Start reading from the top, not wherever the browser puts the caret.
    setTimeout(() => {
      body.setSelectionRange(0, 0);
      body.scrollTop = 0;
    });
  }, { wide: true });
  return { answer, body: body.value };
}

async function done(result, body) {
  if (result.via === "link") {
    let copied = true;
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      copied = false;
    }
    window.open(result.url, "_blank", "noopener");
    await modal((form) => {
      fill(form,
        h("h1", {}, "Finish on GitHub"),
        h("p", {}, "A pre-filled issue page has opened in a new tab. Submit it there."),
        h("p", { class: "note" }, copied
          ? "Only the start of the report fits in a link. The full report is on your clipboard: paste it over the text on that page."
          : "Only the start of the report fits in a link. Download the full report and paste it over the text on that page."),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "btn", onclick: () => download("engraver-bug-report.md", body, "text/markdown") }, "Download the report"),
          h("a", { class: "btn linklike", href: result.url, target: "_blank", rel: "noopener" }, "Open the page again"),
          h("button", { class: "btn primary", value: "" }, "Done")),
      );
    });
    return;
  }
  await modal((form) => {
    fill(form,
      h("h1", {}, `Issue #${result.number} created`),
      h("p", {}, h("a", { href: result.url, target: "_blank", rel: "noopener" }, result.url)),
      h("div", { class: "actions" }, h("button", { class: "btn primary", value: "" }, "Done")),
    );
  });
}

async function report() {
  const status = await api("/api/bug/status").catch(() => null);
  for (;;) {
    if (!(await writeStep(status))) return;
    const preview = await post("/api/bug/preview", { title: draft.title, description: draft.description, expected: draft.expected, include: draft.include, client: clientInfo() });
    const { answer, body } = await reviewStep(status, preview);
    if (answer === "back") continue;
    if (answer !== "send") return;
    const result = await post("/api/bug/report", { title: preview.title, body });
    Object.assign(draft, { title: "", description: "", expected: "" });
    if (result.via !== "link") toast(`Issue #${result.number} created.`);
    await done(result, body);
    return;
  }
}

export function initBugReport() {
  document.getElementById("report-bug").addEventListener("click", act(report));
}
