import { useCallback, useRef, type PointerEvent, type RefObject } from "react";
import { edgeBackOffset, inEdgeZone, shouldGoBack } from "../lib/edgeBack";
// TEMPORARY: see lib/motionLegacy.ts — removed by Task 4, which also
// deletes this file, replacing edge-swipe-back with Framer's `drag` prop.
import { pageTransition } from "../lib/motionLegacy";

/**
 * iOS-style interactive edge-swipe-back. Spread the returned handlers onto a
 * narrow edge strip; the hook drives the full-page panel's transform directly
 * (no React state per move — stays on the GPU). On commit it calls onBack();
 * the page plays its own exit, same contract as useSheetDrag → Dialog.
 * Under reduced motion there is no tracking — a committed flick still fires
 * onBack, untracked.
 */
export function useEdgeBack(
  panelRef: RefObject<HTMLDivElement | null>,
  onBack: () => void,
  reduced: boolean,
) {
  const startX = useRef<number | null>(null);
  const startT = useRef(0);
  const dx = useRef(0);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (dragging.current || !inEdgeZone(e.clientX)) return; // multi-touch + zone guard
    dragging.current = true;
    startX.current = e.clientX;
    startT.current = Date.now();
    dx.current = 0;
    e.currentTarget.setPointerCapture?.(e.pointerId);        // keep events if pointer leaves
    const panel = panelRef.current;
    if (panel && !reduced) panel.style.transition = "none";  // 1:1 follow while dragging
  }, [reduced, panelRef]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current || startX.current === null) return;
    dx.current = e.clientX - startX.current;
    if (reduced) return;                                     // flick-only under reduced motion
    const panel = panelRef.current;
    if (panel) panel.style.transform = `translateX(${edgeBackOffset(dx.current)}px)`;
  }, [panelRef, reduced]);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    const elapsed = Date.now() - startT.current;
    const panel = panelRef.current;
    const width = panel?.offsetWidth || window.innerWidth;   // jsdom: offsetWidth is 0
    if (panel && !reduced) panel.style.transition = pageTransition(reduced);
    if (shouldGoBack(dx.current, elapsed, width)) {
      startX.current = null;
      onBack();                                              // page plays the slide-out
      return;
    }
    if (panel && !reduced) panel.style.transform = "translateX(0)"; // snap back to rest
    startX.current = null;
  }, [panelRef, onBack, reduced]);

  const onPointerCancel = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    startX.current = null;
    const panel = panelRef.current;
    if (panel && !reduced) {
      panel.style.transition = pageTransition(reduced);
      panel.style.transform = "translateX(0)";
    }
  }, [panelRef, reduced]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
