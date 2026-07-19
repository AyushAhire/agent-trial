import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";

/**
 * Chronological event feed -- the default AgentTrail view. Replaces the
 * force-graph as the primary UI: for a security-review workflow you want
 * to read "what happened, in order, and did anything need my attention"
 * at a glance, not decode node layout or raw policy-engine field names.
 *
 * Events are grouped into per-session incident cards: a single agent run
 * can fire many events in under a second (e.g. a prompt-injection attempt
 * that gets blocked 3 different ways), and a flat list makes that read as
 * noise instead of one story. Anything non-clean auto-expands.
 *
 * Also owns the pause/confirm back-channel: a `confirm_request` event
 * pins a banner with Approve/Deny buttons here. Clicking POSTs the
 * decision to the relay's /confirm-response endpoint, which the paused
 * tool call (tools.py's _web_confirm, polling /confirm-status) picks up.
 */

// --- design tokens (status palette validated via the dataviz skill's
// six-checks validator against the dark surface below; never used as
// color-alone -- every status pairs an icon with a label) ---
const T = {
  page: "#0d0d0d",
  surface: "#1a1a19",
  surfaceRaised: "#212120",
  border: "rgba(255,255,255,0.10)",
  ink: "#ffffff",
  inkSecondary: "#c3c2b7",
  inkMuted: "#898781",
  gridline: "#2c2c2a",
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
  font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const STATUS = {
  clean: { color: T.good, label: "Allowed", Icon: IconCheck },
  flagged: { color: T.serious, label: "Flagged", Icon: IconFlag },
  warning: { color: T.warning, label: "Needs Approval", Icon: IconAlert },
  critical: { color: T.critical, label: "Blocked", Icon: IconX },
};

const TOOL_META = {
  read_file: { label: "Read file", Icon: IconFile },
  write_file: { label: "Wrote file", Icon: IconFile },
  run_shell: { label: "Ran command", Icon: IconTerminal },
  call_api: { label: "Made network request", Icon: IconGlobe },
};

const TAG_LABELS = {
  pii: "Personal Info",
  secret: "Secret",
  internal_only: "Internal Only",
  user_uploaded: "User Uploaded",
  // "public" is intentionally omitted -- showing it teaches the user nothing
};

const REASON_LABELS = {
  dangerous_shell_pattern: "Matches a known dangerous command pattern",
  secret_data_exfil_attempt: "Would send previously-read secret data outside the system",
  pii_crossing_trust_boundary: "Would send personal information outside the system",
  internal_data_crossing_trust_boundary: "Would send internal-only data outside the system",
  external_destination_untainted: "New external destination — allowed, flagged for review",
};

function humanReason(reason) {
  if (!reason) return null;
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  if (reason.startsWith("path_denylist:shell_reference:")) {
    const frag = reason.split(":").slice(2).join(":");
    return `Command references a protected path (${frag})`;
  }
  if (reason.startsWith("path_denylist:")) {
    return `This path is protected (matches ${reason.slice("path_denylist:".length)})`;
  }
  return reason.replace(/_/g, " ");
}

function eventSeverity(event) {
  if (event.decision === "block") return "critical";
  if (event.decision === "pending_confirm") return "warning";
  if (event.decision === "allow" && (event.risk_score || 0) > 0) return "flagged";
  return "clean";
}

function sessionSource(events) {
  return events.some((e) => e.source === "claude_code") ? "claude_code" : "toy_agent";
}

const SOURCE_META = {
  claude_code: { label: "Claude Code", Icon: IconClaude },
  toy_agent: { label: "Toy Agent", Icon: IconBot },
};

function deriveHeadline(events) {
  const first = [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0)).find((e) => e.type === "tool_call");
  if (!first || !first.target) return "session";
  if (first.tool === "call_api") {
    try {
      return new URL(first.target).hostname;
    } catch {
      return first.target;
    }
  }
  const parts = first.target.split("/");
  return parts[parts.length - 1] || first.target;
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

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
      source: sessionSource(evts),
      headline: deriveHeadline(evts),
      total: evts.length,
      lastTs: Math.max(...evts.map((e) => e.ts || 0)),
    };
  });
  sessions.sort((a, b) => b.lastTs - a.lastTs);
  return sessions;
}

