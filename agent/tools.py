"""
Agent Guardian - Tool Executors
Every tool goes through traced_tool_call() so nothing bypasses
instrumentation + policy enforcement.
"""

import subprocess
import urllib.request

from instrumentation import traced_tool_call, record_tool_output
from policy import Decision


class PolicyBlocked(Exception):
    def __init__(self, reasons):
        self.reasons = reasons
        super().__init__(f"Blocked by policy: {reasons}")


class PolicyPendingConfirm(Exception):
    def __init__(self, reasons):
        self.reasons = reasons
        super().__init__(f"Needs user confirmation: {reasons}")


def _gate(decision, reasons):
    if decision == Decision.BLOCK:
        raise PolicyBlocked(reasons)
    if decision == Decision.PENDING_CONFIRM:
        # Hackathon demo: raise so the agent loop can pause and show a
        # confirm prompt. A real product would await an async user response.
        raise PolicyPendingConfirm(reasons)


def read_file(path: str) -> str:
    with traced_tool_call("read_file", path, {}) as ctx:
        _gate(ctx.decision, ctx.reasons)
        with open(path, "r", errors="ignore") as f:
            content = f.read()
    record_tool_output("read_file", path, content, source_hint=path)
    return content


def write_file(path: str, content: str) -> str:
    with traced_tool_call("write_file", path, {"len": len(content)}) as ctx:
        _gate(ctx.decision, ctx.reasons)
        with open(path, "w") as f:
            f.write(content)
    return f"wrote {len(content)} chars to {path}"


def run_shell(cmd: str) -> str:
    with traced_tool_call("run_shell", cmd, {}) as ctx:
        _gate(ctx.decision, ctx.reasons)
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
        output = result.stdout + result.stderr
    record_tool_output("run_shell", cmd, output)
    return output


def call_api(url: str, method: str = "GET", body: str = "") -> str:
    with traced_tool_call("call_api", url, {"method": method}) as ctx:
        _gate(ctx.decision, ctx.reasons)
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
