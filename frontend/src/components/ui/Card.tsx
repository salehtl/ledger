import type { ReactNode } from "react";
export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`bg-surface rounded-[var(--radius-card)] shadow-1 p-4 ${className}`}>
      {children}
    </div>
  );
}
