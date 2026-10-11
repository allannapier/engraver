"""Bug reports: collect diagnostics, write them up as a GitHub issue, and file it.

The report is composed here, shown to the person to review and edit, and only
then sent, so nothing leaves the computer that they haven't seen. Secrets are
scrubbed when the report is composed and again when it is sent.

Filing uses, in order: a token saved in Setup (or GITHUB_TOKEN / GH_TOKEN),
the `gh` command-line tool if it is signed in, or a pre-filled "new issue"
link the person submits themselves.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from pathlib import Path

from pydantic import BaseModel, Field

from . import __version__

MAX_BODY = 60_000  # GitHub's limit is 65,536 characters
MAX_LINK = 7_000  # a pre-filled issue URL longer than about 8,000 characters is rejected
REPO_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9_.-]{1,100}$"
DEFAULT_REPO = "allannapier/engraver"
FENCE = "````"


class BugError(Exception):
    """Shown to the person as-is."""


class BugSettings(BaseModel):
    repo: str = Field(default=DEFAULT_REPO, pattern=REPO_PATTERN)
    token: str = ""  # optional GitHub token with permission to create issues


class Include(BaseModel):
    details: bool = True  # machine state, last job, materials
    logs: bool = True  # console, server and browser logs, recent clicks
    design: bool = True  # layers and designs on the canvas, without pictures
    chat: bool = False  # recent assistant conversation


class ClientInfo(BaseModel):
    """What the browser knows that the server doesn't."""

    user_agent: str = Field(default="", max_length=400)
    viewport: str = Field(default="", max_length=40)
    errors: list[str] = Field(default=[], max_length=60)
    events: list[str] = Field(default=[], max_length=80)
    actions: list[str] = Field(default=[], max_length=80)
    project: dict | None = None
    ui: dict = {}
    chat: list[dict] = Field(default=[], max_length=12)


class BugDraft(BaseModel):
    title: str = Field(min_length=3, max_length=150)
    description: str = Field(min_length=3, max_length=6000)
    expected: str = Field(default="", max_length=3000)
    include: Include = Include()
    client: ClientInfo = ClientInfo()


class BugSubmit(BaseModel):
    title: str = Field(min_length=3, max_length=150)
    body: str = Field(min_length=3, max_length=65_000)


# --- server-side log --------------------------------------------------------------


class LogBuffer(logging.Handler):
    """Keeps the last warnings and errors (with tracebacks) so a report can include them."""

    def __init__(self, size: int = 120):
        super().__init__(level=logging.WARNING)
        self.records: deque[str] = deque(maxlen=size)
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%H:%M:%S"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.records.append(self.format(record))
        except Exception:
            pass  # logging must never raise


SERVER_LOG = LogBuffer()
log = logging.getLogger("engraver")
if SERVER_LOG not in log.handlers:
    log.addHandler(SERVER_LOG)


# --- redaction ----------------------------------------------------------------------

TOKEN_SHAPES = re.compile(
    r"\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})"
)


def scrub(text: str, secrets: tuple[str, ...] = ()) -> str:
    """Remove known secrets, anything shaped like an API token, and the home folder's path."""
    for secret in secrets:
        if secret and len(secret) >= 6:
            text = text.replace(secret, "[removed]")
    text = TOKEN_SHAPES.sub("[removed]", text)
    home = str(Path.home())
    if len(home) > 3:
        text = text.replace(home, "~")
    return text


# --- environment --------------------------------------------------------------------

_git_info: dict | None = None


def _git(*args: str) -> str:
    root = Path(__file__).resolve().parent
    try:
        out = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=4)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def app_info() -> dict:
    """Version, commit and platform. The commit tells whoever fixes it which code was running."""
    global _git_info
    if _git_info is None:
        commit = _git("rev-parse", "--short", "HEAD")
        _git_info = {
            "commit": commit,
            "branch": _git("rev-parse", "--abbrev-ref", "HEAD") if commit else "",
            "dirty": bool(_git("status", "--porcelain")) if commit else False,
        }
    return {
        "version": __version__,
        **_git_info,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
    }


# --- composing ------------------------------------------------------------------------


def _block(summary: str, content: str, lang: str = "text") -> str:
    content = content.replace(FENCE, "'" * 4).strip("\n")
    return f"<details>\n<summary>{summary}</summary>\n\n{FENCE}{lang}\n{content}\n{FENCE}\n\n</details>"


