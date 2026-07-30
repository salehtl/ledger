import type { SparkPoint } from "../../lib/reconcile";

/**
 * The balance-history sparkline: one dithered ink column per balance point,
 * oldest → newest, heights normalized to the window's min..max. Same texture
 * as every other bar in the app (`.dither-mask`), monochrome ink — history is
 * neither a bucket (no hue) nor a budget state (no ramp). Rendered aria-hidden;
 * the caller prints the low/high/since caption in visible text beside it.
 */
export function BalanceSparkline({ points, height = 44 }: { points: SparkPoint[]; height?: number }) {
  if (points.length === 0) return null;
  return (
    <div aria-hidden data-spark={points.length} className="flex w-full items-end gap-[2px]" style={{ height }}>
      {points.map((p, i) => (
        <div
          key={`${p.as_of}-${i}`}
          className="flex-1 rounded-[var(--radius)] dither-mask bg-fg"
          style={{ height: `${8 + Math.round(p.h * 92)}%` }}
        />
      ))}
    </div>
  );
}
