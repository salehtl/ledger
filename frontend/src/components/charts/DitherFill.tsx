import { useEffect, useRef } from "react";
import {
  BAYER,
  OFF_TIER,
  backingSize,
  bloomLayerStyle,
  type BloomInput,
} from "../dither-kit/dither-paint";
import { rgb, seedOfColor, type DitherColor } from "../dither-kit/palette";
import { segmentBounds } from "../../lib/ditherFill";
import { useDitherTheme } from "../../hooks/useDitherTheme";

/**
 * How the 50/30/20 buckets are told apart now that they share one ink: the
 * threshold the Bayer matrix is compared against is biased per segment. Positive
 * bias lights more cells (denser), negative lights fewer (sparser), and a bias
 * of 1 clears every threshold so the fill goes solid — which is how over-budget
 * reads, matching ProgressBar.
 */
export type Density = "dense" | "medium" | "sparse" | "solid";

export const DENSITY_BIAS: Record<Density, number> = {
  dense: 0.22,
  medium: 0,
  sparse: -0.22,
  solid: 1,
};

export type DitherSegment = { value: number; color: DitherColor; density?: Density };

/**
 * A horizontal dithered magnitude bar. dither-kit's charts are vertical-only,
 * so this paints across a row instead of down a column, sharing the charts'
 * *dither*: the same 4×4 Bayer matrix and the same `OFF_TIER` alpha for an
 * "off" cell, thresholded against a density ramped along the row. Segments fill
 * left to right; whatever is left of `max` stays track.
 *
 * It is a family resemblance, not a pixel match. The charts' `paintColumn` also
 * modulates alpha with density (`0.3 + density*0.7`) and caps each column with a
 * `BORDER_ALPHA` outline plus a feather row; this only thresholds, to two flat
 * alphas, and draws no outline. And `backingSize` floors the backing at 8 rows,
 * so at the 10–12px heights actually in use a vertical cell is 1.25–1.5px
 * against a 2px horizontal one — the cells are not square.
 *
 * `bloom` defaults off: the aura preset is a 15px blur clipped by this
 * component's own `overflow-hidden` box, so it is invisible at these heights
 * while still costing a filtered, `plus-lighter`-blended layer per instance
 * (~20 of them in a scrolling `LensBreakdown`). Callers on a taller surface can
 * opt back in.
 *
 * Rendered aria-hidden: every caller already states the value in text.
 */
export function DitherFill({
  segments,
  max,
  height = 10,
  bloom = "off",
  className = "",
}: {
  segments: DitherSegment[];
  max: number;
  height?: number;
  bloom?: BloomInput;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bloomRef = useRef<HTMLCanvasElement>(null);
  const dark = useDitherTheme();

  // Segments arrive as a fresh array each render; key the effect on their
  // content so a parent re-render doesn't repaint the canvas needlessly.
  const sig = segments.map((s) => `${s.color}:${s.value}:${s.density ?? "medium"}`).join("|");

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!(wrap && canvas)) return;

    const paint = () => {
      const w = Math.max(0, wrap.clientWidth);
      if (w === 0) return;
      const { cols, rows } = backingSize(w, height);
      if (cols <= 0 || rows <= 0) return;

      canvas.width = cols;
      canvas.height = rows;
      const c = canvas.getContext("2d");
      if (!c) return;
      c.clearRect(0, 0, cols, rows);

      const bounds = segmentBounds(segments.map((s) => s.value), max, cols);
      segments.forEach((seg, i) => {
        const seed = seedOfColor(seg.color);
        const bias = DENSITY_BIAS[seg.density ?? "medium"];
        const [x0, x1] = bounds[i];
        for (let x = x0; x < x1; x++) {
          for (let y = 0; y < rows; y++) {
            // Ramp density from the bottom up, matching the charts' gradient
            // fill, then threshold it through the shared Bayer matrix — offset
            // by this segment's density bias.
            const t = rows > 1 ? y / (rows - 1) : 1;
            const on = t + bias > BAYER[y % 4][x % 4];
            c.fillStyle = rgb(seed.fill, 1, on ? 1 : OFF_TIER);
            c.fillRect(x, y, 1, 1);
          }
        }
      });

      const bloomCanvas = bloomRef.current;
      const bc = bloomCanvas?.getContext("2d");
      if (bloomCanvas && bc) {
        bloomCanvas.width = cols;
        bloomCanvas.height = rows;
        bc.clearRect(0, 0, cols, rows);
        bc.drawImage(canvas, 0, 0);
      }
    };

    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(wrap);
    return () => ro.disconnect();
    // `sig` fully captures the segments' content, so `segments` itself is
    // deliberately not a dep — its identity changes on every parent render.
  }, [sig, max, height, dark]);

  const layer = "absolute inset-0 h-full w-full";
  const pixelated = { imageRendering: "pixelated" as const };

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      className={`relative w-full overflow-hidden rounded-full bg-surface-2 ${className}`}
      style={{ height }}
    >
      <canvas ref={canvasRef} className={layer} style={pixelated} />
      <canvas
        ref={bloomRef}
        className={layer}
        style={{ ...pixelated, ...(bloomLayerStyle(bloom, true) ?? { opacity: 0 }) }}
      />
    </div>
  );
}
