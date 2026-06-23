import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as srv  # noqa: E402

from fastapi.testclient import TestClient

client = TestClient(srv.app)


def test_ha_call_service_requires_domain_and_service():
    resp = client.post("/api/ha/call_service", json={"entity_id": "light.x"})
    assert resp.status_code == 400


def test_ha_call_service_503_when_not_configured(monkeypatch):
    monkeypatch.setitem(srv.CFG, "homeassistant", {})
    resp = client.post("/api/ha/call_service", json={"domain": "light", "service": "turn_on"})
    assert resp.status_code == 503


def test_ha_call_service_posts_to_ha_rest_api(monkeypatch):
    monkeypatch.setitem(srv.CFG, "homeassistant", {"base_url": "http://ha.example"})
    monkeypatch.setenv("HASS_TOKEN", "test-token")

    captured = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"state": "on"}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        return FakeResponse()

    monkeypatch.setattr(srv.requests, "post", fake_post)

    resp = client.post("/api/ha/call_service", json={
        "domain": "light", "service": "turn_on", "entity_id": "light.living_room",
    })
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "result": {"state": "on"}}
    assert captured["url"] == "http://ha.example/api/services/light/turn_on"
    assert captured["headers"]["Authorization"] == "Bearer test-token"
    assert captured["json"] == {"entity_id": "light.living_room"}
