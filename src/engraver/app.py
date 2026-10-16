"""The local web server: static app, machine API, job API, assistant API.

Only reachable from this computer. Requests are checked so that a web page
on another site can't call the API and drive the laser.
"""

from __future__ import annotations

import asyncio
import math
import os
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import __version__, bugs, llm, mcp
from .config import ConfigStore
from .gcode import JobError, JobSpec, MachineProfile, build_job, frame_gcode
from .grbl.controller import GrblController, MachineError, list_ports
from .grbl.simulator import GrblSim
from .library import LibraryError, MaterialLibrary, UserMaterial
from .library import default_path as library_path
from .materials import MATERIALS, NEVER
from .saved import NotFound, SavedError, Shelf, chats_folder, designs_folder, new_id

STATIC_DIR = Path(__file__).parent / "static"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
SIM_PORT = "sim"


class Hub:
    """Fans controller events out to every open browser tab."""

    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self.clients: dict[asyncio.Queue, None] = {}  # in the order the tabs connected
        self.log: deque[dict] = deque(maxlen=300)

    def publish(self, event: dict) -> None:
        """Called from the controller's IO thread."""
        if event.get("type") == "log":
            self.log.append(event)
        loop = self.loop
        if loop and not loop.is_closed():
            loop.call_soon_threadsafe(self._fanout, event)

    def _fanout(self, event: dict) -> None:
        for client in self.clients:
            if client.full() and event.get("type") == "status":
                continue  # a slow tab can miss a status report; the next one supersedes it
            try:
                client.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def send_to_page(self, event: dict) -> bool:
        """Give an event to one tab only, the most recently opened: for work only one tab should do."""
        for client in reversed(self.clients):
            try:
                client.put_nowait(event)
                return True
            except asyncio.QueueFull:
                continue
        return False


class ConnectBody(BaseModel):
    port: str
    baud: int | None = None


class CommandBody(BaseModel):
    line: str = Field(max_length=120)


class JogBody(BaseModel):
    dx: float = Field(default=0, ge=-500, le=500)
    dy: float = Field(default=0, ge=-500, le=500)
    feed: float | None = Field(default=None, gt=0, le=20000)


class JobBody(BaseModel):
    job: JobSpec


class FrameBody(BaseModel):
    job: JobSpec
    dot_power: float = Field(default=0, ge=0, le=100)


REFERENCE_RE = r"^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$"


class ChatBody(BaseModel):
    messages: list[dict]
    context: dict = {}
    image: str | None = None
    # A picture the person attached to guide the assistant. The browser scales it down first.
    reference: str | None = Field(default=None, max_length=4_000_000, pattern=REFERENCE_RE)


class DesignBody(BaseModel):
    name: str = Field(max_length=200)
    project: dict
    thumb: str | None = None
    # Saving under a name another design already has replaces that one only when asked.
    replace: bool = False


class McpReplyBody(BaseModel):
    id: str = Field(max_length=64)
    ok: bool
    result: Any = None
    error: str | None = Field(default=None, max_length=4000)


class ChatSaveBody(BaseModel):
    title: str = Field(max_length=200)
    messages: list[dict] = Field(max_length=500)


def _host_ok(headers, allowed: set[str]) -> bool:
    """Reject DNS-rebinding and cross-site requests: the Host must be this machine,
    and a browser-supplied Origin must be this same server."""
    host = headers.get("host", "")
    hostname = host.rsplit(":", 1)[0] if not host.endswith("]") else host
    if hostname not in allowed:
        return False
    origin = headers.get("origin")
    if origin and origin != "null":
        return urlparse(origin).netloc == host
    return origin != "null"


async def _until_closed(socket: WebSocket) -> None:
    try:
        while True:
            await socket.receive_text()  # the page never sends; this returns only on close
    except (WebSocketDisconnect, RuntimeError):
        pass


