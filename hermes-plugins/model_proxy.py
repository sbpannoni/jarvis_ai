#!/usr/bin/env python3
"""Seat manager in front of snarf's single GPU inference seat (vLLM or llama.cpp).

snarf serves ONE model at a time on :8000. Hermes profiles each name the model
they want. Those two facts have to be reconciled somewhere, and where they are
reconciled decides whether the fleet tells the truth about itself.

THE OLD BEHAVIOUR, AND WHY IT IS GONE
The previous version of this file reconciled them by lying: it rewrote the
"model" field of every request to whatever happened to be resident, so a card
dispatched with --model qwen3.6-27b-awq ran for 7.5 hours on qwen3.8-27b-
abliterated-awq and recorded the wrong name. `hermes kanban set-model` was
decorative. Nothing downstream could know what actually produced a token.

THE NEW BEHAVIOUR
The model field is never modified. A request is answered by the model it asked
for, or it is not answered:
  requested == resident   -> forward untouched
  requested is installed  -> take the seat lock, swap, WAIT for ready, forward
  requested is unknown    -> 404 listing what is installed
  swap already running    -> 503 + Retry-After (do not queue behind a 52s load)
  swapped too recently    -> 503 + Retry-After (see MIN_DWELL below)

MIN_DWELL exists because two profiles wanting two models would otherwise
ping-pong the seat forever, paying a full model load each way and never
finishing anything. A model that just took the seat keeps it for MIN_DWELL
seconds; competing requests are told to come back rather than thrash it.

Swapping is delegated to `model-seat` on snarf, which is the thing that actually
holds the flock, drains in-flight requests, and blocks until /v1/models reports
the new occupant. This proxy never touches systemd itself.

model-seat, not vllm-seat (2026-09-27): vllm-seat only globs vllm-*.service and
takes its own lock file, so it could not load a llama.cpp model (a card pinned
to deepseek-v4-flash-0731 got a 404) and, worse, would start a vLLM unit while
a llama.cpp unit that model-seat loaded still held the GPUs and :8000 -- the
two tools' locks never saw each other. model-seat covers both backends under
one lock, and is what the coder-engine dispatcher already uses.

Every request appends one JSON line to EVENT_LOG recording what was asked for,
what served it, and whether a swap happened -- the feed the nightly tuner reads.
"""
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BACKEND = "http://192.168.1.239:8000"
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8010

SNARF = "sam@192.168.1.239"
SNARF_KEY = "/root/.hermes/profiles/coder/snarf_key"
SSH = ["ssh", "-i", SNARF_KEY, "-o", "BatchMode=yes",
       "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"]

MODEL_CACHE_TTL = 3.0
CATALOG_TTL = 300.0
# Upper bound on one swap as seen from here. model-seat applies its own
# per-backend ready timeout (420s vLLM, 900s llama.cpp -- a 145GB GGUF loads
# far slower than an AWQ checkpoint), so this is only the ssh safety net.
SWAP_TIMEOUT = 900.0
SEAT = "/home/sam/bin/model-seat"
MIN_DWELL = 120.0
EVENT_LOG = "/var/log/hermes-model-proxy.jsonl"

REWRITE_PATHS = ("/v1/chat/completions", "/v1/completions", "/v1/embeddings")

# Mistral-family models reject any reasoning_effort but 'none'/'high' with a
# NON-retryable 400, and Hermes' config.yaml sends 'medium'. Dropping the field
# lets the model apply its own default. This is a compatibility fix, not a lie:
# it removes a parameter the target cannot accept, and it is recorded in the
# event log rather than applied silently.
_MISTRAL_FAMILY = ("devstral", "mistral", "magistral", "codestral")
_MISTRAL_OK = ("none", "high")

_seat_lock = threading.Lock()
_swap_in_progress = threading.Event()
_state_lock = threading.Lock()
_model_cache = {"id": None, "ts": 0.0}
_catalog_cache = {"models": None, "ts": 0.0}
_last_swap_at = 0.0
_swap_target = None   # the model an in-progress swap is loading (guarded by _state_lock)
# When a client asks for the exact model the seat is ALREADY loading, wait this
# long for it rather than 503-ing (a caller that doesn't retry, e.g. a Hermes
# kanban worker, otherwise crashes mid-swap -- the orphaned-card bug). A caller
# wanting a DIFFERENT model still gets 503 immediately (no queuing behind a swap).
WAIT_FOR_MATCHING_SWAP = 180.0