def _shorten(entry: str, cap: int) -> str:
    """Cut an over-long entry in the middle: a traceback's first line and its last frames matter most."""
    if len(entry) <= cap:
        return entry
    return entry[:300] + "\n… (middle cut) …\n" + entry[-(cap - 320) :]


def _tail(lines: list[str], limit: int, max_chars: int, entry_cap: int = 600) -> tuple[str, int]:
    """The last `limit` entries, dropped from the oldest end to fit `max_chars`."""
    kept = [_shorten(str(line), entry_cap) for line in lines[-limit:]]
    while kept and sum(len(line) + 1 for line in kept) > max_chars:
        kept.pop(0)
    return "\n".join(kept), len(kept)


def _json(data, max_chars: int) -> str:
    text = json.dumps(data, indent=1, default=str, ensure_ascii=False)
    # Lists of plain numbers (positions, bounds) read better on one line.
    text = re.sub(r"\[\s*((?:-?\d[\d.eE+-]*,?\s*)+)\]", lambda m: "[" + " ".join(m.group(1).split()) + "]", text)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n… (cut short)"
    return text


def _trim_project(project: dict | None) -> dict | None:
    """Layers and designs as sent by the browser, with artwork capped and pictures left out."""
    if not isinstance(project, dict):
        return None
    out = {"layers": project.get("layers", [])[:30], "designs": []}
    for obj in (project.get("designs") or [])[:60]:
        if not isinstance(obj, dict):
            continue
        item = {k: v for k, v in obj.items() if k != "svg"}
        svg = obj.get("svg")
        if isinstance(svg, str):
            # Embedded pictures are megabytes of base64 and say nothing useful.
            svg = re.sub(r'(href=")data:[^"]{40,}"', r'\1data:(picture left out)"', svg)
            item["svg"] = svg if len(svg) <= 3000 else svg[:3000] + "… (cut short)"
        out["designs"].append(item)
    return out


def compose(draft: BugDraft, env: dict, secrets: tuple[str, ...] = ()) -> str:
    """Write the issue body. Sections are added most-useful first until the size limit."""
    app = env.get("app", {})
    status = env.get("status", {})
    inc = draft.include
    client = draft.client

    commit = app.get("commit") or "unknown commit"
    if app.get("branch"):
        commit += f" on {app['branch']}"
    if app.get("dirty"):
        commit += ", with uncommitted changes"
    if status.get("connected"):
        port = "the simulator" if status.get("port") == "sim" else status.get("port", "?")
        laser = f"connected on {port} ({status.get('version') or 'GRBL'}), state {status.get('state')}"
        if status.get("alarm"):
            laser += f", alarm: {status['alarm']}"
    else:
        laser = "not connected"
    llm = env.get("llm", {})
    model = (
        f"{llm['model']} (key {'saved' if llm.get('key_set') else 'not saved'})" if llm.get("model") else "not set up"
    )

    parts = [f"## What happened\n\n{draft.description.strip()}"]
    if draft.expected.strip():
        parts.append(f"## What was expected\n\n{draft.expected.strip()}")
    env_lines = [
        f"- Engraver {app.get('version', '?')}, {commit}",
        f"- Python {app.get('python', '?')} on {app.get('platform', '?')}",
        f"- Browser: {client.user_agent or 'unknown'}" + (f", window {client.viewport}" if client.viewport else ""),
        f"- Laser: {laser}",
        f"- Assistant model: {model}",
    ]
    parts.append("## Environment\n\n" + "\n".join(env_lines))

    # (text, priority): lower priority numbers are kept first when space runs out.
    sections: list[tuple[str, int]] = []

    def add(summary: str, content: str, priority: int, lang: str = "text") -> None:
        if content.strip():
            sections.append((_block(summary, content, lang), priority))

    if inc.logs:
        text, n = _tail(env.get("server_log", []), 60, 10000, entry_cap=4000)
        add(f"Server warnings and errors (last {n})", text, 1)
        text, n = _tail(client.errors, 40, 6000)
        add(f"Browser errors (last {n})", text, 1)
        text, n = _tail(client.events, 60, 5000)
        add(f"Messages shown and failed requests (last {n})", text, 2)
        text, n = _tail(env.get("console", []), 150, 9000)
        add(f"Laser console (last {n} lines)", text, 2)
        text, n = _tail(client.actions, 50, 3000)
        add(f"Recent clicks, oldest first (last {n})", text, 3)
    if inc.details:
        if status:
            add("Machine state and controller settings", _json(status, 5000), 2, "json")
        if env.get("last_job"):
            add("Last job sent to the laser", _json(env["last_job"], 9000), 2, "json")
        if env.get("machine"):
            add("Machine profile", _json(env["machine"], 1500), 4, "json")
        extras = {"material and options": client.ui} if client.ui else {}
        if env.get("library"):
            extras["saved materials"] = env["library"]
        if extras:
            add("Material, job options and saved materials", _json(extras, 5000), 4, "json")
    if inc.design:
        project = _trim_project(client.project)
        if project and (project["designs"] or project["layers"]):
            add("Layers and designs on the canvas (pictures left out)", _json(project, 14000), 3, "json")
    if inc.chat and client.chat:
        lines = [f"{str(m.get('role', '?')).upper()}: {str(m.get('content', ''))[:1500]}" for m in client.chat[-8:]]
        add(f"Assistant conversation (last {len(lines)} messages)", "\n\n".join(lines), 4)

    footer = (
        "---\nFiled from Engraver's Report a bug form. The details above were collected automatically "
        "when the report was written; API keys and tokens are removed. See `CLAUDE.md` for how the code is laid out and what must keep working."
    )
    head = scrub("\n\n".join(parts), secrets)
    budget = MAX_BODY - len(head) - len(footer) - 200
    kept: list[tuple[int, str]] = []
    dropped = 0
    # Fill by priority, but keep the original order in the finished report.
    for index, (text, _priority) in sorted(enumerate(sections), key=lambda item: item[1][1]):
        text = scrub(text, secrets)
        if len(text) + 2 <= budget:
            kept.append((index, text))
            budget -= len(text) + 2
        else:
            dropped += 1
    body = [head]
    if kept:
        body.append("## Diagnostics\n\n" + "\n\n".join(text for _, text in sorted(kept)))
    if dropped:
        body.append(f"_{dropped} section{'s' if dropped != 1 else ''} left out to fit GitHub's size limit._")
    body.append(footer)
    return "\n\n".join(body)


