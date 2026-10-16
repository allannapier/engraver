"""Turns a job description from the browser into GRBL G-code.

Coordinates arrive in bed millimetres with the origin at the top-left of the
canvas and Y pointing down (how the browser draws). The machine's origin is
the front-left corner with Y pointing away, so Y is flipped here.

Everything runs in M4 (dynamic power): GRBL scales laser power with actual
speed, so corners and the ends of raster lines don't over-burn, and the laser
is off during G0 moves.
"""

from __future__ import annotations

import base64
import io
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
from PIL import Image
from pydantic import BaseModel, Field

Point = tuple[float, float]


class JobError(ValueError):
    """The job can't be turned into safe G-code. The message is shown to the user."""


class Raster(BaseModel):
    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    png: str  # base64, with or without a data: prefix


class Layer(BaseModel):
    id: str = ""
    name: str = "Layer"
    mode: Literal["line", "fill"] = "line"
    speed: float = Field(default=1000, gt=0)  # mm/min
    power: float = Field(default=20, ge=0, le=100)  # percent
    passes: int = Field(default=1, ge=1, le=50)
    polylines: list[list[Point]] = []
    raster: Raster | None = None
    interval: float = Field(default=0.1, ge=0.03, le=2.0)  # mm between scan lines
    image_mode: Literal["threshold", "dither", "grayscale"] = "threshold"
    threshold: int = Field(default=128, ge=1, le=255)
    min_power: float = Field(default=0, ge=0, le=100)  # grayscale: power for the lightest burn
    bidirectional: bool = True


class JobSpec(BaseModel):
    layers: list[Layer]
    origin_mode: Literal["absolute", "origin"] = "absolute"
    finish: Literal["origin", "stay"] = "origin"
    name: str = "Job"


class MachineProfile(BaseModel):
    name: str = "Atomstack A10"
    bed_w: float = 410
    bed_h: float = 400
    s_max: float = 1000
    max_feed: float = 6000
    travel_feed: float = 6000
    overscan: float = 2.0
    frame_feed: float = 3000
    jog_feed: float = 3000
    baud: int = 115200


@dataclass
class Bounds:
    min_x: float = math.inf
    min_y: float = math.inf
    max_x: float = -math.inf
    max_y: float = -math.inf

    def add(self, x: float, y: float) -> None:
        self.min_x, self.max_x = min(self.min_x, x), max(self.max_x, x)
        self.min_y, self.max_y = min(self.min_y, y), max(self.max_y, y)

    @property
    def empty(self) -> bool:
        return self.min_x > self.max_x

    def as_list(self) -> list[float]:
        return [round(v, 3) for v in (self.min_x, self.min_y, self.max_x, self.max_y)]


@dataclass
class GcodeResult:
    lines: list[str]
    bounds: Bounds
    est_seconds: float
    burn_mm: float
    travel_mm: float
    warnings: list[str] = field(default_factory=list)
    # Estimated seconds elapsed once each line has run: lets progress follow time,
    # not line count (a raster is thousands of quick lines, a cut is a few slow ones).
    line_seconds: list[float] = field(default_factory=list)
    # What the machine is working on: one entry per layer pass, and the index of the
    # entry each line belongs to (-1 before the first), so the app can show "pass 4 of 6".
    stages: list[dict] = field(default_factory=list)
    line_stages: list[int] = field(default_factory=list)

    def summary(self) -> dict:
        return {
            "lines": len(self.lines),
            "bounds": self.bounds.as_list(),
            "width": round(self.bounds.max_x - self.bounds.min_x, 2),
            "height": round(self.bounds.max_y - self.bounds.min_y, 2),
            "est_seconds": round(self.est_seconds),
            "burn_mm": round(self.burn_mm),
            "travel_mm": round(self.travel_mm),
            "warnings": self.warnings,
        }


def fmt(value: float) -> str:
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


