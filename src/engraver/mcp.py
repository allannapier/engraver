"""MCP server: lets tools like Claude Code work Engraver over the Model Context Protocol.

The endpoint is `POST /mcp` on the app's own server (Streamable HTTP, answered with
plain JSON). `engraver-mcp` relays the same thing over stdio for clients that only
start local processes.

The canvas lives in the open browser tab, so design tools are relayed to it over the
live-updates socket and the tab answers on `/api/mcp/reply`. Machine tools run here.

What a client can and can't do with the machine:
- It can connect, read the status, jog, set or go to the origin, frame (laser off, or
  the person's 2 % dot), pause and stop.
- It can't start or resume a job. `request_job_start` only opens the page's usual
  confirmation; the beam fires when the person clicks Start burning there.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from . import __version__
from .bugs import log
from .materials import NEVER, as_prompt_table

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
BROWSER_TIMEOUT = 30.0
NO_TAB = (
    "Engraver isn't open in a browser, and the canvas lives there. "
    "Open http://127.0.0.1:8642 (or run `engraver`) and try again."
)

INSTRUCTIONS = """Engraver drives a diode laser engraver/cutter (Atomstack A10 class: 455 nm, about 10 W). Its canvas is the bed. Call get_state first, and get_canvas_image to check how a design looks.

Coordinates: mm from the bed's front-left corner, x to the right, y away from the front. A design's position is the front-left corner of its bounding box.

Layers: every design sits on one layer, and the layer's mode and settings apply to everything on it.
- "fill" layers engrave: the design is rasterised and scanned line by line; dark burns, white and transparent don't. Settings: speed (mm/min), power (%), passes, interval (mm between scan lines), image_mode (threshold for crisp black and white, dither for photos, grayscale to vary power with darkness).
- "line" layers trace vector outlines once each, for scoring or cutting. Settings: speed, power, passes.
A typical project has an engrave layer and a cut layer. Put each design on the layer whose mode suits it.

SVG: a complete standalone <svg> with xmlns and a viewBox (units are arbitrary; the app scales the design to width_mm). Use only svg, g, path, rect, circle, ellipse, line, polyline, polygon and text (fill only), styled with presentation attributes: no CSS, classes, gradients, filters, masks, clip paths, images or scripts.
- Fill designs: solid #000 on transparent, detail bolder than about 0.3 mm at the final size. Greys only for grayscale or dither layers.
- Line designs: fill="none" stroke="#000". The laser follows the centre of every stroke once whatever its width, so never stack duplicate lines, close every outline that is cut out, and draw letters as paths (text doesn't trace).
- Plan before drawing: count every piece and repeat, work out positions as numbers, and place shapes from those numbers. Pieces that are cut out must be connected or deliberately separate.
- The app crops each design to its artwork and scales it on its own, so separate designs only line up when tied together. For parts on different layers that must match (an engraving on a cut-out piece, a score line inside a cut outline), draw them in one shared viewBox, add or replace the outline first, then add or replace the other part with align_with set to the outline's design id; width_mm, x_mm and y_mm are then ignored. When one part changes, replace the other with align_with too.
- To change an existing design use replace_design on it rather than adding a new one, and keep what the person didn't ask to change. Ask for the finished size if it matters and wasn't given.

Settings: call list_materials. The person's own materials beat the generic starting points, and a setting picked from a burned test is known to work on this machine. Never set more than 90 % power; if a job doesn't cut or mark deeply enough, slow down first, then add a pass, then raise power in steps of about 10 % up to 90 %. Keep engraving at or below 60 % unless a tested setting says otherwise. Don't give settings for materials on the never-laser list. When a setting is a guess, say so and suggest the app's test grid (Design tab, Material, Test grid).

Machine: you can connect, jog, set the origin, frame and pause or stop. You cannot start a job: request_job_start opens a confirmation in the app, and the person clicks Start burning. Every change shows in the app and can be undone there."""


class ToolError(Exception):
    """A tool call that couldn't be done, with a message for the client."""


class Bridge:
    """Sends canvas work to the open page and waits for its answer."""

    def __init__(self, hub, timeout: float = BROWSER_TIMEOUT):
        self.hub = hub
        self.timeout = timeout
        self.pending: dict[str, asyncio.Future] = {}

    async def call(self, action: str, args: dict | None = None) -> dict:
        call_id = secrets.token_hex(8)
        future = asyncio.get_running_loop().create_future()
        self.pending[call_id] = future
        try:
            if not self.hub.send_to_page({"type": "mcp", "id": call_id, "action": action, "args": args or {}}):
                raise ToolError(NO_TAB)
            try:
                return await asyncio.wait_for(future, self.timeout)
            except TimeoutError:
                raise ToolError(
                    "Engraver's page didn't answer. Check it's open and not showing an error, then try again."
                ) from None
        finally:
            self.pending.pop(call_id, None)

    def reply(self, call_id: str, ok: bool, result: Any = None, error: str | None = None) -> bool:
        future = self.pending.get(call_id)
        if not future or future.done():
            return False
        if ok:
            future.set_result(result if isinstance(result, dict) else {"result": result})
        else:
            future.set_exception(ToolError(str(error or "The page couldn't do that.")[:2000]))
        return True


# --- tool list ---------------------------------------------------------------------------

READ_ONLY = {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}
EDIT = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}
MOVES = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True}
NO_ARGS = {"type": "object", "properties": {}}


