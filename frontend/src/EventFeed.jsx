import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";

/**
 * Chronological event feed -- the default AgentTrail view. Replaces the
 * force-graph as the primary UI: for a security-review workflow you want
 * to read "what happened, in order, and did anything need my attention"
 * at a glance, not decode node layout.
 *
 * Events are grouped into per-session incident cards rather than shown
 * as a flat list: a single agent run can fire many events in under a
 * second (e.g. a prompt-injection attempt that gets blocked 3 different
 * ways), and a flat list makes that read as noise instead of one story.
 * Anything non-clean (a block, a pending confirm, or an allowed-but-
 * flagged call) auto-expands; clean sessions stay collapsed.
 *
 * Also owns the pause/confirm back-channel: a `confirm_request` event
 * pins a banner with Approve/Deny buttons here. Clicking POSTs the
 * decision to the relay's /confirm-response endpoint, which the paused
 * tool call (tools.py's _web_confirm, polling /confirm-status) picks up.
 */

function decisionColor(event) {
  if (event.decision === "block") return "#ef4444";
  if (event.decision === "pending_confirm") return "#eab308";
  if (event.decision === "allow" && (event.risk_score || 0) > 0) return "#f97316"; // allowed but flagged -- don't let it hide next to a clean allow
  if (event.decision === "allow") return "#22c55e";
  return "#475569";
}

const SEVERITY_META = {
  critical: { color: "#ef4444", icon: "🔴" },
  warning: { color: "#eab308", icon: "🟡" },
  flagged: { color: "#f97316", icon: "🟠" },
  clean: { color: "#22c55e", icon: "🟢" },
};

function groupBySession(events) {
  const bySession = new Map();
  for (const e of events) {
    const sid = e.session_id || "unknown";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(e);
  }
  const sessions = Array.from(bySession.entries()).map(([sessionId, evts]) => {
    const blocked = evts.filter((e) => e.decision === "block").length;
    const asked = evts.filter((e) => e.decision === "pending_confirm").length;
    const flagged = evts.filter((e) => e.decision === "allow" && (e.risk_score || 0) > 0).length;
    let severity = "clean";
    if (blocked > 0) severity = "critical";
    else if (asked > 0) severity = "warning";
    else if (flagged > 0) severity = "flagged";
    return {
      sessionId,
      events: evts,
      blocked,
      asked,
      flagged,
      severity,
      total: evts.length,
      lastTs: Math.max(...evts.map((e) => e.ts || 0)),
    };
  });
  sessions.sort((a, b) => b.lastTs - a.lastTs);
  return sessions;
}

const RELAY_HTTP_BASE = "http://localhost:8766";
const MAX_EVENTS = 150;

