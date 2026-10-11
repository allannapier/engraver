"""An in-process fake GRBL 1.1 laser, used for development and tests.

It behaves like the real controller where it matters to a sender: a 128-byte
serial receive buffer, a small planner queue that delays `ok` when full,
realtime commands that bypass the buffer, feed hold, soft reset, alarms and
status reports. Moves take real time (scaled by `speed`) so pause, stop and
progress can be exercised. Every laser-on move is recorded in `burns`.
"""

from __future__ import annotations

import math
import queue
import re
import threading
import time
from collections import deque

WORD_RE = re.compile(r"([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))")

DEFAULT_SETTINGS = {
    10: 1,
    20: 0,
    21: 0,
    22: 0,
    30: 1000,
    31: 0,
    32: 1,
    100: 80,
    101: 80,
    110: 6000,
    111: 6000,
    120: 1000,
    121: 1000,
    130: 410,
    131: 400,
}


class GrblSim:
    RX_BUFFER = 128
    PLANNER_BLOCKS = 16
    TICK = 0.004

    def __init__(self, speed: float = 1.0, settings: dict | None = None):
        self.speed = speed
        self.settings = dict(DEFAULT_SETTINGS)
        if settings:
            self.settings.update(settings)
        self._out: queue.Queue[bytes] = queue.Queue()
        self._lock = threading.RLock()
        self._rx = bytearray()
        self._planner: deque[dict] = deque()
        self._cur: dict | None = None
        self.state = "Idle"
        self.mpos = [0.0, 0.0]
        self.wco = [0.0, 0.0]  # G54 offset, survives reset like EEPROM
        self._g92 = [0.0, 0.0]
        self._plan_pos = [0.0, 0.0]  # machine position at the end of the planner
        self._reset_modal()
        self._reports = 0
        self._wco_dirty = True
        # Things tests assert on.
        self.burns: list[tuple[float, float, float, float, float]] = []
        self.rx_overflow = False
        self.lines_seen = 0
        self.resets = 0
        self._alive = True
        self._thread = threading.Thread(target=self._run, name="grbl-sim", daemon=True)
        self._thread.start()
        self._send("")
        self._send("Grbl 1.1h ['$' for help]")

    # --- transport interface -------------------------------------------------

    def write(self, data: bytes) -> None:
        with self._lock:
            for byte in data:
                if byte == 0x18:
                    self._reset()
                elif byte == 0x3F:  # ?
                    self._send(self._status())
                elif byte == 0x21:  # !
                    if self.state in ("Run", "Jog"):
                        self._held_from = self.state
                        self.state = "Hold"
                elif byte == 0x7E:  # ~
                    if self.state == "Hold":
                        self.state = "Run" if (self._cur or self._planner) else "Idle"
                elif byte == 0x85:
                    if self.state == "Jog" or (self.state == "Hold" and self._held_from == "Jog"):
                        self._flush_motion()
                        self.state = "Idle"
                else:
                    self._rx.append(byte)
                    if len(self._rx) > self.RX_BUFFER:
                        self.rx_overflow = True

    def read(self, timeout: float = 0.05) -> bytes:
        try:
            return self._out.get(timeout=timeout)
        except queue.Empty:
            return b""

    def close(self) -> None:
        self._alive = False

    # --- internals -----------------------------------------------------------

    def _send(self, text: str) -> None:
        self._out.put((text + "\r\n").encode())

    def _reset_modal(self) -> None:
        self._abs = True
        self._motion = 0
        self._feed = 0.0
        self._s = 0.0
        self._spindle = 5
        self._g92 = [0.0, 0.0]
        self._held_from = "Run"

    def _flush_motion(self) -> None:
        self._planner.clear()
        self._cur = None
        self._plan_pos = list(self.mpos)

    def _reset(self) -> None:
        self.resets += 1
        moving = self.state in ("Run", "Jog")
        self._flush_motion()
        self._rx.clear()
        self._reset_modal()
        self._wco_dirty = True
        self._send("")
        self._send("Grbl 1.1h ['$' for help]")
        if moving:
            self.state = "Alarm"
            self._send("ALARM:3")
        elif self.state != "Alarm":
            self.state = "Idle"
        if self.state == "Alarm":
            self._send("[MSG:'$H'|'$X' to unlock]")

    def _offset(self) -> list[float]:
        return [self.wco[0] + self._g92[0], self.wco[1] + self._g92[1]]

    def _status(self) -> str:
        state = "Hold:0" if self.state == "Hold" else self.state
        feed = self._cur["feed"] if self._cur and self.state in ("Run", "Jog") else 0
        power = self._cur["s"] if self._cur and self.state == "Run" else 0
        text = f"<{state}|MPos:{self.mpos[0]:.3f},{self.mpos[1]:.3f},0.000|FS:{feed:.0f},{power:.0f}"
        self._reports += 1
        if self._wco_dirty or self._reports % 5 == 0:
            off = self._offset()
            text += f"|WCO:{off[0]:.3f},{off[1]:.3f},0.000"
            self._wco_dirty = False
        return text + ">"

    def _run(self) -> None:
        last = time.monotonic()
        while self._alive:
            time.sleep(self.TICK)
            now = time.monotonic()
            dt, last = now - last, now
            with self._lock:
                self._parse_pending()
                self._advance(dt)

    def _parse_pending(self) -> None:
        while len(self._planner) < self.PLANNER_BLOCKS:
            end = self._rx.find(b"\n")
            if end < 0:
                return
            raw = self._rx[:end].decode(errors="replace")
            line = re.sub(r"\(.*?\)|;.*", "", raw).strip().upper().replace(" ", "")
            busy = bool(self._cur or self._planner)
            # Like GRBL, commands that change state wait for motion to finish.
            if busy and self._needs_sync(line):
                return
            del self._rx[: end + 1]
            self.lines_seen += 1
            if not line:
                self._send("ok")
                continue
            code = self._exec(line)
            self._send("ok" if code == 0 else f"error:{code}")

    @staticmethod
    def _needs_sync(line: str) -> bool:
        if line.startswith("$J="):
            return False
        return line.startswith("$") or "G10" in line or "G92" in line or "G4" in re.findall(r"G\d+", line)

    def _exec(self, line: str) -> int:
        if line.startswith("$"):
            return self._exec_system(line)
        if self.state == "Alarm":
            return 9
        return self._exec_gcode(line, jog=False)

    def _exec_system(self, line: str) -> int:
        if line.startswith("$J="):
            if self.state not in ("Idle", "Jog"):
                return 16
            return self._exec_gcode(line[3:], jog=True)
        if self.state not in ("Idle", "Alarm"):
            return 8
        if line == "$$":
            for key in sorted(self.settings):
                self._send(f"${key}={self.settings[key]}")
        elif line == "$I":
            self._send("[VER:1.1h.20190825:ENGRAVER-SIM]")
            self._send("[OPT:V,15,128]")
        elif line == "$X":
            if self.state == "Alarm":
                self.state = "Idle"
                self._send("[MSG:Caution: Unlocked]")
        elif line == "$H":
            if not self.settings.get(22):
                return 5
            self.mpos = [0.0, 0.0]
            self._plan_pos = [0.0, 0.0]
            self.state = "Idle"
        elif line == "$#":
            self._send(f"[G54:{self.wco[0]:.3f},{self.wco[1]:.3f},0.000]")
        elif line == "$G":
            self._send(
                f"[GC:G{self._motion} G54 G17 G21 G{90 if self._abs else 91} M{self._spindle} F{self._feed:g} S{self._s:g}]"
            )
        else:
            match = re.fullmatch(r"\$(\d+)=([-\d.]+)", line)
            if not match:
                return 3
            self.settings[int(match.group(1))] = float(match.group(2))
        return 0

    def _exec_gcode(self, line: str, jog: bool) -> int:
        words = WORD_RE.findall(line)
        if not words or "".join(a + b for a, b in words) != line:
            return 1 if not words else 2
        gs = [float(v) for k, v in words if k == "G"]
        ms = [int(float(v)) for k, v in words if k == "M"]
        args = {k: float(v) for k, v in words if k not in "GM"}
        absolute = self._abs
        for g in gs:
            if g in (0, 1, 2, 3) and not jog:
                self._motion = int(g)
            elif g == 90:
                absolute = True
            elif g == 91:
                absolute = False
            elif g not in (4, 10, 17, 20, 21, 54, 92, 94):
                return 20
        if not jog:
            self._abs = absolute
        for m in ms:
            if m in (3, 4, 5):
                self._spindle = m
            elif m not in (2, 8, 9, 30):
                return 20
        if "F" in args and not jog:
            self._feed = args["F"]
        if "S" in args:
            self._s = args["S"]
        if 4 in gs:
            return 0
        off = self._offset()
        here = self._plan_pos
        if 10 in gs:
            # L20 sets the offset so the current position reads as X/Y; L2 sets it directly.
            mode = args.get("L")
            for i, axis in enumerate("XY"):
                if axis in args:
                    self.wco[i] = here[i] - args[axis] if mode == 20 else args[axis]
            self._wco_dirty = True
            return 0
        if 92 in gs:
            for i, axis in enumerate("XY"):
                if axis in args:
                    self._g92[i] = here[i] - self.wco[i] - args[axis]
            self._wco_dirty = True
            return 0
        if "X" not in args and "Y" not in args:
            return 26 if jog else 0
        target = list(here)
        for i, axis in enumerate("XY"):
            if axis in args:
                target[i] = args[axis] + off[i] if absolute else here[i] + args[axis]
        if jog:
            if "F" not in args:
                return 22
            block = {"target": target, "feed": args["F"], "s": 0.0, "jog": True}
        else:
            rapid = self._motion == 0
            if not rapid and self._feed <= 0:
                return 22
            feed = float(self.settings[110]) if rapid else min(self._feed, float(self.settings[110]))
            s = 0.0 if rapid or self._spindle == 5 else self._s
            block = {"target": target, "feed": feed, "s": s, "jog": False}
        block["start"] = list(here)
        self._planner.append(block)
        self._plan_pos = target
        return 0

    def _advance(self, dt: float) -> None:
        if self.state in ("Hold", "Alarm"):
            return
        budget = dt * self.speed
        while budget > 0:
            if self._cur is None:
                if not self._planner:
                    if self.state in ("Run", "Jog"):
                        self.state = "Idle"
                    return
                self._cur = self._planner.popleft()
                self.state = "Jog" if self._cur["jog"] else "Run"
            cur = self._cur
            dx = cur["target"][0] - self.mpos[0]
            dy = cur["target"][1] - self.mpos[1]
            dist = math.hypot(dx, dy)
            step = cur["feed"] / 60.0 * budget
            if step >= dist:
                self.mpos = list(cur["target"])
                budget -= dist / (cur["feed"] / 60.0) if cur["feed"] > 0 else budget
                if cur["s"] > 0:
                    self.burns.append((*cur["start"], *cur["target"], cur["s"]))
                self._cur = None
            else:
                self.mpos[0] += dx / dist * step
                self.mpos[1] += dy / dist * step
                return
