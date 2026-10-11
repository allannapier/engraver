"""Bug reports: what goes in, what is removed, and how the issue is filed. Nothing here touches GitHub."""

import io
import json
import string
import subprocess
import urllib.error

import pytest
from fastapi.testclient import TestClient

from engraver import bugs
from engraver.app import create_app
from engraver.config import ConfigStore


def fake(*parts: str) -> str:
    """A made-up credential, joined at run time so secret scanners don't mistake this file for a leak."""
    return "-".join(parts)


API_KEY = fake("my", "private", "key", "123456")
TOKEN = fake("tok", "abcdef", "987654")
ENV_TOKEN = fake("envtoken", "13579", "24680")
GH_SHAPED = "ghp_" + string.ascii_lowercase + string.digits  # shaped like a GitHub token
SK_SHAPED = fake("sk", "proj", string.ascii_uppercase[:24])  # shaped like a provider API key

SQUARE = {
    "name": "Coaster",
    "layers": [
        {
            "name": "Cut",
            "mode": "line",
            "speed": 1200,
            "power": 60,
            "polylines": [[[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]]],
        }
    ],
}


class FakeGitHub:
    def __init__(self, how="gh", public=True):
        self.how, self.public, self.created = how, public, []

    def method(self):
        return self.how

    def is_public(self, repo):
        return self.public

    def create(self, repo, title, body):
        self.created.append((repo, title, body))
        return {"url": f"https://github.com/{repo}/issues/7", "number": 7, "via": self.how}


@pytest.fixture
def client(tmp_path):
    app = create_app(store=ConfigStore(tmp_path / "config.json"), sim_speed=80, extra_hosts=("testserver",))
    app.state.github = FakeGitHub()
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


DRAFT = {
    "title": "Frame goes off the bed",
    "description": "Pressed Frame with a design in the corner and the head hit the rail.",
    "expected": "The frame should stay inside the bed.",
    "client": {
        "user_agent": "Mozilla/5.0 Test",
        "viewport": "1440x900",
        "errors": ["TypeError: x is undefined at stage.js:42"],
        "events": ["toast error: Part of the job is off the bed", "POST /api/job/frame -> 422"],
        "actions": ["Design tab", "Frame"],
        "ui": {"materialId": "plywood-3", "originMode": "absolute"},
        "project": {
            "layers": [{"id": "L1", "name": "Cut", "mode": "line", "speed": 300}],
            "designs": [
                {"id": "o1", "kind": "svg", "w": 50, "svg": "<rect width='10' height='10'/>"},
                {
                    "id": "o2",
                    "kind": "image",
                    "svg": '<image href="data:image/png;base64,' + "A" * 5000 + '" width="9"/>',
                },
            ],
        },
        "chat": [{"role": "user", "content": "make a star"}, {"role": "assistant", "content": "Added a star."}],
    },
}


def test_report_has_what_someone_fixing_it_needs(client):
    client.post("/api/connect", json={"port": "sim"})
    import time

    for _ in range(100):
        if "30" in client.get("/api/state").json()["status"]["settings"]:
            break
        time.sleep(0.03)
    client.post("/api/job/frame", json={"job": SQUARE})
    body = client.post("/api/bug/preview", json=DRAFT).json()["body"]
    assert body.startswith("## What happened\n\nPressed Frame")
    assert "## What was expected\n\nThe frame should stay inside the bed." in body
    assert "- Engraver 0.1.0, " in body and "- Python 3." in body
    assert "- Browser: Mozilla/5.0 Test, window 1440x900" in body
    assert "- Laser: connected on the simulator (Grbl 1.1h)" in body
    assert "TypeError: x is undefined at stage.js:42" in body
    assert "POST /api/job/frame -> 422" in body
    assert "Laser console" in body and "Grbl 1.1h" in body
    assert '"30": 1000' in body  # the controller's own settings
    assert '"wpos": [0.0, 0.0]' in body  # short number lists stay on one line
    import re

    assert re.search(r"\d\d:\d\d:\d\d Frame started \(\d+ lines\)", body)  # console lines carry the time
    assert '"kind": "frame"' in body and "G1 X30 Y370" in body  # the last job and its G-code
    assert "<rect width='10' height='10'/>" in body
    assert "data:(picture left out)" in body and "AAAAAAAA" not in body
    assert "make a star" not in body  # the conversation is opt-in
    assert body.rstrip().endswith("what must keep working.")
    assert len(body) < bugs.MAX_BODY


def test_sections_follow_the_tick_boxes(client):
    draft = {**DRAFT, "include": {"details": False, "logs": False, "design": False, "chat": True}}
    body = client.post("/api/bug/preview", json=draft).json()["body"]
    assert "Assistant conversation (last 2 messages)" in body and "USER: make a star" in body
    for absent in ("Laser console", "Browser errors", "Machine state", "Layers and designs", "Recent clicks"):
        assert absent not in body
    assert "## Environment" in body  # always there: it's the minimum needed to reproduce


