import { useLayoutEffect, useRef, useState } from "react";
import { m } from "motion/react";
import { numberCells, wheelOffsetPct, fitScale } from "../lib/rollingNumber";
import { EASE_OUT, DUR } from "../lib/motion";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Roll duration, seconds. Inside the 300ms budget once you discount the
 *  cascade; the previous 650ms was more than twice it. */
export const ROLL_MS = 0.45;
/** Per-wheel delay, seconds. Right-to-left, so the units settle first and
 *  the figure resolves the way an odometer physically would. */
export const ROLL_STAGGER_MS = 0.03;

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
        {numberCells(value).map((c, i, all) =>
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
                    ? { duration: ROLL_MS, ease: EASE_OUT, delay: (all.length - 1 - i) * ROLL_STAGGER_MS }
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
