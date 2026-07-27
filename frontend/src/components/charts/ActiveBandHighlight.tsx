import { activeBandRect } from "../../lib/trendBars";

/**
 * Surface-tint highlight behind the active month's bar band — the dither
 * `BarChart` colors per *series*, not per *bar*, so this is our own markup
 * standing in for the old div-based charts' `bg-surface-2/40` column
 * emphasis. Position comes from `activeBandRect`, which derives from the
 * same `bandCenters()` the bars and label rows are laid out with, so it lines
 * up with the active bar by construction.
 *
 * dither-kit's `markerIndex` prop looks like the built-in mechanism for this
 * (a "controlled crosshair"), but in dither-kit 0.1.0 it's accepted and
 * stored on chart context, never read by any renderer (bar-canvas.tsx,
 * dot.tsx and tooltip.tsx all key off `hoverIndex` only) — so it's inert and
 * both charts have stopped passing it. This component is the real thing.
 *
 * Callers must render this *before* the chart's canvas in DOM order — with
 * no z-index on either element, DOM order is what keeps the highlight behind
 * the bars instead of occluding them.
 */
export function ActiveBandHighlight({ n, index }: { n: number; index: number | null }) {
  const rect = activeBandRect(n, index);
  if (!rect) return null;
  return (
    <div
      data-testid="active-band-highlight"
      aria-hidden
      className="absolute inset-y-0 rounded-lg bg-surface-2/40"
      style={{ left: `${rect.left * 100}%`, width: `${rect.width * 100}%` }}
    />
  );
}