class _Writer:
    """Collects G-code lines while tracking position, distance and time."""

    def __init__(self, machine: MachineProfile):
        self.machine = machine
        self.lines: list[str] = []
        self.marks: list[float] = []
        self.stages: list[dict] = []
        self.line_stages: list[int] = []
        self.pos: Point | None = None
        self.burn_mm = 0.0
        self.travel_mm = 0.0
        self.seconds = 0.0
        self._s: int | None = None
        self._f: float | None = None

    def raw(self, line: str) -> None:
        self.lines.append(line)
        self.marks.append(self.seconds)
        self.line_stages.append(len(self.stages) - 1)

    def begin_stage(self, layer: str, layer_no: int, layers: int, pass_no: int, passes: int) -> None:
        """Start the next layer pass. From the second on, a `G4 P0` dwell comes first:
        GRBL answers it only once the planner has emptied, so the app learns a pass has
        begun when the previous one has actually finished, not when it was queued."""
        self.stages.append({"layer": layer, "layer_no": layer_no, "layers": layers, "pass": pass_no, "passes": passes})
        if len(self.stages) > 1:
            self.raw("G4 P0")

    def _dist(self, x: float, y: float) -> float:
        if self.pos is None:
            return 0.0
        return math.hypot(x - self.pos[0], y - self.pos[1])

    def rapid(self, x: float, y: float) -> None:
        if self.pos is not None and self._dist(x, y) < 0.0005:
            return
        dist = self._dist(x, y)
        self.travel_mm += dist
        self.seconds += dist / self.machine.travel_feed * 60
        self.raw(f"G0 X{fmt(x)} Y{fmt(y)}")
        self.pos = (x, y)
        self._s = None  # restate S on the next burn so each cut is self-contained

    def burn(self, x: float, y: float, s: int, feed: float) -> None:
        dist = self._dist(x, y)
        if s > 0:
            self.burn_mm += dist
        else:
            self.travel_mm += dist
        self.seconds += dist / feed * 60
        parts = ["G1"]
        if self.pos is None or abs(x - self.pos[0]) >= 0.0005:
            parts.append(f"X{fmt(x)}")
        if self.pos is None or abs(y - self.pos[1]) >= 0.0005:
            parts.append(f"Y{fmt(y)}")
        if len(parts) == 1:
            return
        if s != self._s:
            parts.append(f"S{s}")
            self._s = s
        if feed != self._f:
            parts.append(f"F{fmt(feed)}")
            self._f = feed
        self.raw(" ".join(parts))
        self.pos = (x, y)


# --- vector helpers -----------------------------------------------------------


