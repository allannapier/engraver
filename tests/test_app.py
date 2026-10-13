"""HTTP API: request guard, config, jobs through the simulator, assistant with a fake provider."""

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


def test_config_round_trip_never_returns_the_key(client):
    r = client.put(
        "/api/config",
        json={"llm": {"model": "anthropic/claude-sonnet-5-5", "api_key": "sk-secret-1234"}, "machine": {"bed_w": 400}},
    )
    cfg = r.json()["config"]
    assert "api_key" not in cfg["llm"] and cfg["llm"]["api_key_set"] and cfg["llm"]["api_key_hint"] == "…1234"
    assert cfg["machine"]["bed_w"] == 400
    assert "sk-secret-1234" not in client.get("/api/state").text
    # Saving again without a key keeps the stored one.
    client.put("/api/config", json={"llm": {"model": "openai/gpt-x", "api_key": ""}})
    assert client.store.settings.llm.api_key == "sk-secret-1234"
    assert json.loads(client.store.path.read_text())["llm"]["model"] == "openai/gpt-x"
    client.put("/api/config", json={"llm": {"clear_api_key": True}})
    assert client.store.settings.llm.api_key == ""
    assert client.put("/api/config", json={"machine": {"bed_w": "wide"}}).status_code == 422


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


# --- assistant ---------------------------------------------------------------


def fake_response(text="", tool_calls=()):
    calls = [
        SimpleNamespace(function=SimpleNamespace(name=name, arguments=json.dumps(args))) for name, args in tool_calls
    ]
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text, tool_calls=calls or None))])


def test_assistant_needs_a_model(client):
    r = client.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 400 and "Setup" in r.json()["detail"]


def test_assistant_returns_actions_and_sees_context(client):
    client.put("/api/config", json={"llm": {"model": "test/model", "api_key": "sk-abcdefgh"}})
    calls = []

    async def completion(**kwargs):
        calls.append(kwargs)
        return fake_response(
            "Added a star on the engrave layer.",
            [
                (
                    "add_design",
                    {
                        "name": "Star",
                        "svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
                        "width_mm": 60,
                        "mode": "fill",
                    },
                ),
                ("set_layer", {"layer_id": "L1", "speed": 6000, "power": 50}),
                ("fire_laser", {"power": 100}),
            ],
        )

    client.app.state.completion = completion
    body = {
        "messages": [{"role": "user", "content": "make a star for 3mm plywood"}],
        "context": {"layers": [{"id": "L1", "mode": "fill"}], "objects": []},
        "image": "data:image/png;base64,AAAA",
    }
    reply = client.post("/api/ai/chat", json=body).json()
    assert reply["text"].startswith("Added a star")
    assert [a["type"] for a in reply["actions"]] == ["add_design", "set_layer"]  # unknown tools are dropped
    sent = calls[0]
    assert sent["model"] == "test/model" and sent["api_key"] == "sk-abcdefgh"
    names = {tool["function"]["name"] for tool in sent["tools"]}
    assert names == {"add_design", "replace_design", "transform_design", "add_layer", "set_layer"}
    system = sent["messages"][0]["content"]
    assert "Plywood" in system and "PVC" in system and "cannot move the laser head" in system
    user = sent["messages"][-1]["content"]
    assert user[1]["type"] == "image_url" and '"layers"' in user[0]["text"]


def test_assistant_falls_back_when_the_model_rejects_tools(client):
    client.put("/api/config", json={"llm": {"model": "ollama/tiny", "vision": True}})
    attempts = []

    class BadRequestError(Exception):
        pass

    async def completion(**kwargs):
        has_image = isinstance(kwargs["messages"][-1]["content"], list)
        attempts.append(("tools" in kwargs, has_image))
        if "tools" in kwargs:
            raise BadRequestError("this model does not support tools")
        return fake_response("Here you go.\n```svg\n<svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='4'/></svg>\n```")

    client.app.state.completion = completion
    body = {
        "messages": [{"role": "user", "content": "circle"}],
        "context": {"selected": {"id": "o7", "svg": "<svg/>"}},
        "image": "data:image/png;base64,AAAA",
    }
    reply = client.post("/api/ai/chat", json=body).json()
    assert attempts == [(True, True), (True, False), (False, False)]
    assert reply["actions"] == [
        {
            "type": "replace_design",
            "design_id": "o7",
            "svg": "<svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='4'/></svg>",
        }
    ]
    assert reply["text"] == "Here you go."


REF = "data:image/jpeg;base64,/9j/AAAA"


