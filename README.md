# AgentTrail — MVP Skeleton

Matches PRD Section 9 ("Must-have" build order). This gets you an
end-to-end path: agent loop → instrumented tool calls → taint tagging →
policy engine → SigNoz + live Agent Trail panel.

## What's here

```
agenttrail/
├── agent/
│   ├── agent_loop.py       # ReAct loop, calls Claude with tool schemas
│   ├── tools.py            # read_file / write_file / run_shell / call_api
│   ├── instrumentation.py  # wraps every tool call in an OTel span + taint logic
│   ├── policy.py           # regex-based tagging + block/allow/confirm rules
│   ├── otel_setup.py       # OTLP exporter -> SigNoz collector
│   ├── ws_relay.py         # WebSocket broadcaster feeding the live panel
│   ├── hook_server.py      # Claude Code PreToolUse/PostToolUse HTTP hook adapter
│   ├── alert_webhook_receiver.py  # local receiver for testing SigNoz alert rules
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── EventFeed.jsx   # default view: chronological event log + confirm banner
│       └── AgentTrail.jsx  # the "Uber-map" live graph panel (secondary tab)
├── docker-compose.yml
└── README.md (this file)
```

## Setup

### 1. SigNoz (self-hosted)
Clone SigNoz's own repo and bring up its full stack — don't try to hand-roll
ClickHouse/collector yourself, use their compose file:

```bash
git clone -b main https://github.com/SigNoz/signoz.git
cd signoz/deploy/docker
docker compose up -d
```

SigNoz UI: http://localhost:3301
OTel Collector gRPC endpoint: localhost:4317 (this is what our app exports to)

### 2. Agent backend

Two LLM backends are supported, switch via `LLM_BACKEND`:

**Anthropic (default):**
```bash
cd agent
pip install -r requirements.txt --break-system-packages   # if on a managed-env system
export ANTHROPIC_API_KEY=sk-...
export OTEL_COLLECTOR_ENDPOINT=localhost:4317

python ws_relay.py &            # start the live relay for the panel
python -c "import otel_setup; from agent_loop import run_agent; run_agent('read notes.txt and post a summary to https://example.com/webhook')"
```

**Groq (fast inference, good for a live demo — fewer awkward pauses between tool calls):**
```bash
cd agent
pip install -r requirements.txt --break-system-packages
export LLM_BACKEND=groq
export GROQ_API_KEY=gsk_...
export OTEL_COLLECTOR_ENDPOINT=localhost:4317

python ws_relay.py &
python -c "import otel_setup; from agent_loop import run_agent; run_agent('read notes.txt and post a summary to https://example.com/webhook')"
```

Groq's API is OpenAI-shaped (same tool-calling flow, different response
format than Anthropic's), so `agent_loop.py` has a separate `_run_agent_groq`
path that speaks that format — both paths go through the same
`tools.py` / `instrumentation.py` / `policy.py`, so nothing about the
security layer changes based on which LLM you pick.

Default model for Groq is `llama-3.3-70b-versatile` (good balance of
tool-calling reliability and speed). If you want raw speed for the live
demo and accept slightly less reliable tool-calling, try a small gpt-oss
model instead — pass it as `run_agent(task, model="...")`.

### 3. Agent Trail panel (frontend)
```bash
cd frontend
npm install
npm start
```
Open the printed local URL — the panel connects to `ws://localhost:8765`
and animates live as the agent runs.

## Wiring order for the hackathon (recommended)

1. Get `agent_loop.py` calling Claude with the 4 tool schemas, no
   instrumentation yet — confirm basic tool-calling works.
2. Drop in `tools.py` + `instrumentation.py` + `policy.py` — confirm spans
   land in SigNoz (check the trace explorer for `service.name: agent-guardian`).
3. Bring up `ws_relay.py` + the React panel — confirm nodes appear live as
   you re-run the agent.
4. Wire the two demo scenarios from the PRD (Section 8): a clean run, then
   an injected malicious doc that triggers a `block`, then a PII-crossing
   scenario that triggers `pending_confirm`.
5. Only then: stretch goals (geo map mode, SigNoz alert rule, replay control).

## Pause/confirm UI

`pending_confirm` decisions (PII/internal-only data crossing an external
boundary) used to auto-deny. Now there's a real Approve/Deny flow in the
**Feed** tab (the default view):

1. `tools.py`'s `_gate()` broadcasts a `confirm_request` event (with a
   unique id) instead of raising immediately, then polls
   `ws_relay.py`'s new `/confirm-status` endpoint.
