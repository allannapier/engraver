"""MCP endpoint: protocol, what a client may do to the machine, and the relay to the open page."""

import io
import json
import threading
import time
import urllib.error

import pytest
from fastapi.testclient import TestClient

from engraver import mcp
from engraver.app import create_app
from engraver.config import ConfigStore


@pytest.fixture
def client(tmp_path):
    store = ConfigStore(tmp_path / "config.json")
    app = create_app(store=store, sim_speed=80, extra_hosts=("testserver",))
    with TestClient(app) as c:
        c.app_ = app
        yield c


def rpc(client, method, params=None, id_=1, **kw):
    message = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        message["params"] = params
    return client.post("/mcp", json=message, **kw)


def call(client, name, args=None):
    r = rpc(client, "tools/call", {"name": name, "arguments": args or {}})
    assert r.status_code == 200, r.text
    return r.json()["result"]


def body(result):
    return result["content"][0]["text"]


def wait_status(client, predicate, timeout=6.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = client.get("/api/state").json()["status"]
        if predicate(status):
            return status
        time.sleep(0.03)
    raise AssertionError(f"timed out; last status {status}")


def test_initialize_and_list_tools(client):
    r = rpc(client, "initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "claude-code"}})
    result = r.json()["result"]
    assert result["protocolVersion"] == "2025-06-18"
    assert result["serverInfo"]["name"] == "engraver" and "tools" in result["capabilities"]
    assert "cannot start a job" in result["instructions"]
    assert client.app_.state.mcp.client == "Claude Code"
    # An unknown version gets the newest one this server speaks.
    r = rpc(client, "initialize", {"protocolVersion": "1999-01-01"})
    assert r.json()["result"]["protocolVersion"] == mcp.PROTOCOL_VERSIONS[0]

    note = client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert note.status_code == 202 and not note.content
    assert rpc(client, "ping").json()["result"] == {}

    tools = {t["name"]: t for t in rpc(client, "tools/list").json()["result"]["tools"]}
    assert {"get_state", "add_design", "set_layer", "jog", "frame_job", "request_job_start", "stop_job"} <= set(tools)
    # The design tools are the assistant's, with the note made optional.
    assert "note" not in tools["add_design"]["inputSchema"]["properties"]
    assert "note" not in tools["set_layer"]["inputSchema"]["required"]


def test_no_tool_can_start_resume_or_send_raw_gcode(client):
    names = {t["name"] for t in rpc(client, "tools/list").json()["result"]["tools"]}
    assert not names & {"start_job", "resume_job", "command", "send_gcode", "home", "unlock"}
    assert not any("resume" in n or "gcode" in n for n in names)


def test_protocol_errors(client):
    assert rpc(client, "nope").json()["error"]["code"] == -32601
    assert rpc(client, "tools/call", {"name": "start_job"}).json()["error"]["code"] == -32602
    assert rpc(client, "tools/call", {"name": "jog", "arguments": []}).json()["error"]["code"] == -32602
    assert rpc(client, "tools/list", params=[]).json()["error"]["code"] == -32602
    assert client.post("/mcp", json={"id": 1}).json()["error"]["code"] == -32600
    bad = client.post("/mcp", content=b"{not json", headers={"content-type": "application/json"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == -32700
    batch = client.post("/mcp", json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "x"}])
    assert batch.json() == [{"jsonrpc": "2.0", "id": 1, "result": {}}]
    assert client.post("/mcp", json=[{"jsonrpc": "2.0", "method": "x"}]).status_code == 202
    assert client.get("/mcp").status_code == 405
    assert client.delete("/mcp").status_code == 405


def test_other_sites_cannot_reach_it(client):
    assert rpc(client, "ping", headers={"origin": "https://evil.example"}).status_code == 403
    assert rpc(client, "ping", headers={"host": "evil.example"}).status_code == 403


def test_machine_tools_through_the_simulator(client):
    state = json.loads(body(call(client, "get_state")))
    assert state["machine"]["connected"] is False and "sim" in state["ports"]
    assert "isn't open in a browser" in state["canvas"]

    refused = call(client, "connect_machine", {"port": "/dev/nothing"})
    assert refused["isError"] and "No port called" in body(refused)
    assert call(client, "jog", {"dx_mm": 5})["isError"]  # not connected yet

    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert not call(client, "connect_machine", {"port": "sim"})["isError"]
        wait_status(client, lambda s: s["connected"] and s["state"] == "Idle" and "30" in s["settings"])
        # The page hears about what the client did.
        notes = []
        for _ in range(200):
            event = ws.receive_json()
            if event["type"] == "mcp-note":
                notes.append(event["text"])
                break
        assert notes == ["An MCP client: connected to the simulator"]

    result = call(client, "jog", {"dx_mm": 12, "dy_mm": 7})
    assert not result["isError"], body(result)
    wait_status(client, lambda s: s["state"] == "Idle" and s["wpos"] == [12, 7])
    assert call(client, "jog", {"dx_mm": 9999})["isError"]  # out of range

    assert not call(client, "origin", {"action": "set"})["isError"]
    status = wait_status(client, lambda s: s["wco"] == [12, 7])
    assert status["wpos"] == [0, 0]
    state = json.loads(body(call(client, "get_state")))
    assert state["machine"]["origin_set"] and "ports" not in state
    assert call(client, "origin", {"action": "sideways"})["isError"]
    assert not call(client, "origin", {"action": "clear"})["isError"]
    wait_status(client, lambda s: s["wco"] == [0, 0])
    assert not call(client, "origin", {"action": "go"})["isError"]

    assert call(client, "pause_job")["isError"]  # nothing running
    # The person starts a job in the page; the client can pause and stop it, never resume it.
    job = {"layers": [{"name": "Cut", "mode": "line", "speed": 300, "power": 10, "polylines": [[[0, 0], [80, 0]]]}]}
    assert client.post("/api/job/start", json={"job": job}).status_code == 200
    wait_status(client, lambda s: (s["job"] or {}).get("state") == "running")
    assert not call(client, "pause_job")["isError"]
    wait_status(client, lambda s: s["job"]["state"] == "paused")
    assert not call(client, "stop_job")["isError"]
    wait_status(client, lambda s: s["job"]["state"] not in ("running", "paused", "stopping"))


def test_materials_and_saved_designs(client):
    text = body(call(client, "list_materials"))
    assert "(none saved yet)" in text and "Never laser" in text and "PVC" in text
    assert body(call(client, "list_saved_designs")) == "No saved designs yet."
    client.post("/api/designs", json={"name": "Coaster", "project": {"doc": {}}})
    saved = json.loads(body(call(client, "list_saved_designs")))
    assert saved[0]["name"] == "Coaster" and saved[0]["id"]


def run_with_page(client, name, args, answer):
    """Call a tool while a fake page answers the relayed request with `answer(event)`."""
    out = {}
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        worker = threading.Thread(target=lambda: out.update(result=call(client, name, args)))
        worker.start()
        while True:
            event = ws.receive_json()
            if event["type"] == "mcp":
                break
        reply = answer(event)
        if reply is not None:
            assert client.post("/api/mcp/reply", json={"id": event["id"], **reply}).status_code == 200
        worker.join(10)
    return event, out["result"]


def test_canvas_tools_are_relayed_to_the_page(client):
    rpc(client, "initialize", {"clientInfo": {"name": "Claude Code"}})
    event, result = run_with_page(
        client,
        "add_design",
        {"name": "Star", "svg": "<svg/>", "width_mm": 40, "mode": "fill"},
        lambda e: {"ok": True, "result": {"text": 'Added "Star"', "design_id": "o1"}},
    )
    assert event["action"] == "edit"
    assert event["args"] == {
        "client": "Claude Code",
        "type": "add_design",
        "name": "Star",
        "svg": "<svg/>",
        "width_mm": 40,
        "mode": "fill",
    }
    assert not result["isError"] and json.loads(body(result))["design_id"] == "o1"

    event, result = run_with_page(
        client, "request_job_start", {}, lambda e: {"ok": False, "error": "Not done: the machine isn't ready"}
    )
    assert event["action"] == "request_job_start" and event["args"] == {"client": "Claude Code"}
    assert result["isError"] and "isn't ready" in body(result)


def test_state_and_picture_come_from_the_page(client):
    big = {"designs": [{"id": "a", "svg": "x" * 50_000}, {"id": "b", "svg": "<svg/>"}]}
    _, result = run_with_page(client, "get_state", {}, lambda e: {"ok": True, "result": big})
    canvas = json.loads(body(result))["canvas"]
    assert "too large" in canvas["designs"][0]["svg"] and canvas["designs"][1]["svg"] == "<svg/>"

    _, result = run_with_page(
        client, "get_canvas_image", {}, lambda e: {"ok": True, "result": {"image": "data:image/png;base64,iVBOR"}}
    )
    assert result["content"] == [{"type": "image", "data": "iVBOR", "mimeType": "image/png"}]
    _, result = run_with_page(client, "get_canvas_image", {}, lambda e: {"ok": True, "result": {"image": None}})
    assert result["isError"]


def test_a_page_that_never_answers_times_out(client):
    client.app_.state.mcp.bridge.timeout = 0.2
    _, result = run_with_page(client, "new_design", {}, lambda e: None)
    assert result["isError"] and "didn't answer" in body(result)
    # A late or unknown reply is ignored.
    assert client.post("/api/mcp/reply", json={"id": "gone", "ok": True}).status_code == 200


def test_canvas_tools_need_an_open_page(client):
    result = call(client, "delete_design", {"design_id": "o1"})
    assert result["isError"] and "isn't open in a browser" in body(result)


def test_unexpected_errors_are_reported_without_details(client, monkeypatch):
    async def broken(args):
        raise RuntimeError("secret internals")

    monkeypatch.setitem(client.app_.state.mcp.machine, "stop_job", broken)
    result = call(client, "stop_job")
    assert result["isError"] and "internal error" in body(result) and "secret" not in body(result)


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_stdio_relay():
    sent = []

    def opener(request, timeout):
        sent.append((request.full_url, request.data))
        return FakeResponse(b'{"jsonrpc":"2.0","id":3,"result":{}}')

    line = '{"jsonrpc":"2.0","id":3,"method":"ping"}'
    assert mcp.relay(line, "http://127.0.0.1:8642/mcp", opener) == '{"jsonrpc":"2.0","id":3,"result":{}}'
    assert sent == [("http://127.0.0.1:8642/mcp", line.encode())]
    assert mcp.relay('{"jsonrpc":"2.0","method":"x"}', "http://x/mcp", lambda r, timeout: FakeResponse(b"")) is None
    assert json.loads(mcp.relay("{oops", "http://x/mcp", opener))["error"]["code"] == -32700

    def down(request, timeout):
        raise urllib.error.URLError("refused")

    reply = json.loads(mcp.relay(line, "http://127.0.0.1:1/mcp", down))
    assert reply["id"] == 3 and "isn't running" in reply["error"]["message"]
    assert mcp.relay('{"jsonrpc":"2.0","method":"x"}', "http://x/mcp", down) is None


def test_stdio_main(monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO('\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n'))
    monkeypatch.setattr(mcp, "relay", lambda line, url: f"{url} {line.strip()}")
    mcp.stdio_main(["http://x/mcp"])
    assert capsys.readouterr().out == 'http://x/mcp {"jsonrpc":"2.0","id":1,"method":"ping"}\n'
