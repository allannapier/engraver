"""The local web server: static app, machine API, job API, assistant API.

Only reachable from this computer. Requests are checked so that a web page
on another site can't call the API and drive the laser.
"""

from __future__ import annotations

import asyncio
import os
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, llm
from .config import ConfigStore
from .gcode import JobError, JobSpec, MachineProfile, build_job, frame_gcode
from .grbl.controller import GrblController, MachineError, list_ports
from .grbl.simulator import GrblSim
from .library import LibraryError, MaterialLibrary, UserMaterial
from .library import default_path as library_path
from .materials import MATERIALS, NEVER

STATIC_DIR = Path(__file__).parent / "static"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
SIM_PORT = "sim"


class Hub:
    """Fans controller events out to every open browser tab."""

    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self.clients: set[asyncio.Queue] = set()
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


class ChatBody(BaseModel):
    messages: list[dict]
    context: dict = {}
    image: str | None = None


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


def create_app(store: ConfigStore | None = None, sim_speed: float | None = None, extra_hosts: tuple[str, ...] = ()) -> FastAPI:
    store = store or ConfigStore()
    library = MaterialLibrary(library_path(store.path))
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

    app = FastAPI(title="Engraver", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.controller = controller
    app.state.store = store
    app.state.hub = hub
    app.state.library = library
    app.state.completion = None  # tests swap in a fake provider here

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if not _host_ok(request.headers, allowed_hosts):
            return JSONResponse({"detail": "Request refused: Engraver only answers its own page on this computer."}, status_code=403)
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

    @app.exception_handler(LibraryError)
    async def library_error(request: Request, exc: LibraryError):
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

    @app.put("/api/config")
    def put_config(patch: dict):
        try:
            store.update(patch)
        except ValueError as exc:
            raise HTTPException(422, "Some settings aren't valid. Check the numbers and try again.") from exc
        return {"config": store.public(), "machine": machine().model_dump()}

    # --- machine -------------------------------------------------------------

    @app.get("/api/ports")
    def ports():
        return {"ports": list_ports() + [{"device": SIM_PORT, "description": "Simulator (no laser needed)", "usb": False}]}

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
        controller.start(result.lines, name=body.job.name, kind="job", est_seconds=result.est_seconds, line_seconds=result.line_seconds)
        return result.summary()

    @app.post("/api/job/frame")
    def job_frame(body: FrameBody):
        profile = machine()
        result = build_job(body.job, profile)
        lines = frame_gcode(result.bounds, profile, dot_power=body.dot_power, finish=body.job.finish)
        b = result.bounds
        perimeter = 2 * ((b.max_x - b.min_x) + (b.max_y - b.min_y))
        controller.start(lines, name="Frame", kind="frame", est_seconds=perimeter / profile.frame_feed * 60)
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
            store.settings.llm, machine(), body.messages, body.context, body.image,
            completion=app.state.completion, library=library.as_prompt(),
        )

    @app.post("/api/ai/test")
    async def ai_test():
        reply = await llm.test_connection(store.settings.llm, completion=app.state.completion)
        return {"ok": True, "reply": reply}

    # --- live updates --------------------------------------------------------

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        if not _host_ok(socket.headers, allowed_hosts):
            await socket.close(code=1008)
            return
        await socket.accept()
        client: asyncio.Queue = asyncio.Queue(maxsize=400)
        hub.clients.add(client)
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
            hub.clients.discard(client)

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app
