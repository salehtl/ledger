import type { ReactNode } from "react";
export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`bg-surface border border-border rounded-[var(--radius-card)] p-4 ${className}`}>
      {children}
    </div>
  );
}
