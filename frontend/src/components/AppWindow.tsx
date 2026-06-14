import { ReactNode } from "react";

export function AppWindow({ title, online = true, children }: { title: string; online?: boolean; children: ReactNode }) {
  return (
    <div className="window app-window">
      <div className="title-bar">
        <div className="title-bar-text">{title}</div>
        {!online && <div className="title-bar-status" role="status">● Offline</div>}
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}
