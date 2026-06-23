import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as srv  # noqa: E402

from fastapi.testclient import TestClient

client = TestClient(srv.app)


async def test_push_activity_event_appends_and_caps_log():
    srv.ACTIVITY_LOG.clear()
    for i in range(srv.ACTIVITY_LOG_MAX + 10):
        await srv._push_activity_event({"source": "test", "i": i})
    assert len(srv.ACTIVITY_LOG) == srv.ACTIVITY_LOG_MAX
    assert srv.ACTIVITY_LOG[-1]["i"] == srv.ACTIVITY_LOG_MAX + 9


async def test_activity_endpoint_returns_recent_events():
    srv.ACTIVITY_LOG.clear()
    await srv._push_activity_event({"source": "test", "msg": "hello"})
    resp = client.get("/api/activity")
    events = resp.json()["events"]
    assert events[-1]["msg"] == "hello"


def test_host_reachable_false_for_closed_port():
    assert srv._host_reachable("127.0.0.1", 1) is False


async def test_push_activity_event_discards_dead_websocket_client():
    class DeadClient:
        async def send_json(self, payload):
            raise RuntimeError("connection closed")

    srv.WS_CLIENTS.clear()
    dead = DeadClient()
    srv.WS_CLIENTS.add(dead)
    await srv._push_activity_event({"source": "test"})
    assert dead not in srv.WS_CLIENTS
