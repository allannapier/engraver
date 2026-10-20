"""Controller against the simulator: streaming, flow control, pause, stop, errors."""

import time

import pytest

from engraver.grbl import GrblController, GrblSim
from engraver.grbl import protocol as p
from engraver.grbl.controller import MachineError


def wait_for(predicate, timeout=5.0, message="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {message}")


@pytest.fixture
def rig():
    events = []
    sim = GrblSim(speed=60)
    ctl = GrblController(on_event=events.append)
    ctl.connect("sim", transport=sim)
    wait_for(lambda: ctl.connected and 30 in ctl.settings, message="connect")
    yield ctl, sim, events
    ctl.disconnect()


def square(size=20, feed=1200, s=500):
    return ["G21", "G90", "M4 S0", "G0 X0 Y0", f"G1 X{size} S{s} F{feed}", f"G1 Y{size}", "G1 X0", "G1 Y0", "M5"]


def test_parse_status():
    status = p.parse_status("<Hold:0|MPos:1.500,-2.000,0.000|FS:1200,300|WCO:10.000,5.000,0.000>")
    assert status["state"] == "Hold" and status["substate"] == 0
    assert status["mpos"][:2] == [1.5, -2.0]
    assert status["wco"][:2] == [10.0, 5.0]
    assert status["feed"] == 1200 and status["power"] == 300
    assert p.parse_status("ok") is None
    assert p.parse_setting("$110=6000.000") == (110, 6000.0)


def test_connect_reads_machine_settings(rig):
    ctl, _sim, _ = rig
    assert ctl.version.startswith("Grbl 1.1")
    assert ctl.settings[30] == 1000 and ctl.settings[32] == 1
    assert ctl.snapshot()["state"] == "Idle"


def test_job_runs_to_completion(rig):
    ctl, sim, _ = rig
    ctl.start(square(), name="Square")
    wait_for(lambda: ctl.job.state == "done", message="job done")
    assert ctl.job.acked == ctl.job.public()["total"]
    assert len(sim.burns) == 4
    assert all(burn[4] == 500 for burn in sim.burns)
    assert sim.mpos == [0.0, 0.0]


def test_long_job_never_overflows_the_receive_buffer(rig):
    ctl, sim, _ = rig
    lines = ["G21", "G90", "M4 S0", "G0 X0 Y0", "F6000"]
    for i in range(1500):
        lines.append(f"G1 X{(i % 2) * 0.5 + 10:.3f} Y{i * 0.01:.3f} S300")
    lines.append("M5")
    ctl.start(lines)
    wait_for(lambda: ctl.job.state == "done", timeout=20, message="long job")
    assert not sim.rx_overflow
    assert sim.lines_seen >= len(lines)


def test_pause_holds_position_and_resume_finishes(rig):
    ctl, sim, _ = rig
    sim.speed = 2
    ctl.start(square(size=40, feed=600))
    wait_for(lambda: ctl.state == "Run", message="running")
    ctl.pause()
    wait_for(lambda: ctl.state == "Hold", message="hold")
    before = list(sim.mpos)
    time.sleep(0.15)
    assert sim.mpos == before
    assert ctl.job.state == "paused"
    sim.speed = 200
    ctl.resume()
    wait_for(lambda: ctl.job.state == "done", message="resumed job done")
    assert len(sim.burns) == 4


def test_stop_halts_the_laser_and_keeps_position(rig):
    ctl, sim, _ = rig
    sim.speed = 2
    ctl.start(square(size=100, feed=600))
    wait_for(lambda: ctl.state == "Run" and sim.mpos[0] > 1, message="moving")
    ctl.stop()
    wait_for(lambda: ctl.job.state == "stopped", message="stopped")
    wait_for(lambda: ctl.state == "Idle", message="idle after stop")
    burns = len(sim.burns)
    pos = list(sim.mpos)
    time.sleep(0.2)
    # Held before the reset, so no alarm and nothing still queued or moving.
    assert sim.state == "Idle" and sim.resets == 1
    assert sim.mpos == pos and len(sim.burns) == burns
    assert burns < 4  # the square was cut short
    # The machine is usable again straight away.
    ctl.start(["G0 X1 Y1"], name="after")
    wait_for(lambda: ctl.job.name == "after" and ctl.job.state == "done", message="follow-up job")


