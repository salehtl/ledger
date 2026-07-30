import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { numberCells, wheelOffsetPct, fitScale } from "../lib/rollingNumber";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Odometer-style number: each digit is a 0–9 wheel that rolls up from zero when
 * the number first appears. Static chars (separators, the "—" zero placeholder)
 * render inline. When the value is too wide for its container the whole row
 * scales down instead of overflowing. Wheels are transform-only and
 * interruptible; reduced motion snaps (app.css).
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
  // First paint renders every wheel at 0; flipping this after mount rolls each
  // wheel up to its digit (useEffect, not useLayoutEffect — the browser must
  // paint the zero state or there is nothing to transition from).
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  // The value this instance mounted with. Once it changes we are past the
  // spin-up for good, so every wheel from then on moves with the transition
  // suppressed. Deliberately a ref-free comparison: no timers to keep in sync
  // with the CSS duration, and a revision landing mid-spin-up snaps to the
  // truth rather than finishing a roll toward a stale figure.
  const mountValue = useRef(value);
  const rolling = live && value === mountValue.current;

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
      <span
        ref={innerRef}
        aria-hidden
        className="rolling-row"
        style={scale < 1 ? { transform: `scale(${scale})` } : undefined}
      >
        {numberCells(value).map((c) =>
          c.digit === null ? (
            <span key={c.key} className="rolling-cell">{c.char}</span>
          ) : (
            <span key={c.key} className="rolling-cell rolling-wheel">
              <span
                className="rolling-wheel-track"
                style={{
                  transform: `translateY(${wheelOffsetPct(live ? c.digit : 0)}%)`,
                  // Left to the stylesheet during the spin-up so reduced motion
                  // (which kills the transition there) still wins.
                  transition: rolling ? undefined : "none",
                }}
              >
                {DIGITS.map((d) => <span key={d} className="rolling-wheel-digit">{d}</span>)}
              </span>
            </span>
          ),
        )}
      </span>
    </span>
  );
}