def simplify(points: list[Point], tolerance: float = 0.02) -> list[Point]:
    """Douglas-Peucker. Curves arrive finely flattened; this keeps the line count sane."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        worst, index = 0.0, -1
        for i in range(first + 1, last):
            px, py = points[i]
            if length < 1e-9:
                dist = math.hypot(px - ax, py - ay)
            else:
                dist = abs(dy * (px - ax) - dx * (py - ay)) / length
            if dist > worst:
                worst, index = dist, i
        if worst > tolerance and index > 0:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))
    return [pt for pt, kept in zip(points, keep, strict=False) if kept]


def order_paths(paths: list[list[Point]], start: Point) -> list[list[Point]]:
    """Greedy nearest-neighbour ordering to cut down travel. Open paths may be reversed."""
    if len(paths) > 4000:
        return paths
    remaining = list(paths)
    ordered = []
    pos = start
    while remaining:
        best, best_d, flip = 0, math.inf, False
        for i, path in enumerate(remaining):
            d0 = (path[0][0] - pos[0]) ** 2 + (path[0][1] - pos[1]) ** 2
            if d0 < best_d:
                best, best_d, flip = i, d0, False
            d1 = (path[-1][0] - pos[0]) ** 2 + (path[-1][1] - pos[1]) ** 2
            if d1 < best_d:
                best, best_d, flip = i, d1, True
        path = remaining.pop(best)
        if flip:
            path = path[::-1]
        ordered.append(path)
        pos = path[-1]
    return ordered


# --- raster ------------------------------------------------------------------


def decode_image(data: str) -> Image.Image:
    if "," in data and data.lstrip().startswith("data:"):
        data = data.split(",", 1)[1]
    try:
        img = Image.open(io.BytesIO(base64.b64decode(data)))
        img.load()
    except Exception as exc:
        raise JobError("Couldn't read the image for a fill layer.") from exc
    rgba = img.convert("RGBA")
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    return Image.alpha_composite(white, rgba).convert("L")


def raster_power(layer: Layer, s_max: float) -> np.ndarray:
    """Per-pixel S values (rows top to bottom) for a fill layer."""
    raster = layer.raster
    cols = max(1, round(raster.w / layer.interval))
    rows = max(1, round(raster.h / layer.interval))
    if cols * rows > 40_000_000:
        raise JobError("Fill area is too detailed. Increase the line interval or make it smaller.")
    gray = decode_image(raster.png).resize((cols, rows), Image.LANCZOS)
    full = round(layer.power / 100 * s_max)
    if layer.image_mode == "dither":
        on = np.asarray(gray.convert("1", dither=Image.FLOYDSTEINBERG)) == 0
        return np.where(on, full, 0).astype(np.int32)
    px = np.asarray(gray, dtype=np.float32)
    if layer.image_mode == "threshold":
        return np.where(px < layer.threshold, full, 0).astype(np.int32)
    # Grayscale: darker pixel, more power. Near-white stays unburned.
    dark = (255.0 - px) / 255.0
    low = round(min(layer.min_power, layer.power) / 100 * s_max)
    power = low + (full - low) * dark
    # 32 power steps is finer than wood can show and keeps runs long.
    step = max(1.0, (full - low) / 32)
    power = np.round(power / step) * step
    return np.where(dark < 0.04, 0, np.clip(power, 0, full)).astype(np.int32)


def _raster_gcode(
    out: _Writer,
    layer: Layer,
    power: np.ndarray,
    machine: MachineProfile,
    to_machine,
    bounds: Bounds,
    lo_x: float,
    hi_x: float,
    stage: Callable[[int], None],
) -> None:
    rows, cols = power.shape
    raster = layer.raster
    px = raster.w / cols
    py = raster.h / rows
    feed = min(layer.speed, machine.max_feed)
    left, top = to_machine(raster.x, raster.y)
    forward = True
    for number in range(1, layer.passes + 1):
        stage(number)
        # Front of the bed to the back: rows from the bottom of the image up.
        for row in range(rows - 1, -1, -1):
            line = power[row]
            lit = np.flatnonzero(line)
            if lit.size == 0:
                continue
            first, last = int(lit[0]), int(lit[-1]) + 1
            y = top - (row + 0.5) * py
            # Run-length encode the lit span: boundaries where the power changes.
            span = line[first:last]
            edges = np.flatnonzero(np.diff(span)) + 1
            starts = np.concatenate(([0], edges)) + first
            ends = np.concatenate((edges, [span.size])) + first
            runs = [(int(a), int(b), int(line[a])) for a, b in zip(starts, ends, strict=False)]
            x_first, x_last = left + first * px, left + last * px
            bounds.add(x_first, y - py / 2)
            bounds.add(x_last, y + py / 2)
            if forward:
                lead = max(lo_x, x_first - machine.overscan)
                tail = min(hi_x, x_last + machine.overscan)
            else:
                runs = [(b, a, s) for a, b, s in reversed(runs)]
                lead = min(hi_x, x_last + machine.overscan)
                tail = max(lo_x, x_first - machine.overscan)
            out.rapid(lead, y)
            out.burn(left + runs[0][0] * px, y, 0, feed)
            for start, end, s in runs:
                gap = abs(end - start) * px
                if s == 0 and gap > 12:
                    out.rapid(left + end * px, y)  # skip long blank stretches quickly
                else:
                    out.burn(left + end * px, y, s, feed)
            out.burn(tail, y, 0, feed)
            if layer.bidirectional:
                forward = not forward


# --- job ---------------------------------------------------------------------


def build_job(job: JobSpec, machine: MachineProfile) -> GcodeResult:
    layers = [layer for layer in job.layers if (layer.polylines if layer.mode == "line" else layer.raster)]
    if not layers:
        raise JobError("Nothing to burn. Add a design, or switch on output for its layer.")

    # First pass in bed coordinates (Y up) to find the job's extent.
    def flip(x: float, y: float) -> Point:
        return x, machine.bed_h - y

    # Fill layers are measured by what will actually burn, not by the bitmap's edges,
    # so the frame and the "from origin" corner match the marks on the material.
    extent = Bounds()
    rasters: dict[int, np.ndarray] = {}
    for index, layer in enumerate(layers):
        if layer.mode == "line":
            for path in layer.polylines:
                for x, y in path:
                    extent.add(*flip(x, y))
            continue
        power = raster_power(layer, machine.s_max)
        lit_rows = np.flatnonzero(power.any(axis=1))
        lit_cols = np.flatnonzero(power.any(axis=0))
        if lit_rows.size == 0:
            continue
        rasters[index] = power
        r = layer.raster
        px, py = r.w / power.shape[1], r.h / power.shape[0]
        extent.add(*flip(r.x + lit_cols[0] * px, r.y + lit_rows[0] * py))
        extent.add(*flip(r.x + (lit_cols[-1] + 1) * px, r.y + (lit_rows[-1] + 1) * py))
    if extent.empty:
        if any(layer.mode == "fill" for layer in layers):
            raise JobError("Nothing to burn: the fill layers come out blank with these settings.")
        raise JobError("Nothing to burn. Add a design, or switch on output for its layer.")

    eps = 0.01
    width, height = extent.max_x - extent.min_x, extent.max_y - extent.min_y
    if job.origin_mode == "absolute":
        over = {
            "left": -extent.min_x,
            "right": extent.max_x - machine.bed_w,
            "front": -extent.min_y,
            "back": extent.max_y - machine.bed_h,
        }
        sides = [f"{side} by {amount:.0f} mm" if amount >= 1 else side for side, amount in over.items() if amount > eps]
        if sides:
            raise JobError(
                f"Part of the job is off the bed ({', '.join(sides)}). Move it inside, or start from the origin instead."
            )
        shift_x = shift_y = 0.0
        lo_x, hi_x = 0.0, machine.bed_w
    else:
        if width > machine.bed_w + eps or height > machine.bed_h + eps:
            raise JobError(
                f"The job is {width:.0f} × {height:.0f} mm, bigger than the {machine.bed_w:.0f} × {machine.bed_h:.0f} mm bed."
            )
        # The job's front-left corner becomes work X0 Y0.
        shift_x, shift_y = extent.min_x, extent.min_y
        lo_x, hi_x = 0.0, width + machine.overscan

    def to_machine(x: float, y: float) -> Point:
        fx, fy = flip(x, y)
        return fx - shift_x, fy - shift_y

    out = _Writer(machine)
    bounds = Bounds()
    warnings: list[str] = []
    out.raw("G21")
    out.raw("G90")
    out.raw("G54")
    out.raw("M5")
    out.pos = None
    cursor: Point = (0.0, 0.0)
    burning = [index for index, layer in enumerate(layers) if layer.mode == "line" or index in rasters]
    for index, layer in enumerate(layers):
        if layer.mode == "fill" and index not in rasters:
            warnings.append(f"{layer.name}: nothing dark enough to burn with these settings.")
            continue
        feed = min(layer.speed, machine.max_feed)
        if layer.speed > machine.max_feed:
            warnings.append(f"{layer.name}: speed limited to {machine.max_feed:.0f} mm/min.")
        s = round(layer.power / 100 * machine.s_max)
        if s <= 0:
            warnings.append(f"{layer.name}: power is 0, so this layer won't mark anything.")
        out.raw("M4 S0")
        layer_no = burning.index(index) + 1

        def stage(number: int, layer=layer, layer_no=layer_no) -> None:
            out.begin_stage(layer.name, layer_no, len(burning), number, layer.passes)

        if layer.mode == "line":
            paths = []
            for path in layer.polylines:
                pts = [to_machine(x, y) for x, y in path]
                pts = simplify(_dedupe(pts))
                if len(pts) >= 2:
                    paths.append(pts)
            for number in range(1, layer.passes + 1):
                stage(number)
                for path in order_paths(paths, out.pos or cursor):
                    out.rapid(*path[0])
                    bounds.add(*path[0])
                    for x, y in path[1:]:
                        out.burn(x, y, s, feed)
                        bounds.add(x, y)
        else:
            _raster_gcode(out, layer, rasters[index], machine, to_machine, bounds, lo_x, hi_x, stage)
        out.raw("M5")
        cursor = out.pos or cursor
    if bounds.empty:
        raise JobError("Nothing to burn. Add a design, or switch on output for its layer.")
    if job.finish == "origin":
        out.rapid(0, 0)
    out.raw("M5")
    return GcodeResult(
        lines=out.lines,
        bounds=bounds,
        # Acceleration isn't modelled; pad a little so the estimate isn't optimistic.
        est_seconds=out.seconds * 1.1 + 1,
        burn_mm=out.burn_mm,
        travel_mm=out.travel_mm,
        warnings=warnings,
        line_seconds=out.marks,
        stages=out.stages,
        line_stages=out.line_stages,
    )


def _dedupe(points: list[Point]) -> list[Point]:
    out: list[Point] = []
    for pt in points:
        if not out or abs(pt[0] - out[-1][0]) > 0.002 or abs(pt[1] - out[-1][1]) > 0.002:
            out.append(pt)
    return out


MAX_FRAME_DOT_PERCENT = 2.0


def frame_gcode(bounds: Bounds, machine: MachineProfile, dot_power: float = 0.0, finish: str = "origin") -> list[str]:
    """Trace the job's bounding box. Laser off by default; `dot_power` (capped at
    2 %) turns on a faint dot so the outline can be seen on the material."""
    dot = max(0.0, min(dot_power, MAX_FRAME_DOT_PERCENT))
    s = round(dot / 100 * machine.s_max)
    x0, y0, x1, y1 = (fmt(v) for v in bounds.as_list())
    lines = ["G21", "G90", "G54", "M5", f"G0 X{x0} Y{y0}"]
    lines.append(f"M3 S{s}" if s > 0 else "M5")
    lines += [
        f"G1 X{x1} Y{y0} F{fmt(machine.frame_feed)}",
        f"G1 X{x1} Y{y1}",
        f"G1 X{x0} Y{y1}",
        f"G1 X{x0} Y{y0}",
        "M5",
    ]
    if finish == "origin":
        lines.append("G0 X0 Y0")
    return lines