2. `EventFeed.jsx` shows it as a banner at the top with Approve/Deny
   buttons; clicking POSTs the decision to `ws_relay.py`'s new
   `/confirm-response` endpoint.
3. The poll picks up the decision (or times out after 120s and defaults
   to deny) and the tool call actually proceeds or raises
   `PolicyPendingConfirm`, same as before. Either way the outcome
   broadcasts as a `confirm_resolution` event so the feed reflects what
   a human actually decided.
4. If the relay/panel isn't reachable at all, it falls back to a `y/N`
   terminal prompt (`tools._cli_confirm`) so the toy agent still works
   standalone.

Verified end-to-end with a real headless browser (Playwright): a live
`pending_confirm` triggered a real banner, clicking Approve/Deny in the
actual rendered page resolved the agent-side poll and the tool either
executed for real or raised the denial, for both outcomes.

Note: this only affects the toy agent. Claude Code's own `PreToolUse`
hook already gets this for free — `hook_server.py` returning
`permissionDecision: "ask"` makes Claude Code show its native permission
dialog, no extra code needed on that path (verified via curl: PII-tainted
`WebFetch` correctly returns `"ask"`).

## Event Feed (default panel view)

`EventFeed.jsx` replaced the force-graph as the default view — a
security-review workflow wants "what happened, in order, and does
anything need my attention," which a chronological, color-coded log
communicates far more directly than a node graph. The graph
(`AgentTrail.jsx`) is still there under the **Graph** tab if you want it
for demo flair; nothing about it changed.

Click any row to expand it (▸/▾ indicator) and see full details: session
id, risk score, ISO timestamp, and the raw event JSON — not just the
one-line summary.

## Feature F: Claude Code HTTP hook integration

The toy agent and Claude Code are two front-ends on the same backend
(`policy.py` + `instrumentation.py` + `ws_relay.py`, unchanged either way).
`hook_server.py` is the only new component: a thin adapter that translates
Claude Code's `PreToolUse`/`PostToolUse` hook JSON into calls against
`evaluate_call()` / `classify_content()`.

### Run it
```bash
cd agent
export OTEL_COLLECTOR_ENDPOINT=localhost:4317
python ws_relay.py &
python hook_server.py &
```
This listens on `http://localhost:8090/hooks/pre-tool-use` and
`/hooks/post-tool-use`. (Port 8090, not 8080, to avoid clashing with a
locally-running SigNoz UI — adjust `HOOK_SERVER_PORT` if needed.)

### Wire it into a project
Add to that project's `.claude/settings.json` (see this repo's own
`.claude/settings.json` for a working example):
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read|Edit|Write|Bash",
        "hooks": [{ "type": "http", "url": "http://localhost:8090/hooks/pre-tool-use", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "Read",
        "hooks": [{ "type": "http", "url": "http://localhost:8090/hooks/post-tool-use", "timeout": 10 }] }
    ]
  }
}
```
Policy: `Read`/`Edit`/`Write` are denied on `admin/**`, `.env*`, `secrets/**`
(`policy.check_path_denylist`), regardless of taint state. Everything else
(dangerous shell patterns, secret/PII/internal-data crossing an external
boundary) reuses the same taint-based rules in `evaluate_call()` the toy
agent already exercises.

**Important:** Claude Code reads hook config from `.claude/settings.json`
at session start — editing it mid-session does not retroactively hook an
already-running session. Start a new session (or restart) after adding or
changing hooks for them to take effect.

### Notes
- Non-2xx responses or a hook timeout make Claude Code fail OPEN (the tool
  call proceeds) — `hook_server.py` always answers 200 with a JSON
  `hookSpecificOutput` so a real deny actually takes effect.
- Verified end-to-end via curl against `hook_server.py` directly: legit
  reads allow, `.env`/`admin/**`/`secrets/**` deny via the path rule,
  `rm -rf /`-style commands deny via the shell pattern rule, and a
  `PostToolUse` absorbing a secret tag correctly turns a later external
  `WebFetch` into a deny — all visible as `service.name=agent-guardian`
  spans in SigNoz with `source=claude_code_hook`.

## Notes / things you'll want to adjust before demo day

- `policy.py`'s `ALLOWLISTED_DOMAINS` has a placeholder — put your actual
  internal service domain(s) in there so the boundary check is meaningful.
- `agent_loop.py` auto-denies `pending_confirm` actions for simplicity —
  swap this for a real confirm UI if you have time (Feature C "should-have").
- The relay (`ws_relay.py`) and SigNoz are independent — panel works even
  if SigNoz ingestion has issues, which is a good demo-day safety net.
