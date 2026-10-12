"""Things the person keeps between sessions: saved designs and assistant chats.

Each item is one JSON file in a folder next to the settings file
(`~/.engraver/designs/`, `~/.engraver/chats/`). The server stores what it is
given and checks only its shape and size; the browser cleans and sanitises
everything again when it loads an item, as it does for a project file.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

ID_RE = re.compile(r"^[a-f0-9]{16,32}$")
THUMB_RE = re.compile(r"^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$")
THUMB_MAX = 300_000


class SavedError(ValueError):
    """Shown to the person as-is."""


class NotFound(SavedError):
    pass


def new_id() -> str:
    return secrets.token_hex(8)


class Shelf:
    """A folder of named JSON items, newest first.

    `max_items` caps the folder. When `prune` is set, saving past the cap
    removes the oldest items; otherwise it refuses.
    """

    def __init__(self, folder: Path, *, noun: str, max_items: int, max_bytes: int, prune: bool = False):
        self.folder = folder
        self.noun = noun
        self.max_items = max_items
        self.max_bytes = max_bytes
        self.prune = prune
        self._lock = threading.Lock()

    def _path(self, item_id: str) -> Path:
        if not ID_RE.match(item_id or ""):
            raise NotFound(f"That {self.noun} doesn't exist.")
        return self.folder / f"{item_id}.json"

    def _read(self, path: Path) -> dict | None:
        try:
            raw = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return None
        if not isinstance(raw, dict) or not isinstance(raw.get("name"), str) or "data" not in raw:
            return None
        return raw

    @staticmethod
    def _meta(item_id: str, raw: dict) -> dict:
        meta = {"id": item_id, "name": raw["name"], "updated": float(raw.get("updated") or 0)}
        if isinstance(raw.get("thumb"), str):
            meta["thumb"] = raw["thumb"]
        if isinstance(raw.get("count"), int):
            meta["count"] = raw["count"]
        return meta

    def _all(self) -> list[dict]:
        items = []
        for path in self.folder.glob("*.json"):
            if not ID_RE.match(path.stem):
                continue
            raw = self._read(path)
            if raw is not None:
                items.append(self._meta(path.stem, raw))
        items.sort(key=lambda m: m["updated"], reverse=True)
        return items

    def list(self) -> list[dict]:
        with self._lock:
            return self._all()

    def get(self, item_id: str) -> dict:
        path = self._path(item_id)
        with self._lock:
            raw = self._read(path)
        if raw is None:
            raise NotFound(f"That {self.noun} doesn't exist any more.")
        return {**self._meta(item_id, raw), "data": raw["data"]}

    def put(self, item_id: str, name: str, data, *, thumb: str | None = None, count: int | None = None) -> dict:
        path = self._path(item_id)
        name = " ".join(str(name).split())[:80]
        if not name:
            raise SavedError(f"Give the {self.noun} a name.")
        if thumb is not None and (len(thumb) > THUMB_MAX or not THUMB_RE.match(thumb)):
            thumb = None  # a bad preview isn't worth losing the save over
        record = {"name": name, "updated": time.time(), "data": data}
        if thumb:
            record["thumb"] = thumb
        if count is not None:
            record["count"] = count
        text = json.dumps(record)
        if len(text) > self.max_bytes:
            mb = self.max_bytes // 1_000_000
            raise SavedError(f"This {self.noun} is too big to save (over {mb} MB). Try smaller pictures.")
        with self._lock:
            existing = self._all()
            others = [m for m in existing if m["id"] != item_id]
            if len(others) >= self.max_items:
                if not self.prune:
                    raise SavedError(
                        f"You have {len(others)} saved {self.noun}s, the most it keeps. Delete some first."
                    )
                for old in others[self.max_items - 1 :]:
                    (self.folder / f"{old['id']}.json").unlink(missing_ok=True)
            self.folder.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(text)
            if os.name == "posix":
                os.chmod(tmp, 0o600)
            tmp.replace(path)
        return self._meta(item_id, record)

    def find_name(self, name: str, *, other_than: str = "") -> dict | None:
        wanted = " ".join(name.split()).lower()
        return next((m for m in self.list() if m["id"] != other_than and m["name"].lower() == wanted), None)

    def delete(self, item_id: str) -> None:
        path = self._path(item_id)
        with self._lock:
            path.unlink(missing_ok=True)


def designs_folder(config_path: Path) -> Path:
    override = os.environ.get("ENGRAVER_DESIGNS")
    return Path(override) if override else config_path.with_name("designs")


def chats_folder(config_path: Path) -> Path:
    override = os.environ.get("ENGRAVER_CHATS")
    return Path(override) if override else config_path.with_name("chats")
