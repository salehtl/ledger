type Tone = "good" | "warn" | "bad";

/**
 * pct is a fraction (0..1+). Over budget is a *texture* change, not a colour
 * change: under budget the fill is dithered, at or over it fills to solid ink.
 * The `tone` prop still overrides the automatic reading (e.g. to mark by
 * projection rather than spend); "bad" means solid. An optional `pace` fraction
 * draws a vertical "today" marker. `onAccent` styles the track for the hero.
 */
export function ProgressBar({ pct, label, pace, tone, onAccent = false }: {
  pct: number; label?: string; pace?: number; tone?: Tone; onAccent?: boolean;
}) {
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const auto: Tone = pct >= 1.0 ? "bad" : pct >= 0.8 ? "warn" : "good";
  const solid = (tone ?? auto) === "bad";
  const track = onAccent ? "bg-hero-fg/25" : "bg-surface-2";
  const marker = onAccent ? "bg-hero-fg" : "bg-fg/70";
  const ink = onAccent ? "bg-hero-fg" : "bg-fg";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`relative h-3 w-full overflow-hidden rounded-[var(--radius)] ${track}`}
    >
      <div
        data-fill={solid ? "solid" : "dithered"}
        className={`h-full transition-[width] duration-300 ${ink} ${solid ? "" : "dither-mask"}`}
        style={{ width: `${clamped}%` }}
      />
      {pace !== undefined && (
        <div
          data-pace
          aria-hidden
          className={`absolute top-0 bottom-0 w-0.5 ${marker}`}
          style={{ left: `${Math.min(100, Math.max(0, pace * 100))}%` }}
        />
      )}
    </div>
  );
}