def describe_job(job, result, kind: str) -> dict:
    """A compact record of a job for a later report: settings and sizes, not the bulk data."""
    layers = []
    for layer in job.layers:
        item = {
            "name": layer.name,
            "mode": layer.mode,
            "speed": layer.speed,
            "power": layer.power,
            "passes": layer.passes,
        }
        if layer.mode == "line":
            item["paths"] = len(layer.polylines)
            item["points"] = sum(len(path) for path in layer.polylines)
        elif layer.raster:
            r = layer.raster
            item.update(
                interval=layer.interval,
                image_mode=layer.image_mode,
                raster_mm=[r.x, r.y, r.w, r.h],
                png_chars=len(r.png),
            )
        layers.append(item)
    lines = result.lines
    return {
        "kind": kind,
        "name": job.name,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "origin_mode": job.origin_mode,
        "finish": job.finish,
        "summary": result.summary(),
        "layers": layers[:40],
        "gcode_first_lines": lines[:40],
        "gcode_last_lines": lines[-10:] if len(lines) > 50 else [],
    }


# --- filing ---------------------------------------------------------------------------


class GitHub:
    """Creates the issue. Tests replace this with a fake; nothing here runs in the test suite."""

    API = "https://api.github.com"

    def __init__(self, token_getter):
        self._token_getter = token_getter
        # Not 0.0: time.monotonic() counts from boot on Linux, so a low number isn't "long ago".
        self._gh_checked = float("-inf")
        self._gh_ok = False
        self._visibility: dict[str, tuple[float, bool | None]] = {}

    def token(self) -> str:
        return self._token_getter() or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""

    def _gh_signed_in(self) -> bool:
        if time.monotonic() - self._gh_checked > 60:
            self._gh_checked = time.monotonic()
            self._gh_ok = False
            if shutil.which("gh"):
                try:
                    self._gh_ok = (
                        subprocess.run(["gh", "auth", "status"], capture_output=True, timeout=8).returncode == 0
                    )
                except (OSError, subprocess.SubprocessError):
                    pass
        return self._gh_ok

    def method(self) -> str:
        """How an issue would be filed right now: "token", "gh" or "link"."""
        if os.environ.get("ENGRAVER_BUG_DRY_RUN"):
            return "link"  # for trying the form out without creating anything
        if self.token():
            return "token"
        return "gh" if self._gh_signed_in() else "link"

    def _request(self, path: str, payload: dict | None = None, token: str = "", timeout: float = 20):
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": f"engraver/{__version__}",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.API}{path}", data=data, headers=headers, method="POST" if data else "GET"
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())

    def is_public(self, repo: str) -> bool | None:
        """True if anyone can read the repo's issues, False if private, None if it can't be told."""
        if os.environ.get("ENGRAVER_BUG_DRY_RUN"):
            return None
        cached = self._visibility.get(repo)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
        result: bool | None = None
        try:
            if self.token() or not self._gh_signed_in():
                # Without a token this only succeeds for public repos, which is the answer.
                result = not self._request(f"/repos/{repo}", token=self.token(), timeout=6).get("private", False)
            else:
                out = subprocess.run(
                    ["gh", "api", f"repos/{repo}", "--jq", ".private"], capture_output=True, text=True, timeout=10
                )
                if out.returncode == 0:
                    result = out.stdout.strip() == "false"
        except (OSError, ValueError, subprocess.SubprocessError):
            result = None
        self._visibility[repo] = (time.monotonic(), result)
        return result

    def create(self, repo: str, title: str, body: str) -> dict:
        method = self.method()
        if method == "token":
            return self._create_with_token(repo, title, body)
        if method == "gh":
            return self._create_with_gh(repo, title, body)
        return link_fallback(repo, title, body)

    def _create_with_token(self, repo: str, title: str, body: str) -> dict:
        payload = {"title": title, "body": body, "labels": ["bug"]}
        for attempt in range(2):
            try:
                issue = self._request(f"/repos/{repo}/issues", payload, token=self.token())
                return {"url": issue["html_url"], "number": issue["number"], "via": "token"}
            except urllib.error.HTTPError as exc:
                if exc.code == 422 and attempt == 0 and "labels" in payload:
                    payload.pop("labels")  # the repo has no "bug" label; file it without
                    continue
                raise BugError(_http_reason(exc.code, repo)) from exc
            except (OSError, ValueError, KeyError) as exc:
                raise BugError(f"Couldn't reach GitHub ({exc}). Check your connection and try again.") from exc
        raise BugError("GitHub refused the issue.")

    def _create_with_gh(self, repo: str, title: str, body: str) -> dict:
        base = ["gh", "issue", "create", "--repo", repo, "--title", title, "--body-file", "-"]
        out = None
        for extra in (["--label", "bug"], []):
            try:
                out = subprocess.run(base + extra, input=body, capture_output=True, text=True, timeout=45)
            except (OSError, subprocess.SubprocessError) as exc:
                raise BugError(f"The gh command-line tool didn't finish ({exc}).") from exc
            if out.returncode == 0:
                break
            if "label" not in out.stderr.lower():
                break
        if out is None or out.returncode != 0:
            reason = (out.stderr.strip().splitlines() or ["no message"])[-1] if out else "no message"
            raise BugError(f"gh couldn't create the issue: {reason[:200]}")
        match = re.search(r"https://github\.com/\S+/issues/(\d+)", out.stdout)
        if not match:
            raise BugError("gh ran, but didn't say where the issue is. Check the repository's issue list.")
        return {"url": match.group(0), "number": int(match.group(1)), "via": "gh"}