export default function EventFeed({ wsUrl = "ws://localhost:8765" }) {
  const [events, setEvents] = useState([]);
  const [pending, setPending] = useState([]); // confirm_request events awaiting a decision
  const [connected, setConnected] = useState(false);
  const [expandedKey, setExpandedKey] = useState(null); // expanded individual event row (raw JSON), scoped within an expanded session
  const [sessionOverrides, setSessionOverrides] = useState({}); // sessionId -> explicit expand/collapse, overrides the severity-based default
  const wsRef = useRef();

  const sessions = useMemo(() => groupBySession(events), [events]);

  const toggleSession = useCallback((sessionId, currentEffective) => {
    setSessionOverrides((prev) => ({ ...prev, [sessionId]: !currentEffective }));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data);

      if (event.type === "confirm_request") {
        setPending((prev) => [...prev, event]);
        return; // shown only in the banner, not the feed list
      }
      if (event.type === "confirm_resolution") {
        // clear any matching pending banner (covers the case where a
        // decision came from somewhere other than this browser tab)
        setPending((prev) => prev.filter((p) => !(p.tool === event.tool && p.target === event.target)));
      }

      setEvents((prev) => [{ ...event, _key: `${event.ts}-${event.tool}-${Math.random()}` }, ...prev].slice(0, MAX_EVENTS));
    };
    return () => ws.close();
  }, [wsUrl]);

  const resolveConfirm = useCallback((item, approved) => {
    setPending((prev) => prev.filter((p) => p.id !== item.id));
    fetch(`${RELAY_HTTP_BASE}/confirm-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, approved }),
    }).catch(() => {
      // relay unreachable; tools.py's own timeout will fall back to deny
    });
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", background: "#0f172a", color: "#e2e8f0", overflow: "hidden" }}>
      <div style={{ padding: "8px 14px", borderBottom: "1px solid #1e293b", fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Agent Trail — Event Feed</span>
        <span style={{ opacity: 0.6 }}>{connected ? "● connected" : "○ disconnected"}</span>
      </div>

      {pending.length > 0 && (
        <div style={{ padding: 10, background: "#422006", borderBottom: "2px solid #eab308" }}>
          {pending.map((item) => (
            <div key={item.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", marginBottom: 6, background: "#1e293b", borderRadius: 6, borderLeft: "4px solid #eab308" }}>
              <div style={{ fontSize: 12, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>Confirmation needed: {item.tool}</div>
                <div style={{ opacity: 0.85, wordBreak: "break-all" }}>{item.target}</div>
                <div style={{ opacity: 0.6 }}>{(item.reasons || []).join(", ")}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0, marginLeft: 12 }}>
                <button
                  onClick={() => resolveConfirm(item, true)}
                  style={{ background: "#22c55e", color: "#0f172a", border: "none", borderRadius: 4, padding: "6px 12px", fontWeight: 600, cursor: "pointer" }}
                >
                  Approve
                </button>
                <button
                  onClick={() => resolveConfirm(item, false)}
                  style={{ background: "#ef4444", color: "#0f172a", border: "none", borderRadius: 4, padding: "6px 12px", fontWeight: 600, cursor: "pointer" }}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
        {events.length === 0 && (
          <div style={{ opacity: 0.5, fontSize: 13, padding: 20, textAlign: "center" }}>
            Waiting for events — run the toy agent or trigger a Claude Code hook.
          </div>
        )}
        {sessions.map((session) => {
          const defaultExpanded = session.severity !== "clean";
          const effectiveExpanded = sessionOverrides.hasOwnProperty(session.sessionId)
            ? sessionOverrides[session.sessionId]
            : defaultExpanded;
          return (
            <SessionCard
              key={session.sessionId}
              session={session}
              expanded={effectiveExpanded}
              onToggle={() => toggleSession(session.sessionId, effectiveExpanded)}
              expandedEventKey={expandedKey}
              onToggleEvent={(key) => setExpandedKey(expandedKey === key ? null : key)}
            />
          );
        })}
      </div>
    </div>
  );
}

function SessionCard({ session, expanded, onToggle, expandedEventKey, onToggleEvent }) {
  const meta = SEVERITY_META[session.severity];
  const parts = [];
  if (session.blocked) parts.push(`${session.blocked} blocked`);
  if (session.asked) parts.push(`${session.asked} needs confirmation`);
  if (session.flagged) parts.push(`${session.flagged} flagged`);
  if (parts.length === 0) parts.push("all clean");

  const orderedEvents = [...session.events].sort((a, b) => (a.ts || 0) - (b.ts || 0));

  return (
    <div style={{ marginBottom: 6, border: `1px solid ${meta.color}55`, borderRadius: 6, overflow: "hidden" }}>
      <div
        onClick={onToggle}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "#111827", cursor: "pointer", borderLeft: `4px solid ${meta.color}` }}
      >
        <div style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
          <span style={{ flexShrink: 0 }}>{expanded ? "▾" : "▸"}</span>
          <span style={{ flexShrink: 0 }}>{meta.icon}</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{parts.join(", ")}</span>
          <span style={{ opacity: 0.5, flexShrink: 0 }}>
            · {session.total} event{session.total !== 1 ? "s" : ""}
          </span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.5, flexShrink: 0, marginLeft: 12 }}>
          {session.sessionId.slice(0, 8)} · {new Date(session.lastTs * 1000).toLocaleTimeString()}
        </div>
      </div>
      {expanded && (
        <div style={{ padding: 8, background: "#0b1220" }}>
          {orderedEvents.map((event) => (
            <EventRow
              key={event._key}
              event={event}
              expanded={expandedEventKey === event._key}
              onToggle={() => onToggleEvent(event._key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ event, expanded, onToggle }) {
  const color = decisionColor(event);
  const time = event.ts ? new Date(event.ts * 1000).toLocaleTimeString() : "";

  let title, detail;
  if (event.type === "tool_call") {
    const flagged = event.decision === "allow" && (event.risk_score || 0) > 0;
    title = `${event.tool} → ${event.decision}${flagged ? " (flagged)" : ""}`;
    detail = event.reasons && event.reasons.length ? event.reasons.join(", ") : null;
  } else if (event.type === "taint_update") {
    title = `${event.tool} tagged data`;
    detail = (event.new_tags || []).join(", ") || null;
  } else if (event.type === "confirm_resolution") {
    title = `${event.tool} → ${event.decision === "allow" ? "approved by user" : "denied by user"}`;
    detail = null;
  } else {
    title = event.type;
    detail = null;
  }

  return (
    <div
      onClick={onToggle}
      style={{ display: "flex", gap: 10, padding: "8px 10px", marginBottom: 4, borderLeft: `3px solid ${color}`, background: expanded ? "#182234" : "#111827", borderRadius: 4, fontSize: 12, cursor: "pointer" }}
    >
      <div style={{ opacity: 0.5, flexShrink: 0, width: 12 }}>{expanded ? "▾" : "▸"}</div>
      <div style={{ opacity: 0.5, flexShrink: 0, width: 74 }}>{time}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ opacity: 0.75, wordBreak: "break-all" }}>{event.target}</div>
        {detail && <div style={{ opacity: 0.55, marginTop: 2 }}>{detail}</div>}
        {event.tags && event.tags.length > 0 && (
          <div style={{ opacity: 0.5, marginTop: 2 }}>tags: {event.tags.join(", ")}</div>
        )}

        {expanded && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #1e293b" }}>
            <DetailRow label="type" value={event.type} />
            <DetailRow label="session" value={event.session_id} />
            {event.risk_score !== undefined && <DetailRow label="risk score" value={event.risk_score} />}
            {event.source && <DetailRow label="source" value={event.source} />}
            <DetailRow label="timestamp" value={event.ts ? new Date(event.ts * 1000).toISOString() : ""} />
            <pre style={{ marginTop: 8, padding: 8, background: "#0b1220", borderRadius: 4, overflowX: "auto", opacity: 0.8, fontSize: 11 }}>
              {JSON.stringify(stripInternal(event), null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div style={{ opacity: 0.7, marginTop: 2 }}>
      <span style={{ opacity: 0.6 }}>{label}:</span> {String(value)}
    </div>
  );
}

function stripInternal(event) {
  const { _key, ...rest } = event;
  return rest;
}
