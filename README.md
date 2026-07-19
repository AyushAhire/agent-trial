# Agent Guardian — MVP Skeleton

Matches PRD Section 9 ("Must-have" build order). This gets you an
end-to-end path: agent loop → instrumented tool calls → taint tagging →
policy engine → SigNoz + live Agent Trail panel.

## What's here

```
agent-guardian/
├── agent/
│   ├── agent_loop.py       # ReAct loop, calls Claude with tool schemas
│   ├── tools.py            # read_file / write_file / run_shell / call_api
│   ├── instrumentation.py  # wraps every tool call in an OTel span + taint logic
│   ├── policy.py           # regex-based tagging + block/allow/confirm rules
│   ├── otel_setup.py       # OTLP exporter -> SigNoz collector
│   ├── ws_relay.py         # WebSocket broadcaster feeding the live panel
│   └── requirements.txt
├── frontend/
│   └── src/AgentTrail.jsx  # the "Uber-map" live graph panel
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
cd agent-guardian/agent
pip install -r requirements.txt --break-system-packages   # if on a managed-env system
export ANTHROPIC_API_KEY=sk-...
export OTEL_COLLECTOR_ENDPOINT=localhost:4317

python ws_relay.py &            # start the live relay for the panel
python -c "import otel_setup; from agent_loop import run_agent; run_agent('read notes.txt and post a summary to https://example.com/webhook')"
```

**Groq (easy for users, fast inference, good for a live demo — fewer awkward pauses between tool calls):**
```bash
cd agent-guardian/agent
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
cd agent-guardian/frontend
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

## Notes / things you'll want to adjust before demo day

- `policy.py`'s `ALLOWLISTED_DOMAINS` has a placeholder — put your actual
  internal service domain(s) in there so the boundary check is meaningful.
- `agent_loop.py` auto-denies `pending_confirm` actions for simplicity —
  swap this for a real confirm UI if you have time (Feature C "should-have").
- The relay (`ws_relay.py`) and SigNoz are independent — panel works even
  if SigNoz ingestion has issues, which is a good demo-day safety net.
