"""HTTP API: request guard, config, jobs through the simulator, material library."""

import json
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from engraver.app import create_app
from engraver.config import ConfigStore


@pytest.fixture
def client(tmp_path):
    store = ConfigStore(tmp_path / "config.json")
    app = create_app(store=store, sim_speed=80, extra_hosts=("testserver",))
    with TestClient(app) as c:
        c.store = store
        yield c


def wait_for(client, predicate, timeout=6.0):
    deadline = time.monotonic() + timeout
    status = None
    while time.monotonic() < deadline:
        status = client.get("/api/state").json()["status"]
        if predicate(status):
            return status
        time.sleep(0.03)
    raise AssertionError(f"timed out; last status {status}")


def connect(client):
    assert client.post("/api/connect", json={"port": "sim"}).status_code == 200
    wait_for(client, lambda s: s["connected"] and "30" in s["settings"])


SQUARE = {
    "layers": [
        {
            "name": "Cut",
            "mode": "line",
            "speed": 1200,
            "power": 60,
            "polylines": [[[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]]],
        }
    ]
}


def test_requests_from_other_sites_are_refused(client):
    assert client.get("/api/state").status_code == 200
    assert client.get("/api/state", headers={"host": "evil.example"}).status_code == 403
    assert client.post("/api/job/stop", headers={"origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/job/stop", headers={"origin": "null"}).status_code == 403
    assert client.post("/api/job/stop", headers={"origin": "http://testserver"}).status_code == 200


def test_static_app_is_served(client):
    assert client.get("/").status_code == 200


def test_config_round_trip(client):
    cfg = client.put("/api/config", json={"machine": {"bed_w": 400}}).json()["config"]
    assert cfg["machine"]["bed_w"] == 400 and "llm" not in cfg
    assert json.loads(client.store.path.read_text())["machine"]["bed_w"] == 400
    assert client.put("/api/config", json={"machine": {"bed_w": "wide"}}).status_code == 422


def test_an_old_assistant_key_is_removed_from_disk(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"machine": {"bed_w": 410}, "llm": {"model": "x/y", "api_key": "sk-old-key-1234"}}))
    store = ConfigStore(path)
    assert store.settings.machine.bed_w == 410
    saved = json.loads(path.read_text())
    assert "llm" not in saved and "sk-old-key" not in path.read_text() and saved["machine"]["bed_w"] == 410


def test_camera_settings(client):
    points = [
        {"u": 0.1, "v": 0.1, "x": 40, "y": 360},
        {"u": 0.9, "v": 0.1, "x": 370, "y": 360},
        {"u": 0.9, "v": 0.9, "x": 370, "y": 40},
        {"u": 0.1, "v": 0.9, "x": 40, "y": 40},
    ]
    r = client.put("/api/config", json={"camera": {"device_id": "abc", "label": "Webcam", "points": points}})
    cam = r.json()["config"]["camera"]
    assert cam["device_id"] == "abc" and len(cam["points"]) == 4
    # Other settings leave the camera alone; clearing the points keeps the camera.
    client.put("/api/config", json={"machine": {"bed_w": 420}})
    assert client.get("/api/state").json()["config"]["camera"]["label"] == "Webcam"
    client.put("/api/config", json={"camera": {"points": []}})
    cam = client.get("/api/state").json()["config"]["camera"]
    assert cam["points"] == [] and cam["device_id"] == "abc"
    # Calibration is four points inside the picture, or nothing.
    assert client.put("/api/config", json={"camera": {"points": points[:3]}}).status_code == 422
    bad = [dict(points[0], u=1.5), *points[1:]]
    assert client.put("/api/config", json={"camera": {"points": bad}}).status_code == 422


def test_machine_actions_need_a_connection(client):
    r = client.post("/api/jog", json={"dx": 10})
    assert r.status_code == 409 and "Not connected" in r.json()["detail"]
    assert client.post("/api/job/start", json={"job": SQUARE}).status_code == 409


def test_preview_and_export(client):
    summary = client.post("/api/job/preview", json={"job": SQUARE}).json()
    assert summary["width"] == 20 and summary["height"] == 20 and summary["burn_mm"] == 80
    gcode = client.post("/api/job/gcode", json={"job": SQUARE}).text
    assert gcode.startswith("G21\nG90") and "S600" in gcode
    r = client.post("/api/job/preview", json={"job": {"layers": []}})
    assert r.status_code == 422 and "Nothing to burn" in r.json()["detail"]


def test_frame_then_run_a_job(client):
    connect(client)
    assert client.post("/api/job/frame", json={"job": SQUARE}).status_code == 200
    status = wait_for(client, lambda s: s["job"] and s["job"]["state"] == "done")
    assert status["job"]["kind"] == "frame"
    assert client.post("/api/job/start", json={"job": SQUARE}).status_code == 200
    status = wait_for(client, lambda s: s["job"]["kind"] == "job" and s["job"]["state"] == "done")
    assert status["job"]["acked"] == status["job"]["total"]
    assert status["wpos"] == [0, 0]
    sim = client.app.state.controller._transport
    assert len(sim.burns) == 4 and all(b[4] == 600 for b in sim.burns)


