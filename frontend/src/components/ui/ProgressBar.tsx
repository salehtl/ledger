/** pct is a fraction (0..1+). Tone: green <0.8, amber <1.0, red >=1.0. */
export function ProgressBar({ pct, label }: { pct: number; label?: string }) {
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const tone = pct >= 1.0 ? "bg-bad" : pct >= 0.8 ? "bg-warn" : "bg-good";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-2.5 w-full rounded-full bg-border overflow-hidden"
    >
      <div className={`h-full rounded-full transition-[width] duration-300 ${tone}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}