def emit(event):
    event.setdefault("ts", time.time())
    try:
        with open(EVENT_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, separators=(",", ":")) + "\n")
    except OSError:
        pass


def resident_model(force=False):
    """served-model-name currently on :8000, or None if the seat is not servable."""
    now = time.time()
    with _state_lock:
        if not force and _model_cache["id"] and now - _model_cache["ts"] < MODEL_CACHE_TTL:
            return _model_cache["id"]
    try:
        with urllib.request.urlopen(f"{BACKEND}/v1/models", timeout=5) as resp:
            data = json.load(resp)
        entries = data.get("data") or []
        mid = entries[0].get("id") if entries else None
    except Exception:
        mid = None
    with _state_lock:
        _model_cache["id"] = mid
        _model_cache["ts"] = now
    return mid


def catalog():
    """Installed served-model-names, from model-seat on snarf (unit files are truth)."""
    now = time.time()
    with _state_lock:
        if _catalog_cache["models"] and now - _catalog_cache["ts"] < CATALOG_TTL:
            return _catalog_cache["models"]
    models = []
    try:
        proc = subprocess.run(SSH + [SNARF, f"{SEAT} --json list"],
                              capture_output=True, text=True, timeout=30)
        if proc.returncode == 0:
            models = [m["model"] for m in json.loads(proc.stdout).get("models", [])]
    except Exception:
        models = []
    if models:
        with _state_lock:
            _catalog_cache["models"] = models
            _catalog_cache["ts"] = now
    return models or (_catalog_cache["models"] or [])


def swap_seat(target):
    """Drive model-seat on snarf. Returns (ok, detail_dict). Blocks until ready."""
    global _last_swap_at
    began = time.time()
    try:
        proc = subprocess.run(
            SSH + [SNARF, f"{SEAT} --json switch {target}"],
            capture_output=True, text=True, timeout=SWAP_TIMEOUT + 60,
        )
    except subprocess.TimeoutExpired:
        return False, {"error": "swap_timeout", "target": target,
                       "elapsed": round(time.time() - began, 2)}
    try:
        detail = json.loads(proc.stdout)
    except Exception:
        detail = {"error": "unparseable_seat_output",
                  "stdout": proc.stdout[-400:], "stderr": proc.stderr[-400:]}
    ok = proc.returncode == 0 and detail.get("ok") is True
    if ok:
        with _state_lock:
            _last_swap_at = time.time()
            _model_cache["id"] = target
            _model_cache["ts"] = time.time()
    detail["elapsed"] = round(time.time() - began, 2)
    return ok, detail