def create_app(
    store: ConfigStore | None = None, sim_speed: float | None = None, extra_hosts: tuple[str, ...] = ()
) -> FastAPI:
    store = store or ConfigStore()
    library = MaterialLibrary(library_path(store.path))
    designs = Shelf(designs_folder(store.path), noun="design", max_items=500, max_bytes=40_000_000)
    chats = Shelf(chats_folder(store.path), noun="chat", max_items=30, max_bytes=20_000_000, prune=True)
    hub = Hub()
    controller = GrblController(on_event=hub.publish)
    allowed_hosts = LOCAL_HOSTS | set(extra_hosts)
    if sim_speed is None:
        sim_speed = float(os.environ.get("ENGRAVER_SIM_SPEED", "1"))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        hub.loop = asyncio.get_running_loop()
        yield
        hub.loop = None
        await asyncio.to_thread(controller.disconnect)

    app = FastAPI(
        title="Engraver", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )
    app.state.controller = controller
    app.state.store = store
    app.state.hub = hub
    app.state.library = library
    app.state.designs = designs
    app.state.chats = chats
    app.state.github = bugs.GitHub(lambda: store.settings.bugs.token)  # tests swap in a fake
    app.state.last_job = None
    app.state.completion = None  # tests swap in a fake provider here

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if not _host_ok(request.headers, allowed_hosts):
            return JSONResponse(
                {"detail": "Request refused: Engraver only answers its own page on this computer."}, status_code=403
            )
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(MachineError)
    async def machine_error(request: Request, exc: MachineError):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(JobError)
    async def job_error(request: Request, exc: JobError):
        return JSONResponse({"detail": str(exc)}, status_code=422)

    @app.exception_handler(bugs.BugError)
    async def bug_error(request: Request, exc: bugs.BugError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception):
        # Kept for bug reports: the traceback is what someone fixing it needs most.
        bugs.log.error("%s %s failed", request.method, request.url.path, exc_info=exc)
        return JSONResponse(
            {"detail": "Engraver hit an internal error. Use Report a bug to send the details."}, status_code=500
        )

    @app.exception_handler(LibraryError)
    async def library_error(request: Request, exc: LibraryError):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(NotFound)
    async def not_found(request: Request, exc: NotFound):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(SavedError)
    async def saved_error(request: Request, exc: SavedError):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(llm.AssistantError)
    async def assistant_error(request: Request, exc: llm.AssistantError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    def machine() -> MachineProfile:
        """The saved profile, corrected by what the connected controller reports.

        $30 (the S value that means 100 %) must match the machine or every power
        setting would be wrong, so the controller's value always wins.
        """
        profile = store.settings.machine.model_copy()
        reported = controller.settings
        if reported.get(30, 0) > 0:
            profile.s_max = reported[30]
        if reported.get(110, 0) > 0:
            profile.max_feed = min(profile.max_feed, reported[110])
            profile.travel_feed = min(profile.travel_feed, reported[110])
        return profile

    def require_laser_mode() -> None:
        if controller.settings.get(32) == 0:
            raise MachineError(
                "Laser mode is off on the controller ($32=0), so the beam would stay on between cuts. "
                "Send $32=1 from the console, then try again."
            )

    # --- state ---------------------------------------------------------------

    @app.get("/api/state")
    def state():
        return {
            "version": __version__,
            "status": controller.snapshot(),
            "config": store.public(),
            "machine": machine().model_dump(),
            "materials": MATERIALS,
            "library": library.all(),
            "never": NEVER,
            "log": list(hub.log),
        }

    # --- the person's own materials --------------------------------------------

    @app.put("/api/library/{material_id}")
    def put_material(material_id: str, material: UserMaterial):
        if material.id != material_id:
            raise HTTPException(422, "The material's id doesn't match the address it was sent to.")
        library.put(material)
        return {"library": library.all()}

    @app.delete("/api/library/{material_id}")
    def delete_material(material_id: str):
        library.delete(material_id)
        return {"library": library.all()}

    # --- saved designs -------------------------------------------------------------

    def save_design(design_id: str, body: DesignBody) -> dict:
        clash = designs.find_name(body.name, other_than=design_id)
        if clash and not body.replace:
            raise SavedError(f'You already have a design called "{clash["name"]}".')
        meta = designs.put(design_id, body.name, body.project, thumb=body.thumb)
        if clash:
            designs.delete(clash["id"])
        return meta

    @app.get("/api/designs")
    def list_designs():
        return {"designs": designs.list()}

    @app.get("/api/designs/{design_id}")
    def get_design(design_id: str):
        return designs.get(design_id)

    @app.post("/api/designs")
    def create_design(body: DesignBody):
        return save_design(new_id(), body)

    @app.put("/api/designs/{design_id}")
    def put_design(design_id: str, body: DesignBody):
        return save_design(design_id, body)

    @app.delete("/api/designs/{design_id}")
    def delete_design(design_id: str):
        designs.delete(design_id)
        return {"designs": designs.list()}

    # --- assistant chats -------------------------------------------------------------

    @app.get("/api/chats")
    def list_chats():
        return {"chats": chats.list()}

    @app.get("/api/chats/{chat_id}")
    def get_chat(chat_id: str):
        return chats.get(chat_id)

    @app.put("/api/chats/{chat_id}")
    def put_chat(chat_id: str, body: ChatSaveBody):
        return chats.put(chat_id, body.title or "Chat", body.messages, count=len(body.messages))

    @app.delete("/api/chats/{chat_id}")
    def delete_chat(chat_id: str):
        chats.delete(chat_id)
        return {"chats": chats.list()}

    @app.put("/api/config")
    def put_config(patch: dict):
        try:
            store.update(patch)
        except ValueError as exc:
            raise HTTPException(422, "Some settings aren't valid. Check the numbers and try again.") from exc
        return {"config": store.public(), "machine": machine().model_dump()}

    # --- machine -------------------------------------------------------------

    @app.get("/api/ports")
    def ports(all: bool = False):
        found, hidden = list_ports(show_all=all)
        return {
            "ports": [*found, {"device": SIM_PORT, "description": "Simulator (no laser needed)", "usb": False}],
            "hidden": hidden,
        }

    @app.post("/api/connect")
    def connect(body: ConnectBody):
        if body.port == SIM_PORT:
            profile = store.settings.machine
            sim = GrblSim(speed=sim_speed, settings={130: profile.bed_w, 131: profile.bed_h})
            controller.connect(SIM_PORT, transport=sim)
        else:
            controller.connect(body.port, body.baud or store.settings.machine.baud)
        return {"ok": True}

    @app.post("/api/disconnect")
    def disconnect():
        controller.disconnect()
        return {"ok": True}

    @app.post("/api/command")
    def command(body: CommandBody):
        controller.command(body.line)
        return {"ok": True}

    @app.post("/api/jog")
    def jog(body: JogBody):
        controller.jog(body.dx, body.dy, body.feed or store.settings.machine.jog_feed)
        return {"ok": True}

    @app.post("/api/jog/cancel")
    def jog_cancel():
        controller.jog_cancel()
        return {"ok": True}

    @app.post("/api/origin/{action}")
    def origin(action: Literal["set", "goto", "clear"]):
        {"set": controller.set_origin, "goto": controller.go_to_origin, "clear": controller.clear_origin}[action]()
        return {"ok": True}

    @app.post("/api/home")
    def home():
        controller.command("$H")
        return {"ok": True}

    @app.post("/api/unlock")
    def unlock():
        controller.command("$X")
        return {"ok": True}

    # --- jobs ----------------------------------------------------------------

    @app.post("/api/job/preview")
    def job_preview(body: JobBody):
        return build_job(body.job, machine()).summary()

    @app.post("/api/job/gcode", response_class=PlainTextResponse)
    def job_gcode(body: JobBody):
        result = build_job(body.job, machine())
        return "\n".join(result.lines) + "\n"

    @app.post("/api/job/start")
    def job_start(body: JobBody):
        require_laser_mode()
        result = build_job(body.job, machine())
        app.state.last_job = bugs.describe_job(body.job, result, "job")
        controller.start(
            result.lines,
            name=body.job.name,
            kind="job",
            est_seconds=result.est_seconds,
            line_seconds=result.line_seconds,
            stages=result.stages,
            line_stages=result.line_stages,
        )
        return result.summary()

    @app.post("/api/job/frame")
    def job_frame(body: FrameBody):
        profile = machine()
        result = build_job(body.job, profile)
        lines = frame_gcode(result.bounds, profile, dot_power=body.dot_power, finish=body.job.finish)
        app.state.last_job = {**bugs.describe_job(body.job, result, "frame"), "frame_gcode": lines}
        b = result.bounds
        perimeter = 2 * ((b.max_x - b.min_x) + (b.max_y - b.min_y))
        # The trip from the origin to the outline and (usually) back is often longer than the outline.
        trips = 2 if body.job.finish == "origin" else 1
        travel = math.hypot(b.min_x, b.min_y) * trips
        est = perimeter / profile.frame_feed * 60 + travel / profile.travel_feed * 60 + 1
        controller.start(lines, name="Frame", kind="frame", est_seconds=est)
        return result.summary()

    @app.post("/api/job/pause")
    def job_pause():
        controller.pause()
        return {"ok": True}

    @app.post("/api/job/resume")
    def job_resume():
        controller.resume()
        return {"ok": True}

    @app.post("/api/job/stop")
    def job_stop():
        controller.stop()
        return {"ok": True}

    # --- assistant -----------------------------------------------------------

    @app.post("/api/ai/chat")
    async def ai_chat(body: ChatBody):
        return await llm.chat(
            store.settings.llm,
            machine(),
            body.messages,
            body.context,
            body.image,
            completion=app.state.completion,
            library=library.as_prompt(),
            reference=body.reference,
        )

    @app.post("/api/ai/test")
    async def ai_test():
        reply = await llm.test_connection(store.settings.llm, completion=app.state.completion)
        return {"ok": True, "reply": reply}

    # --- bug reports -----------------------------------------------------------

    def secrets() -> tuple[str, ...]:
        return (
            store.settings.llm.api_key,
            store.settings.bugs.token,
            os.environ.get("GITHUB_TOKEN", ""),
            os.environ.get("GH_TOKEN", ""),
        )

    @app.get("/api/bug/status")
    def bug_status():
        repo = store.settings.bugs.repo
        github = app.state.github
        return {"repo": repo, "method": github.method(), "public": github.is_public(repo)}

    @app.post("/api/bug/preview")
    def bug_preview(draft: bugs.BugDraft):
        """Compose the report. Nothing is sent: the person reviews this text first."""
        settings = store.settings
        env = {
            "app": bugs.app_info(),
            "status": controller.snapshot(),
            "machine": machine().model_dump(),
            "llm": {
                "model": settings.llm.model,
                "key_set": bool(settings.llm.api_key),
                "api_base": settings.llm.api_base,
                "vision": settings.llm.vision,
            },
            "console": [
                f"{time.strftime('%H:%M:%S', time.localtime(e.get('t', 0)))} {'> ' if e.get('kind') == 'tx' else ''}{e.get('text', '')}"
                + (" [error]" if e.get("kind") == "error" else "")
                for e in hub.log
            ],
            "server_log": list(bugs.SERVER_LOG.records),
            "last_job": app.state.last_job,
            "library": library.all(),
        }
        return {"title": bugs.scrub(draft.title.strip(), secrets()), "body": bugs.compose(draft, env, secrets())}

    @app.post("/api/bug/report")
    def bug_report(report: bugs.BugSubmit):
        """File the reviewed text as an issue. Scrubbed again in case a secret was pasted in."""
        title = bugs.scrub(report.title.strip(), secrets())
        body = bugs.scrub(report.body, secrets())
        return app.state.github.create(store.settings.bugs.repo, title, body)

    # --- live updates --------------------------------------------------------

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        if not _host_ok(socket.headers, allowed_hosts):
            await socket.close(code=1008)
            return
        await socket.accept()
        client: asyncio.Queue = asyncio.Queue(maxsize=400)
        hub.clients[client] = None
        # Watch for the tab closing while waiting for events; otherwise this handler
        # would sit on the queue forever and keep the server from shutting down.
        closed = asyncio.ensure_future(_until_closed(socket))
        try:
            await socket.send_json({"type": "status", "status": controller.snapshot()})
            while True:
                waiting = asyncio.ensure_future(client.get())
                await asyncio.wait({waiting, closed}, return_when=asyncio.FIRST_COMPLETED)
                if closed.done():
                    waiting.cancel()
                    break
                await socket.send_json(waiting.result())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            closed.cancel()
            hub.clients.pop(client, None)

    # --- MCP: tools like Claude Code working the app -----------------------------------

    def ports_list() -> list[str]:
        found, _ = list_ports()
        return [p["device"] for p in found] + [SIM_PORT]

    def machine_state() -> dict:
        status = controller.snapshot()
        settings = status.pop("settings", {})
        status.pop("mpos", None)
        state = {
            "machine": {
                **status,
                "origin_set": any(abs(v) > 0.001 for v in status["wco"]),
                "laser_mode": settings.get("32") != 0,
            },
            "bed_mm": [machine().bed_w, machine().bed_h],
        }
        if not status["connected"]:
            state["ports"] = ports_list()
        return state

    def tool(fn):
        """A machine tool: runs off the event loop; returns {"text", "note"} (note is shown in the page)."""

        async def run(args: dict) -> dict:
            return await asyncio.to_thread(fn, args)

        return run

    @tool
    def connect_machine(args: dict) -> dict:
        port = str(args.get("port", "")).strip()
        if port not in ports_list():
            raise mcp.ToolError(f'No port called "{port}". Ports: {", ".join(ports_list())}.')
        connect(ConnectBody(port=port))
        name = "the simulator" if port == SIM_PORT else port
        return {"text": f"Connecting to {name}. Check get_state for when it is idle.", "note": f"connected to {name}"}

    @tool
    def jog_tool(args: dict) -> dict:
        body = JogBody(dx=args.get("dx_mm", 0), dy=args.get("dy_mm", 0), feed=args.get("feed"))
        jog(body)
        return {"text": f"Jogging {body.dx:g}, {body.dy:g} mm.", "note": f"moved the head {body.dx:g}, {body.dy:g} mm"}

    @tool
    def origin_tool(args: dict) -> dict:
        action = args.get("action")
        if action not in ("set", "go", "clear"):
            raise mcp.ToolError('action must be "set", "go" or "clear".')
        origin("goto" if action == "go" else action)
        done = {"set": "set the origin here", "go": "moved the head to the origin", "clear": "cleared the origin"}[
            action
        ]
        return {"text": done[0].upper() + done[1:] + ".", "note": done}

    @tool
    def pause_tool(args: dict) -> dict:
        controller.pause()
        return {"text": "Paused. Only the person can resume it, from the app.", "note": "paused the job"}

    @tool
    def stop_tool(args: dict) -> dict:
        controller.stop()
        return {"text": "Stopping: the laser is off and the head keeps its position.", "note": "stopped the job"}

    async def list_materials_tool(args: dict) -> dict:
        return {"text": mcp.materials_text(library.as_prompt())}

    async def list_saved_tool(args: dict) -> dict:
        found = [{"id": d["id"], "name": d["name"], "updated": d.get("updated")} for d in designs.list()]
        return {"text": found or "No saved designs yet."}

    bridge = mcp.Bridge(hub)
    mcp_server = mcp.Server(
        bridge,
        machine={
            "connect_machine": connect_machine,
            "jog": jog_tool,
            "origin": origin_tool,
            "pause_job": pause_tool,
            "stop_job": stop_tool,
            "list_materials": list_materials_tool,
            "list_saved_designs": list_saved_tool,
        },
        machine_state=lambda: asyncio.to_thread(machine_state),
        notify=lambda text: hub.publish({"type": "mcp-note", "text": text}),
        errors=(MachineError, JobError, LibraryError, NotFound, SavedError, ValidationError),
    )
    app.state.mcp = mcp_server

    @app.post("/mcp")
    async def mcp_endpoint(request: Request):
        try:
            payload = await request.json()
        except ValueError:
            return JSONResponse(mcp._error(None, -32700, "Parse error"), status_code=400)
        if isinstance(payload, list):
            replies = [r for r in [await mcp_server.handle(m) for m in payload] if r]
        else:
            reply = await mcp_server.handle(payload)
            replies = reply
        if not replies:
            return Response(status_code=202)
        return JSONResponse(replies)

    @app.get("/mcp")
    @app.delete("/mcp")
    def mcp_no_stream():
        # No server-initiated messages and no sessions, so there is no stream to open or end.
        return Response(status_code=405, headers={"Allow": "POST"})

    @app.post("/api/mcp/reply")
    def mcp_reply(body: McpReplyBody):
        bridge.reply(body.id, body.ok, body.result, body.error)
        return {"ok": True}

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app
