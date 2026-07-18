import React, { useEffect, useRef, useState, useCallback } from "react";
import ForceGraph2D from "react-force-graph-2d";

/**
 * Agent Trail panel — live "Uber-map"-style view of everywhere the agent
 * has gone: each tool call becomes a node, each call an animated edge
 * from the Agent center node. Trust level drives node color; a blocked
 * action pulses red. Data is pushed live over the ws_relay WebSocket —
 * no polling, no dependency on SigNoz's own query latency.
 */

const TRUST_COLOR = {
  allow: "#22c55e",          // green
  pending_confirm: "#eab308", // yellow
  block: "#ef4444",          // red
};

const AGENT_NODE_ID = "__agent__";

export default function AgentTrail({ wsUrl = "ws://localhost:8765" }) {
  const [graphData, setGraphData] = useState({
    nodes: [{ id: AGENT_NODE_ID, label: "Agent", isCenter: true }],
    links: [],
  });
  const [selected, setSelected] = useState(null);
  const [log, setLog] = useState([]);
  const fgRef = useRef();
  const graphWrapRef = useRef();
  const [graphSize, setGraphSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = graphWrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setGraphSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const addToolCallEvent = useCallback((event) => {
    setGraphData((prev) => {
      const nodeId = `${event.tool}:${event.target}`;
      const existing = prev.nodes.find((n) => n.id === nodeId);

      const node = existing || {
        id: nodeId,
        label: event.target,
        tool: event.tool,
      };
      node.decision = event.decision;
      node.tags = event.tags;
      node.riskScore = event.risk_score;
      node.lastSeen = event.ts;
      node.pulse = event.decision === "block" ? true : false;

      const nodes = existing
        ? prev.nodes.map((n) => (n.id === nodeId ? node : n))
        : [...prev.nodes, node];

      const linkExists = prev.links.some(
        (l) => l.source === AGENT_NODE_ID && l.target === nodeId
      );
      const links = linkExists
        ? prev.links
        : [...prev.links, { source: AGENT_NODE_ID, target: nodeId }];

      return { nodes, links };
    });

    setLog((prev) => [
      {
        id: `${event.ts}-${event.tool}`,
        tool: event.tool,
        target: event.target,
        decision: event.decision,
        tags: event.tags,
        ts: event.ts,
      },
      ...prev,
    ].slice(0, 50));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data);
      if (event.type === "tool_call") {
        addToolCallEvent(event);
      }
      // taint_update events could tint existing nodes; kept minimal for MVP
    };
    ws.onerror = () => console.warn("Agent Trail: relay not reachable yet");
    return () => ws.close();
  }, [wsUrl, addToolCallEvent]);

  const nodeCanvasObject = (node, ctx, globalScale) => {
    const isCenter = node.id === AGENT_NODE_ID;
    const color = isCenter ? "#818cf8" : TRUST_COLOR[node.decision] || "#94a3b8";
    const radius = isCenter ? 10 : 6;

    if (node.pulse) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 4, 0, 2 * Math.PI);
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    const label = isCenter ? "AGENT" : node.label;
    const fontSize = 10 / globalScale;
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(label.slice(0, 28), node.x + radius + 2, node.y + 3);
  };

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", background: "#0f172a", color: "#e2e8f0", overflow: "hidden" }}>
      <div ref={graphWrapRef} style={{ flex: "2 1 0%", minWidth: 0, position: "relative", overflow: "hidden" }}>
        <ForceGraph2D
          ref={fgRef}
          width={graphSize.width || undefined}
          height={graphSize.height || undefined}
          graphData={graphData}
          nodeCanvasObject={nodeCanvasObject}
          linkColor={() => "rgba(148,163,184,0.4)"}
          linkDirectionalParticles={2}
          linkDirectionalParticleSpeed={0.006}
          onNodeClick={(node) => setSelected(node)}
          backgroundColor="#0f172a"
        />
      </div>

      <div style={{ flex: "1 0 280px", minWidth: 0, maxWidth: 360, borderLeft: "1px solid #1e293b", padding: 12, overflowY: "auto" }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Agent Trail</h3>
        <div style={{ fontSize: 11, marginBottom: 12, opacity: 0.7 }}>
          <Legend color={TRUST_COLOR.allow} label="Allowed" />
          <Legend color={TRUST_COLOR.pending_confirm} label="Needs confirmation" />
          <Legend color={TRUST_COLOR.block} label="Blocked" />
        </div>

        {selected && selected.id !== AGENT_NODE_ID && (
          <div style={{ background: "#1e293b", padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
            <div><strong>{selected.tool}</strong></div>
            <div style={{ wordBreak: "break-all", opacity: 0.8 }}>{selected.label}</div>
            <div>decision: {selected.decision}</div>
            <div>risk score: {selected.riskScore}</div>
            <div>tags: {(selected.tags || []).join(", ") || "none"}</div>
          </div>
        )}

        <div style={{ fontSize: 11 }}>
          {log.map((entry) => (
            <div
              key={entry.id}
              style={{
                padding: "4px 0",
                borderBottom: "1px solid #1e293b",
                color: TRUST_COLOR[entry.decision] || "#e2e8f0",
              }}
            >
              [{entry.tool}] {entry.target.slice(0, 40)}
              {entry.tags && entry.tags.length > 0 && (
                <span style={{ opacity: 0.7 }}> · {entry.tags.join(",")}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
      {label}
    </div>
  );
}
