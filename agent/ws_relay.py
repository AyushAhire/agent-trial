"""
Agent Guardian - WebSocket Relay
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

Run standalone: `python ws_relay.py`
  -> ws://localhost:8765  (frontend connects here)
  -> http://localhost:8766/event  (agent process POSTs here)
"""

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import websockets

_CONNECTED = set()
_LOOP = None


async def _handler(websocket):
    _CONNECTED.add(websocket)
    try:
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
    if _LOOP is None:
        return
    asyncio.run_coroutine_threadsafe(_broadcast_async(event), _LOOP)


class _IngestHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/event":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            event = json.loads(body)
            push_event(event)
            self.send_response(200)
        except Exception as e:
            print(f"[relay] bad event: {e}")
            self.send_response(400)
        self.end_headers()

    def log_message(self, format, *args):
        pass  # quiet; the console is busy enough during a demo


def _run_http_ingest():
    server = HTTPServer(("localhost", 8766), _IngestHandler)
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
