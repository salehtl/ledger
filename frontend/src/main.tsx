import React from "react";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="window" style={{ margin: 16 }}>
      <div className="title-bar"><div className="title-bar-text">ledger</div></div>
      <div className="window-body">Loading…</div>
    </div>
  </React.StrictMode>,
);