def _http_reason(code: int, repo: str) -> str:
    if code == 401:
        return "GitHub rejected the token. Check it in Setup."
    if code in (403, 404):
        return f"The token can't create issues in {repo}. It needs Issues read and write access to that repository."
    if code == 410:
        return f"Issues are switched off for {repo}."
    return f"GitHub refused the issue (HTTP {code})."


def link_fallback(repo: str, title: str, body: str) -> dict:
    """No sign-in available: a pre-filled new-issue page the person submits themselves.

    Only the start of the report fits in a link (encoding makes text up to three
    times longer), so the browser also puts the full text on the clipboard.
    """
    note = "\n\n_(Only the start of the report fits in a link. The full report was copied to the clipboard: paste it here to replace this text.)_"

    def link(text: str) -> str:
        return f"https://github.com/{repo}/issues/new?" + urllib.parse.urlencode(
            {"title": title, "body": text, "labels": "bug"}
        )

    url = link(body)
    if len(url) > MAX_LINK:
        lo, hi = 0, len(body)
        while lo < hi:  # the longest prefix whose encoded link still fits
            mid = (lo + hi + 1) // 2
            if len(link(body[:mid] + note)) <= MAX_LINK:
                lo = mid
            else:
                hi = mid - 1
        cut = body.rfind("\n", 0, lo)
        url = link(body[: cut if cut > lo * 0.6 else lo] + note)
    return {"url": url, "number": None, "via": "link", "body": body}
