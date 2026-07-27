import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "../../components/ui/PixelIcon";
import { IconButton } from "../../components/ui/IconButton";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useEdgeBack } from "../../hooks/useEdgeBack";
import { pageTransition, SHEET_EXIT_MS } from "../../lib/motion";

/**
 * Shared full-screen drill-in shell for a Settings subpage. Matches the
 * CategoryManager / RulesManager panel: a back-arrow header over a scrolling
 * body. `headerRight` hosts the page's autosave feedback.
 *
 * The shell slides in from the right and supports iOS-style edge-swipe-back:
 * a drag starting in the 24px left-edge strip tracks the finger and reveals
 * the screen underneath; the back arrow and a committed drag both play the
 * slide-out before onClose unmounts the page. Reduced motion drops all
 * slides; an edge flick still navigates back.
 */
export function SettingsPage({
  title,
  onClose,
  headerRight,
  children,
}: {
  title: string;
  onClose: () => void;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closingRef = useRef(false);   // guards against double-close
  const timerRef = useRef<number | null>(null);

  // Slide in from the right on mount. Double rAF lets the browser paint the
  // offscreen start state before transitioning to rest (same as Dialog).
  useEffect(() => {
    const panel = panelRef.current;
    if (reduced || !panel) return;
    panel.style.transform = "translateX(100%)";
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => { panel.style.transform = "translateX(0)"; });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [reduced]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // Play the exit, then ask the parent to unmount us. Under reduced motion,
  // close immediately (no slide).
  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reduced) { onCloseRef.current(); return; }
    const panel = panelRef.current;
    if (panel) panel.style.transform = "translateX(100%)";
    timerRef.current = window.setTimeout(() => onCloseRef.current(), SHEET_EXIT_MS);
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  const drag = useEdgeBack(panelRef, () => requestCloseRef.current(), reduced);

  return (
    <div
      ref={panelRef}
      style={{ transition: pageTransition(reduced), willChange: reduced ? "auto" : "transform" }}
      className="fixed inset-0 z-40 bg-bg flex flex-col"
    >
      {/* Invisible activation strip: touch-none here (and only here) lets
          horizontal pointermoves reach us instead of scrolling the page. */}
      <div
        aria-hidden
        data-testid="edge-back-strip"
        className="absolute left-0 inset-y-0 w-6 z-10 touch-none"
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      />
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        <IconButton label={`Back from ${title}`} className="-ml-2" onClick={requestClose}>
          <ArrowLeft size={20} />
        </IconButton>
        <h1 className="flex-1 text-lg font-semibold text-fg">{title}</h1>
        {headerRight}
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 max-w-screen-sm w-full mx-auto">
        {children}
      </div>
    </div>
  );
}
