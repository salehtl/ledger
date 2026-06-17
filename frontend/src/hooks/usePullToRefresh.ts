import { useEffect, useRef, useState, type RefObject } from "react";
import { resist, shouldTrigger } from "../lib/pullToRefresh";

/**
 * Pull-to-refresh gesture on a scroll container. Tracking begins only when the
 * element is scrolled to the top; releasing past the threshold calls onRefresh
 * and keeps `refreshing` true until its promise settles.
 */
export function usePullToRefresh(
  ref: RefObject<HTMLElement>,
  onRefresh: () => Promise<unknown>,
): { pullDistance: number; refreshing: boolean } {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const startY = useRef<number | null>(null);
  const distanceRef = useRef(0);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const setDistance = (d: number) => { distanceRef.current = d; setPullDistance(d); };

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      startY.current = el.scrollTop <= 0 ? e.touches[0].clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current === null || refreshingRef.current) return;
      const dist = resist(e.touches[0].clientY - startY.current);
      if (dist > 0) {
        e.preventDefault(); // suppress native scroll/bounce while pulling
        setDistance(dist);
      }
    };
    const onEnd = () => {
      if (startY.current === null) return;
      startY.current = null;
      if (shouldTrigger(distanceRef.current)) {
        refreshingRef.current = true;
        setRefreshing(true);
        setDistance(0);
        Promise.resolve(onRefreshRef.current()).finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
        });
      } else {
        setDistance(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [ref]);

  return { pullDistance, refreshing };
}