def normalise_reasoning_effort(payload, model_id):
    effort = payload.get("reasoning_effort")
    if not effort:
        return False
    name = (model_id or "").lower()
    if any(tag in name for tag in _MISTRAL_FAMILY) and str(effort).lower() not in _MISTRAL_OK:
        payload.pop("reasoning_effort", None)
        return True
    return False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ---------------------------------------------------------------- replies

    def _json(self, code, obj, extra_headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code, kind, message, extra=None, headers=None):
        payload = {"error": {"type": kind, "message": message}}
        if extra:
            payload["error"].update(extra)
        self._json(code, payload, headers)

    # ---------------------------------------------------------------- routing

    def _resolve_seat(self, requested):
        """Ensure `requested` is resident. Returns None on success, else a reply fn."""
        global _swap_target
        current = resident_model()
        if requested == current:
            return None, False

        installed = catalog()
        if installed and requested not in installed:
            return (lambda: self._error(
                404, "model_not_installed",
                f"model {requested!r} is not installed on snarf",
                {"requested": requested, "available": sorted(installed)})), False

        if _swap_in_progress.is_set():
            with _state_lock:
                target = _swap_target
            if target == requested:
                # The seat is already loading exactly what we want. Wait for it
                # instead of 503-ing -- a client that doesn't retry (Hermes kanban
                # worker) would otherwise crash mid-swap and orphan its card. This
                # only ever waits for the model the caller asked for; a different
                # target still 503s below (no queuing behind a swap).
                deadline = time.time() + WAIT_FOR_MATCHING_SWAP
                while _swap_in_progress.is_set() and time.time() < deadline:
                    if resident_model(force=True) == requested:
                        return None, False
                    time.sleep(2.0)
                if resident_model(force=True) == requested:
                    return None, False
            return (lambda: self._error(
                503, "seat_swapping",
                "the inference seat is loading another model; retry shortly",
                {"requested": requested, "resident": current},
                {"Retry-After": "60"})), False

        with _state_lock:
            since = time.time() - _last_swap_at
        if _last_swap_at and since < MIN_DWELL:
            return (lambda: self._error(
                503, "seat_dwell",
                f"model {current!r} took the seat {int(since)}s ago; "
                f"minimum dwell is {int(MIN_DWELL)}s to prevent thrashing",
                {"requested": requested, "resident": current,
                 "retry_after": int(MIN_DWELL - since)},
                {"Retry-After": str(max(1, int(MIN_DWELL - since)))})), False

        if not _seat_lock.acquire(blocking=False):
            return (lambda: self._error(
                503, "seat_busy", "another request is swapping the seat",
                {"requested": requested}, {"Retry-After": "60"})), False
        try:
            _swap_in_progress.set()
            with _state_lock:
                _swap_target = requested   # let a matching concurrent request wait, not 503
            # Re-check under the lock: a concurrent swap may have already
            # delivered what we need while we were waiting to get here.
            if resident_model(force=True) == requested:
                return None, False
            ok, detail = swap_seat(requested)
            emit({"event": "swap", "requested": requested, "previous": current,
                  "ok": ok, "detail": detail})
            if not ok:
                return (lambda: self._error(
                    503, "seat_swap_failed",
                    f"could not put {requested!r} in the seat",
                    {"requested": requested, "detail": detail},
                    {"Retry-After": "120"})), False
            return None, True
        finally:
            _swap_in_progress.clear()
            with _state_lock:
                _swap_target = None
            _seat_lock.release()

    def _proxy(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        started = time.time()
        requested = None
        swapped = False
        dropped_effort = False

        if body and self.path in REWRITE_PATHS:
            try:
                payload = json.loads(body)
            except Exception:
                payload = None
            if isinstance(payload, dict):
                requested = payload.get("model")
                if requested:
                    reply, swapped = self._resolve_seat(requested)
                    if reply is not None:
                        emit({"event": "request", "path": self.path, "requested": requested,
                              "served_by": None, "swapped": False, "outcome": "refused"})
                        reply()
                        return
                # The model field is NOT modified. Only the incompatible
                # reasoning_effort is dropped, and it is recorded.
                dropped_effort = normalise_reasoning_effort(payload, requested)
                body = json.dumps(payload).encode()

        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ("host", "content-length")}
        req = urllib.request.Request(f"{BACKEND}{self.path}", data=body or None,
                                     method=self.command, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=900) as resp:
                clen = resp.getheader("Content-Length")
                self.send_response(resp.status)
                for k, v in resp.getheaders():
                    if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                        self.send_header(k, v)
                if clen is not None:
                    self.send_header("Content-Length", clen)
                else:
                    # Streaming (SSE): no length known up front. Delimit by
                    # close rather than emitting an unframed body on a
                    # keep-alive connection, which is what made the old proxy
                    # hang clients mid-stream.
                    self.send_header("Connection", "close")
                    self.close_connection = True
                self.end_headers()
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            outcome = "ok"
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            outcome = f"upstream_{e.code}"
        except Exception as e:
            self._error(502, "ProxyError", str(e), {"requested": requested})
            outcome = "proxy_error"

        if requested:
            emit({"event": "request", "path": self.path, "requested": requested,
                  "served_by": requested, "swapped": swapped,
                  "dropped_reasoning_effort": dropped_effort,
                  "latency": round(time.time() - started, 2), "outcome": outcome})

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        self._proxy()


if __name__ == "__main__":
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()
