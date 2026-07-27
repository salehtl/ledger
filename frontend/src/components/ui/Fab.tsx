import type { LucideIcon } from "lucide-react";
import { fire } from "../../lib/feedback";

/**
 * The screen's single creation action: a square vermilion plate above the bottom
 * nav, flush to the 16px content margin. Deliberately not elevated — nothing in
 * this design floats. If it needs separating from content beneath it, that is a
 * layout problem, not an elevation problem.
 */
export function Fab({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => { fire("selection"); onClick(); }}
      className="press fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-[var(--radius-card)] bg-accent text-accent-fg hover:opacity-90 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)]"
    >
      <Icon size={24} aria-hidden />
    </button>
  );
}