def test_secrets_never_reach_the_report(client, monkeypatch):
    client.put("/api/config", json={"llm": {"model": "x/y", "api_key": API_KEY}, "bugs": {"token": TOKEN}})
    monkeypatch.setenv("GITHUB_TOKEN", ENV_TOKEN)
    draft = json.loads(json.dumps(DRAFT))
    draft["description"] = f"It failed with {API_KEY} and {GH_SHAPED} in the log"
    draft["client"]["errors"] = [f"Authorization: Bearer {TOKEN}", f"key {SK_SHAPED} leaked", f"env {ENV_TOKEN}"]
    draft["client"]["events"] = [f"read {bugs.Path.home()}/.engraver/config.json"]
    body = client.post("/api/bug/preview", json=draft).json()["body"]
    for secret in (API_KEY, TOKEN, ENV_TOKEN, GH_SHAPED[:14], SK_SHAPED[:16], str(bugs.Path.home()) + "/"):
        assert secret not in body
    assert "[removed]" in body and "~/.engraver/config.json" in body
    assert "assistant model: x/y (key saved)".lower() in body.lower()
    # Pasted into the review box by hand, it is still removed on the way out.
    client.post("/api/bug/report", json={"title": f"Leak {TOKEN}", "body": f"contains {API_KEY} again"})
    _, title, sent = client.app.state.github.created[0]
    assert TOKEN not in title and API_KEY not in sent


def test_oversized_reports_drop_the_least_useful_sections():
    draft = bugs.BugDraft.model_validate({**DRAFT, "include": {"chat": True}})
    env = {
        "app": {"version": "0.1.0", "commit": "abc1234", "python": "3.13", "platform": "test"},
        "status": {"connected": False, "settings": {str(i): "x" * 40 for i in range(200)}},
        "console": [f"line {i} " + "y" * 500 for i in range(400)],
        "server_log": ["Traceback (most recent call last): boom " + "z" * 500] * 100,
        "last_job": {"gcode_first_lines": ["G1 X1"] * 4000},
        "library": [{"name": "m", "notes": "n" * 400}] * 40,
        "machine": {"bed_w": 410},
    }
    draft.client.project = {
        "layers": [],
        "designs": [{"id": str(i), "svg": "<path d='" + "M0 0L1 1" * 2000 + "'/>"} for i in range(60)],
    }
    draft.client.errors = ["e" * 550] * 60
    draft.client.chat = [{"role": "user", "content": "c" * 1500}] * 8
    body = bugs.compose(draft, env)
    assert len(body) <= bugs.MAX_BODY
    assert "Server warnings and errors" in body and "Browser errors" in body  # the highest-value parts survive
    assert body.count("<details>") == body.count("</details>")
    assert body.count(bugs.FENCE) % 2 == 0


def test_a_server_crash_is_caught_recorded_and_reported(client, monkeypatch):
    def explode(*args, **kwargs):
        raise RuntimeError("raster buffer went sideways")

    monkeypatch.setattr("engraver.app.build_job", explode)
    r = client.post("/api/job/preview", json={"job": SQUARE})
    assert r.status_code == 500 and "Report a bug" in r.json()["detail"]
    body = client.post("/api/bug/preview", json=DRAFT).json()["body"]
    assert "POST /api/job/preview failed" in body
    assert "RuntimeError: raster buffer went sideways" in body and "Traceback (most recent call last)" in body


def test_filing_sends_exactly_the_reviewed_text(client):
    assert client.get("/api/bug/status").json() == {"repo": "allannapier/engraver", "method": "gh", "public": True}
    reviewed = "## What happened\n\nEdited by hand before sending."
    r = client.post("/api/bug/report", json={"title": "Frame goes off the bed", "body": reviewed})
    assert r.json() == {"url": "https://github.com/allannapier/engraver/issues/7", "number": 7, "via": "gh"}
    assert client.app.state.github.created == [("allannapier/engraver", "Frame goes off the bed", reviewed)]


def test_repo_and_token_settings(client):
    r = client.put("/api/config", json={"bugs": {"repo": "https://github.com/someone/fork/", "token": TOKEN}})
    cfg = r.json()["config"]["bugs"]
    assert cfg == {"repo": "someone/fork", "token_set": True}
    assert TOKEN not in client.get("/api/state").text
    client.put("/api/config", json={"bugs": {"repo": "someone/fork", "token": ""}})
    assert client.app.state.store.settings.bugs.token == TOKEN  # blank keeps the saved one
    assert (
        client.put("/api/config", json={"bugs": {"clear_token": True}}).json()["config"]["bugs"]["token_set"] is False
    )
    assert client.put("/api/config", json={"bugs": {"repo": "not a repo"}}).status_code == 422
    assert client.post("/api/bug/preview", json={"title": "x", "description": "too short"}).status_code == 422


# --- the real GitHub client, with the network and gh replaced ---------------------


class Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_token_filing_calls_the_issues_api(monkeypatch):
    calls = []

    def urlopen(request, timeout=0):
        calls.append(request)
        payload = json.loads(request.data)
        if "labels" in payload:  # this repo has no "bug" label
            raise urllib.error.HTTPError(request.full_url, 422, "Unprocessable", {}, io.BytesIO(b"{}"))
        return Reply(json.dumps({"html_url": "https://github.com/o/r/issues/12", "number": 12}).encode())

    monkeypatch.setattr(bugs.urllib.request, "urlopen", urlopen)
    monkeypatch.delenv("ENGRAVER_BUG_DRY_RUN", raising=False)
    github = bugs.GitHub(lambda: TOKEN)
    assert github.method() == "token"
    assert github.create("o/r", "Title", "Body") == {
        "url": "https://github.com/o/r/issues/12",
        "number": 12,
        "via": "token",
    }
    assert len(calls) == 2 and calls[0].full_url == "https://api.github.com/repos/o/r/issues"
    assert calls[0].get_header("Authorization") == f"Bearer {TOKEN}"
    assert json.loads(calls[1].data) == {"title": "Title", "body": "Body"}


@pytest.mark.parametrize(
    "code, words", [(401, "rejected the token"), (404, "can't create issues in o/r"), (410, "switched off")]
)
def test_token_errors_say_what_to_fix(monkeypatch, code, words):
    def urlopen(request, timeout=0):
        raise urllib.error.HTTPError(request.full_url, code, "no", {}, io.BytesIO(b"{}"))

    monkeypatch.setattr(bugs.urllib.request, "urlopen", urlopen)
    monkeypatch.delenv("ENGRAVER_BUG_DRY_RUN", raising=False)
    with pytest.raises(bugs.BugError, match=words):
        bugs.GitHub(lambda: TOKEN).create("o/r", "Title", "Body")


def test_gh_filing_passes_the_body_on_stdin(monkeypatch):
    runs = []

    def run(cmd, **kwargs):
        runs.append((cmd, kwargs.get("input")))
        if cmd[:3] == ["gh", "auth", "status"]:
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if "--label" in cmd:
            return subprocess.CompletedProcess(cmd, 1, "", "could not add label: 'bug' not found")
        return subprocess.CompletedProcess(cmd, 0, "https://github.com/o/r/issues/31\n", "")

    monkeypatch.setattr(bugs.shutil, "which", lambda name: "/usr/bin/gh")
    monkeypatch.setattr(bugs.subprocess, "run", run)
    for name in ("GITHUB_TOKEN", "GH_TOKEN", "ENGRAVER_BUG_DRY_RUN"):
        monkeypatch.delenv(name, raising=False)
    github = bugs.GitHub(lambda: "")
    assert github.method() == "gh"
    assert github.create("o/r", 'Title with "quotes"', "Body `text`") == {
        "url": "https://github.com/o/r/issues/31",
        "number": 31,
        "via": "gh",
    }
    creates = [r for r in runs if r[0][:3] == ["gh", "issue", "create"]]
    assert len(creates) == 2 and creates[1][0] == [
        "gh",
        "issue",
        "create",
        "--repo",
        "o/r",
        "--title",
        'Title with "quotes"',
        "--body-file",
        "-",
    ]
    assert creates[1][1] == "Body `text`"  # never interpolated into a shell command


def test_gh_sign_in_is_checked_on_a_machine_that_just_booted(monkeypatch):
    # time.monotonic() starts near zero at boot, so "never checked" can't be written as 0.
    monkeypatch.setattr(bugs.shutil, "which", lambda name: "/usr/bin/gh")
    monkeypatch.setattr(bugs.subprocess, "run", lambda cmd, **kwargs: subprocess.CompletedProcess(cmd, 0, "", ""))
    monkeypatch.setattr(bugs.time, "monotonic", lambda: 12.0)
    for name in ("GITHUB_TOKEN", "GH_TOKEN", "ENGRAVER_BUG_DRY_RUN"):
        monkeypatch.delenv(name, raising=False)
    assert bugs.GitHub(lambda: "").method() == "gh"


def test_without_a_sign_in_it_falls_back_to_a_prefilled_link(monkeypatch):
    monkeypatch.setattr(bugs.shutil, "which", lambda name: None)
    for name in ("GITHUB_TOKEN", "GH_TOKEN", "ENGRAVER_BUG_DRY_RUN"):
        monkeypatch.delenv(name, raising=False)
    github = bugs.GitHub(lambda: "")
    assert github.method() == "link"
    long_body = "## What happened\n\nIt broke.\n\n" + "\n".join(f"log line {i}" for i in range(2000))
    result = github.create("o/r", "Title", long_body)
    assert result["via"] == "link" and result["number"] is None and result["body"] == long_body
    assert result["url"].startswith("https://github.com/o/r/issues/new?title=Title&body=")
    assert len(result["url"]) <= bugs.MAX_LINK and "copied+to+the+clipboard" in result["url"]
    # Text that balloons when encoded (quotes, braces, newlines) still fits.
    heavy = github.create("o/r", "Title", '{"a": "b"}\n' * 3000)
    assert len(heavy["url"]) <= bugs.MAX_LINK and heavy["url"].count("%7B") > 50
    short = github.create("o/r", "Title", "Short report.")
    assert "clipboard" not in short["url"] and "Short+report." in short["url"]
