// frontend/src/components/ui/Dialog.tsx
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { X } from "./PixelIcon";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { sheetTransition, scrimTransition, SHEET_EXIT_MS } from "../../lib/motion";
import { useSheetDrag } from "../../hooks/useSheetDrag";
import { useVisualViewport } from "../../hooks/useVisualViewport";
import { IconButton } from "./IconButton";

/** Persistent action rail for a scrollable bottom sheet. */
export function DialogFooter({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-dialog-footer=""
      className={`sticky bottom-0 z-20 -mx-4 -mb-[max(1rem,env(safe-area-inset-bottom))] mt-4 flex items-center justify-end gap-2 border-t border-border bg-surface px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-10px_24px_-18px_rgba(0,0,0,0.45)] ${className}`}
    >
      {children}
    </div>
  );
}

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
  const viewport = useVisualViewport();

  // Slide the sheet up and fade the scrim in on mount. Double rAF lets the
  // browser paint the offscreen start state before transitioning to rest.
  // Under reduced motion, skip the slide but still seed + fade the scrim.
  useEffect(() => {
    const panel = panelRef.current, scrim = scrimRef.current;
    // A sheet that opens onto a field should land the caret in it. Focusing
    // the panel unconditionally stole that focus back, so search took two
    // taps: one to open the sheet, another to actually get into the input.
    const autofocus = panel?.querySelector<HTMLElement>("[autofocus]");
    if (autofocus) autofocus.focus();
    else panel?.focus();
    if (!scrim) return;
    scrim.style.opacity = "0";
    if (reduced || !panel) {
      const r = requestAnimationFrame(() => { scrim.style.opacity = "1"; });
      return () => cancelAnimationFrame(r);
    }
    panel.style.transform = "translateY(100%)";
    // Force a style flush so the start state is committed before we change it.
    // A double rAF is not enough in WebKit: Safari left the sheet parked at
    // translateY(100%) — entirely below the viewport — for ~400-800ms and then
    // snapped it into place with no transition. Since the scrim is already up
    // and dismisses on tap, tapping where the sheet should be closed it again,
    // which made every bottom sheet on iOS feel broken.
    void panel.offsetHeight;
    const raf = requestAnimationFrame(() => {
      panel.style.transform = "translateY(0)";
      scrim.style.opacity = "1";
    });
    return () => cancelAnimationFrame(raf);
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
    // Sized from the visual viewport, not 100dvh. On iOS the layout viewport
    // does not shrink for the software keyboard, so a dvh-tall bottom-anchored
    // container kept the sheet pinned to the bottom of the *display* — putting
    // the amount field and the Save button underneath the keyboard, with no
    // overflow to scroll them back into reach.
    <div
      className="fixed inset-x-0 z-50 flex items-end sm:items-center justify-center"
      style={{ top: viewport.offsetTop, height: viewport.height || undefined }}
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
        style={{
          transition: sheetTransition(reduced),
          willChange: reduced ? "auto" : "transform",
          // 85% of the *visible* box. With the keyboard up the sheet shrinks and
          // scrolls instead of extending underneath it; the home-indicator inset
          // is dropped then, because the keyboard already occupies that space.
          maxHeight: viewport.height ? `${Math.round(viewport.height * 0.85)}px` : "85dvh",
          paddingBottom: viewport.keyboardOpen ? "1rem" : "max(1rem, env(safe-area-inset-bottom))",
        }}
        className="relative w-full sm:max-w-md bg-surface rounded-t-[var(--radius)] sm:rounded-[var(--radius)] shadow-1 px-4 pt-3 overflow-y-auto overscroll-contain outline-none"
      >
        <div
          className="touch-none cursor-grab active:cursor-grabbing sm:cursor-default"
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerCancel}
        >
          <div aria-hidden className="sm:hidden mx-auto mb-2 h-1 w-9 rounded-[var(--radius)] bg-border" />
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
