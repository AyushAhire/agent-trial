"""
AgentTrail - Instrumentation Middleware

Wraps every tool call in an OTel span, tags/propagates taint via span
attributes (baggage-style manual propagation kept simple for hackathon
reliability), runs the policy engine, and mirrors each event to the
Agent Trail live panel via a WebSocket broadcaster.

Design choice: rather than reading spans back OUT of SigNoz for the live
panel (adds a dependency on SigNoz query latency during the demo), we
mirror events to the frontend at EMIT time. SigNoz remains the system of
record for dashboards/alerts; the panel is a live tap on the same stream.
"""

import threading
import time
import uuid
import json
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

from policy import classify_content, evaluate_call, Decision, PolicyResult, Tag

tracer = trace.get_tracer("agent-guardian")

# Session-level taint state: which tags are "in scope" for the current
# agent run, accumulated as tools produce tagged output. Simple dict
# instead of a general dataflow graph -> fast to build, good enough to demo.
class TaintContext:
    def __init__(self, session_id: str = None):
        self.session_id = session_id or str(uuid.uuid4())
        self.active_tags = set()  # tags currently "carried" by the agent's working memory
        self.history = []

    def absorb(self, tags: set):
        self.active_tags |= tags

    def snapshot(self):
        return sorted(t.value if hasattr(t, "value") else t for t in self.active_tags)


# The toy agent is one short-lived process per run, so a single module-level
# context is correct for it. hook_server.py is a long-running process that
# serves MANY distinct Claude Code sessions over its lifetime, so it can't
# share this one singleton -- doing so would merge unrelated sessions into
# the same incident card and leak taint tags between them (session A reads
# a secret, unrelated session B inherits the tag and gets blocked for no
# reason). _session_contexts keys a separate TaintContext per Claude Code
# session_id; get_taint_context(None) returns the toy agent's singleton.
taint_ctx = TaintContext()
_session_contexts = {}
_session_contexts_lock = threading.Lock()


def get_taint_context(session_id: str = None) -> TaintContext:
    if not session_id:
        return taint_ctx
    with _session_contexts_lock:
        if session_id not in _session_contexts:
            _session_contexts[session_id] = TaintContext(session_id=session_id)
        return _session_contexts[session_id]


RELAY_INGEST_URL = "http://localhost:8766/event"