ALIGN_WITH = {
    "type": "string",
    "description": (
        "Id of a design drawn in the same viewBox coordinates. This design is placed so the shared "
        "coordinates line up with it; width_mm, x_mm and y_mm are ignored."
    ),
}
IMAGE_MODE = {"type": "string", "enum": ["threshold", "dither", "grayscale"]}

DESIGN_TOOLS: list[dict] = [
    {
        "name": "add_design",
        "description": "Add a new design to the canvas from SVG markup.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short name shown in the app."},
                "svg": {"type": "string", "description": "Complete standalone SVG document."},
                "width_mm": {"type": "number", "description": "Finished width on the material in mm."},
                "mode": {
                    "type": "string",
                    "enum": ["fill", "line"],
                    "description": "fill = engrave, line = score or cut.",
                },
                "layer_id": {
                    "type": "string",
                    "description": "Existing layer to put it on. Omit to use the first layer with a matching mode, or a new one.",
                },
                "x_mm": {"type": "number", "description": "Left edge, mm from the bed's left. Omit to centre."},
                "y_mm": {"type": "number", "description": "Front edge, mm from the bed's front. Omit to centre."},
                "align_with": ALIGN_WITH,
            },
            "required": ["name", "svg", "width_mm", "mode"],
        },
    },
    {
        "name": "replace_design",
        "description": (
            "Replace the artwork of an existing design, keeping its centre, width and layer "
            "(or its placement relative to align_with, if given)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "design_id": {"type": "string"},
                "svg": {"type": "string", "description": "Complete standalone SVG document."},
                "name": {"type": "string"},
                "align_with": ALIGN_WITH,
            },
            "required": ["design_id", "svg"],
        },
    },
    {
        "name": "transform_design",
        "description": "Move, resize or rotate an existing design. Omitted values stay as they are. Height follows width unless both are given.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "design_id": {"type": "string"},
                "x_mm": {"type": "number"},
                "y_mm": {"type": "number"},
                "width_mm": {"type": "number"},
                "height_mm": {"type": "number"},
                "rotation_deg": {"type": "number"},
                "layer_id": {"type": "string", "description": "Move the design to this layer."},
            },
            "required": ["design_id"],
        },
    },
    {
        "name": "add_layer",
        "description": "Create a layer with its laser settings.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "mode": {"type": "string", "enum": ["fill", "line"]},
                "speed": {"type": "number", "description": "mm/min"},
                "power": {"type": "number", "description": "percent, 0-90"},
                "passes": {"type": "integer"},
                "interval": {"type": "number", "description": "fill only: mm between scan lines"},
                "image_mode": IMAGE_MODE,
            },
            "required": ["name", "mode", "speed", "power"],
        },
    },
    {
        "name": "set_layer",
        "description": "Change settings on an existing layer. Omitted values stay as they are.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "layer_id": {"type": "string"},
                "name": {"type": "string"},
                "mode": {"type": "string", "enum": ["fill", "line"]},
                "speed": {"type": "number", "description": "mm/min"},
                "power": {"type": "number", "description": "percent, 0-90"},
                "passes": {"type": "integer"},
                "interval": {"type": "number", "description": "fill only: mm between scan lines"},
                "image_mode": IMAGE_MODE,
            },
            "required": ["layer_id"],
        },
    },
]
for _tool in DESIGN_TOOLS:
    _tool["annotations"] = EDIT

