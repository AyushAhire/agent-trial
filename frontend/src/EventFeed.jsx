import React, { useEffect, useState, useCallback, useRef } from "react";

/**
 * Chronological event feed -- the default AgentTrail view. Replaces the
 * force-graph as the primary UI: for a security-review workflow you want
 * to read "what happened, in order, and did anything need my attention"
 * at a glance, not decode node layout.
 *
 * Also owns the pause/confirm back-channel: a `confirm_request` event
 * pins a banner with Approve/Deny buttons here. Clicking POSTs the
 * decision to the relay's /confirm-response endpoint, which the paused
 * tool call (tools.py's _web_confirm, polling /confirm-status) picks up.
 */

const DECISION_COLOR = {
  allow: "#22c55e",
  pending_confirm: "#eab308",
  block: "#ef4444",
};

const RELAY_HTTP_BASE = "http://localhost:8766";
const MAX_EVENTS = 150;

export default function EventFeed({ wsUrl = "ws://localhost:8765" }) {
  const [events, setEvents] = useState([]);
  const [pending, setPending] = useState([]); // confirm_request events awaiting a decision
  const [connected, setConnected] = useState(false);
  const [expandedKey, setExpandedKey] = useState(null);
  const wsRef = useRef();

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
        {events.map((event) => (
          <EventRow
            key={event._key}
            event={event}
            expanded={expandedKey === event._key}
            onToggle={() => setExpandedKey(expandedKey === event._key ? null : event._key)}
          />
        ))}
      </div>
    </div>
  );
}

function EventRow({ event, expanded, onToggle }) {
  const color = DECISION_COLOR[event.decision] || "#475569";
  const time = event.ts ? new Date(event.ts * 1000).toLocaleTimeString() : "";

  let title, detail;
  if (event.type === "tool_call") {
    title = `${event.tool} → ${event.decision}`;
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
