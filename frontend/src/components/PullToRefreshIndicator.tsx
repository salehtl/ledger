import { Loader2 } from "./ui/PixelIcon";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";

export function PullToRefreshIndicator({ pullDistance, refreshing }: {
  pullDistance: number;
  refreshing: boolean;
}) {
  const height = refreshing ? PULL_THRESHOLD : pullDistance;
  const visible = refreshing || pullDistance > 0;
  const progress = Math.min(1, pullDistance / PULL_THRESHOLD);
  // Quantized to 90° steps (0/90/180/270deg), not a smooth `progress * 270`:
  // rotating a pixel grid off-axis blurs it, so the pull gauge only ever
  // shows grid-aligned rotations.
  const stepDeg = Math.min(3, Math.floor(progress * 3)) * 90;
  const transition = refreshing || pullDistance === 0 ? "height 0.2s ease-out" : "none";

  return (
    <div
      data-testid="ptr-indicator"
      aria-hidden={!visible}
      className="absolute inset-x-0 top-0 z-10 flex items-end justify-center overflow-hidden pointer-events-none"
      style={{ height, transition }}
    >
      <div className="pb-2">
        {refreshing ? (
          <Loader2 size={24} role="status" aria-label="Refreshing" className="text-muted spin-pixel" />
        ) : (
          <Loader2
            size={24}
            aria-hidden
            className="text-muted"
            style={{ opacity: progress, transform: `rotate(${stepDeg}deg)` }}
          />
        )}
      </div>
    </div>
  );
}
