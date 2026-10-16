"""The person's own materials: settings that worked on this machine.

Kept in a JSON file next to the settings file. The built-in table in
`materials.py` is a set of starting points; entries here are what the person
saved from a layer or picked from a test grid, and take priority.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

OPERATIONS = ("engrave", "score", "cut")


class Setting(BaseModel):
    mode: Literal["line", "fill"]
    speed: float = Field(gt=0, le=60000)  # mm/min
    power: float = Field(ge=0, le=100)  # percent
    passes: int = Field(default=1, ge=1, le=50)
    interval: float | None = Field(default=None, ge=0.03, le=2)  # fill only, mm
    # Where the numbers came from: picked from a burned test grid, saved by hand,
    # or copied from the built-in starting points.
    source: Literal["test", "saved", "starting"] = "saved"
    date: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")


class UserMaterial(BaseModel):
    id: str = Field(pattern=r"^my-[a-z0-9-]{1,56}$")
    name: str = Field(min_length=1, max_length=60)
    notes: str = Field(default="", max_length=500)
    engrave: Setting | None = None
    score: Setting | None = None
    cut: Setting | None = None


class LibraryError(ValueError):
    """Shown to the person as-is."""


class MaterialLibrary:
    MAX_ENTRIES = 200

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._items: dict[str, UserMaterial] = {}
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text())
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return
        for entry in raw.get("materials", []) if isinstance(raw, dict) else []:
            try:
                material = UserMaterial.model_validate(entry)
            except ValidationError:
                continue  # one bad entry shouldn't hide the rest
            self._items[material.id] = material

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"materials": [m.model_dump() for m in self._items.values()]}, indent=2))
        tmp.replace(self.path)

    def all(self) -> list[dict]:
        with self._lock:
            items = sorted(self._items.values(), key=lambda m: m.name.lower())
            return [m.model_dump() for m in items]

    def put(self, material: UserMaterial) -> None:
        with self._lock:
            if material.id not in self._items and len(self._items) >= self.MAX_ENTRIES:
                raise LibraryError("The material library is full. Delete one you no longer use.")
            clash = next(
                (
                    m
                    for m in self._items.values()
                    if m.id != material.id and m.name.strip().lower() == material.name.strip().lower()
                ),
                None,
            )
            if clash:
                raise LibraryError(f'You already have a material called "{clash.name}". Pick a different name.')
            self._items[material.id] = material
            self._save()

    def delete(self, material_id: str) -> None:
        with self._lock:
            if self._items.pop(material_id, None) is not None:
                self._save()

    def as_prompt(self) -> str:
        """The library as text for MCP clients, or "" when it's empty."""
        rows = []
        for mat in self.all():
            parts = []
            for op in OPERATIONS:
                cfg = mat.get(op)
                if not cfg:
                    continue
                origin = {
                    "test": "picked from a test grid",
                    "saved": "saved by the person",
                    "starting": "untested starting point",
                }[cfg["source"]]
                extra = f", interval {cfg['interval']} mm" if cfg.get("interval") else ""
                when = f" on {cfg['date']}" if cfg.get("date") and cfg["source"] != "starting" else ""
                parts.append(
                    f"{op} {cfg['mode']} {cfg['speed']:g} mm/min {cfg['power']:g}% x{cfg['passes']}{extra} ({origin}{when})"
                )
            if not parts and not mat["notes"]:
                continue
            line = f"{mat['name']}: " + "; ".join(parts) if parts else f"{mat['name']}: no settings saved yet"
            if mat["notes"]:
                line += f". Notes: {mat['notes']}"
            rows.append(line)
        return "\n".join(rows)


def default_path(config_path: Path) -> Path:
    override = os.environ.get("ENGRAVER_MATERIALS")
    return Path(override) if override else config_path.with_name("materials.json")