const RELAY_HTTP_BASE = "http://localhost:8766";
const MAX_EVENTS = 150;
const STORAGE_KEY = "agenttrail_events_v1";

// Stable per-event identity (not Math.random()): needed so a page refresh
// (restored from localStorage) and the relay's replay-on-connect buffer
// don't produce two copies of the same event when both land at once.
function eventIdentity(event) {
  return `${event.ts}|${event.type}|${event.tool}|${event.target}`;
}

function loadStoredEvents() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function EventFeed({ wsUrl = "ws://localhost:8765" }) {
  const [events, setEvents] = useState(loadStoredEvents);
  const [pending, setPending] = useState([]);
  const [connected, setConnected] = useState(false);
  const [expandedKey, setExpandedKey] = useState(null);
  const [sessionOverrides, setSessionOverrides] = useState({});
  const [, forceTick] = useState(0);
  const wsRef = useRef();

  const sessions = useMemo(() => groupBySession(events), [events]);

  // keep relative timestamps ("2m ago") fresh without needing a new event
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // persist to localStorage so a page refresh (or the relay restarting)
  // doesn't wipe the feed -- the relay's own replay buffer covers a fresh
  // tab/reconnect; this covers surviving a reload without even needing
  // that round trip
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    } catch {
      // storage full/unavailable -- history just won't persist, not fatal
    }
  }, [events]);

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
        return;
      }
      if (event.type === "confirm_resolution") {
        setPending((prev) => prev.filter((p) => !(p.tool === event.tool && p.target === event.target)));
      }
      const key = eventIdentity(event);
      setEvents((prev) => {
        if (prev.some((e) => e._key === key)) return prev; // relay's replay buffer resent something localStorage already had
        return [{ ...event, _key: key }, ...prev].slice(0, MAX_EVENTS);
      });
    };
    return () => ws.close();
  }, [wsUrl]);

  const toggleSession = useCallback((sessionId, currentEffective) => {
    setSessionOverrides((prev) => ({ ...prev, [sessionId]: !currentEffective }));
  }, []);

  const resolveConfirm = useCallback((item, approved) => {
    setPending((prev) => prev.filter((p) => p.id !== item.id));
    fetch(`${RELAY_HTTP_BASE}/confirm-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, approved }),
    }).catch(() => {});
  }, []);

  const totals = useMemo(
    () => ({
      sessions: sessions.length,
      blocked: sessions.reduce((n, s) => n + s.blocked, 0),
      asked: sessions.reduce((n, s) => n + s.asked, 0),
      flagged: sessions.reduce((n, s) => n + s.flagged, 0),
    }),
    [sessions]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", background: T.page, color: T.ink, overflow: "hidden", fontFamily: T.font }}>
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: sessions.length ? 10 : 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: 0.2 }}>Event Feed</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: T.inkMuted }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? T.good : T.inkMuted, display: "inline-block" }} />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>
        {sessions.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            <StatTile label="Sessions" value={totals.sessions} />
            <StatTile label="Blocked" value={totals.blocked} color={totals.blocked ? T.critical : undefined} />
            <StatTile label="Needs Approval" value={totals.asked} color={totals.asked ? T.warning : undefined} />
            <StatTile label="Flagged" value={totals.flagged} color={totals.flagged ? T.serious : undefined} />
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <div style={{ padding: 10, background: "rgba(250,178,25,0.08)", borderBottom: `1px solid ${T.warning}55` }}>
          {pending.map((item) => (
            <ConfirmBanner key={item.id} item={item} onResolve={resolveConfirm} />
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {events.length === 0 && (
          <div style={{ opacity: 0.5, fontSize: 13, padding: 32, textAlign: "center" }}>
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

function StatTile({ label, value, color }) {
  return (
    <div style={{ background: T.surfaceRaised, border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 12px", minWidth: 64 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: color || T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10, color: T.inkMuted, marginTop: 1 }}>{label}</div>
    </div>
  );
}

function ConfirmBanner({ item, onResolve }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", marginBottom: 6, background: T.surfaceRaised, borderRadius: 10, border: `1px solid ${T.warning}55` }}>
      <div style={{ fontSize: 12.5, minWidth: 0, display: "flex", gap: 10, alignItems: "flex-start" }}>
        <IconAlert size={16} color={T.warning} style={{ marginTop: 2, flexShrink: 0 }} />
        <div>
          <div style={{ fontWeight: 600 }}>Confirmation needed — {TOOL_META[item.tool]?.label || item.tool}</div>
          <div style={{ opacity: 0.85, wordBreak: "break-all", marginTop: 2 }}>{item.target}</div>
          <div style={{ opacity: 0.6, marginTop: 2 }}>{(item.reasons || []).map(humanReason).join(", ")}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0, marginLeft: 12 }}>
        <PillButton label="Approve" color={T.good} onClick={() => onResolve(item, true)} />
        <PillButton label="Deny" color={T.critical} onClick={() => onResolve(item, false)} />
      </div>
    </div>
  );
}

function PillButton({ label, color, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? color : `${color}22`,
        color: hover ? "#0d0d0d" : color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: "6px 14px",
        fontWeight: 600,
        fontSize: 12,
        cursor: "pointer",
        transition: "all 120ms ease",
      }}
    >
      {label}
    </button>
  );
}

function SourceBadge({ source }) {
  const meta = SOURCE_META[source];
  const Icon = meta.Icon;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, background: T.surfaceRaised, border: `1px solid ${T.border}`, borderRadius: 999, padding: "2px 8px", fontSize: 10.5, color: T.inkSecondary, flexShrink: 0 }}>
      <Icon size={11} color={T.inkSecondary} />
      {meta.label}
    </div>
  );
}

function SessionCard({ session, expanded, onToggle, expandedEventKey, onToggleEvent }) {
  const status = STATUS[session.severity];
  const parts = [];
  if (session.blocked) parts.push(`${session.blocked} blocked`);
  if (session.asked) parts.push(`${session.asked} needs approval`);
  if (session.flagged) parts.push(`${session.flagged} flagged`);
  const summary = parts.length ? parts.join(" · ") : "All clean";

  const orderedEvents = [...session.events].sort((a, b) => (a.ts || 0) - (b.ts || 0));

  return (
    <div style={{ marginBottom: 8, borderRadius: 12, overflow: "hidden", border: `1px solid ${status.color}40`, background: T.surface, boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }}>
      <div
        onClick={onToggle}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", cursor: "pointer", gap: 10, borderLeft: `3px solid ${status.color}` }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, flex: 1 }}>
          <IconChevron expanded={expanded} size={13} color={T.inkMuted} />
          <status.Icon size={16} color={status.color} style={{ flexShrink: 0 }} />
          <SourceBadge source={session.source} />
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{session.headline}</div>
          <div style={{ fontSize: 12, color: T.inkSecondary, whiteSpace: "nowrap" }}>{summary}</div>
        </div>
        <div style={{ fontSize: 11, color: T.inkMuted, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {session.total} event{session.total !== 1 ? "s" : ""} · {timeAgo(session.lastTs)}
        </div>
      </div>
      {expanded && (
        <div style={{ padding: "4px 10px 10px", borderTop: `1px solid ${T.border}` }}>
          {orderedEvents.map((event) => (
            <EventRow key={event._key} event={event} expanded={expandedEventKey === event._key} onToggle={() => onToggleEvent(event._key)} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ event, expanded, onToggle }) {
  const severity = eventSeverity(event);
  const status = STATUS[severity];
  const time = event.ts ? new Date(event.ts * 1000).toLocaleTimeString() : "";
  const toolMeta = TOOL_META[event.tool];
  const ToolIcon = toolMeta?.Icon || IconFile;

  let title, detailText;
  if (event.type === "tool_call") {
    title = `${toolMeta?.label || event.tool} — ${status.label}`;
    detailText = event.reasons && event.reasons.length ? event.reasons.map(humanReason).join(", ") : null;
  } else if (event.type === "taint_update") {
    title = `${toolMeta?.label || event.tool} — classified this data`;
    detailText = null;
  } else if (event.type === "confirm_resolution") {
    title = `${toolMeta?.label || event.tool} — ${event.decision === "allow" ? "Approved by user" : "Denied by user"}`;
    detailText = null;
  } else {
    title = event.type;
    detailText = null;
  }

  const visibleTags = (event.tags || event.new_tags || []).filter((t) => TAG_LABELS[t]);

  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        gap: 10,
        padding: "8px 8px",
        marginTop: 4,
        borderRadius: 8,
        background: expanded ? T.surfaceRaised : "transparent",
        cursor: "pointer",
        transition: "background 120ms ease",
      }}
    >
      <ToolIcon size={14} color={T.inkMuted} style={{ marginTop: 2, flexShrink: 0 }} />
      <div style={{ opacity: 0.5, flexShrink: 0, width: 70, fontSize: 11, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{time}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</span>
          <StatusChip severity={severity} />
        </div>
        <div style={{ opacity: 0.7, wordBreak: "break-all", fontSize: 12, marginTop: 2 }}>{event.target}</div>
        {detailText && <div style={{ opacity: 0.55, marginTop: 2, fontSize: 11.5 }}>{detailText}</div>}
        {visibleTags.length > 0 && (
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {visibleTags.map((t) => (
              <span key={t} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, background: T.surfaceRaised, border: `1px solid ${T.border}`, color: T.inkSecondary }}>
                {TAG_LABELS[t]}
              </span>
            ))}
          </div>
        )}

        {expanded && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.border}` }}>
            <DetailRow label="session" value={event.session_id} />
            {event.risk_score !== undefined && <DetailRow label="risk score" value={event.risk_score} />}
            {event.source && <DetailRow label="source" value={event.source} />}
            <DetailRow label="timestamp" value={event.ts ? new Date(event.ts * 1000).toISOString() : ""} />
            <pre style={{ marginTop: 8, padding: 8, background: T.page, borderRadius: 6, overflowX: "auto", opacity: 0.8, fontSize: 11 }}>
              {JSON.stringify(stripInternal(event), null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusChip({ severity }) {
  const status = STATUS[severity];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, padding: "1px 7px 1px 5px", borderRadius: 999, background: `${status.color}1f`, color: status.color, fontWeight: 600 }}>
      <status.Icon size={10} color={status.color} />
      {status.label}
    </span>
  );
}

