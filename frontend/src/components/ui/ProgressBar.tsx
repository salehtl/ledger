type Tone = "good" | "warn" | "bad";
const TONE_BG: Record<Tone, string> = { good: "bg-good", warn: "bg-warn", bad: "bg-bad" };

/**
 * pct is a fraction (0..1+). Tone defaults to green <0.8, amber <1.0, red >=1.0,
 * but a `tone` prop can override it (e.g. to colour by projection, not spend).
 * An optional `pace` fraction draws a vertical "today" marker on the track.
 */
export function ProgressBar({ pct, label, pace, tone }: { pct: number; label?: string; pace?: number; tone?: Tone }) {
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const auto: Tone = pct >= 1.0 ? "bad" : pct >= 0.8 ? "warn" : "good";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="relative h-3 w-full rounded-full bg-border overflow-hidden"
    >
      <div className={`h-full rounded-full transition-[width] duration-300 ${TONE_BG[tone ?? auto]}`} style={{ width: `${clamped}%` }} />
      {pace !== undefined && (
        <div
          data-pace
          aria-hidden
          className="absolute top-0 bottom-0 w-0.5 bg-fg/70"
          style={{ left: `${Math.min(100, Math.max(0, pace * 100))}%` }}
        />
      )}
    </div>
  );
}
