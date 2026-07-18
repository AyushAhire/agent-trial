"""
Agent Guardian - Instrumentation Middleware

Wraps every tool call in an OTel span, tags/propagates taint via span
attributes (baggage-style manual propagation kept simple for hackathon
reliability), runs the policy engine, and mirrors each event to the
Agent Trail live panel via a WebSocket broadcaster.

Design choice: rather than reading spans back OUT of SigNoz for the live
panel (adds a dependency on SigNoz query latency during the demo), we
mirror events to the frontend at EMIT time. SigNoz remains the system of
record for dashboards/alerts; the panel is a live tap on the same stream.
"""

import time
import uuid
import json
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

from policy import classify_content, evaluate_call, Decision, Tag

tracer = trace.get_tracer("agent-guardian")

# Session-level taint state: which tags are "in scope" for the current
# agent run, accumulated as tools produce tagged output. Simple dict
# instead of a general dataflow graph -> fast to build, good enough to demo.
class TaintContext:
    def __init__(self):
        self.session_id = str(uuid.uuid4())
        self.active_tags = set()  # tags currently "carried" by the agent's working memory
        self.history = []

    def absorb(self, tags: set):
        self.active_tags |= tags

    def snapshot(self):
        return sorted(t.value if hasattr(t, "value") else t for t in self.active_tags)


taint_ctx = TaintContext()


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


def record_tool_output(tool_name: str, target: str, output_text: str, source_hint: str = ""):
    """Call after a tool executes successfully: classify the OUTPUT and
    absorb any new taint tags into the session context so downstream
    tool calls inherit them (this is the propagation step)."""
    result = classify_content(output_text, source_hint=source_hint)
    taint_ctx.absorb(result.tags)

    broadcast({
        "type": "taint_update",
        "session_id": taint_ctx.session_id,
        "tool": tool_name,
        "target": target,
        "new_tags": [t.value for t in result.tags if t != Tag.PUBLIC],
        "ts": time.time(),
    })
    return result
