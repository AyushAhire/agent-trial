import React from "react";
import AgentTrail from "./AgentTrail";

export default function App() {
  return (
    <div style={{ height: "100vh", width: "100%", overflow: "hidden" }}>
      <AgentTrail wsUrl="ws://localhost:8765" />
    </div>
  );
}
