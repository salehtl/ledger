import { useEffect, useRef, useState, type RefObject } from "react";
import { resist, shouldTrigger, pullIntent } from "../lib/pullToRefresh";
import { fire } from "../lib/feedback";

/**
 * Elements whose touches must never start a pull. Dialogs render inline inside
 * <main> (no portal), so sheet drags and sheet-content scrolls bubble here;
 * gesture-owning surfaces (swipe deck cards, swipeable rows) opt out with
 * data-ptr-exempt.
 */
const EXEMPT_SELECTOR = '[role="dialog"], [data-ptr-exempt]';

type Track = { x: number; y: number; phase: "undecided" | "pulling" | "rejected" };

/**
 * Pull-to-refresh gesture on a scroll container. A touch is tracked only when
 * the element is scrolled to the top, is single-finger, and does not originate
 * inside an open dialog or a PTR-exempt surface. The gesture is claimed only
 * once it proves clearly downward (axis lock — see lib/pullToRefresh);
 * releasing past the threshold calls onRefresh and keeps `refreshing` true
 * until its promise settles.
 */
export function usePullToRefresh(
  ref: RefObject<HTMLElement>,
  onRefresh: () => Promise<unknown>,
  enabled = true,
): { pullDistance: number; refreshing: boolean } {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const track = useRef<Track | null>(null);
  const distanceRef = useRef(0);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const setDistance = (d: number) => { distanceRef.current = d; setPullDistance(d); };

    const onStart = (e: TouchEvent) => {
      track.current = null;
      if (!enabledRef.current || refreshingRef.current) return;
      if (e.touches.length > 1) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(EXEMPT_SELECTOR)) return;
      if (el.scrollTop > 0) return;
      track.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, phase: "undecided" };
    };

    const onMove = (e: TouchEvent) => {
      const t = track.current;
      if (!t || t.phase === "rejected" || refreshingRef.current || !e.touches[0]) return;
      if (e.touches.length > 1) { // a pinch is not a pull
        track.current = null;
        setDistance(0);
        return;
      }
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      if (t.phase === "undecided") {
        // Content scrolled mid-gesture (drag up, then back down): rebase so a
        // pull can only start from a genuine at-rest top, never hijack a scroll.
        if (el.scrollTop > 0) { t.x = x; t.y = y; return; }
        const intent = pullIntent(x - t.x, y - t.y);
        if (intent === "reject") { t.phase = "rejected"; return; }
        if (intent === "undecided") return;
        t.phase = "pulling";
      }
      e.preventDefault(); // the pull owns this gesture; suppress native scroll/bounce
      setDistance(resist(y - t.y));
    };

    const onEnd = () => {
      const t = track.current;
      if (!t) return;
      track.current = null;
      if (t.phase === "pulling" && shouldTrigger(distanceRef.current)) {
        fire("success"); // synchronous, inside the touchend gesture
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
