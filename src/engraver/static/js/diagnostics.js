// A short memory of what went wrong and what was clicked, kept for bug reports.
// Nothing here is sent anywhere unless the person files a report and reviews it.
// It never records what is typed into text boxes.

const stamp = () => new Date().toTimeString().slice(0, 8);

export const errors = []; // uncaught exceptions and console.error calls
export const events = []; // messages shown to the person and requests that failed
export const actions = []; // buttons, tabs and menus used, oldest first

function push(list, text, max) {
  list.push(`${stamp()} ${String(text).slice(0, 1200)}`);
  if (list.length > max) list.shift();
}

export const noteError = (text) => push(errors, text, 60);
export const noteEvent = (text) => push(events, text, 80);

const describe = (value) => {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

function labelOf(node) {
  // What the person sees on the control first; icon-only buttons fall back to their label.
  const text = node.textContent.trim() || node.getAttribute("aria-label") || node.getAttribute("title") || node.id || node.tagName;
  return text.replace(/\s+/g, " ").trim().slice(0, 50);
}

let installed = false;
export function installDiagnostics() {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    const where = event.filename ? ` at ${event.filename.replace(location.origin, "")}:${event.lineno}:${event.colno}` : "";
    noteError(event.error?.stack || `${event.message}${where}`);
  });
  window.addEventListener("unhandledrejection", (event) => noteError(`Unhandled promise rejection: ${describe(event.reason)}`));

  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    noteError(args.map(describe).join(" "));
  };

  // Capture phase, so it still sees clicks that a handler stops.
  document.addEventListener("click", (event) => {
    const node = event.target.closest?.("button, [role=button], [role=tab], a, input[type=checkbox]");
    if (!node || node.closest("#toasts")) return;
    const state = node.type === "checkbox" ? ` (${node.checked ? "on" : "off"})` : "";
    push(actions, `click: ${labelOf(node.type === "checkbox" ? node.closest("label") || node : node)}${state}`, 80);
  }, true);
  document.addEventListener("change", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLSelectElement)) return;
    const label = node.getAttribute("aria-label") || node.closest("label")?.firstChild?.textContent?.trim() || node.id || "menu";
    push(actions, `choose: ${label.slice(0, 40)} = ${(node.selectedOptions[0]?.textContent || node.value).trim().slice(0, 50)}`, 80);
  }, true);
}
