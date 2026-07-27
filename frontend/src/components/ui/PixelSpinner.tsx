// Eight blocks in a ring, on the same 2-unit grid as the pixelarticons pack
// (24 viewBox = a 12×12 pixel grid). Even coordinates only, so every edge lands
// on a whole device pixel.
//
// Positions approximate a circle as an octagon. The diagonals sit fractionally
// further from centre than the axials (8.49 vs 8 units); on a 12-square grid
// that is the closest a ring gets without going off-grid, and pixel art reads
// it as round.
import type { SVGProps } from "react";

const CELLS: [number, number][] = [
  [10, 2],  // N
  [16, 4],  // NE
  [18, 10], // E
  [16, 16], // SE
  [10, 18], // S
  [4, 16],  // SW
  [2, 10],  // W
  [4, 4],   // NW
];

const CYCLE_MS = 800;

/**
 * A pixel-art spinner and pull gauge.
 *
 * **Why this exists.** The pixelarticons `Loader2` glyph is four-fold
 * rotationally symmetric — four spokes at N/E/S/W plus eight diagonal dots — so
 * rotating it in 90° steps (which is what `.spin-pixel` did, and the only
 * rotation that keeps a pixel grid sharp) maps the shape exactly onto itself.
 * It animated correctly and looked completely static. Rotating it off-axis
 * instead would move, but antialiases the grid into mush, which is the whole
 * thing the pixel pack exists to avoid.
 *
 * So this doesn't rotate anything. The blocks hold still and the *brightness*
 * travels around the ring, quantised into eight discrete levels by
 * `steps(8, end)` so it reads as a comet trail rather than a smooth fade.
 * Discrete is the point — a continuous fade would look vector, not pixel.
 *
 * Because nothing moves, this stays legible under `prefers-reduced-motion`:
 * the guidance there is to drop movement, not comprehension, and an opacity
 * cycle carries "still working" without any motion to trigger on. `.spin-pixel`
 * froze solid under that query, which left no loading indication at all.
 *
 * Two modes:
 * - `progress` (0–1): a static gauge; the ring fills clockwise from the top.
 *   Used for the pull-to-refresh pull, where how far you've pulled is the
 *   information — the old gauge rotated a symmetric glyph and so only ever
 *   changed its overall opacity.
 * - no `progress`: the travelling trail, for indeterminate waits.
 */
export function PixelSpinner({
  size = 24,
  progress,
  className = "",
  style,
  ...rest
}: {
  size?: number;
  progress?: number;
} & Omit<SVGProps<SVGSVGElement>, "children">) {
  const determinate = progress != null;
  const lit = determinate ? Math.round(Math.min(1, Math.max(0, progress)) * CELLS.length) : 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      // Caller style merges on top, but imageRendering stays — a caller
      // passing `style` must not silently drop the pixel-snapping.
      style={{ imageRendering: "pixelated", ...style }}
      {...rest}
    >
      {CELLS.map(([x, y], i) => (
        <rect
          key={`${x},${y}`}
          x={x}
          y={y}
          width={4}
          height={4}
          data-cell={i}
          // Determinate: a block is on or off, nothing in between — a gauge you
          // can count. Indeterminate: every block runs the same keyframe, phase
          // -shifted a step apart, which is what makes the bright one travel.
          opacity={determinate ? (i < lit ? 1 : 0.15) : undefined}
          className={determinate ? undefined : "pixel-spinner-cell"}
          // Delays run backwards round the ring so the bright block travels
          // *clockwise*, matching the cell order. Using `-i * step` directly
          // spins it anticlockwise, which reads as wrong without being obvious
          // why.
          style={
            determinate
              ? undefined
              : { animationDelay: `-${(((CELLS.length - i) % CELLS.length) * CYCLE_MS) / CELLS.length}ms` }
          }
        />
      ))}
    </svg>
  );
}
