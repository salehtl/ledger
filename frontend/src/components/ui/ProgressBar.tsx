import type { DitherColor } from "../dither-kit/palette";
import { hueVar } from "../../lib/paletteColor";

type Tone = "good" | "warn" | "bad";

/**
 * pct is a fraction (0..1+). Over budget is a *texture* change, not a colour
 * change: under budget the fill is dithered, at or over it fills to solid ink.
 * The `tone` prop still overrides the automatic reading (e.g. to mark by
 * projection rather than spend); "bad" means solid. An optional `pace` fraction
 * draws a vertical "today" marker. `onAccent` styles the track for the hero.
 *
 * `color` paints the fill in a palette hue instead of the default ink, so a
 * bucket bar matches the swatch dot beside its label. It is deliberately
 * ignored under `onAccent`: the hero bar totals all three buckets, so no single
 * bucket hue is honest for it, and mid-chroma ink on the branded accent ground
 * is a contrast problem.
 */
export function ProgressBar({ pct, label, pace, tone, onAccent = false, color }: {
  pct: number; label?: string; pace?: number; tone?: Tone; onAccent?: boolean; color?: DitherColor;
}) {
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const auto: Tone = pct >= 1.0 ? "bad" : pct >= 0.8 ? "warn" : "good";
  const solid = (tone ?? auto) === "bad";
  const track = onAccent ? "bg-hero-fg/25" : "bg-surface-2";
  const marker = onAccent ? "bg-hero-fg" : "bg-fg/70";
  const ink = onAccent ? "bg-hero-fg" : "bg-fg";
  const hue = !onAccent && color !== undefined ? hueVar(color) : undefined;
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
        className={`h-full transition-[width] duration-300 ${hue ? "" : ink} ${solid ? "" : "dither-mask"}`}
        style={{ width: `${clamped}%`, ...(hue ? { background: hue } : {}) }}
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
