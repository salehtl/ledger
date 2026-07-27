// frontend/src/components/ui/SectionLabel.tsx
import type { ElementType, ReactNode } from "react";

/** The one eyebrow/section-label style. `as` picks the element (p, h2, legend). */
export function SectionLabel({ as: Tag = "p" as ElementType, className = "", children }:
  { as?: ElementType; className?: string; children: ReactNode }) {
  return (
    <Tag className={`font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted ${className}`}>
      {children}
    </Tag>
  );
}
