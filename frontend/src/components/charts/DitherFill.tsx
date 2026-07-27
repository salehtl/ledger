import { segmentBounds } from "../../lib/ditherFill";
import { hueVar } from "../../lib/paletteColor";
import type { DitherColor } from "../dither-kit/palette";

/**
 * Whether a segment reads as spending in progress or spending past its limit.
 * Dotted is the resting state; solid means at or over budget — the same
 * texture-not-colour reading `ProgressBar` gives its own fill at `pct >= 1.0`.
 */
export type Density = "dense" | "medium" | "sparse" | "solid";

export type DitherSegment = { value: number; color: DitherColor; density?: Density };

/**
 * A horizontal dotted magnitude bar. Segments fill left to right against `max`;
 * whatever is left of `max` stays track.
 *
 * The texture is `.dither-mask` (`styles/app.css`) — the same class `ProgressBar`
 * uses, and the app's one definition of "dotted". Hues resolve to
 * `var(--color-…)` rather than raw RGB, so an OS theme flip is handled by the
 * cascade instead of a repaint; only canvas consumers (`TrendBars`, `FlowBars`,
 * `SwipeDeck`) need `useDitherTheme()`.
 *
 * This was a `<canvas>` painting a Bayer matrix until the bars were unified. A
 * flat rectangle of one hue never needed one, and the canvas cost a
 * `ResizeObserver`, a repaint effect, and a theme subscription per instance —
 * ~20 of them in a scrolling `LensBreakdown`.
 *
 * Rendered aria-hidden: every caller already states the value in text.
 */
export function DitherFill({
  segments,
  max,
  height = 10,
  className = "",
}: {
  segments: DitherSegment[];
  max: number;
  height?: number;
  className?: string;
}) {
  // cols = 100 makes each boundary a percentage. Rounding cumulative positions
  // rather than each segment's own share keeps segments that sum to `max` from
  // finishing short and showing a sliver of track.
  const bounds = segmentBounds(segments.map((s) => s.value), max, 100);

  return (
    <div
      aria-hidden="true"
      className={`flex w-full overflow-hidden rounded-[var(--radius)] bg-surface-2 ${className}`}
      style={{ height }}
    >
      {segments.map((seg, i) => {
        const [start, end] = bounds[i];
        const solid = seg.density === "solid";
        return (
          <div
            key={i}
            data-fill={solid ? "solid" : "dithered"}
            className={`h-full shrink-0 ${solid ? "" : "dither-mask"}`}
            style={{ width: `${end - start}%`, background: hueVar(seg.color) }}
          />
        );
      })}
    </div>
  );
}