def broadcast(event: dict):
    """Send an event to the Agent Trail panel via the relay's HTTP ingest
    endpoint. The relay runs as a SEPARATE process, so this must go over
    the network (HTTP), not a direct Python import/function call — module
    state isn't shared across processes."""
    try:
        import urllib.request
        data = json.dumps(event).encode()
        req = urllib.request.Request(
            RELAY_INGEST_URL, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        urllib.request.urlopen(req, timeout=1)
    except Exception:
        pass  # relay not running; instrumentation still works standalone


@contextmanager
def traced_tool_call(tool_name: str, target: str, params: dict):
    """Use as: with traced_tool_call("call_api", url, {...}) as ctx: ... 
    ctx.decision tells the caller whether to actually execute the tool."""

    start = time.time()
    policy_result = evaluate_call(tool_name, target, params, taint_ctx.active_tags)

    with tracer.start_as_current_span(f"tool.{tool_name}") as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("tool.params_json", json.dumps(params)[:500])
        span.set_attribute("data.tags", ",".join(taint_ctx.snapshot()))
        span.set_attribute("risk.score", policy_result.risk_score)
        span.set_attribute("policy.decision", policy_result.decision.value)
        span.set_attribute("policy.reasons", ",".join(policy_result.reasons))
        span.set_attribute("session.id", taint_ctx.session_id)

        event = {
            "type": "tool_call",
            "session_id": taint_ctx.session_id,
            "tool": tool_name,
            "target": target,
            "tags": taint_ctx.snapshot(),
            "risk_score": policy_result.risk_score,
            "decision": policy_result.decision.value,
            "reasons": policy_result.reasons,
            "ts": start,
        }
        broadcast(event)

        if policy_result.decision == Decision.BLOCK:
            span.set_status(Status(StatusCode.ERROR, "blocked_by_policy"))
            span.add_event("policy.flag_raised", {"reasons": ",".join(policy_result.reasons)})

        class Ctx:
            decision = policy_result.decision
            reasons = policy_result.reasons

        yield Ctx()

        span.set_attribute("duration_ms", int((time.time() - start) * 1000))


def precheck(tool_name: str, target: str, params: dict, override_reason: str = None, session_id: str = None) -> PolicyResult:
    """Decision + telemetry only, no execution — for callers that don't run
    the tool themselves (the Claude Code PreToolUse hook adapter: Claude
    Code executes the tool after we hand back allow/deny/ask, we never
    touch the filesystem/shell/network here).

    override_reason: short-circuits straight to BLOCK (used for the hard
    path denylist in policy.check_path_denylist, which applies regardless
    of taint state and shouldn't wait on evaluate_call's taint-based rules).

    session_id: Claude Code's own session id. hook_server.py is one
    long-running process serving many distinct Claude Code sessions, so
    each needs its own isolated TaintContext (see get_taint_context) --
    without this, an unrelated session could inherit another session's
    taint tags, or two sessions would render as one merged incident card.
    """
    ctx = get_taint_context(session_id)

    if override_reason:
        policy_result = PolicyResult(Decision.BLOCK, 100, [override_reason])
    else:
        policy_result = evaluate_call(tool_name, target, params, ctx.active_tags)

    with tracer.start_as_current_span(f"tool.{tool_name}") as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("tool.params_json", json.dumps(params)[:500])
        span.set_attribute("data.tags", ",".join(ctx.snapshot()))
        span.set_attribute("risk.score", policy_result.risk_score)
        span.set_attribute("policy.decision", policy_result.decision.value)
        span.set_attribute("policy.reasons", ",".join(policy_result.reasons))
        span.set_attribute("session.id", ctx.session_id)
        span.set_attribute("source", "claude_code_hook")

        if policy_result.decision == Decision.BLOCK:
            span.set_status(Status(StatusCode.ERROR, "blocked_by_policy"))
            span.add_event("policy.flag_raised", {"reasons": ",".join(policy_result.reasons)})

        broadcast({
            "type": "tool_call",
            "session_id": ctx.session_id,
            "tool": tool_name,
            "target": target,
            "tags": ctx.snapshot(),
            "risk_score": policy_result.risk_score,
            "decision": policy_result.decision.value,
            "reasons": policy_result.reasons,
            "ts": time.time(),
            "source": "claude_code",
        })

    return policy_result


def record_confirm_resolution(tool_name: str, target: str, approved: bool):
    """A pending_confirm decision doesn't end at evaluate_call() anymore --
    a human resolves it (see tools.py's _gate). Broadcast the actual
    outcome so the panel/telemetry stream reflects what really happened,
    not just the pre-human-input pause."""
    broadcast({
        "type": "confirm_resolution",
        "session_id": taint_ctx.session_id,
        "tool": tool_name,
        "target": target,
        "decision": "allow" if approved else "block",
        "ts": time.time(),
    })


def record_tool_output(tool_name: str, target: str, output_text: str, source_hint: str = "", session_id: str = None):
    """Call after a tool executes successfully: classify the OUTPUT and
    absorb any new taint tags into the session context so downstream
    tool calls inherit them (this is the propagation step).

    session_id: see precheck() -- this is the function that actually
    absorbs taint, so it's the one that most needs per-session isolation
    (otherwise one Claude Code session's secret read taints every other
    session hitting the same hook_server.py process)."""
    ctx = get_taint_context(session_id)
    result = classify_content(output_text, source_hint=source_hint)
    ctx.absorb(result.tags)

    broadcast({
        "type": "taint_update",
        "session_id": ctx.session_id,
        "tool": tool_name,
        "target": target,
        "new_tags": [t.value for t in result.tags if t != Tag.PUBLIC],
        "ts": time.time(),
    })
    return result