function DetailRow({ label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div style={{ opacity: 0.7, marginTop: 2, fontSize: 11.5 }}>
      <span style={{ opacity: 0.6 }}>{label}:</span> {String(value)}
    </div>
  );
}

function stripInternal(event) {
  const { _key, ...rest } = event;
  return rest;
}

// --- icons: small inline SVGs, 16x16 viewBox, currentColor-free (explicit
// color prop) so they work as plain data, not text-colored glyphs ---

function IconChevron({ expanded, size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms ease", flexShrink: 0 }}>
      <path d="M6 4l4 4-4 4" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCheck({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="1.5" />
      <path d="M5.2 8.2l2 2 3.6-4" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconX({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="1.5" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconAlert({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M8 2.2l6.2 10.8H1.8L8 2.2z" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
      <line x1="8" y1="6.5" x2="8" y2="9.3" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.7" fill={color} />
    </svg>
  );
}

function IconFlag({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M4 2v12" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 2.6h7.5l-1.8 2.7 1.8 2.7H4" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconFile({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M4 1.5h5l3 3v10h-8z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 1.5v3h3" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function IconTerminal({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke={color} strokeWidth="1.3" />
      <path d="M4 6.2l2.4 1.9L4 10" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="10" x2="11.5" y2="10" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconGlobe({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="8" cy="8" r="6.3" fill="none" stroke={color} strokeWidth="1.3" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6.3" fill="none" stroke={color} strokeWidth="1.3" />
      <line x1="1.8" y1="8" x2="14.2" y2="8" stroke={color} strokeWidth="1.3" />
    </svg>
  );
}

function IconBot({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect x="3" y="5.5" width="10" height="7.5" rx="2" fill="none" stroke={color} strokeWidth="1.3" />
      <line x1="8" y1="5.5" x2="8" y2="3" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="2.2" r="0.9" fill={color} />
      <circle cx="6" cy="9" r="0.9" fill={color} />
      <circle cx="10" cy="9" r="0.9" fill={color} />
    </svg>
  );
}

function IconClaude({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path
        d="M8 1.5l1.6 4.2 4.4.4-3.4 2.9 1.1 4.3L8 10.9l-3.7 2.4 1.1-4.3-3.4-2.9 4.4-.4z"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