MAX_SVG_CONTEXT = 40_000


def trim_context(context: dict) -> dict:
    """The canvas state with its artwork kept within MAX_SVG_CONTEXT characters."""
    ctx = dict(context or {})
    selected = ctx.get("selected")
    if selected and isinstance(selected.get("svg"), str) and len(selected["svg"]) > MAX_SVG_CONTEXT:
        ctx["selected"] = {**selected, "svg": selected["svg"][:MAX_SVG_CONTEXT] + "…[truncated]"}
    # Every design's artwork goes along so parts can be matched up, within a budget; the rest just say so.
    designs = ctx.get("designs")
    if isinstance(designs, list):
        budget = MAX_SVG_CONTEXT
        kept = []
        for design in designs:
            if isinstance(design, dict) and isinstance(design.get("svg"), str):
                if len(design["svg"]) <= budget:
                    budget -= len(design["svg"])
                else:
                    design = {**design, "svg": "(too large to include; select it to see it)"}
            kept.append(design)
        ctx["designs"] = kept
    return ctx


TOOLS: list[dict] = [
    {
        "name": "get_state",
        "description": (
            "What's on the canvas (designs with their SVG, layers and settings, selection, open saved design) "
            "and the machine's status (connection, state, head position, origin, job). Call this first."
        ),
        "inputSchema": NO_ARGS,
        "annotations": READ_ONLY,
    },
    {
        "name": "get_canvas_image",
        "description": "A picture of the bed with every design on it, to check how the work looks. Line layers show as red outlines.",
        "inputSchema": NO_ARGS,
        "annotations": READ_ONLY,
    },
    {
        "name": "list_materials",
        "description": "The person's own tested settings, generic starting points per material, and materials that must never be lasered.",
        "inputSchema": NO_ARGS,
        "annotations": READ_ONLY,
    },
    *DESIGN_TOOLS,
    {
        "name": "delete_design",
        "description": "Remove a design from the canvas.",
        "inputSchema": {"type": "object", "properties": {"design_id": {"type": "string"}}, "required": ["design_id"]},
        "annotations": {**EDIT, "destructiveHint": True},
    },
    {
        "name": "list_saved_designs",
        "description": "Designs saved in the app, newest first.",
        "inputSchema": NO_ARGS,
        "annotations": READ_ONLY,
    },
    {
        "name": "save_design",
        "description": (
            "Save the canvas in the app. Without a name it saves over the design that's open; with a name it saves "
            "a new one. A name that's already used is refused unless replace is true."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string", "maxLength": 80}, "replace": {"type": "boolean"}},
        },
        "annotations": EDIT,
    },
    {
        "name": "open_saved_design",
        "description": "Replace the canvas with a saved design. Undo in the app brings back what was there.",
        "inputSchema": {"type": "object", "properties": {"design_id": {"type": "string"}}, "required": ["design_id"]},
        "annotations": EDIT,
    },
    {
        "name": "new_design",
        "description": "Clear the canvas to start a new design. Undo in the app brings back what was there.",
        "inputSchema": NO_ARGS,
        "annotations": EDIT,
    },
    {
        "name": "connect_machine",
        "description": 'Connect to the laser. port is a device from get_state\'s ports list, or "sim" for the simulator.',
        "inputSchema": {"type": "object", "properties": {"port": {"type": "string"}}, "required": ["port"]},
        "annotations": MOVES,
    },
    {
        "name": "jog",
        "description": "Move the head with the laser off. dx_mm is to the right, dy_mm away from the front.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "dx_mm": {"type": "number", "minimum": -500, "maximum": 500},
                "dy_mm": {"type": "number", "minimum": -500, "maximum": 500},
                "feed": {"type": "number", "exclusiveMinimum": 0, "maximum": 20000, "description": "mm/min"},
            },
        },
        "annotations": MOVES,
    },
    {
        "name": "origin",
        "description": "set: make the head's position the origin (X0 Y0). go: move the head to the origin. clear: remove the origin offset.",
        "inputSchema": {
            "type": "object",
            "properties": {"action": {"type": "string", "enum": ["set", "go", "clear"]}},
            "required": ["action"],
        },
        "annotations": MOVES,
    },
    {
        "name": "frame_job",
        "description": (
            "Trace the job's outline with the head so the person can check placement on the material. The laser is off, "
            "or at a 2 % dot if the person switched that on in the app."
        ),
        "inputSchema": NO_ARGS,
        "annotations": MOVES,
    },
    {
        "name": "request_job_start",
        "description": (
            "Open the app's start confirmation for what's on the canvas. Nothing burns until the person clicks "
            "Start burning there; this returns once the confirmation is showing."
        ),
        "inputSchema": NO_ARGS,
        "annotations": EDIT,
    },
    {
        "name": "pause_job",
        "description": "Pause the running job. Only the person can resume it, from the app.",
        "inputSchema": NO_ARGS,
        "annotations": MOVES,
    },
    {
        "name": "stop_job",
        "description": "Stop the running job or frame and turn the laser off. The head keeps its position.",
        "inputSchema": NO_ARGS,
        "annotations": MOVES,
    },
]

