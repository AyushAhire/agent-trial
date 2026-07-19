import React, { useState } from "react";
import AgentTrail from "./AgentTrail";
import EventFeed from "./EventFeed";

const T = {
  page: "#0d0d0d",
  surface: "#1a1a19",
  surfaceRaised: "#212120",
  border: "rgba(255,255,255,0.10)",
  ink: "#ffffff",
  inkMuted: "#898781",
  font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

export default function App() {
  const [view, setView] = useState("feed");

  return (
    <div style={{ height: "100vh", width: "100%", overflow: "hidden", display: "flex", flexDirection: "column", background: T.page, fontFamily: T.font }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", background: T.surface, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <ShieldMark />
          <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: 0.2, color: T.ink }}>AgentTrail</span>
        </div>
        <div style={{ display: "flex", gap: 4, background: T.surfaceRaised, borderRadius: 999, padding: 3 }}>
          <TabButton label="Feed" active={view === "feed"} onClick={() => setView("feed")} />
          <TabButton label="Graph" active={view === "graph"} onClick={() => setView("graph")} />
        </div>
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
        background: active ? T.page : "transparent",
        color: active ? T.ink : T.inkMuted,
        border: "none",
        borderRadius: 999,
        padding: "5px 14px",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        transition: "background 120ms ease, color 120ms ease",
      }}
    >
      {label}
    </button>
  );
}

function ShieldMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16">
      <path
        d="M8 1.3l5.2 1.9v4.1c0 3.4-2.2 6-5.2 7.4-3-1.4-5.2-4-5.2-7.4V3.2z"
        fill="none"
        stroke="#0ca30c"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M5.6 8l1.7 1.7 3.1-3.4" fill="none" stroke="#0ca30c" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