def test_error_on_a_job_line_stops_the_job(rig):
    ctl, sim, _events = rig
    sim.speed = 2
    ctl.start(["G21", "G90", "M4 S0", "G1 X50 S400 F600", "G99", "G1 X80"])
    wait_for(lambda: ctl.job.state == "error", message="job error")
    assert "Unsupported" in ctl.job.error and "G99" in ctl.job.error
    wait_for(lambda: ctl.state == "Idle", message="idle after error")
    assert sim.mpos[0] < 50


def test_manual_commands_are_refused_during_a_job(rig):
    ctl, sim, _ = rig
    sim.speed = 2
    ctl.start(square(size=50, feed=600))
    with pytest.raises(MachineError):
        ctl.jog(10, 0, 3000)
    with pytest.raises(MachineError):
        ctl.command("G0 X5")
    with pytest.raises(MachineError):
        ctl.start(["G0 X1"])
    ctl.stop()
    wait_for(lambda: ctl.job.state == "stopped", message="stopped")


def test_jog_and_origin(rig):
    ctl, sim, _ = rig
    ctl.jog(30, 20, 6000)
    wait_for(lambda: sim.mpos == [30.0, 20.0] and ctl.state == "Idle", message="jog")
    ctl.set_origin()
    wait_for(lambda: ctl.snapshot()["wpos"] == [0.0, 0.0] and sim.wco == [30.0, 20.0], message="origin set")
    ctl.jog(5, 5, 6000)
    wait_for(lambda: ctl.snapshot()["wpos"] == [5.0, 5.0], message="work position follows")
    ctl.go_to_origin()
    wait_for(lambda: sim.mpos == [30.0, 20.0] and ctl.state == "Idle", message="back at origin")
    # A stop soft-resets the controller; the origin has to survive that.
    ctl.stop()
    wait_for(lambda: sim.resets == 1 and ctl.state == "Idle", message="reset")
    time.sleep(0.5)
    assert ctl.snapshot()["wco"] == [30.0, 20.0]
    ctl.clear_origin()
    wait_for(lambda: sim.wco == [0.0, 0.0], message="origin cleared")


def test_alarm_blocks_jobs_until_unlocked(rig):
    ctl, sim, _ = rig
    sim.speed = 1
    ctl.command("G1 X200 F600")
    wait_for(lambda: ctl.state == "Run", message="moving")
    sim.write(p.SOFT_RESET)  # a reset mid-move is what loses position on real hardware
    wait_for(lambda: ctl.state == "Alarm", message="alarm")
    with pytest.raises(MachineError):
        ctl.start(["G0 X1"])
    ctl.command("$X")
    wait_for(lambda: ctl.state == "Idle", message="unlocked")


def test_disconnect_mid_job_turns_everything_off(rig):
    ctl, sim, _ = rig
    sim.speed = 2
    ctl.start(square(size=100, feed=600))
    wait_for(lambda: ctl.state == "Run", message="running")
    ctl.disconnect()
    assert not ctl.connected
    assert sim.resets == 1 and sim.state in ("Idle", "Alarm")
    assert ctl.job.state == "stopped" and "Disconnected" in ctl.job.error


def test_connect_to_a_silent_port_fails_cleanly():
    class Silent:
        def write(self, data):
            pass

        def read(self, timeout=0.05):
            time.sleep(0.01)
            return b""

        def close(self):
            self.closed = True

    events = []
    ctl = GrblController(on_event=events.append)
    silent = Silent()
    ctl.connect("nowhere", transport=silent)
    wait_for(lambda: any(e["type"] == "log" and e["kind"] == "error" for e in events), timeout=10, message="error")
    wait_for(lambda: ctl.state == "Disconnected", message="closed")
    assert not ctl.connected and silent.closed


def test_progress_follows_estimated_time(rig):
    ctl, sim, _ = rig
    sim.speed = 3
    lines = [
        "G21",
        "G90",
        "M4 S0",
        "G0 X0 Y0",
        "G1 X1 S100 F6000",
        "G1 X2",
        "G1 X3",
        "G1 X4",
        "G4 P0",
        "G1 X80 F600",
        "M5",
    ]
    marks = [0, 0, 0, 0, 0.01, 0.02, 0.03, 0.04, 0.04, 7.64, 7.64]
    ctl.start(lines, line_seconds=marks)
    # G4 waits for the short moves to finish, so the slow move isn't acknowledged yet.
    wait_for(lambda: ctl.job.acked == 8, message="short moves acknowledged")
    assert ctl.job.public()["progress"] < 0.05  # 8 of 11 lines, but almost none of the time
    sim.speed = 300
    wait_for(lambda: ctl.job.state == "done", message="done")
    assert ctl.job.public()["progress"] == 1.0


