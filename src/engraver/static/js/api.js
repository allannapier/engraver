// Calls to the local server, plus the live event stream.

import { noteEvent } from "./diagnostics.js";

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    noteEvent(`${method} ${path} -> no answer from the server`);
    throw new Error("Can't reach Engraver's server. Is it still running in the terminal?");
  }
  if (!res.ok) {
    let detail;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* not JSON */
    }
    if (Array.isArray(detail)) {
      const first = detail[0] || {};
      detail = `${(first.loc || []).slice(-1)[0] || "Value"}: ${first.msg || "not valid"}`;
    }
    const message = typeof detail === "string" ? detail : `Request failed (${res.status})`;
    noteEvent(`${method} ${path} -> ${res.status}: ${message}`);
    throw new Error(message);
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? res.json() : res.text();
}

export const post = (path, body = {}) => api(path, { method: "POST", body });

// Reconnects on its own, so restarting the server doesn't need a page reload.
export function connectEvents(onEvent, onLink) {
  let socket;
  let build = null;
  let retry = 500;
  const open = () => {
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.onopen = () => {
      retry = 500;
      onLink?.(true);
    };
    socket.onmessage = (msg) => {
      const event = JSON.parse(msg.data);
      if (event.type === "hello") {
        // The server was updated while this tab stayed open: its code is out of date.
        if (build && build !== event.build) location.reload();
        build = event.build;
        return;
      }
      onEvent(event);
    };
    socket.onclose = () => {
      onLink?.(false);
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 5000);
    };
  };
  open();
  // Tell the server which tab the person is using; MCP page actions go there.
  const claim = () => {
    if (!document.hidden && socket?.readyState === WebSocket.OPEN) socket.send("active");
  };
  window.addEventListener("focus", claim);
  document.addEventListener("visibilitychange", claim);
}
