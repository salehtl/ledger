// frontend/src/components/ui/Dialog.tsx
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { sheetTransition, scrimTransition, SHEET_EXIT_MS } from "../../lib/motion";
import { useSheetDrag } from "../../hooks/useSheetDrag";
import { IconButton } from "./IconButton";

export function Dialog({ title, titleAdornment, titleStyle, onClose, children }: {
  title: string;
  titleAdornment?: ReactNode;
  titleStyle?: CSSProperties;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const reduced = usePrefersReducedMotion();
  const titleId = useId();
  const closingRef = useRef(false);     // guards against double-close
  const timerRef = useRef<number | null>(null);

  // Slide the sheet up and fade the scrim in on mount. Double rAF lets the
  // browser paint the offscreen start state before transitioning to rest.
  // Under reduced motion, skip the slide but still seed + fade the scrim.
  useEffect(() => {
    const panel = panelRef.current, scrim = scrimRef.current;
    panel?.focus();
    if (!scrim) return;
    scrim.style.opacity = "0";
    if (reduced || !panel) {
      const r = requestAnimationFrame(() => { scrim.style.opacity = "1"; });
      return () => cancelAnimationFrame(r);
    }
    panel.style.transform = "translateY(100%)";
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        panel.style.transform = "translateY(0)";
        scrim.style.opacity = "1";
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [reduced]);

  // Play the exit, then ask the parent to unmount us. Under reduced motion,
  // close immediately (no slide).
  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reduced) { onCloseRef.current(); return; }
    const panel = panelRef.current, scrim = scrimRef.current;
    if (panel) panel.style.transform = "translateY(100%)";
    if (scrim) scrim.style.opacity = "0";
    timerRef.current = window.setTimeout(() => onCloseRef.current(), SHEET_EXIT_MS);
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  const drag = useSheetDrag(panelRef, () => requestCloseRef.current(), reduced);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { requestCloseRef.current(); return; }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []); // mount-only; refs hold the latest callbacks

  return (
    <div
      className="fixed inset-x-0 top-0 h-[100dvh] z-50 flex items-end sm:items-center justify-center"
      onClick={requestClose}
    >
      <div ref={scrimRef} aria-hidden data-testid="dialog-scrim" className="absolute inset-0 bg-black/40" style={{ transition: scrimTransition() }} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{ transition: sheetTransition(reduced), willChange: reduced ? "auto" : "transform" }}
        className="relative w-full sm:max-w-md bg-surface rounded-t-[var(--radius-sheet)] sm:rounded-[var(--radius-sheet)] shadow-1 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[85dvh] overflow-y-auto overscroll-contain outline-none"
      >
        <div
          className="touch-none cursor-grab active:cursor-grabbing sm:cursor-default"
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerCancel}
        >
          <div aria-hidden className="sm:hidden mx-auto mb-2 h-1 w-9 rounded-full bg-border" />
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2.5 min-w-0">
              {titleAdornment}
              <h2 id={titleId} style={titleStyle} className="text-lg font-semibold truncate">{title}</h2>
            </div>
            <IconButton label="Close" className="-mr-2" onClick={requestClose}><X size={18} /></IconButton>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
