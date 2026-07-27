import { PixelSpinner } from "./ui/PixelSpinner";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";

export function PullToRefreshIndicator({ pullDistance, refreshing }: {
  pullDistance: number;
  refreshing: boolean;
}) {
  const height = refreshing ? PULL_THRESHOLD : pullDistance;
  const visible = refreshing || pullDistance > 0;
  const progress = Math.min(1, pullDistance / PULL_THRESHOLD);
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
          <PixelSpinner size={24} role="status" aria-label="Refreshing" className="text-muted" />
        ) : (
          // The ring fills as you pull, so how far you've come is countable in
          // blocks. The whole gauge still fades in over the first few pixels of
          // travel so it doesn't pop into existence at full strength.
          <PixelSpinner
            size={24}
            aria-hidden
            progress={progress}
            className="text-muted"
            style={{ opacity: Math.min(1, progress * 3) }}
          />
        )}
      </div>
    </div>
  );
}
