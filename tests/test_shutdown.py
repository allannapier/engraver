"""Quitting the server must be prompt and must stop a running job, even with a browser tab open."""

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

websockets = pytest.importorskip("websockets")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def call(port, path, body=None):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


@pytest.mark.skipif(sys.platform == "win32", reason="uses POSIX signals")
def test_ctrl_c_exits_quickly_and_stops_the_job(tmp_path):
    port = free_port()
    env = {**os.environ, "ENGRAVER_CONFIG": str(tmp_path / "config.json"), "ENGRAVER_SIM_SPEED": "1"}
    server = subprocess.Popen(
        [sys.executable, "-m", "engraver.cli", "--no-browser", "--port", str(port)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                call(port, "/api/state")
                break
            except OSError:
                assert time.monotonic() < deadline, "server didn't start"
                time.sleep(0.1)

        async def scenario():
            # An open tab: a websocket that stays connected through the shutdown.
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws", origin=f"http://127.0.0.1:{port}") as ws:
                call(port, "/api/connect", {"port": "sim"})
                while not (status := call(port, "/api/state")["status"])["connected"] or "30" not in status["settings"]:
                    await asyncio.sleep(0.05)
                long_cut = {
                    "layers": [
                        {"mode": "line", "speed": 300, "power": 100, "polylines": [[[0, 0], [300, 0], [300, 300]]]}
                    ]
                }
                call(port, "/api/job/start", {"job": long_cut})
                while call(port, "/api/state")["status"]["state"] != "Run":
                    await asyncio.sleep(0.05)
                seen = set()
                while "status" not in seen:
                    seen.add(json.loads(await asyncio.wait_for(ws.recv(), 5))["type"])
                server.send_signal(signal.SIGINT)
                started = time.monotonic()
                await asyncio.to_thread(server.wait, 10)
                return time.monotonic() - started

        took = asyncio.run(scenario())
        output = server.stdout.read()
        assert took < 6, f"shutdown took {took:.1f}s\n{output}"
        assert "turned the laser off before quitting" in output
    finally:
        if server.poll() is None:
            server.kill()


def test_closed_tabs_are_forgotten(tmp_path):
    from fastapi.testclient import TestClient

    from engraver.app import create_app
    from engraver.config import ConfigStore

    app = create_app(store=ConfigStore(tmp_path / "config.json"), extra_hosts=("testserver",))
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            assert len(app.state.hub.clients) == 1
        deadline = time.monotonic() + 3
        while app.state.hub.clients and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not app.state.hub.clients