DESIGN_ACTIONS = {tool["name"] for tool in DESIGN_TOOLS}
TOOL_NAMES = {tool["name"] for tool in TOOLS}


# --- calling tools -----------------------------------------------------------------------


def text(value: Any) -> list[dict]:
    if not isinstance(value, str):
        value = json.dumps(value, indent=1)
    return [{"type": "text", "text": value}]


def materials_text(library_prompt: str) -> str:
    own = library_prompt or "(none saved yet)"
    never = "\n".join(f"- {item['name']}: {item['why']}" for item in NEVER)
    return (
        f"The person's own materials (use these first):\n{own}\n\n"
        f"Generic starting points (speed mm/min, power %, passes):\n{as_prompt_table()}\n\n"
        f"Never laser:\n{never}"
    )


class Server:
    """JSON-RPC handling for the MCP endpoint.

    `machine` maps tool names to the app's server-side calls; `machine_state` returns the
    machine part of get_state; `errors` are exceptions whose message is meant for the client.
    """

    def __init__(
        self,
        bridge: Bridge,
        machine: dict[str, Callable],
        machine_state: Callable,
        notify: Callable[[str], None],
        errors: tuple[type[Exception], ...] = (),
    ):
        self.bridge = bridge
        self.machine = machine
        self.machine_state = machine_state
        self.notify = notify
        self.errors = (ToolError, *errors)
        self.client = "An MCP client"

    async def handle(self, message: Any) -> dict | None:
        if (
            not isinstance(message, dict)
            or message.get("jsonrpc") != "2.0"
            or not isinstance(message.get("method"), str)
        ):
            return _error(message.get("id") if isinstance(message, dict) else None, -32600, "Invalid request")
        if "id" not in message:
            return None  # a notification (initialized, cancelled): nothing to answer
        call_id, method = message["id"], message["method"]
        params = message.get("params", {})
        params = {} if params is None else params
        if not isinstance(params, dict):
            return _error(call_id, -32602, "params must be an object")
        if method == "initialize":
            info = params.get("clientInfo") or {}
            if isinstance(info, dict) and isinstance(info.get("name"), str) and info["name"].strip():
                self.client = _client_name(info["name"])
            asked = params.get("protocolVersion")
            return _result(
                call_id,
                {
                    "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "engraver", "title": "Engraver", "version": __version__},
                    "instructions": INSTRUCTIONS,
                },
            )
        if method == "ping":
            return _result(call_id, {})
        if method == "tools/list":
            return _result(call_id, {"tools": TOOLS})
        if method == "tools/call":
            name, args = params.get("name"), params.get("arguments")
            args = {} if args is None else args
            if name not in TOOL_NAMES:
                return _error(call_id, -32602, f"Unknown tool: {name}")
            if not isinstance(args, dict):
                return _error(call_id, -32602, "arguments must be an object")
            return _result(call_id, await self.call(name, args))
        return _error(call_id, -32601, f"Method not found: {method}")

    async def call(self, name: str, args: dict) -> dict:
        try:
            content = await self._call(name, args)
        except self.errors as exc:
            return {"content": text(str(exc)), "isError": True}
        except Exception as exc:
            log.error("MCP tool %s failed", name, exc_info=exc)
            return {
                "content": text("Engraver hit an internal error doing that. The details are in its log."),
                "isError": True,
            }
        return {"content": content, "isError": False}

    async def _call(self, name: str, args: dict) -> list[dict]:
        if name in self.machine:
            reply = await self.machine[name](args)
            if reply.get("note"):
                self.notify(f"{self.client}: {reply['note']}")
            return text(reply.get("text") or reply)
        if name == "get_state":
            state = await self.machine_state()
            try:
                canvas = await self.bridge.call("context", {})
                state["canvas"] = trim_context(canvas)
            except ToolError as exc:
                state["canvas"] = str(exc)
            return text(state)
        if name == "get_canvas_image":
            shot = await self.bridge.call("snapshot", {})
            url = shot.get("image") or ""
            prefix = "data:image/png;base64,"
            if not url.startswith(prefix):
                raise ToolError("The page couldn't draw the canvas as a picture.")
            return [{"type": "image", "data": url[len(prefix) :], "mimeType": "image/png"}]
        # Everything else changes the canvas or starts something in the page.
        args = dict(args, type=name) if name in DESIGN_ACTIONS else dict(args)
        reply = await self.bridge.call(name if name not in DESIGN_ACTIONS else "edit", {"client": self.client, **args})
        return text(reply)


