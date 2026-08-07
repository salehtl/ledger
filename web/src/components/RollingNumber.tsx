import { useLayoutEffect, useRef, useState } from "react";
import { m } from "motion/react";
import { numberCells, wheelOffsetPct, fitScale } from "../lib/rollingNumber";
import { EASE_OUT, DUR } from "../lib/motion";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Roll duration, seconds. A deliberate exception to the 300ms UI ceiling:
 *  a once-per-mount decorative entrance, not a repeated interaction — the
 *  previous 650ms was still more than twice this. */
export const ROLL_MS = 0.45;
/** Per-wheel delay step, seconds. Right-to-left, so the units settle first
 *  and the figure resolves the way an odometer physically would. Indexed
 *  over digit wheels only — a comma or decimal point has nothing to roll,
 *  so a separator doesn't consume a stagger step. */
export const ROLL_STAGGER_MS = 0.03;
/** Ceiling on the per-wheel delay, seconds. Without it a wide enough figure's
 *  cascade alone could blow the 0.6s worst-case budget on its own. The CSS
 *  version this replaced capped its cascade the same way (`nth-child(n+7)`
 *  pinned every later wheel to a fixed delay); this is that cap's Framer
 *  equivalent. */
export const ROLL_STAGGER_MAX = 0.12;

/**
 * Odometer-style number: each digit is a 0–9 wheel that rolls up from zero when
 * the number first appears. Static chars (separators, the "—" zero placeholder)
 * render inline. When the value is too wide for its container the whole row
 * scales down instead of overflowing. Wheels are transform-only and
 * interruptible; reduced motion is handled globally (MotionProvider).
 *
 * A *revision* of the value snaps instead of rolling. Every figure sharing a
 * card with a rolling number — budget, remaining, projection, the pace badge —
 * is plain text that updates in the same commit, so a 650ms roll left the hero
 * amount disagreeing with its own card (a cache-restore repaint showed
 * "39,800.31 spent … 6,519.19 left of 52,034.00"), and rolling each wheel
 * independently walked through amounts that were never real. The spin-up is
 * exempt: there is no prior figure for a zero to contradict.
 */
export function RollingNumber({ value, className = "" }: { value: string; className?: string }) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(1);
  // The value this instance mounted with. Once it changes we are past the
  // spin-up for good, so every wheel from then on moves with the roll
  // suppressed. Deliberately a ref-free comparison: no timers to keep in sync
  // with the animation duration, and a revision landing mid-spin-up snaps to the
  // truth rather than finishing a roll toward a stale figure.
  const mountValue = useRef(value);
  const rolling = value === mountValue.current;

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    // transform doesn't affect scrollWidth, so measuring is loop-free.
    const measure = () => setScale(fitScale(outer.clientWidth, inner.scrollWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    return () => ro.disconnect();
  }, [value]);

  const cells = numberCells(value);
  // Stagger delay per cell, indexed over digit wheels only (right to left) —
  // a separator has nothing to roll, so it doesn't consume a step — and
  // capped at ROLL_STAGGER_MAX so a wide figure's cascade alone can't blow
  // the settle-time budget. Computed once here rather than during the JSX
  // map so the "how many digit wheels came after this one" count doesn't
  // need recomputing per cell.
  const digitTotal = cells.reduce((n, c) => n + (c.digit === null ? 0 : 1), 0);
  let digitsSeen = 0;
  const delays = cells.map((c) => {
    if (c.digit === null) return 0;
    const stepsAfter = digitTotal - 1 - digitsSeen;
    digitsSeen += 1;
    return Math.min(stepsAfter * ROLL_STAGGER_MS, ROLL_STAGGER_MAX);
  });

  return (
    <span ref={outerRef} className={`rolling-number ${className}`}>
      <span className="sr-only">{value}</span>
      <m.span
        ref={innerRef}
        aria-hidden
        className="rolling-row"
        animate={{ scale }}
        transition={{ duration: DUR.base, ease: EASE_OUT }}
      >
        {cells.map((c, i) =>
          c.digit === null ? (
            <span key={c.key} className="rolling-cell">{c.char}</span>
          ) : (
            <span key={c.key} className="rolling-cell rolling-wheel">
              <m.span
                className="rolling-wheel-track"
                initial={{ y: `${wheelOffsetPct(0)}%` }}
                animate={{ y: `${wheelOffsetPct(c.digit)}%` }}
                transition={
                  rolling
                    ? { duration: ROLL_MS, ease: EASE_OUT, delay: delays[i] }
                    : { duration: 0 }
                }
              >
                {DIGITS.map((d) => <span key={d} className="rolling-wheel-digit">{d}</span>)}
              </m.span>
            </span>
          ),
        )}
      </m.span>
    </span>
  );
}
