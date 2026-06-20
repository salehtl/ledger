type Tone = "good" | "warn" | "bad";
const TONE_BG: Record<Tone, string> = { good: "bg-good", warn: "bg-warn", bad: "bg-bad" };

/**
 * pct is a fraction (0..1+). Tone defaults to green <0.8, amber <1.0, red >=1.0,
 * but a `tone` prop can override it (e.g. to colour by projection, not spend).
 * An optional `pace` fraction draws a vertical "today" marker on the track.
 * `onAccent` styles the track for placement on a filled brand surface (the hero).
 */
export function ProgressBar({ pct, label, pace, tone, onAccent = false }: {
  pct: number; label?: string; pace?: number; tone?: Tone; onAccent?: boolean;
}) {
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const auto: Tone = pct >= 1.0 ? "bad" : pct >= 0.8 ? "warn" : "good";
  const track = onAccent ? "bg-white/25" : "bg-surface-2";
  const marker = onAccent ? "bg-white" : "bg-fg/70";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`relative h-3 w-full rounded-full overflow-hidden ${track}`}
    >
      <div className={`h-full rounded-full transition-[width] duration-300 ${onAccent ? "bg-white" : TONE_BG[tone ?? auto]}`} style={{ width: `${clamped}%` }} />
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