def _client_name(raw: str) -> str:
    name = " ".join(raw.replace("-", " ").split())[:40]
    known = {"claude code": "Claude Code", "claude ai": "Claude", "claude desktop": "Claude"}
    return known.get(name.lower(), name)


def _result(call_id, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": call_id, "result": result}


def _error(call_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": call_id, "error": {"code": code, "message": message}}


# --- stdio relay ---------------------------------------------------------------------------


def relay(line: str, url: str, opener: Callable = urllib.request.urlopen) -> str | None:
    """Forward one JSON-RPC line to the running app. Returns the reply line, or None for a notification."""
    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        return json.dumps(_error(None, -32700, "Parse error"))
    request = urllib.request.Request(
        url,
        data=line.encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
        method="POST",
    )
    try:
        with opener(request, timeout=120) as response:
            body = response.read().decode()
    except (urllib.error.URLError, OSError) as exc:
        if isinstance(message, dict) and "id" in message:
            return json.dumps(
                _error(message["id"], -32000, f"Engraver isn't running at {url} ({exc}). Start it with `engraver`.")
            )
        return None
    return body.strip() or None


def stdio_main(argv: list[str] | None = None) -> None:
    """`engraver-mcp [URL]`: an MCP server on stdio that forwards to the running app."""
    args = sys.argv[1:] if argv is None else argv
    url = args[0] if args else "http://127.0.0.1:8642/mcp"
    for line in sys.stdin:
        if not line.strip():
            continue
        reply = relay(line, url)
        if reply:
            sys.stdout.write(reply + "\n")
            sys.stdout.flush()
