import { useEffect, useRef } from "react";
import {
  BAYER,
  OFF_TIER,
  backingSize,
  bloomLayerStyle,
  type BloomInput,
} from "../dither-kit/dither-paint";
import { rgb, seedOfColor, type DitherColor } from "../dither-kit/palette";
import { useDitherTheme } from "../../hooks/useDitherTheme";

export type DitherSegment = { value: number; color: DitherColor };

/**
 * A horizontal dithered magnitude bar. dither-kit's charts are vertical-only,
 * so this paints the same ordered dither — its Bayer matrix, cell size and
 * off-tier alpha — across a row instead of down a column, keeping the texture
 * identical to the charts beside it. Segments fill left to right; whatever is
 * left of `max` stays track.
 *
 * Rendered aria-hidden: every caller already states the value in text.
 */
export function DitherFill({
  segments,
  max,
  height = 10,
  bloom = "aura",
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
  const sig = segments.map((s) => `${s.color}:${s.value}`).join("|");

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

      const total = max > 0 ? max : 1;
      let x0 = 0;
      for (const seg of segments) {
        const span = Math.round((Math.max(0, seg.value) / total) * cols);
        const seed = seedOfColor(seg.color);
        const end = Math.min(cols, x0 + span);
        for (let x = x0; x < end; x++) {
          for (let y = 0; y < rows; y++) {
            // Ramp density from the bottom up, matching the charts' gradient
            // fill, then threshold it through the shared Bayer matrix.
            const t = rows > 1 ? y / (rows - 1) : 1;
            const on = t > BAYER[y % 4][x % 4];
            c.fillStyle = rgb(seed.fill, 1, on ? 1 : OFF_TIER);
            c.fillRect(x, y, 1, 1);
          }
        }
        x0 = end;
      }

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
