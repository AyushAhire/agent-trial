"""
Agent Guardian - Tool Executors
Every tool goes through traced_tool_call() so nothing bypasses
instrumentation + policy enforcement.
"""

import subprocess
import urllib.request

from instrumentation import traced_tool_call, record_tool_output, record_confirm_resolution
from policy import Decision


class PolicyBlocked(Exception):
    def __init__(self, reasons):
        self.reasons = reasons
        super().__init__(f"Blocked by policy: {reasons}")


class PolicyPendingConfirm(Exception):
    def __init__(self, reasons):
        self.reasons = reasons
        super().__init__(f"User denied confirmation: {reasons}")


def _cli_confirm(tool_name: str, target: str, reasons: list) -> bool:
    """Default pause/confirm UI: ask the human running the terminal.
    Swap this out (assign a different function to tools.confirm_prompt)
    for a non-CLI front-end (e.g. wiring it to the AgentTrail panel)."""
    print(f"\n⚠️  CONFIRMATION NEEDED: {tool_name} -> {target}")
    print(f"    reasons: {', '.join(reasons)}")
    resp = input("    Allow this action? [y/N]: ").strip().lower()
    return resp == "y"


# Swappable so a different front-end (e.g. a web prompt) can replace the
# CLI y/n prompt without touching the gating logic below.
confirm_prompt = _cli_confirm


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
