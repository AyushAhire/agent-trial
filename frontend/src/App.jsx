import React, { useState } from "react";
import AgentTrail from "./AgentTrail";
import EventFeed from "./EventFeed";

export default function App() {
  const [view, setView] = useState("feed");

  return (
    <div style={{ height: "100vh", width: "100%", overflow: "hidden", display: "flex", flexDirection: "column", background: "#0f172a" }}>
      <div style={{ display: "flex", gap: 4, padding: "6px 10px", background: "#0f172a", borderBottom: "1px solid #1e293b" }}>
        <TabButton label="Feed" active={view === "feed"} onClick={() => setView("feed")} />
        <TabButton label="Graph" active={view === "graph"} onClick={() => setView("graph")} />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === "feed" ? <EventFeed wsUrl="ws://localhost:8765" /> : <AgentTrail wsUrl="ws://localhost:8765" />}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "#1e293b" : "transparent",
        color: active ? "#e2e8f0" : "#64748b",
        border: "none",
        borderRadius: 4,
        padding: "6px 14px",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
