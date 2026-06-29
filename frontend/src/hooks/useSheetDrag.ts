import { useCallback, useRef, type PointerEvent, type RefObject } from "react";
import { sheetOffset, shouldDismiss } from "../lib/sheetDrag";
import { sheetTransition } from "../lib/motion";

/**
 * Pointer drag-to-dismiss for a bottom sheet. Spread the returned handlers onto
 * the drag region (grab handle + header). Drives the panel's transform directly
 * (no React state per move — avoids re-render churn and stays on the GPU).
 */
export function useSheetDrag(
  panelRef: RefObject<HTMLDivElement>,
  onDismiss: () => void,
  reduced: boolean,
) {
  const startY = useRef<number | null>(null);
  const startT = useRef(0);
  const dy = useRef(0);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (reduced || dragging.current) return;          // multi-touch guard
    dragging.current = true;
    startY.current = e.clientY;
    startT.current = Date.now();
    dy.current = 0;
    e.currentTarget.setPointerCapture?.(e.pointerId);  // keep events if pointer leaves
    const panel = panelRef.current;
    if (panel) panel.style.transition = "none";        // 1:1 follow while dragging
  }, [reduced, panelRef]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current || startY.current === null) return;
    dy.current = e.clientY - startY.current;
    const panel = panelRef.current;
    if (panel) panel.style.transform = `translateY(${sheetOffset(dy.current)}px)`;
  }, [panelRef]);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    const elapsed = Date.now() - startT.current;
    const panel = panelRef.current;
    if (shouldDismiss(dy.current, elapsed)) {
      if (panel) panel.style.transition = sheetTransition(reduced); // restore curve so slide-out animates
      startY.current = null;                           // parity with snap-back branch
      onDismiss();                                     // Dialog plays the rest of the slide-out
      return;
    }
    if (panel) {                                       // snap back to rest
      panel.style.transition = sheetTransition(reduced);
      panel.style.transform = "translateY(0)";
    }
    startY.current = null;
  }, [panelRef, onDismiss, reduced]);

  const onPointerCancel = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    startY.current = null;
    const panel = panelRef.current;
    if (panel) {
      panel.style.transition = sheetTransition(reduced);
      panel.style.transform = "translateY(0)";
    }
  }, [panelRef, reduced]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
