import type { ReactNode } from "react";

/**
 * `"none"` is for the list-card idiom: a full-bleed `divide-y` list whose rows
 * carry their own `p-4`, so the dividers span the card edge to edge while the
 * content still sits on the standard inset.
 *
 * It exists because the old way of doing this was `className="!p-0"`. That
 * works alone, but `!p-0` is `padding: 0 !important` and therefore outranks any
 * padding utility a caller puts beside it — `className="!p-0 px-4"` silently
 * rendered content flush against the border. Opting out via a prop keeps the
 * caller's own utilities winnable.
 */
type Padding = "default" | "none";

const PADDING: Record<Padding, string> = {
  default: "p-4",
  none: "",
};

export function Card(
  { className = "", padding = "default", children }:
  { className?: string; padding?: Padding; children: ReactNode },
) {
  return (
    <div
      className={`bg-surface rounded-[var(--radius)] border border-border ${PADDING[padding]} ${className}`}
    >
      {children}
    </div>
  );
}
