"""Settings saved on this computer: machine profile and bug report sign-in.

The optional GitHub token is stored in plain text in a file only the current
user can read. It is never sent back to the browser.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

from .bugs import BugSettings
from .gcode import MachineProfile


class CameraPoint(BaseModel):
    """One calibration point: where it is in the camera picture and on the bed."""

    u: float = Field(ge=0, le=1)  # fraction of the picture's width, from the left
    v: float = Field(ge=0, le=1)  # fraction of the picture's height, from the top
    x: float = Field(ge=-2000, le=2000)  # mm from the bed's front-left corner, to the right
    y: float = Field(ge=-2000, le=2000)  # mm from the front, away


class CameraSettings(BaseModel):
    """A webcam looking down at the bed. The device id is the browser's, so it's only meaningful there."""

    device_id: str = Field(default="", max_length=300)
    label: str = Field(default="", max_length=200)
    points: list[CameraPoint] = []

    @field_validator("points")
    @classmethod
    def _four_or_none(cls, points: list[CameraPoint]) -> list[CameraPoint]:
        if points and len(points) != 4:
            raise ValueError("calibration needs exactly four points")
        return points


class MaterialArea(BaseModel):
    """A piece of material on the bed, saved by name: front-left corner and size in machine mm."""

    id: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=60)
    x: float = Field(ge=-2000, le=2000)
    y: float = Field(ge=-2000, le=2000)
    w: float = Field(gt=0, le=4000)
    h: float = Field(gt=0, le=4000)


class Settings(BaseModel):
    machine: MachineProfile = MachineProfile()
    bugs: BugSettings = BugSettings()
    camera: CameraSettings = CameraSettings()
    areas: list[MaterialArea] = []


def default_path() -> Path:
    override = os.environ.get("ENGRAVER_CONFIG")
    if override:
        return Path(override)
    return Path.home() / ".engraver" / "config.json"


class ConfigStore:
    def __init__(self, path: Path | None = None):
        self.path = path or default_path()
        self._lock = threading.Lock()
        self.settings = self._load()

    def _load(self) -> Settings:
        try:
            data = json.loads(self.path.read_text())
            settings = Settings.model_validate(data)
        except FileNotFoundError:
            return Settings()
        except Exception:
            # A corrupt file shouldn't stop the app from starting.
            return Settings()
        if isinstance(data, dict) and "llm" in data:
            # The built-in assistant is gone: rewrite the file so its API key doesn't stay on disk.
            self.settings = settings
            try:
                self.save()
            except OSError:
                pass
        return settings

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.settings.model_dump(), indent=2))
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            tmp.replace(self.path)

    def public(self) -> dict:
        data = self.settings.model_dump()
        token = data["bugs"].pop("token")
        data["bugs"]["token_set"] = bool(token)
        return data

    def update(self, patch: dict) -> None:
        current = self.settings.model_dump()
        machine = {**current["machine"], **(patch.get("machine") or {})}
        bugs_patch = dict(patch.get("bugs") or {})
        if bugs_patch.pop("clear_token", False):
            bugs_patch["token"] = ""
        elif not bugs_patch.get("token"):
            bugs_patch.pop("token", None)
        bugs_patch.pop("token_set", None)
        if "repo" in bugs_patch:
            bugs_patch["repo"] = str(bugs_patch["repo"]).strip().removeprefix("https://github.com/").strip("/")
        bugs = {**current["bugs"], **bugs_patch}
        camera = {**current["camera"], **(patch.get("camera") or {})}
        self.settings = Settings.model_validate(
            {"machine": machine, "bugs": bugs, "camera": camera, "areas": patch.get("areas", current["areas"])}
        )
        self.save()
