// frontend/src/components/ui/Dialog.tsx
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, m, useDragControls } from "motion/react";
import { X } from "./PixelIcon";
import { SHEET_ENTER, SHEET_EXIT, FADE } from "../../lib/motion";
import { shouldDismissSheet } from "../../lib/sheetDrag";
import { useVisualViewport } from "../../hooks/useVisualViewport";
import { IconButton } from "./IconButton";

/**
 * Persistent action rail for a scrollable bottom sheet.
 *
 * The footer owns the sheet's bottom inset (`--sheet-inset-bottom`) and the
 * panel contributes none — see `.sheet-panel:has()` in app.css. `sticky
 * bottom: 0` resolves against the scroll container's *content* box, so any
 * padding-bottom on the panel rides the stuck footer up by exactly that much,
 * straight over the last row of content. The previous
 * `-mb-[max(1rem,env(safe-area-inset-bottom))]` was meant to cancel that but
 * did the opposite: a negative margin shrinks the content box, so it *was* the
 * lift. `mt-4` masked it wherever `env(safe-area-inset-bottom)` is 0 — which is
 * every desktop browser and both headless engines — while a phone with a 34px
 * home-indicator inset lost 18px of the row above and gained a dead 34px strip
 * below the buttons.
 */
export function DialogFooter({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-dialog-footer=""
      className={`sticky bottom-0 z-20 -mx-4 mt-4 flex items-center justify-end gap-2 border-t border-border bg-surface px-4 pt-3 pb-[var(--sheet-inset-bottom)] shadow-[0_-10px_24px_-18px_rgba(0,0,0,0.45)] ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Freeze every scrollable ancestor for as long as the sheet is up, restoring
 * the exact inline value and offset afterwards.
 *
 * A `position: fixed` overlay is attached to the viewport, so a touch drag on
 * it chains to the *root* scroller rather than to its DOM ancestor — which is
 * why `<main>`'s own `overscroll-contain` never saw the gesture and the whole
 * page (top bar included) rubber-banded behind an open sheet, dragging the
 * fixed overlay with it and leaving an unscrimmed strip at the top.
 *
 * Ancestors, not `document.body`: this app scrolls an inner `<main>`, and a
 * sheet opened from a drill-in overlay has to freeze that overlay's scroller
 * too. Restoring the recorded inline value (rather than clearing it) keeps
 * stacked sheets honest — the inner sheet hands the lock back to the outer one.
 */
function useScrollLock(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const start = ref.current;
    if (!start) return;
    const frozen: { el: HTMLElement; overflow: string; top: number }[] = [];
    for (let el = start.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      frozen.push({ el, overflow: el.style.overflow, top: el.scrollTop });
      el.style.overflow = "hidden";
    }
    return () => {
      for (const f of frozen) {
        f.el.style.overflow = f.overflow;
        f.el.scrollTop = f.top;
      }
    };
  }, [ref]);
}

export function Dialog({ title, titleAdornment, titleStyle, onClose, children }: {
  title: string;
  titleAdornment?: ReactNode;
  titleStyle?: CSSProperties;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const viewport = useVisualViewport();
  useScrollLock(rootRef);

  // The sheet owns its own exit: `open` drives AnimatePresence, and the
  // parent is only told to unmount once the exit has actually finished.
  // That replaces a setTimeout racing a CSS duration — the two could not be
  // kept in sync, and the mismatch is what SHEET_EXIT_MS was papering over.
  //
  // No double-close guard any more: closing twice is `setOpen(false)` twice,
  // which is idempotent, and AnimatePresence fires onExitComplete exactly once
  // per exit. The old guard existed only because two taps could arm two timers.
  const [open, setOpen] = useState(true);
  const requestClose = useCallback(() => setOpen(false), []);

  // Drag lives on the handle + header, not the whole panel, or a drag on the
  // scrollable body would fight the scroller.
  const dragControls = useDragControls();

  // A drag that STARTS on the handle and ENDS off the panel — the upward
  // rubber-band, released over the dim area — makes the browser synthesise a
  // click on the nearest common ancestor of press and release, which is this
  // overlay root. That is not a tap on the scrim and must not close the sheet.
  // (The hand-rolled version never hit this: it took a pointer capture, which
  // retargeted the compatibility click back inside the panel.) So a drag
  // disarms exactly one click, and the next press re-arms it.
  const draggedRef = useRef(false);

  // A sheet that opens onto a field should land the caret in it. Focusing
  // the panel unconditionally stole that focus back, so search took two
  // taps: one to open the sheet, another to actually get into the input.
  useEffect(() => {
    const panel = panelRef.current;
    const autofocus = panel?.querySelector<HTMLElement>("[autofocus]");
    if (autofocus) autofocus.focus();
    else panel?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { requestClose(); return; }
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
    return () => document.removeEventListener("keydown", onKey);
  }, [requestClose]);

  return (
    <AnimatePresence onExitComplete={() => onCloseRef.current()}>
      {open && (
        // Sized from the visual viewport, not 100dvh. On iOS the layout viewport
        // does not shrink for the software keyboard, so a dvh-tall bottom-anchored
        // container kept the sheet pinned to the bottom of the *display* — putting
        // the amount field and the Save button underneath the keyboard, with no
        // overflow to scroll them back into reach.
        <div
          ref={rootRef}
          className="fixed inset-x-0 z-50 flex items-end sm:items-center justify-center"
          style={{ top: viewport.offsetTop, height: viewport.height || undefined }}
          onPointerDownCapture={() => { draggedRef.current = false; }}
          onClick={() => { if (!draggedRef.current) requestClose(); }}
        >
          {/* touch-none: a drag on the dim area must die here, not travel to the
              root scroller and rubber-band the page out from under the sheet. */}
          <m.div
            aria-hidden
            data-testid="dialog-scrim"
            className="absolute inset-0 touch-none bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE}
          />
          <m.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            // `initial` is committed as the first render's inline style, so the
            // offscreen start state exists before the browser has ever painted
            // this element — there is no start state to flush, which is what the
            // hand-rolled version needed `void panel.offsetHeight` for and still
            // got wrong in WebKit: Safari left the sheet parked at
            // translateY(100%), entirely below the viewport, for ~400-800ms and
            // then snapped it into place with no transition. Since the scrim is
            // already up and dismisses on tap, tapping where the sheet should be
            // closed it again, which made every bottom sheet on iOS feel broken.
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            // The exit transition rides on the exit target, not on a
            // `{ exit: … }` key of `transition` — Framer has no such key, so
            // that form typechecks nowhere and would silently leave the
            // slide-out running at the slower enter duration.
            exit={{ y: "100%", transition: SHEET_EXIT }}
            transition={SHEET_ENTER}
            drag="y"
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            // Downward only: an upward pull is clamped rather than tracked, so
            // the panel does not move at all above rest.
            dragElastic={{ top: 0, bottom: 0.9 }}
            dragMomentum={false}
            onDragStart={() => { draggedRef.current = true; }}
            onDragEnd={(_, info) => {
              if (shouldDismissSheet(info.offset.y, info.velocity.y)) requestClose();
            }}
            style={{
              // 85% of the *visible* box. With the keyboard up the sheet shrinks and
              // scrolls instead of extending underneath it; the home-indicator inset
              // is dropped then, because the keyboard already occupies that space.
              maxHeight: viewport.height ? `${Math.round(viewport.height * 0.85)}px` : "85dvh",
              // The keyboard already occupies the home-indicator strip, so the inset
              // collapses to a plain gutter. Set as a variable rather than as padding
              // so a DialogFooter — which may be the thing that actually needs the
              // clearance — inherits the same number.
              ...(viewport.keyboardOpen ? { ["--sheet-inset-bottom" as string]: "1rem" } : {}),
            }}
            className="sheet-panel relative w-full sm:max-w-md bg-surface rounded-t-[var(--radius)] sm:rounded-[var(--radius)] shadow-1 px-4 pt-3 overflow-y-auto overscroll-contain outline-none"
          >
            {/* data-sheet-handle, like data-dialog-footer above: the drag
                region is a styling-classes-only div, and harness/gestures.mjs
                has to grab it by something that is not a Tailwind class. */}
            <div
              data-sheet-handle=""
              className="touch-none cursor-grab active:cursor-grabbing sm:cursor-default"
              onPointerDown={(e) => dragControls.start(e)}
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
          </m.div>
        </div>
      )}
    </AnimatePresence>
  );
}
