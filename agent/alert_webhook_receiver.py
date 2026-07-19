"""
AgentTrail - local alert webhook receiver (demo/dev use)

SigNoz's alertmanager POSTs alert payloads here instead of to a real
mail server or an external service like webhook.site. Keeps the whole
pipeline self-hosted, and gives an easy way to *see* an alert land
during the demo (prints each firing/resolved alert to the console).

Must listen on 0.0.0.0, not localhost: SigNoz runs in a Docker
container on its own bridge network, so it reaches the host via the
container's default gateway IP, not "localhost".

Run standalone: `python alert_webhook_receiver.py`
  -> http://0.0.0.0:8091/alert  (point SigNoz's webhook channel here,
     using the HOST's gateway IP as seen from inside the SigNoz
     container, e.g. http://172.20.0.1:8091/alert -- check with
     `docker inspect <signoz-container> --format '{{json .NetworkSettings.Networks}}'`)
"""

import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer


class AlertHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {"raw": body.decode(errors="ignore")}

        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        alerts = payload.get("alerts", [payload])
        print(f"\n=== [{ts}] alert webhook received ({len(alerts)} alert(s)) ===")
        for a in alerts:
            status = a.get("status", "?")
            labels = a.get("labels", {})
            annotations = a.get("annotations", {})
            print(f"  status: {status}")
            for k, v in labels.items():
                print(f"  label.{k}: {v}")
            for k, v in annotations.items():
                print(f"  annotation.{k}: {v}")
        print("=" * 50)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def log_message(self, format, *args):
        pass


def main():
    server = HTTPServer(("0.0.0.0", 8091), AlertHandler)
    print("Alert webhook receiver listening on http://0.0.0.0:8091/alert")
    server.serve_forever()


if __name__ == "__main__":
    main()
