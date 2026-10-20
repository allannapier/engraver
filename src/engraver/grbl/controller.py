"""Talks to a GRBL laser over a serial port (or the simulator).

One background thread owns the port. It streams G-code with GRBL's
character-counting protocol, polls status, and reports everything through a
single `on_event` callback. Public methods are safe to call from any thread.

Safety rules baked in here:
- Stop always sends feed hold (laser off in laser mode), waits for motion to
  finish, then soft-resets, so position is kept and nothing is left queued.
- Any GRBL error on a job line halts the job the same way.
- Manual commands and jogging are refused while a job is running.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

from . import protocol as p


class _Tracked(str):
    """A manual line whose ok or error somebody is waiting for."""

    done: threading.Event
    error: int | None

    def __new__(cls, text: str):
        obj = super().__new__(cls, text)
        obj.done = threading.Event()
        obj.error = None
        return obj


class MachineError(Exception):
    """A request the machine can't act on right now. The message is shown to the user."""


@dataclass
class Job:
    lines: list[str]
    name: str = "Job"
    kind: str = "job"  # "job" or "frame"
    est_seconds: float = 0.0
    state: str = "running"  # running | paused | stopping | done | stopped | error
    sent: int = 0
    acked: int = 0
    started: float = field(default_factory=time.time)
    ended: float | None = None
    error: str | None = None
    idle_reports: int = 0
    line_seconds: list[float] | None = None  # estimated time at the end of each line
    stages: list[dict] | None = None  # one per layer pass, see gcode.GcodeResult
    line_stages: list[int] | None = None  # index into `stages` for each line

    def progress(self) -> float:
        if self.state == "done":
            return 1.0
        if not self.lines or not self.acked:
            return 0.0
        marks = self.line_seconds
        if marks and marks[-1] > 0:
            return min(1.0, marks[min(self.acked, len(marks)) - 1] / marks[-1])
        return self.acked / len(self.lines)

    def stage(self) -> dict | None:
        """The layer pass being burned. A pass after the first opens with a dwell that
        GRBL acknowledges only once the planner is empty, so the last acknowledged
        line tells which pass the head is on."""
        if not self.stages or not self.line_stages or self.state == "done":
            return None
        index = self.line_stages[min(self.acked, len(self.line_stages)) - 1] if self.acked else 0
        return dict(self.stages[max(index, 0)])

    def public(self) -> dict:
        end = self.ended or time.time()
        return {
            "progress": round(self.progress(), 4),
            "name": self.name,
            "kind": self.kind,
            "state": self.state,
            "total": len(self.lines),
            "acked": self.acked,
            "elapsed": round(end - self.started, 1),
            "est_seconds": round(self.est_seconds, 1),
            "error": self.error,
            "stage": self.stage(),
        }


class SerialTransport:
    def __init__(self, port: str, baud: int):
        import serial  # imported here so the simulator works without pyserial installed

        self._ser = serial.Serial(port, baud, timeout=0.02, write_timeout=2)

    def write(self, data: bytes) -> None:
        self._ser.write(data)

    def read(self, timeout: float = 0.02) -> bytes:
        return self._ser.read(self._ser.in_waiting or 1)

    def close(self) -> None:
        self._ser.close()


def list_ports(show_all: bool = False) -> tuple[list[dict], int]:
    """Serial ports worth offering, and how many were left out.

    Linux lists 32 legacy /dev/ttyS* ports whether or not anything is attached,
    and macOS lists Bluetooth ones; neither has any hardware details. Those are
    hidden unless `show_all`, so the laser's USB port isn't buried.
    """
    try:
        from serial.tools import list_ports as lp
    except ImportError:
        return [], 0
    ports, hidden = [], 0
    for info in lp.comports():
        desc = info.description if info.description and info.description != "n/a" else ""
        real = info.vid is not None or (info.hwid or "n/a") != "n/a"
        if not real and not show_all:
            hidden += 1
            continue
        ports.append({"device": info.device, "description": desc, "usb": info.vid is not None})
    # USB serial adapters first: that's where the laser will be.
    ports.sort(key=lambda item: (not item["usb"], item["device"]))
    return ports, hidden


