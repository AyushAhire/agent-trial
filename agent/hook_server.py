"""
AgentTrail - Claude Code HTTP Hook Server (Feature F)

The only new component for the Claude Code integration: a thin adapter
that translates Claude Code's PreToolUse/PostToolUse hook JSON into calls
against the SAME policy engine and taint context the toy agent uses
(policy.py's evaluate_call()/classify_content(), instrumentation.py's
taint_ctx). Nothing about the policy/observability engine changes to
support this — Claude Code is just a second caller.

Routes:
  POST /hooks/pre-tool-use   -> allow / deny / ask
  POST /hooks/post-tool-use  -> classify output, absorb taint

Claude Code HTTP hook contract (see code.claude.com/docs/hooks):
  - Request body has tool_name / tool_input (PreToolUse) or
    tool_name / tool_input / tool_output (PostToolUse).
  - Response must be 2xx with a JSON body to actually take effect:
    {"hookSpecificOutput": {"hookEventName": ..., "permissionDecision":
     "allow"|"deny"|"ask", "permissionDecisionReason": "..."}}
  - Non-2xx or a timeout FAILS OPEN (Claude Code proceeds as if allowed),
    so this server must always answer 200 with a decision.
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from instrumentation import precheck, record_tool_output
from policy import Decision

# Claude Code tool name -> our internal tool vocabulary (matches the
# vocab evaluate_call() already understands from the toy agent).
TOOL_NAME_MAP = {
    "Read": "read_file",
    "Edit": "write_file",
    "Write": "write_file",
    "NotebookEdit": "write_file",
    "Bash": "run_shell",
    "WebFetch": "call_api",
}

# Tools whose target lives under a path-shaped key vs. a command/url key.
TARGET_KEY_MAP = {
    "Read": "file_path",
    "Edit": "file_path",
    "Write": "file_path",
    "NotebookEdit": "notebook_path",
    "Bash": "command",
    "WebFetch": "url",
}

DECISION_TO_PERMISSION = {
    Decision.ALLOW: "allow",
    Decision.BLOCK: "deny",
    Decision.PENDING_CONFIRM: "ask",
}


def _extract_target(tool_name: str, tool_input: dict) -> str:
    key = TARGET_KEY_MAP.get(tool_name)
    if key and key in tool_input:
        return str(tool_input[key])
    return json.dumps(tool_input)[:200]


def _stringify_output(tool_output) -> str:
    if isinstance(tool_output, str):
        return tool_output
    if isinstance(tool_output, dict):
        # Claude Code's Read tool nests content differently across tool
        # types; take the most likely text field, fall back to the whole blob.
        for key in ("content", "output", "stdout", "text"):
            if key in tool_output and isinstance(tool_output[key], str):
                return tool_output[key]
    return json.dumps(tool_output)[:5000]


class HookHandler(BaseHTTPRequestHandler):
    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(body or b"{}")
        except json.JSONDecodeError:
            return {}

    def _respond_json(self, obj: dict, status: int = 200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path == "/hooks/pre-tool-use":
            self._pre_tool_use()
        elif self.path == "/hooks/post-tool-use":
            self._post_tool_use()
        else:
            self._respond_json({"error": "not found"}, 404)

    def _pre_tool_use(self):
        payload = self._read_json()
        tool_name = payload.get("tool_name", "")
        tool_input = payload.get("tool_input", {}) or {}

        mapped_tool = TOOL_NAME_MAP.get(tool_name, tool_name.lower())
        target = _extract_target(tool_name, tool_input)

        # path denylist (admin/**, .env*, secrets/**) is now enforced
        # inside evaluate_call() itself, so both front-ends get it uniformly
        result = precheck(mapped_tool, target, tool_input)
        permission = DECISION_TO_PERMISSION[result.decision]

        self._respond_json({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": permission,
                "permissionDecisionReason": "; ".join(result.reasons) if result.reasons else "ok",
            }
        })

    def _post_tool_use(self):
        payload = self._read_json()
        tool_name = payload.get("tool_name", "")
        tool_input = payload.get("tool_input", {}) or {}
        tool_output = payload.get("tool_output", "")

        mapped_tool = TOOL_NAME_MAP.get(tool_name, tool_name.lower())
        target = _extract_target(tool_name, tool_input)
        output_text = _stringify_output(tool_output)

        record_tool_output(mapped_tool, target, output_text, source_hint=target)

        # Always allow post-hoc (data is already read); we only pause/deny
        # in PreToolUse. Empty hookSpecificOutput = no override.
        self._respond_json({"hookSpecificOutput": {"hookEventName": "PostToolUse"}})

    def log_message(self, format, *args):
        pass  # quiet; the console is busy enough during a demo


def main():
    import os
    import otel_setup  # noqa: F401  side effect: configures the OTel exporter

    host = os.environ.get("HOOK_SERVER_HOST", "localhost")
    port = int(os.environ.get("HOOK_SERVER_PORT", "8090"))
    server = ThreadingHTTPServer((host, port), HookHandler)
    print(f"AgentTrail hook server listening on http://{host}:{port}/hooks/{{pre,post}}-tool-use")
    server.serve_forever()


if __name__ == "__main__":
    main()
