"""
AgentTrail - WebSocket Relay
Two roles in one process:
  1. WebSocket server on :8765 -> the Agent Trail frontend connects here
     to receive live events.
  2. HTTP ingest endpoint on :8766 -> the agent process (a SEPARATE
     Python process from this one) POSTs events here.

Why HTTP for ingestion instead of importing this module from the agent
process: instrumentation.py runs in a different OS process than this
relay. Python module state (like the WebSocket connection list) is NOT
shared across processes, so a direct import + function call silently
no-ops. HTTP POST is the simplest reliable way to get an event from
one process into another without extra dependencies.

A new connection (fresh tab, reconnect, second viewer) is replayed the
last ~500 events before joining the live stream -- see _HISTORY -- so
"the panel wasn't open yet" no longer means an event is gone for good.

Run standalone: `python ws_relay.py`
  -> ws://localhost:8765  (frontend connects here)
  -> http://localhost:8766/event  (agent process POSTs here)
"""

import asyncio
import collections
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import websockets

_CONNECTED = set()
_LOOP = None

# Back-channel for the pause/confirm UI: the panel can't reach into the
# agent process directly (separate process, same as the event broadcast
# problem instrumentation.py's docstring describes), so a confirm decision
# is staged here and the agent side polls for it. Guarded by a lock since
# the HTTP ingest handler runs in its own thread pool.
_PENDING_CONFIRMS = {}
_PENDING_LOCK = threading.Lock()

# Replay buffer: a client that connects late (a fresh tab, a reconnect
# after a dropped socket, a second viewer) used to see NOTHING before it
# connected -- broadcast() is fire-and-forget with no memory. Keep the
# last N events here and replay them to each new connection before it
# starts receiving live ones, so "the panel wasn't open yet" stops being
# a way to silently miss a block. Capped, not unbounded -- this is a
# recent-history buffer, not a database.
_HISTORY = collections.deque(maxlen=500)
_HISTORY_LOCK = threading.Lock()


async def _handler(websocket):
    _CONNECTED.add(websocket)
    try:
        with _HISTORY_LOCK:
            backlog = list(_HISTORY)
        for event in backlog:
            await websocket.send(json.dumps(event))
        async for _ in websocket:
            pass  # panel doesn't send anything back in the MVP
    finally:
        _CONNECTED.discard(websocket)


async def _broadcast_async(event: dict):
    if not _CONNECTED:
        return
    msg = json.dumps(event)
    await asyncio.gather(*(ws.send(msg) for ws in list(_CONNECTED)), return_exceptions=True)


def push_event(event: dict):
    """Thread-safe entrypoint. Called from within THIS process only
    (the HTTP handler below runs in a thread inside this same process)."""
    with _HISTORY_LOCK:
        _HISTORY.append(event)
    if _LOOP is None:
        return
    asyncio.run_coroutine_threadsafe(_broadcast_async(event), _LOOP)


class _IngestHandler(BaseHTTPRequestHandler):
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _respond_json(self, obj: dict, status: int = 200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/confirm-status":
            self._respond_json({"error": "not found"}, 404)
            return
        confirm_id = parse_qs(parsed.query).get("id", [None])[0]
        with _PENDING_LOCK:
            if confirm_id in _PENDING_CONFIRMS:
                approved = _PENDING_CONFIRMS.pop(confirm_id)
                self._respond_json({"resolved": True, "approved": approved})
            else:
                self._respond_json({"resolved": False})

    def do_POST(self):
        if self.path == "/confirm-response":
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(body)
                confirm_id = payload["id"]
                with _PENDING_LOCK:
                    _PENDING_CONFIRMS[confirm_id] = bool(payload["approved"])
                self._respond_json({"status": "ok"})
            except Exception as e:
                print(f"[relay] bad confirm-response: {e}")
                self._respond_json({"error": str(e)}, 400)
            return

        if self.path != "/event":
            self._respond_json({"error": "not found"}, 404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            event = json.loads(body)
            push_event(event)
            self._respond_json({"status": "ok"})
        except Exception as e:
            print(f"[relay] bad event: {e}")
            self._respond_json({"error": str(e)}, 400)

    def log_message(self, format, *args):
        pass  # quiet; the console is busy enough during a demo


def _run_http_ingest():
    server = ThreadingHTTPServer(("localhost", 8766), _IngestHandler)
    print("Agent Trail ingest listening on http://localhost:8766/event")
    server.serve_forever()


def _run_server():
    global _LOOP
    _LOOP = asyncio.new_event_loop()
    asyncio.set_event_loop(_LOOP)

    threading.Thread(target=_run_http_ingest, daemon=True).start()

    async def main():
        async with websockets.serve(_handler, "localhost", 8765):
            print("Agent Trail relay listening on ws://localhost:8765")
            await asyncio.Future()  # run forever

    _LOOP.run_until_complete(main())


def start_in_background():
    t = threading.Thread(target=_run_server, daemon=True)
    t.start()


if __name__ == "__main__":
    _run_server()