def test_power_uses_the_controllers_s_max(client):
    connect(client)
    client.post("/api/command", json={"line": "$30=255"})
    client.post("/api/command", json={"line": "$$"})
    wait_for(client, lambda s: s["settings"].get("30") == 255)
    gcode = client.post("/api/job/gcode", json={"job": SQUARE}).text
    assert "S153" in gcode and "S600" not in gcode


def test_job_is_refused_when_laser_mode_is_off(client):
    connect(client)
    client.post("/api/command", json={"line": "$32=0"})
    client.post("/api/command", json={"line": "$$"})
    wait_for(client, lambda s: s["settings"].get("32") == 0)
    r = client.post("/api/job/start", json={"job": SQUARE})
    assert r.status_code == 409 and "$32=1" in r.json()["detail"]


def test_pause_resume_stop_over_http(client):
    connect(client)
    client.app.state.controller._transport.speed = 1
    big = {"layers": [{"mode": "line", "speed": 600, "power": 50, "polylines": [[[0, 0], [300, 0], [300, 300]]]}]}
    assert client.post("/api/job/start", json={"job": big}).status_code == 200
    wait_for(client, lambda s: s["state"] == "Run")
    assert client.post("/api/job/pause").status_code == 200
    wait_for(client, lambda s: s["state"] == "Hold" and s["job"]["state"] == "paused")
    assert client.post("/api/job/resume").status_code == 200
    wait_for(client, lambda s: s["state"] == "Run")
    assert client.post("/api/job/stop").status_code == 200
    wait_for(client, lambda s: s["job"]["state"] == "stopped" and s["state"] == "Idle")


def test_live_updates_over_websocket(client):
    with client.websocket_connect("/ws") as ws:
        first = ws.receive_json()
        assert first["type"] == "status" and first["status"]["connected"] is False
        connect(client)
        seen = set()
        for _ in range(40):
            event = ws.receive_json()
            seen.add(event["type"])
            if event["type"] == "status" and event["status"]["connected"]:
                break
        assert {"status", "log"} <= seen


# --- material library ----------------------------------------------------------

PLY = {
    "id": "my-birch-ply-3mm",
    "name": "Birch ply 3 mm",
    "notes": "From the hobby shop, slightly warped",
    "engrave": {
        "mode": "fill",
        "speed": 4000,
        "power": 55,
        "passes": 1,
        "interval": 0.1,
        "source": "test",
        "date": "2026-10-11",
    },
    "cut": {"mode": "line", "speed": 250, "power": 100, "passes": 2, "source": "saved", "date": "2026-10-11"},
}


def test_library_saves_updates_and_deletes(client, tmp_path):
    assert client.get("/api/state").json()["library"] == []
    r = client.put(f"/api/library/{PLY['id']}", json=PLY)
    assert r.status_code == 200
    saved = r.json()["library"][0]
    assert saved["name"] == "Birch ply 3 mm" and saved["engrave"]["speed"] == 4000 and saved["score"] is None
    assert (tmp_path / "materials.json").exists()

    # It survives a restart: a new app reading the same folder sees it.
    again = create_app(store=ConfigStore(tmp_path / "config.json"), extra_hosts=("testserver",))
    with TestClient(again) as other:
        assert other.get("/api/state").json()["library"][0]["cut"]["passes"] == 2

    updated = {**PLY, "cut": {**PLY["cut"], "speed": 300}}
    assert client.put(f"/api/library/{PLY['id']}", json=updated).json()["library"][0]["cut"]["speed"] == 300
    assert len(client.get("/api/state").json()["library"]) == 1
    assert client.delete(f"/api/library/{PLY['id']}").json()["library"] == []


def test_library_rejects_bad_entries(client):
    assert client.put("/api/library/my-x", json={**PLY, "id": "my-other"}).status_code == 422
    assert (
        client.put("/api/library/plywood-3", json={**PLY, "id": "plywood-3"}).status_code == 422
    )  # built-in ids are off limits
    too_hot = {**PLY, "engrave": {**PLY["engrave"], "power": 140}}
    assert client.put(f"/api/library/{PLY['id']}", json=too_hot).status_code == 422
    assert client.put(f"/api/library/{PLY['id']}", json=PLY).status_code == 200
    r = client.put("/api/library/my-second", json={**PLY, "id": "my-second", "name": "birch PLY 3 mm"})
    assert r.status_code == 409 and "already have" in r.json()["detail"]