def test_stop_right_after_start_never_resets_mid_motion(rig):
    """A hold that reaches GRBL before it has started moving is ignored, and the
    lines already in its buffer then run. Stop must notice and hold again rather
    than reset during motion, which raises an alarm and loses position."""
    ctl, sim, _ = rig
    sim.speed = 1
    sim.TICK = 0.03  # the simulator reads its buffer every 30 ms, leaving a window to hit
    for attempt in range(6):
        ctl.start(square(size=150, feed=3000), name=f"Run {attempt}")
        while ctl.job.sent == 0:  # spin until the lines have just been written...
            pass
        ctl.stop()  # ...so the hold lands before the simulator has read them
        wait_for(
            lambda: ctl.job.state == "stopped" and ctl.state == "Idle", message=f"stopped cleanly on attempt {attempt}"
        )
        assert sim.state == "Idle" and ctl.alarm is None, f"attempt {attempt} ended in {sim.state}"
        still = list(sim.mpos)
        time.sleep(0.1)
        assert sim.mpos == still, "nothing may still be moving after a stop"
    assert sim.resets == 6


def test_stop_while_idle_and_while_paused(rig):
    ctl, sim, _ = rig
    ctl.stop()
    wait_for(lambda: sim.resets == 1 and ctl.state == "Idle", message="idle stop")
    sim.speed = 1
    ctl.start(square(size=100, feed=600))
    wait_for(lambda: ctl.state == "Run", message="running")
    ctl.pause()
    wait_for(lambda: ctl.state == "Hold", message="hold")
    ctl.stop()
    wait_for(lambda: ctl.job.state == "stopped" and ctl.state == "Idle", message="stopped from pause")
    assert sim.state == "Idle"


def test_stage_follows_the_pass_being_burned(rig):
    from engraver.gcode import JobSpec, MachineProfile, build_job

    ctl, sim, _ = rig
    sim.speed = 20
    square = [[(10, 10), (30, 10), (30, 30), (10, 30), (10, 10)]]
    job = JobSpec(
        layers=[{"name": "Cut", "mode": "line", "speed": 1200, "power": 50, "passes": 3, "polylines": square}]
    )
    result = build_job(job, MachineProfile())
    ctl.start(result.lines, line_seconds=result.line_seconds, stages=result.stages, line_stages=result.line_stages)
    seen = []
    deadline = time.monotonic() + 10
    while ctl.job.state != "done" and time.monotonic() < deadline:
        stage = ctl.job.public()["stage"]
        burned = len(sim.burns)
        if stage and (not seen or seen[-1][0] != stage["pass"]):
            seen.append((stage["pass"], burned))
        time.sleep(0.005)
    assert ctl.job.state == "done"
    assert [number for number, _ in seen] == [1, 2, 3]
    # A pass is only reported once the one before it is burned: 4 sides per pass.
    for number, burned in seen:
        assert burned >= 4 * (number - 1)
    assert ctl.job.public()["stage"] is None


def test_jobs_without_stages_report_none(rig):
    ctl, _sim, _ = rig
    ctl.start(square(), stages=[{"layer": "x"}], line_stages=[0])  # mismatched lengths are dropped
    assert ctl.job.public()["stage"] is None
    wait_for(lambda: ctl.job.state == "done", message="job done")


def test_waiting_jog_reports_a_refusal(rig):
    ctl, sim, _ = rig
    ctl.jog(5, 0, 6000, wait=3)
    sim._exec_gcode = lambda line, jog: 15  # jog target exceeds travel
    with pytest.raises(MachineError, match="refused the jog"):
        ctl.jog(5, 0, 6000, wait=3)


def test_waiting_jog_retries_a_garbled_line(rig):
    ctl, sim, _ = rig
    real = sim._exec_gcode
    calls = []

    def flaky(line, jog):
        calls.append(line)
        return 1 if len(calls) == 1 else real(line, jog)

    sim._exec_gcode = flaky
    ctl.jog(5, 0, 6000, wait=3)
    assert len(calls) == 2
