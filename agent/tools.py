"""
AgentTrail - Tool Executors
Every tool goes through traced_tool_call() so nothing bypasses
instrumentation + policy enforcement.
"""

import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid

from instrumentation import traced_tool_call, record_tool_output, record_confirm_resolution, taint_ctx, broadcast
from policy import Decision

CONFIRM_STATUS_URL = "http://localhost:8766/confirm-status"


class PolicyBlocked(Exception):
    def __init__(self, reasons):
        self.reasons = reasons
        super().__init__(f"Blocked by policy: {reasons}")


class PolicyPendingConfirm(Exception):
    def __init__(self, reasons):
        self.reasons = reasons
        super().__init__(f"User denied confirmation: {reasons}")


def _cli_confirm(tool_name: str, target: str, reasons: list) -> bool:
    """Fallback pause/confirm UI: ask the human running the terminal.
    Used when the AgentTrail panel/relay isn't reachable."""
    print(f"\n⚠️  CONFIRMATION NEEDED: {tool_name} -> {target}")
    print(f"    reasons: {', '.join(reasons)}")
    resp = input("    Allow this action? [y/N]: ").strip().lower()
    return resp == "y"


def _web_confirm(tool_name: str, target: str, reasons: list, timeout: float = 120.0) -> bool:
    """Default pause/confirm UI: broadcast a confirm_request event (the
    AgentTrail panel shows it as a banner with Approve/Deny buttons) and
    poll the relay for the panel's decision. Falls back to the CLI prompt
    if the relay/panel isn't reachable at all, so the toy agent still
    works standalone without the panel running."""
    confirm_id = str(uuid.uuid4())
    broadcast({
        "type": "confirm_request",
        "id": confirm_id,
        "session_id": taint_ctx.session_id,
        "tool": tool_name,
        "target": target,
        "reasons": reasons,
        "ts": time.time(),
    })

    print(f"\n⚠️  CONFIRMATION NEEDED: {tool_name} -> {target} (reasons: {', '.join(reasons)})")
    print(f"    Waiting for Approve/Deny in the AgentTrail panel ({timeout:.0f}s timeout)...")

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{CONFIRM_STATUS_URL}?id={confirm_id}", timeout=3) as resp:
                data = json.loads(resp.read())
        except (urllib.error.URLError, OSError):
            print("    panel/relay not reachable -- falling back to terminal prompt")
            return _cli_confirm(tool_name, target, reasons)

        if data.get("resolved"):
            approved = bool(data.get("approved"))
            print(f"    -> {'APPROVED' if approved else 'DENIED'} via panel")
            return approved
        time.sleep(1)

    print("    timed out waiting for a decision -- defaulting to DENY")
    return False


# Swappable so a different front-end can replace this without touching
# the gating logic below (assign a different function to
# tools.confirm_prompt with the same signature).
confirm_prompt = _web_confirm


def _gate(decision, reasons, tool_name: str = "", target: str = ""):
    if decision == Decision.BLOCK:
        raise PolicyBlocked(reasons)
    if decision == Decision.PENDING_CONFIRM:
        approved = confirm_prompt(tool_name, target, reasons)
        record_confirm_resolution(tool_name, target, approved)
        if not approved:
            raise PolicyPendingConfirm(reasons)


def read_file(path: str) -> str:
    with traced_tool_call("read_file", path, {}) as ctx:
        _gate(ctx.decision, ctx.reasons, "read_file", path)
        with open(path, "r", errors="ignore") as f:
            content = f.read()
    record_tool_output("read_file", path, content, source_hint=path)
    return content


def write_file(path: str, content: str) -> str:
    with traced_tool_call("write_file", path, {"len": len(content)}) as ctx:
        _gate(ctx.decision, ctx.reasons, "write_file", path)
        with open(path, "w") as f:
            f.write(content)
    return f"wrote {len(content)} chars to {path}"


def run_shell(cmd: str) -> str:
    with traced_tool_call("run_shell", cmd, {}) as ctx:
        _gate(ctx.decision, ctx.reasons, "run_shell", cmd)
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
        output = result.stdout + result.stderr
    record_tool_output("run_shell", cmd, output)
    return output


def call_api(url: str, method: str = "GET", body: str = "") -> str:
    with traced_tool_call("call_api", url, {"method": method}) as ctx:
        _gate(ctx.decision, ctx.reasons, "call_api", url)
        req = urllib.request.Request(url, data=body.encode() if body else None, method=method)
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode(errors="ignore")
    record_tool_output("call_api", url, content, source_hint=url)
    return content


TOOL_REGISTRY = {
    "read_file": read_file,
    "write_file": write_file,
    "run_shell": run_shell,
    "call_api": call_api,
}
