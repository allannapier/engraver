"""Settings saved on this computer: machine profile and assistant provider.

The API key is stored in plain text in a file only the current user can read.
It is never sent back to the browser.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from pydantic import BaseModel

from .gcode import MachineProfile


class LLMSettings(BaseModel):
    model: str = ""  # LiteLLM model string, e.g. "anthropic/claude-sonnet-5-5"
    api_key: str = ""
    api_base: str = ""
    vision: bool = True  # send a picture of the canvas with each request
    max_tokens: int = 8000


class Settings(BaseModel):
    machine: MachineProfile = MachineProfile()
    llm: LLMSettings = LLMSettings()


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
            return Settings.model_validate(json.loads(self.path.read_text()))
        except FileNotFoundError:
            return Settings()
        except Exception:
            # A corrupt file shouldn't stop the app from starting.
            return Settings()

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
        key = data["llm"].pop("api_key")
        data["llm"]["api_key_set"] = bool(key)
        data["llm"]["api_key_hint"] = f"…{key[-4:]}" if len(key) >= 8 else ""
        return data

    def update(self, patch: dict) -> None:
        current = self.settings.model_dump()
        machine = {**current["machine"], **(patch.get("machine") or {})}
        llm_patch = dict(patch.get("llm") or {})
        # An empty key means "keep what's saved"; clearing is explicit.
        if llm_patch.pop("clear_api_key", False):
            llm_patch["api_key"] = ""
        elif not llm_patch.get("api_key"):
            llm_patch.pop("api_key", None)
        llm_patch.pop("api_key_set", None)
        llm_patch.pop("api_key_hint", None)
        llm = {**current["llm"], **llm_patch}
        self.settings = Settings.model_validate({"machine": machine, "llm": llm})
        self.save()
