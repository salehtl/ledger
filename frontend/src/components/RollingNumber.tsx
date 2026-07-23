import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { numberCells, wheelOffsetPct, fitScale } from "../lib/rollingNumber";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Odometer-style number: each digit is a 0–9 wheel that rolls to its value —
 * on first mount (spin-up from zero) and on every value change. Static chars
 * (separators, the "—" zero placeholder) render inline. When the value is too
 * wide for its container the whole row scales down instead of overflowing.
 * Wheels are transform-only and interruptible; reduced motion snaps (app.css).
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
                style={{ transform: `translateY(${wheelOffsetPct(live ? c.digit : 0)}%)` }}
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
