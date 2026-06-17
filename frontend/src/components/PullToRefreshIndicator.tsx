import { Loader2 } from "lucide-react";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";

export function PullToRefreshIndicator({ pullDistance, refreshing }: {
  pullDistance: number;
  refreshing: boolean;
}) {
  const height = refreshing ? PULL_THRESHOLD : pullDistance;
  const visible = refreshing || pullDistance > 0;
  const progress = Math.min(1, pullDistance / PULL_THRESHOLD);

  return (
    <div
      data-testid="ptr-indicator"
      aria-hidden={!visible}
      className="absolute inset-x-0 top-0 z-10 flex items-end justify-center overflow-hidden pointer-events-none"
      style={{ height }}
    >
      <div className="pb-2">
        {refreshing ? (
          <Loader2 size={24} role="status" aria-label="Refreshing" className="text-muted animate-spin" />
        ) : (
          <Loader2
            size={24}
            aria-hidden
            className="text-muted"
            style={{ opacity: progress, transform: `rotate(${progress * 270}deg)` }}
          />
        )}
      </div>
    </div>
  );
}
