import { ArrowUp, ArrowDown } from "../ui/PixelIcon";
import { formatMinor } from "../../lib/minorMoney";

/** Magnitude text: a rounded percent when available, else an absolute amount. */
function magnitude(deltaPct: number | null, delta: bigint): string {
  return deltaPct != null ? `${Math.round(Math.abs(deltaPct) * 100)}%` : formatMinor(delta < 0n ? -delta : delta);
}

/**
 * Directional month-over-month change indicator. Spending up = warn, down = good.
 *
 * `delta` is `bigint` minor units, like every other money value on this screen:
 * it is the difference of two SUMs, and the projection stores amounts as TEXT
 * because a JS `number` cannot hold an `int64`.
 */
export function DeltaBadge({ delta, deltaPct, isNew = false, isGone = false }: {
  delta: bigint; deltaPct: number | null; isNew?: boolean; isGone?: boolean;
}) {
  if (isNew) return <span className="text-xs text-muted">new</span>;
  if (isGone) return <span className="text-xs text-good" aria-label="gone vs last month">gone</span>;
  if (delta === 0n) return <span className="text-xs text-muted" aria-label="no change vs last month">—</span>;
  const up = delta > 0n;
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
