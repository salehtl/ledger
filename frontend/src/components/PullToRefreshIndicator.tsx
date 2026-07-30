import { m, useMotionValue, animate } from "motion/react";
import { useEffect } from "react";
import { PixelSpinner } from "./ui/PixelSpinner";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";
import { SPRING_SNAP } from "../lib/motion";

/**
 * The gauge that rides down as you pull.
 *
 * The container is a fixed-height clipper and the gauge is translated inside
 * it, so nothing animates `height`. The previous version transitioned height
 * at gesture-release — a layout animation at the exact moment the app is
 * also refetching — and did it on a built-in `ease-out`, the last one in the
 * codebase.
 *
 * During the pull the motion value is *set*, not animated, so it tracks the
 * finger 1:1. Only the release springs.
 */
export function PullToRefreshIndicator({ pullDistance, refreshing }: {
  pullDistance: number;
  refreshing: boolean;
}) {
  const target = refreshing ? PULL_THRESHOLD : pullDistance;
  const visible = refreshing || pullDistance > 0;
  const progress = Math.min(1, pullDistance / PULL_THRESHOLD);

  // y=0 is the rest position at the bottom of the clipper; -PULL_THRESHOLD
  // parks it fully above the clip and out of sight.
  const y = useMotionValue(-PULL_THRESHOLD);

  useEffect(() => {
    const next = target - PULL_THRESHOLD;
    // Dragging: follow the finger exactly. Releasing or entering the
    // refreshing state: spring, so the gauge settles rather than snapping.
    if (!refreshing && pullDistance > 0) y.set(next);
    else animate(y, next, SPRING_SNAP);
  }, [target, refreshing, pullDistance, y]);

  return (
    <div
      data-testid="ptr-indicator"
      aria-hidden={!visible}
      className="absolute inset-x-0 top-0 z-10 overflow-hidden pointer-events-none"
      style={{ height: PULL_THRESHOLD }}
    >
      <m.div className="flex h-full items-end justify-center pb-2" style={{ y }}>
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
      </m.div>
    </div>
  );
}
