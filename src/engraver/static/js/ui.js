// Small DOM helpers shared by the panels: element builder, icons, toasts, dialogs.

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = value;
    else if (key === "checked" || key === "disabled" || key === "selected" || key === "hidden") node[key] = Boolean(value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** replaceChildren that skips null/false, so `cond && node` works at the top level too. */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

const ICONS = {
  import: "M12 3v11m0 0-4-4m4 4 4-4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  text: "M5 6V4h14v2M12 4v16m-3 0h6",
  rect: "M4 5h16v14H4z",
  ellipse: "M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z",
  undo: "M9 7 4 12l5 5M4 12h10a5 5 0 0 1 0 10h-2",
  redo: "m15 7 5 5-5 5m5-5H10a5 5 0 0 0 0 10h2",
  duplicate: "M8 8h12v12H8zM4 16V4h12",
  delete: "M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13M10 11v6m4-6v6",
  center: "M12 3v18M3 12h18M7 7h10v10H7z",
  "zoom-in": "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm5 11.5L20 20M10.5 8v5M8 10.5h5",
  "zoom-out": "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm5 11.5L20 20M8 10.5h5",
  fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  refresh: "M20 11a8 8 0 0 0-14.5-4M4 4v4h4m-4 5a8 8 0 0 0 14.5 4M20 20v-4h-4",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  unlock: "M7 11V8a5 5 0 0 1 9.6-2M6 11h12v9H6z",
  up: "M12 19V5m0 0-6 6m6-6 6 6",
  down: "M12 5v14m0 0-6-6m6 6 6-6",
  left: "M19 12H5m0 0 6-6m-6 6 6 6",
  right: "M5 12h14m0 0-6-6m6 6-6 6",
  close: "M6 6l12 12M18 6 6 18",
};

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] || "");
  svg.append(path);
  return svg;
}

const toasts = document.getElementById("toasts");
let lastToast = { text: "", at: 0 };
export function toast(text, kind = "info") {
  // The same message twice in a row (a held key, a repeating error) shows once.
  if (text === lastToast.text && Date.now() - lastToast.at < 3000) return;
  lastToast = { text, at: Date.now() };
  const node = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
  toasts.append(node);
  while (toasts.children.length > 4) toasts.firstChild.remove();
  setTimeout(() => node.remove(), kind === "error" ? 9000 : 4500);
}

const dialog = document.getElementById("dialog");

/**
 * Show a modal. `build(form)` fills it in; buttons with a `value` close it.
 * Resolves with the value of the button used, or null if dismissed.
 */
export function modal(build) {
  return new Promise((resolve) => {
    const form = h("form", { method: "dialog" });
    build(form);
    dialog.replaceChildren(form);
    dialog.returnValue = "";
    dialog.addEventListener("close", () => resolve(dialog.returnValue || null), { once: true });
    dialog.showModal();
  });
}

export const closeModal = (value = "") => dialog.close(value);

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Run an async action from a click; errors become a toast instead of vanishing. */
export function act(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      toast(error.message || String(error), "error");
    }
  };
}

export function download(filename, text, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
