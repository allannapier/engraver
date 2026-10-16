"""Saved designs: kept in a folder next to the settings file."""

import json

import pytest
from fastapi.testclient import TestClient

from engraver import saved
from engraver.app import create_app
from engraver.config import ConfigStore
from engraver.saved import NotFound, SavedError, Shelf

PROJECT = {"format": "engraver-project", "version": 1, "doc": {"layers": [], "objects": []}, "ui": {}}
THUMB = "data:image/jpeg;base64,/9j/4AAQ"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    """Each save gets a later time, so "newest first" doesn't depend on clock resolution."""
    ticks = iter(range(1_700_000_000, 1_800_000_000))
    monkeypatch.setattr(saved.time, "time", lambda: float(next(ticks)))


@pytest.fixture
def client(tmp_path):
    app = create_app(store=ConfigStore(tmp_path / "config.json"), sim_speed=80, extra_hosts=("testserver",))
    with TestClient(app) as c:
        c.dir = tmp_path
        yield c


def test_save_list_open_and_delete_a_design(client):
    assert client.get("/api/designs").json() == {"designs": []}
    meta = client.post("/api/designs", json={"name": "  Coaster   set ", "project": PROJECT, "thumb": THUMB}).json()
    assert meta["name"] == "Coaster set"
    assert meta["thumb"] == THUMB
    assert (client.dir / "designs" / f"{meta['id']}.json").exists()

    listed = client.get("/api/designs").json()["designs"]
    assert [d["id"] for d in listed] == [meta["id"]]

    item = client.get(f"/api/designs/{meta['id']}").json()
    assert item["data"] == PROJECT

    changed = {**PROJECT, "ui": {"materialId": "oak"}}
    again = client.put(f"/api/designs/{meta['id']}", json={"name": "Coaster set", "project": changed}).json()
    assert again["id"] == meta["id"]
    assert "thumb" not in again
    assert client.get(f"/api/designs/{meta['id']}").json()["data"]["ui"] == {"materialId": "oak"}

    assert client.delete(f"/api/designs/{meta['id']}").json() == {"designs": []}
    assert client.get(f"/api/designs/{meta['id']}").status_code == 404


def test_a_name_in_use_is_only_replaced_when_asked(client):
    first = client.post("/api/designs", json={"name": "Sign", "project": PROJECT}).json()
    clash = client.post("/api/designs", json={"name": "sign", "project": PROJECT})
    assert clash.status_code == 409
    assert "already have a design" in clash.json()["detail"]

    second = client.post("/api/designs", json={"name": "sign", "project": PROJECT, "replace": True}).json()
    ids = [d["id"] for d in client.get("/api/designs").json()["designs"]]
    assert ids == [second["id"]]
    assert first["id"] not in ids


def test_newest_design_comes_first_and_bad_thumbs_are_dropped(client):
    a = client.post("/api/designs", json={"name": "A", "project": PROJECT}).json()
    b = client.post("/api/designs", json={"name": "B", "project": PROJECT, "thumb": "javascript:alert(1)"}).json()
    assert "thumb" not in b
    assert [d["id"] for d in client.get("/api/designs").json()["designs"]] == [b["id"], a["id"]]


def test_ids_that_are_not_ours_are_refused(client):
    assert client.get("/api/designs/..%2Fconfig").status_code == 404
    assert client.get("/api/designs/NOT-AN-ID").status_code == 404


def test_a_damaged_file_is_skipped(client):
    meta = client.post("/api/designs", json={"name": "Good", "project": PROJECT}).json()
    (client.dir / "designs" / ("ab" * 8 + ".json")).write_text("{not json")
    (client.dir / "designs" / "notes.json").write_text("{}")
    assert [d["id"] for d in client.get("/api/designs").json()["designs"]] == [meta["id"]]


def test_designs_are_capped(tmp_path):
    shelf = Shelf(tmp_path, noun="design", max_items=2, max_bytes=10_000)
    shelf.put("a" * 16, "one", {})
    shelf.put("b" * 16, "two", {})
    shelf.put("b" * 16, "two again", {})  # replacing one doesn't count against the cap
    with pytest.raises(SavedError, match="Delete some first"):
        shelf.put("c" * 16, "three", {})


def test_size_and_name_limits(tmp_path):
    shelf = Shelf(tmp_path, noun="design", max_items=5, max_bytes=2_000_000)
    with pytest.raises(SavedError, match="too big"):
        shelf.put("a" * 16, "big", {"svg": "x" * 2_000_000})
    with pytest.raises(SavedError, match="name"):
        shelf.put("a" * 16, "   ", {})
    with pytest.raises(NotFound):
        shelf.get("a" * 16)
    assert not list(tmp_path.iterdir())


def test_saved_files_are_private(tmp_path):
    shelf = Shelf(tmp_path, noun="design", max_items=5, max_bytes=10_000)
    shelf.put("a" * 16, "mine", {"x": 1})
    path = tmp_path / ("a" * 16 + ".json")
    assert json.loads(path.read_text())["data"] == {"x": 1}
    assert path.stat().st_mode & 0o077 == 0
