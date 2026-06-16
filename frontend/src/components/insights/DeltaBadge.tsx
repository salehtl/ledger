import { ArrowUp, ArrowDown } from "lucide-react";
import { formatFils } from "../../lib/money";

/** Magnitude text: a rounded percent when available, else an absolute fils amount. */
function magnitude(deltaPct: number | null, delta: number): string {
  return deltaPct != null ? `${Math.round(Math.abs(deltaPct) * 100)}%` : formatFils(Math.abs(delta));
}

/** Directional month-over-month change indicator. Spending up = warn, down = good. */
export function DeltaBadge({ delta, deltaPct, isNew = false, isGone = false }: {
  delta: number; deltaPct: number | null; isNew?: boolean; isGone?: boolean;
}) {
  if (isNew) return <span className="text-xs text-muted">new</span>;
  if (isGone) return <span className="text-xs text-good" aria-label="gone vs last month">gone</span>;
  if (delta === 0) return <span className="text-xs text-muted" aria-label="no change vs last month">—</span>;
  const up = delta > 0;
  const text = magnitude(deltaPct, delta);
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? "text-warn" : "text-good"}`}
      aria-label={`${up ? "up" : "down"} ${text} vs last month`}
    >
      <Icon size={12} aria-hidden />{text}
    </span>
  );
}
