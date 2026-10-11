"""G-code generation: coordinates, power scaling, raster scanning, safety limits."""

import base64
import io
import re

import pytest
from PIL import Image, ImageDraw

from engraver.gcode import JobError, JobSpec, MachineProfile, build_job, frame_gcode, simplify

MACHINE = MachineProfile(bed_w=400, bed_h=400, s_max=1000, overscan=2)


def png(draw_fn, size=(100, 100), background=(255, 255, 255, 255)):
    img = Image.new("RGBA", size, background)
    draw_fn(ImageDraw.Draw(img))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def run(lines):
    """Tiny G-code interpreter: returns burn segments (x0, y0, x1, y1, s) and all moves."""
    x = y = 0.0
    s = 0
    spindle = False
    burns, moves = [], []
    for line in lines:
        words = {k: float(v) for k, v in re.findall(r"([A-Z])([-\d.]+)", line)}
        if line.startswith(("M4", "M3")):
            spindle = True
        if line.startswith("M5"):
            spindle = False
        if "S" in words:
            s = words["S"]
        if line.startswith(("G0", "G1")) and ("X" in words or "Y" in words):
            nx, ny = words.get("X", x), words.get("Y", y)
            rapid = line.startswith("G0")
            if not rapid and spindle and s > 0:
                burns.append((x, y, nx, ny, s))
            moves.append((rapid, nx, ny))
            x, y = nx, ny
    return burns, moves


def line_job(polylines, **layer):
    return JobSpec(layers=[{"mode": "line", "speed": 600, "power": 80, "polylines": polylines, **layer}])


def test_vector_flips_y_and_scales_power():
    # A 10 mm square whose top-left is 20 mm from the left and 30 mm from the top of the canvas.
    square = [[(20, 30), (30, 30), (30, 40), (20, 40), (20, 30)]]
    result = build_job(line_job(square), MACHINE)
    burns, _moves = run(result.lines)
    assert len(burns) == 4
    assert all(b[4] == 800 for b in burns)
    xs = [v for b in burns for v in (b[0], b[2])]
    ys = [v for b in burns for v in (b[1], b[3])]
    assert (min(xs), max(xs)) == (20, 30)
    assert (min(ys), max(ys)) == (360, 370)  # 400 - 40, 400 - 30
    assert result.bounds.as_list() == [20, 360, 30, 370]
    assert "F600" in " ".join(result.lines)
    assert result.lines[-1] == "M5" and result.lines[-2] == "G0 X0 Y0"
    assert result.burn_mm == pytest.approx(40)


def test_passes_repeat_the_cut():
    result = build_job(line_job([[(0, 0), (10, 0)]], passes=3), MACHINE)
    burns, _ = run(result.lines)
    assert len(burns) == 3


def test_laser_is_off_for_every_rapid():
    result = build_job(line_job([[(0, 0), (10, 0)], [(50, 50), (60, 50)], [(11, 0), (20, 0)]]), MACHINE)
    # Nearest-neighbour ordering from the front-left: the far stroke is closest to the
    # head's start, then the two neighbouring strokes are cut back to back, reversed
    # so each begins where the last one ended.
    burns, _ = run(result.lines)
    assert [round(b[0]) for b in burns] == [50, 20, 10]
    # After any G0 the next G1 restates S, so a cut never inherits a stale power.
    for i, line in enumerate(result.lines):
        if line.startswith("G0") and i + 1 < len(result.lines) and result.lines[i + 1].startswith("G1"):
            assert " S" in result.lines[i + 1]


def test_origin_mode_moves_the_design_to_zero():
    job = line_job([[(100, 100), (150, 100), (150, 130), (100, 130), (100, 100)]])
    job.origin_mode = "origin"
    result = build_job(job, MACHINE)
    assert result.bounds.as_list() == [0, 0, 50, 30]


def test_off_bed_design_is_refused_in_absolute_mode():
    job = line_job([[(390, 10), (420, 10)]])
    with pytest.raises(JobError, match="off the bed"):
        build_job(job, MACHINE)
    job.origin_mode = "origin"
    assert build_job(job, MACHINE).bounds.as_list() == [0, 0, 30, 0]


def test_oversized_and_empty_jobs_are_refused():
    too_big = line_job([[(0, 0), (500, 0)]])
    with pytest.raises(JobError, match=r"off the bed \(right by 100 mm\)"):
        build_job(too_big, MACHINE)
    too_big.origin_mode = "origin"
    with pytest.raises(JobError, match="bigger than"):
        build_job(too_big, MACHINE)
    with pytest.raises(JobError, match="Nothing to burn"):
        build_job(JobSpec(layers=[{"mode": "line", "polylines": []}]), MACHINE)


def test_speed_is_capped_at_the_machine_limit():
    result = build_job(line_job([[(0, 0), (10, 0)]], speed=99999), MACHINE)
    assert "F6000" in " ".join(result.lines)
    assert any("limited" in w for w in result.warnings)


def test_simplify_keeps_corners_and_drops_collinear_points():
    pts = [(x / 10, 0.0) for x in range(101)] + [(10.0, y / 10) for y in range(1, 101)]
    assert simplify(pts) == [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]


def fill_job(image, **layer):
    raster = {"x": 50, "y": 100, "w": 20, "h": 20, "png": image}
    return JobSpec(layers=[{"mode": "fill", "speed": 3000, "power": 50, "interval": 0.2, "raster": raster, **layer}])


