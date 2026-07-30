import { m, useReducedMotion } from "motion/react";
import { type PaceStatus, derivePaceStatus } from "../../lib/insights";
import { DUR, EASE_OUT } from "../../lib/motion";

/**
 * The app's one progress/pace bar: a dotted fill over the grey track, plus an
 * optional "today" marker.
 *
 * The fill is always the same dot texture; what changes with state is the ink
 * it's printed in — the three-stop pace ramp:
 *
 *   under      inside pace          `--color-pace-under`     (ink)
 *   over       past pace            `--color-pace-over`      (amber-orange)
 *   overbudget past the budget      `--color-pace-exceeded`  (red)
 *
 * `pct` is a fraction (0..1+) of the budget spent; `pace` (0..1) is how much of
 * the period has elapsed and draws the marker. With no `pace` there is no
 * period to be ahead of, so the ramp collapses to under/overbudget — this is
 * how an open-ended project (no end date) never shows amber.
 *
 * `status` overrides the geometric reading when the caller has a better signal:
 * Home passes its run-rate `paceStatus`, so the bar and the verdict label
 * printed beside it can never disagree.
 *
 * `onAccent` styles the bar for the hero panel, where the ramp is carried by
 * *texture* instead of ink: neither the amber nor the red clears 3:1 on that
 * ground in both themes, and the hero panel prints in one colour by design. It
 * dots for under/over and fills solid once over budget.
 */
const PACE_INK: Record<PaceStatus, string> = {
  under: "var(--color-pace-under)",
  over: "var(--color-pace-over)",
  overbudget: "var(--color-pace-exceeded)",
};

export function ProgressBar({ pct, label, pace, status, onAccent = false }: {
  /** Fraction of the budget spent (0..1+); over 1 clamps the width, not the state. */
  pct: number;
  /** Accessible name for the bar. */
  label?: string;
  /** Fraction of the period elapsed (0..1). Draws the marker and enables "over pace". */
  pace?: number;
  /** Overrides the geometric verdict derived from `pct`/`pace`. */
  status?: PaceStatus;
  /** Hero-panel variant: single-colour, state carried by texture. */
  onAccent?: boolean;
}) {
  // clipPath is not a transform, so Framer's global reducedMotion policy does
  // not cover it — this one is gated by hand.
  const reduced = useReducedMotion();
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const state = status ?? derivePaceStatus(pct, pace);
  const solid = onAccent && state === "overbudget";
  const track = onAccent ? "bg-hero-fg/25" : "bg-surface-2";
  const marker = onAccent ? "bg-hero-fg" : "bg-fg/70";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`relative h-3 w-full overflow-hidden rounded-[var(--radius)] ${track}`}
    >
      <m.div
        data-fill={solid ? "solid" : "dithered"}
        data-state={state}
        className={`h-full w-full ${onAccent ? "bg-hero-fg" : ""} ${solid ? "" : "dither-mask"}`}
        // clip-path, not width and not scaleX. width is a layout property;
        // scaleX would stretch the .dither-mask's 2px dot grid into ellipses.
        // A clip reveals the texture at its true scale.
        initial={false}
        animate={{ clipPath: `inset(0 ${100 - clamped}% 0 0)` }}
        transition={reduced ? { duration: 0 } : { duration: DUR.sheet, ease: EASE_OUT }}
        style={onAccent ? undefined : { background: PACE_INK[state] }}
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