def test_assistant_gets_the_reference_picture_before_the_canvas(client):
    client.put("/api/config", json={"llm": {"model": "test/model", "vision": True}})
    calls = []

    async def completion(**kwargs):
        calls.append(kwargs)
        return fake_response("Done.")

    client.app.state.completion = completion
    body = {
        "messages": [{"role": "user", "content": "like this"}],
        "image": "data:image/png;base64,AAAA",
        "reference": REF,
    }
    assert client.post("/api/ai/chat", json=body).status_code == 200
    text, ref, canvas = calls[0]["messages"][-1]["content"]
    assert ref["image_url"]["url"] == REF and canvas["image_url"]["url"].startswith("data:image/png")
    assert "reference picture" in text["text"] and "last attached image is the canvas" in text["text"]


def test_reference_picture_is_sent_even_with_canvas_vision_off(client):
    client.put("/api/config", json={"llm": {"model": "test/model", "vision": False}})
    calls = []

    async def completion(**kwargs):
        calls.append(kwargs)
        return fake_response("Done.")

    client.app.state.completion = completion
    body = {
        "messages": [{"role": "user", "content": "like this"}],
        "image": "data:image/png;base64,AAAA",
        "reference": REF,
    }
    client.post("/api/ai/chat", json=body)
    content = calls[0]["messages"][-1]["content"]
    assert [part["type"] for part in content] == ["text", "image_url"]
    assert content[1]["image_url"]["url"] == REF and "as it looks now" not in content[0]["text"]


def test_reference_picture_is_never_dropped_silently(client):
    client.put("/api/config", json={"llm": {"model": "ollama/tiny", "vision": True}})
    attempts = []

    class BadRequestError(Exception):
        pass

    async def completion(**kwargs):
        content = kwargs["messages"][-1]["content"]
        attempts.append(sum(1 for part in content if part.get("type") == "image_url"))
        raise BadRequestError("this model does not support images")

    client.app.state.completion = completion
    body = {
        "messages": [{"role": "user", "content": "like this"}],
        "image": "data:image/png;base64,AAAA",
        "reference": REF,
    }
    r = client.post("/api/ai/chat", json=body)
    assert attempts == [2, 1, 1]  # the canvas picture can go, the reference always stays
    assert r.status_code == 400 and "couldn't take the reference picture" in r.json()["detail"]


def test_reference_picture_must_be_an_image_data_url(client):
    client.put("/api/config", json={"llm": {"model": "test/model"}})
    for bad in ("https://example.com/cat.png", "data:image/svg+xml;base64,PHN2Zy8+", "data:text/html;base64,AAAA"):
        r = client.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "hi"}], "reference": bad})
        assert r.status_code == 422, bad


def test_assistant_errors_are_readable_and_hide_the_key(client):
    client.put("/api/config", json={"llm": {"model": "x/y", "api_key": "sk-supersecret"}})

    class AuthenticationError(Exception):
        pass

    class APIError(Exception):
        pass

    async def bad_key(**kwargs):
        raise AuthenticationError("invalid key sk-supersecret")

    client.app.state.completion = bad_key
    r = client.post("/api/ai/test")
    assert r.status_code == 400 and "rejected the API key" in r.json()["detail"]

    async def boom(**kwargs):
        raise APIError("upstream said no to sk-supersecret")

    client.app.state.completion = boom
    r = client.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 400 and "sk-supersecret" not in r.text and "upstream said no" in r.text


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


def test_assistant_is_told_about_the_persons_own_materials(client):
    client.put("/api/config", json={"llm": {"model": "test/model"}})
    seen = []

    async def completion(**kwargs):
        seen.append(kwargs["messages"][0]["content"])
        return fake_response("ok")

    client.app.state.completion = completion
    ask = {"messages": [{"role": "user", "content": "settings for my ply?"}]}
    client.post("/api/ai/chat", json=ask)
    assert "hasn't saved any materials" in seen[0]
    client.put(f"/api/library/{PLY['id']}", json=PLY)
    client.post("/api/ai/chat", json=ask)
    prompt = seen[1]
    assert (
        "Birch ply 3 mm: engrave fill 4000 mm/min 55% x1, interval 0.1 mm (picked from a test grid on 2026-10-11)"
        in prompt
    )
    assert "cut line 250 mm/min 100% x2 (saved by the person on 2026-10-11)" in prompt
    assert "slightly warped" in prompt and "take priority" in prompt
    assert prompt.index("Birch ply 3 mm") < prompt.index("Plywood (basswood/birch), 3 mm")


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


def test_silent_tool_reply_gets_a_description():
    from engraver.llm import _describe

    text = _describe([{"type": "add_design"}, {"type": "set_layer"}, {"type": "set_layer"}])
    assert "added a design" in text and text.count("changed layer settings") == 1