class GrblController:
    POLL_SECONDS = 0.2

    def __init__(self, on_event: Callable[[dict], None] | None = None, rx_buffer: int = 120):
        self._on_event = on_event or (lambda event: None)
        # Stay a few bytes under GRBL's 128-byte buffer.
        self.rx_buffer = rx_buffer
        self._lock = threading.RLock()
        self._wlock = threading.Lock()
        self._transport = None
        self._thread: threading.Thread | None = None
        self._alive = False
        self._reset_state()

    def _reset_state(self) -> None:
        self.connected = False
        self.port = ""
        self.state = "Disconnected"
        self.substate: int | None = None
        self.mpos = [0.0, 0.0]
        self.wco = [0.0, 0.0]
        self.feed = 0.0
        self.power = 0.0
        self.version = ""
        self.settings: dict[int, float] = {}
        self.alarm: str | None = None
        self.job: Job | None = None
        self._manual: deque[str] = deque()
        self._sent: deque[tuple[int, bool, str]] = deque()  # (bytes, is_job_line, text)
        self._sent_bytes = 0
        self._halt: dict | None = None
        self._expect_reset = False
        self._last_status = 0.0

    # --- public API ----------------------------------------------------------

    def connect(self, port: str, baud: int = 115200, transport=None) -> None:
        with self._lock:
            if self.connected or self._thread:
                raise MachineError("Already connected. Disconnect first.")
            try:
                self._transport = transport or SerialTransport(port, baud)
            except Exception as exc:  # pyserial raises several unrelated types
                raise MachineError(f"Could not open {port}: {exc}") from exc
            self._reset_state()
            self.port = port
            self.state = "Connecting"
            self._alive = True
            self._thread = threading.Thread(target=self._run, name="grbl-io", daemon=True)
            self._thread.start()

    def disconnect(self) -> None:
        thread = self._thread
        if not thread:
            return
        with self._lock:
            job = self.job
            busy = bool(job and job.state in ("running", "paused", "stopping"))
            if (busy or self.state in ("Run", "Jog", "Hold")) and self.connected:
                # Never leave the laser running with nobody listening: stop it the careful way first.
                if job and job.state == "stopping" and self._halt:
                    self._halt.update(final="stopped", error="Disconnected while running")
                self._begin_halt("stopped", "Disconnected while running" if busy else None)
        deadline = time.monotonic() + 4.0
        while self._halt and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.02)
        self._alive = False
        thread.join(timeout=2)  # the IO thread closes the port on its way out

    def command(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        with self._lock:
            self._require_free()
            self._manual.append(line)

    def jog(self, dx: float, dy: float, feed: float, wait: float | None = None) -> None:
        """Queue a jog. With `wait`, block until GRBL answers it and raise if it refuses.

        A garbled line (error 1 or 2, usually serial noise) is sent once more.
        """
        if dx == 0 and dy == 0:
            return
        for attempt in range(2 if wait else 1):
            line = _Tracked(f"$J=G91 G21 X{dx:.3f} Y{dy:.3f} F{feed:.0f}")
            with self._lock:
                self._require_free()
                if self.state not in ("Idle", "Jog"):
                    raise MachineError(f"Can't move while the machine is {self.state.lower()}.")
                self._manual.append(line)
            if not wait:
                return
            if not line.done.wait(wait):
                raise MachineError("The machine didn't answer the jog. Check the connection and try again.")
            if line.error is None:
                return
            if line.error in (1, 2) and attempt == 0:
                continue
            if line.error == 0:
                raise MachineError("The jog was cancelled by a stop or a reset.")
            raise MachineError(f"The machine refused the jog: {p.error_text(line.error)}.")

    def jog_cancel(self) -> None:
        self._write(p.JOG_CANCEL)

    def set_origin(self) -> None:
        """Make the current head position work X0 Y0 (stored in G54, survives a stop)."""
        self.command("G10 L20 P1 X0 Y0")
        with self._lock:
            self.wco = list(self.mpos)

    def clear_origin(self) -> None:
        self.command("G10 L2 P1 X0 Y0")
        with self._lock:
            self.wco = [0.0, 0.0]

    def go_to_origin(self) -> None:
        with self._lock:
            self._require_free()
            if self.state != "Idle":
                raise MachineError(f"Can't move while the machine is {self.state.lower()}.")
            self._manual.append("M5")
            self._manual.append("G90 G0 X0 Y0")

    def start(
        self,
        lines: list[str],
        name: str = "Job",
        kind: str = "job",
        est_seconds: float = 0.0,
        line_seconds: list[float] | None = None,
        stages: list[dict] | None = None,
        line_stages: list[int] | None = None,
    ) -> None:
        cleaned = [line.split(";")[0].strip() for line in lines]
        if line_seconds is not None and len(line_seconds) == len(lines):
            line_seconds = [mark for mark, text in zip(line_seconds, cleaned, strict=False) if text]
        else:
            line_seconds = None
        if stages and line_stages is not None and len(line_stages) == len(lines):
            line_stages = [mark for mark, text in zip(line_stages, cleaned, strict=False) if text]
        else:
            stages = line_stages = None
        lines = [text for text in cleaned if text]
        if not lines:
            raise MachineError("Nothing to send: the job is empty.")
        with self._lock:
            self._require_free()
            if self.state == "Alarm":
                raise MachineError("Machine is locked after an alarm. Unlock it first.")
            if self.state != "Idle":
                raise MachineError(f"Can't start while the machine is {self.state.lower()}.")
            too_long = next((text for text in lines if len(text) + 1 > self.rx_buffer), None)
            if too_long:
                raise MachineError(f"G-code line too long for the controller: {too_long[:40]}…")
            self.job = Job(
                lines=lines,
                name=name,
                kind=kind,
                est_seconds=est_seconds,
                line_seconds=line_seconds,
                stages=stages,
                line_stages=line_stages,
            )
            self._log("info", f"{name} started ({len(lines)} lines)")

    def pause(self) -> None:
        with self._lock:
            if not self.job or self.job.state != "running":
                raise MachineError("Nothing is running.")
            self.job.state = "paused"
        self._write(p.FEED_HOLD)
        self._log("info", "Paused")

    def resume(self) -> None:
        with self._lock:
            if not self.job or self.job.state != "paused":
                raise MachineError("Nothing is paused.")
            self.job.state = "running"
            self.job.idle_reports = 0
        self._write(p.CYCLE_START)
        self._log("info", "Resumed")

    def stop(self) -> None:
        """Halt whatever is happening. Safe to call at any time while connected."""
        with self._lock:
            if not self.connected:
                return
            self._begin_halt("stopped", None)
        self._log("info", "Stop requested")

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "connected": self.connected,
                "port": self.port,
                "state": self.state,
                "substate": self.substate,
                "mpos": [round(v, 3) for v in self.mpos],
                "wpos": [round(self.mpos[i] - self.wco[i], 3) for i in range(2)],
                "wco": [round(v, 3) for v in self.wco],
                "feed": self.feed,
                "power": self.power,
                "version": self.version,
                "alarm": self.alarm,
                "settings": {str(k): v for k, v in self.settings.items()},
                "job": self.job.public() if self.job else None,
            }

    # --- helpers -------------------------------------------------------------

    def _require_free(self) -> None:
        if not self.connected:
            raise MachineError("Not connected to the laser.")
        if self._halt:
            raise MachineError("Stopping. Try again in a moment.")
        if self.job and self.job.state in ("running", "paused", "stopping"):
            raise MachineError("A job is running. Stop it first.")

    def _emit(self, event: dict) -> None:
        try:
            self._on_event(event)
        except Exception:
            pass  # a broken listener must never take down the IO thread

    def _log(self, kind: str, text: str) -> None:
        self._emit({"type": "log", "kind": kind, "text": text, "t": time.time()})

    def _write(self, data: bytes) -> None:
        transport = self._transport
        if not transport:
            return
        try:
            with self._wlock:
                transport.write(data)
        except Exception as exc:
            self._log("error", f"Write failed: {exc}")
            self._alive = False

    def _close(self, reason: str) -> None:
        with self._lock:
            transport, self._transport = self._transport, None
            self._thread = None
            job = self.job
            was_connected = self.connected or self.state == "Connecting"
            self._abandon()  # nobody will answer a jog that's waiting now
            self._reset_state()
            if job and job.state in ("running", "paused", "stopping"):
                job.state, job.error, job.ended = "error", "Connection lost", time.time()
            self.job = job  # keep the last job's outcome visible after the port closes
        if transport:
            try:
                transport.close()
            except Exception:
                pass
        if was_connected:
            self._log("info", reason)
        self._emit({"type": "status", "status": self.snapshot()})

    def _begin_halt(self, final: str, error: str | None) -> None:
        """Feed hold now; the IO loop soft-resets once the machine has really stopped.

        "Really" matters. A hold sent while GRBL is still idle is ignored, and lines
        already in its buffer then start moving. So the reset waits for status
        reports that arrived after the hold, and the hold is sent again if one of
        them shows motion.
        """
        if self._halt:
            return
        self._abandon()
        self._manual.clear()
        if self.job and self.job.state in ("running", "paused"):
            self.job.state = "stopping"
        self._halt = {"at": time.monotonic(), "final": final, "error": error, "fresh": 0, "idle": 0}
        self._write(p.FEED_HOLD)
        self._last_status = 0.0  # ask for a status report straight away

    def _finish_halt(self) -> None:
        halt, self._halt = self._halt, None
        self._expect_reset = True
        self._write(p.SOFT_RESET)
        self._abandon()
        self._sent.clear()
        self._sent_bytes = 0
        if self.job and self.job.state == "stopping":
            self.job.state = halt["final"]
            self.job.error = halt["error"]
            self.job.ended = time.time()
            self._log("error" if halt["error"] else "info", halt["error"] or f"{self.job.name} stopped")

    # --- IO thread -----------------------------------------------------------

    def _run(self) -> None:
        buf = b""
        try:
            if not self._handshake():
                return
            while self._alive:
                data = self._transport.read(0.02)
                if data:
                    buf += data
                    *lines, buf = buf.split(b"\n")
                    for raw in lines:
                        text = raw.decode(errors="replace").strip()
                        if text:
                            with self._lock:
                                self._handle(text)
                now = time.monotonic()
                with self._lock:
                    if self._halt:
                        halt = self._halt
                        held = self.state == "Hold" and self.substate in (0, None) and halt["fresh"] >= 1
                        idle = self.state == "Idle" and halt["idle"] >= 2
                        alarm = self.state == "Alarm" and halt["fresh"] >= 1
                        # Past the deadline the laser being off matters more than keeping position.
                        if held or idle or alarm or now - halt["at"] > 3.0:
                            self._finish_halt()
                    else:
                        self._pump()
                # Poll faster while stopping, so the reset follows the hold closely.
                if now - self._last_status > (0.05 if self._halt else self.POLL_SECONDS):
                    self._last_status = now
                    self._write(p.STATUS_QUERY)
        except Exception as exc:
            self._log("error", f"Connection lost: {exc}")
        finally:
            self._close("Disconnected")

    def _handshake(self) -> bool:
        """Wait for GRBL's banner. Boards that don't reset when the port opens get
        a soft reset; ones with a non-standard banner are accepted if they answer `?`."""
        self._log("info", f"Connecting to {self.port}…")
        seen = b""
        step, deadline = 0, time.monotonic() + 2.0
        while self._alive:
            seen += self._transport.read(0.05)
            if b"Grbl" in seen and seen.rstrip().endswith(b"]"):
                break
            if step == 2 and (b"<" in seen and b">" in seen):
                break
            if time.monotonic() > deadline:
                step += 1
                if step == 1:
                    self._write(p.SOFT_RESET)
                    deadline = time.monotonic() + 3.0
                elif step == 2:
                    self._write(b"\n" + p.STATUS_QUERY)
                    deadline = time.monotonic() + 1.5
                else:
                    self._log(
                        "error", "No reply from the device. Check the port, the cable and that the laser is powered on."
                    )
                    return False
        if not self._alive:
            return False
        with self._lock:
            self.version = "GRBL (version not reported)"
            for raw in seen.split(b"\n"):
                text = raw.decode(errors="replace").strip()
                if text.startswith("Grbl"):
                    self.version = text.split("[")[0].strip()
                    self._log("rx", text)
                elif text.startswith("ALARM"):
                    self._handle(text)
            self.connected = True
            if self.state == "Connecting":
                self.state = "Idle"
            self._manual.extend(["$I", "$$"])
        return True

    def _pump(self) -> None:
        """Send as many queued lines as fit in GRBL's receive buffer."""
        while True:
            job = self.job
            if self._manual:
                text, is_job = self._manual[0], False
            elif job and job.state in ("running", "paused") and job.sent < len(job.lines):
                text, is_job = job.lines[job.sent], True
            else:
                return
            size = len(text) + 1
            if self._sent_bytes + size > self.rx_buffer and self._sent:
                return
            if is_job:
                job.sent += 1
            else:
                self._manual.popleft()
                if text not in ("$I", "$$"):
                    self._log("tx", text)
            self._sent.append((size, is_job, text))
            self._sent_bytes += size
            self._write(text.encode() + b"\n")

    def _handle(self, text: str) -> None:
        if text == "ok":
            self._ack(None)
        elif text.startswith("error:"):
            self._ack(_int(text[6:]))
        elif text.startswith("<"):
            self._on_status(text)
        elif text.startswith("ALARM:"):
            self.alarm = p.alarm_text(_int(text[6:]))
            self.state = "Alarm"
            self._log("error", f"Alarm: {self.alarm}")
            if self.job and self.job.state in ("running", "paused", "stopping"):
                self.job.state, self.job.error, self.job.ended = "error", f"Alarm: {self.alarm}", time.time()
            self._abandon()
            self._sent.clear()
            self._sent_bytes = 0
            self._manual.clear()
        elif text.startswith("Grbl"):
            self.version = text.split("[")[0].strip()
            if self._expect_reset:
                self._expect_reset = False
            else:
                # The controller restarted on its own (power blip, USB glitch).
                self._abandon()
                self._sent.clear()
                self._sent_bytes = 0
                if self.job and self.job.state in ("running", "paused", "stopping"):
                    self.job.state, self.job.error, self.job.ended = (
                        "error",
                        "The controller restarted mid-job",
                        time.time(),
                    )
                    self._log("error", self.job.error)
        elif (setting := p.parse_setting(text)) is not None:
            self.settings[setting[0]] = setting[1]
        elif text.startswith("[VER:"):
            self._log("rx", text)
        elif text.startswith("[OPT:"):
            pass
        else:
            self._log("rx", text)

    def _ack(self, error: int | None) -> None:
        if not self._sent:
            return
        size, is_job, text = self._sent.popleft()
        self._sent_bytes -= size
        if is_job:
            job = self.job
            if not job:
                return
            job.acked += 1
            if error is not None and job.state in ("running", "paused"):
                self._begin_halt("error", f"{p.error_text(error)} (line {job.acked}: {text})")
        elif error is not None:
            self._log("error", f"{text} → {p.error_text(error)}")
        elif text not in ("$I", "$$"):
            self._log("rx", "ok")
        if not is_job and isinstance(text, _Tracked):
            self._settle(text, error)

    @staticmethod
    def _settle(text: str, error: int | None) -> None:
        if isinstance(text, _Tracked):
            text.error = error
            text.done.set()

    def _abandon(self) -> None:
        """Fail every waiting line: what they were queued behind is being thrown away."""
        for text in [*self._manual, *(t for _, job, t in self._sent if not job)]:
            self._settle(text, 0)

    def _on_status(self, text: str) -> None:
        status = p.parse_status(text)
        if not status:
            return
        self.state = status["state"]
        self.substate = status.get("substate")
        if self.state != "Alarm":
            self.alarm = None
        if "wco" in status:
            self.wco = status["wco"][:2]
        if "mpos" in status:
            self.mpos = status["mpos"][:2]
        elif "wpos" in status:
            self.mpos = [status["wpos"][i] + self.wco[i] for i in range(2)]
        self.feed = status.get("feed", self.feed)
        self.power = status.get("power", self.power)
        if self._halt:
            halt = self._halt
            halt["fresh"] += 1
            if self.state in ("Run", "Jog", "Home"):
                # Moving after the hold was sent: it arrived too early. Hold again.
                halt["idle"] = 0
                self._write(p.FEED_HOLD)
            elif self.state == "Idle":
                # Only trust idle when nothing sent is still waiting to be read and run.
                halt["idle"] = halt["idle"] + 1 if not self._sent else 0
        job = self.job
        if job and job.state == "running" and job.acked >= len(job.lines):
            # Everything is acknowledged; wait for motion to actually finish.
            # Two idle reports in a row guards against one that was already in flight.
            job.idle_reports = job.idle_reports + 1 if self.state == "Idle" else 0
            if job.idle_reports >= 2:
                job.state, job.ended = "done", time.time()
                self._log("info", f"{job.name} finished in {job.public()['elapsed']:.0f}s")
        self._emit({"type": "status", "status": self.snapshot()})


def _int(text: str) -> int:
    try:
        return int(text.strip())
    except ValueError:
        return 0