def test_fill_burns_only_the_dark_area():
    # Black 10x10 mm square centred in a white 20x20 mm raster.
    image = png(lambda d: d.rectangle([25, 25, 74, 74], fill=(0, 0, 0, 255)))
    result = build_job(fill_job(image), MACHINE)
    burns, moves = run(result.lines)
    assert burns and all(b[4] == 500 for b in burns)
    assert all(b[1] == b[3] for b in burns)  # horizontal scan lines only
    xs = [v for b in burns for v in (b[0], b[2])]
    ys = sorted({b[1] for b in burns})
    assert min(xs) == pytest.approx(55, abs=0.25) and max(xs) == pytest.approx(65, abs=0.25)
    # Raster top is 100 mm down the canvas, so machine Y spans 300 - 15 .. 300 - 5.
    assert ys[0] == pytest.approx(285, abs=0.25) and ys[-1] == pytest.approx(295, abs=0.25)
    assert len(ys) == 50  # 10 mm at 0.2 mm interval
    assert ys[1] - ys[0] == pytest.approx(0.2)
    # Overscan: the head travels past each end of the burn with the laser off.
    all_x = [m[1] for m in moves if not (m[1] == 0 and m[2] == 0)]
    assert min(all_x) == pytest.approx(53, abs=0.25) and max(all_x) == pytest.approx(67, abs=0.25)


def test_fill_scans_both_directions():
    image = png(lambda d: d.rectangle([0, 0, 99, 99], fill=(0, 0, 0, 255)))
    burns, _ = run(build_job(fill_job(image), MACHINE).lines)
    directions = [b[2] > b[0] for b in burns]
    assert directions[0] != directions[1] and directions[0] == directions[2]
    burns, _ = run(build_job(fill_job(image, bidirectional=False), MACHINE).lines)
    assert all(b[2] > b[0] for b in burns)


def test_transparent_pixels_do_not_burn():
    image = png(lambda d: d.rectangle([0, 0, 49, 99], fill=(0, 0, 0, 255)), background=(0, 0, 0, 0))
    burns, _ = run(build_job(fill_job(image), MACHINE).lines)
    assert max(v for b in burns for v in (b[0], b[2])) == pytest.approx(60, abs=0.25)


def test_grayscale_power_follows_darkness():
    def draw(d):
        d.rectangle([0, 0, 49, 99], fill=(0, 0, 0, 255))
        d.rectangle([50, 0, 99, 99], fill=(128, 128, 128, 255))

    burns, _ = run(build_job(fill_job(draw and png(draw), image_mode="grayscale", power=80), MACHINE).lines)
    powers = sorted({b[4] for b in burns})
    assert powers[-1] == 800
    assert 300 < powers[0] < 500  # mid grey is roughly half power


def test_blank_fill_is_refused():
    with pytest.raises(JobError, match="blank"):
        build_job(fill_job(png(lambda d: None)), MACHINE)


def test_overscan_never_leaves_the_bed():
    image = png(lambda d: d.rectangle([0, 0, 99, 99], fill=(0, 0, 0, 255)))
    job = fill_job(image)
    job.layers[0].raster.x = 0
    _, moves = run(build_job(job, MACHINE).lines)
    assert min(m[1] for m in moves) >= 0


def test_frame_traces_the_bounds_with_the_laser_off():
    result = build_job(line_job([[(20, 30), (30, 40)]]), MACHINE)
    lines = frame_gcode(result.bounds, MACHINE)
    burns, moves = run(lines)
    assert not burns and not any(line.startswith(("M3", "M4")) for line in lines)
    assert {(m[1], m[2]) for m in moves} >= {(20, 360), (30, 360), (30, 370), (20, 370)}


def test_frame_dot_is_capped_at_two_percent():
    result = build_job(line_job([[(20, 30), (30, 40)]]), MACHINE)
    lines = frame_gcode(result.bounds, MACHINE, dot_power=100)
    assert "M3 S20" in lines and lines[-2] == "M5"


def test_fill_origin_is_the_corner_of_what_burns_not_of_the_bitmap():
    # Black square with a 5 mm white margin all round; "from origin" must ignore the margin.
    image = png(lambda d: d.rectangle([25, 25, 74, 74], fill=(0, 0, 0, 255)))
    job = fill_job(image)
    job.origin_mode = "origin"
    result = build_job(job, MACHINE)
    x0, y0, x1, y1 = result.bounds.as_list()
    assert (x0, y0) == pytest.approx((0, 0), abs=0.11)
    assert (x1, y1) == pytest.approx((10, 10), abs=0.11)
    _, moves = run(result.lines)
    assert min(m[1] for m in moves) >= 0


def test_progress_marks_follow_time_not_line_count():
    # A long slow cut after a fast short one: half the lines are nowhere near half the time.
    job = JobSpec(layers=[
        {"mode": "line", "speed": 6000, "power": 10, "polylines": [[(0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (5, 1)]]},
        {"mode": "line", "speed": 100, "power": 100, "polylines": [[(0, 10), (100, 10)]]},
    ])
    result = build_job(job, MACHINE)
    marks = result.line_seconds
    assert len(marks) == len(result.lines)
    assert marks == sorted(marks)
    slow_cut = next(i for i, line in enumerate(result.lines) if "F100" in line)
    assert marks[slow_cut - 1] / marks[-1] < 0.1 < slow_cut / len(marks)