def test_a_damaged_library_file_does_not_break_startup(tmp_path):
    (tmp_path / "materials.json").write_text('{"materials": [{"id": "nope"}, ' + json.dumps(PLY) + "]}")
    app = create_app(store=ConfigStore(tmp_path / "config.json"), extra_hosts=("testserver",))
    with TestClient(app) as c:
        assert [m["id"] for m in c.get("/api/state").json()["library"]] == [PLY["id"]]
    (tmp_path / "materials.json").write_text("not json")
    app = create_app(store=ConfigStore(tmp_path / "config.json"), extra_hosts=("testserver",))
    with TestClient(app) as c:
        assert c.get("/api/state").json()["library"] == []


def test_mcp_clients_are_told_about_the_persons_own_materials(client):
    def materials():
        reply = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_materials"}},
        )
        return reply.json()["result"]["content"][0]["text"]

    assert "(none saved yet)" in materials()
    client.put(f"/api/library/{PLY['id']}", json=PLY)
    text = materials()
    assert (
        "Birch ply 3 mm: engrave fill 4000 mm/min 55% x1, interval 0.1 mm (picked from a test grid on 2026-10-11)"
        in text
    )
    assert "cut line 250 mm/min 100% x2 (saved by the person on 2026-10-11)" in text
    assert "slightly warped" in text
    assert text.index("Birch ply 3 mm") < text.index("Plywood (basswood/birch), 3 mm")


# --- found while trying the app in a real browser ---------------------------------


def test_port_list_hides_ports_with_no_hardware_behind_them(client, monkeypatch):
    port = SimpleNamespace
    found = [
        port(device="/dev/ttyS0", description="n/a", hwid="n/a", vid=None),  # Linux lists 32 of these regardless
        port(device="/dev/ttyS1", description="n/a", hwid="n/a", vid=None),
        port(device="/dev/ttyUSB0", description="USB Serial", hwid="USB VID:PID=1A86:7523", vid=0x1A86),
        port(device="/dev/ttyAMA0", description="ttyAMA0", hwid="fe201000.serial", vid=None),  # a real on-board UART
    ]
    monkeypatch.setattr("serial.tools.list_ports.comports", lambda: found)
    listing = client.get("/api/ports").json()
    assert [p["device"] for p in listing["ports"]] == ["/dev/ttyUSB0", "/dev/ttyAMA0", "sim"]
    assert listing["hidden"] == 2
    everything = client.get("/api/ports?all=true").json()
    assert [p["device"] for p in everything["ports"]] == [
        "/dev/ttyUSB0",
        "/dev/ttyAMA0",
        "/dev/ttyS0",
        "/dev/ttyS1",
        "sim",
    ]
    assert everything["hidden"] == 0


def test_frame_estimate_counts_the_trip_there_and_back(client):
    connect(client)
    client.app.state.controller._transport.speed = 1
    client.post("/api/job/frame", json={"job": SQUARE})
    est = wait_for(client, lambda s: s["job"] and s["job"]["kind"] == "frame")["job"]["est_seconds"]
    # 80 mm of outline at 3000 mm/min is 1.6 s; the 370 mm trip each way at 6000 mm/min is 7.4 s more.
    assert 9.5 < est < 11
    stay = {**SQUARE, "finish": "stay"}
    client.post("/api/job/stop")
    wait_for(client, lambda s: s["state"] == "Idle" and s["job"]["state"] in ("stopped", "done"))
    client.post("/api/job/frame", json={"job": stay})
    est = wait_for(client, lambda s: s["job"]["state"] == "running")["job"]["est_seconds"]
    assert 5.5 < est < 7
    client.post("/api/job/stop")


def test_page_actions_go_to_the_active_tab():
    import asyncio

    from engraver.app import Hub

    hub = Hub()
    old, new = asyncio.Queue(), asyncio.Queue()
    hub.clients[old] = None
    hub.clients[new] = None
    hub.activate(new)
    assert hub.send_to_page({"type": "mcp"}) and new.qsize() == 2 and old.qsize() == 1
    hub.activate(old)
    assert hub.send_to_page({"type": "mcp"})
    kinds = []
    while not old.empty():
        kinds.append(old.get_nowait())
    assert kinds[-2:] == [{"type": "control", "active": True, "tabs": 2}, {"type": "mcp"}]


def test_a_reconnecting_tab_does_not_take_control(client):
    hub = client.app.state.hub

    def settle(predicate):
        deadline = time.monotonic() + 3
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert predicate()

    with client.websocket_connect("/ws"), client.websocket_connect("/ws") as second:
        settle(lambda: len(hub.clients) == 2)
        first_tab = next(iter(hub.clients))
        assert hub.active is first_tab  # nobody was in control: the first tab took it
        second.send_text("active")  # the person clicks into the second tab
        settle(lambda: hub.active is not first_tab)
        in_use = hub.active
        with client.websocket_connect("/ws"):  # a background tab reconnecting
            settle(lambda: len(hub.clients) == 3)
            assert hub.active is in_use
