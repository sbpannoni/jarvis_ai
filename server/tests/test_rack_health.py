import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as srv  # noqa: E402

from fastapi.testclient import TestClient

client = TestClient(srv.app)


def test_prometheus_query_raises_on_non_success_status(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"status": "error", "error": "bad query"}

    monkeypatch.setattr(srv.requests, "get", lambda *a, **k: FakeResponse())
    import pytest
    with pytest.raises(RuntimeError):
        srv._prometheus_query("http://prom.example", "up")


def test_prometheus_query_returns_result_list(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"status": "success", "data": {"result": [
                {"metric": {"instance": "x"}, "value": [1700000000, "42"]}
            ]}}

    monkeypatch.setattr(srv.requests, "get", lambda *a, **k: FakeResponse())
    result = srv._prometheus_query("http://prom.example", "up")
    assert result == [{"metric": {"instance": "x"}, "value": [1700000000, "42"]}]


def test_rack_health_endpoint_serves_cached_data_within_window():
    srv.RACK_HEALTH_CACHE.update(ts=time.time(), data={"x": "cached"})
    resp = client.get("/api/rack_health")
    assert resp.json() == {"x": "cached"}
