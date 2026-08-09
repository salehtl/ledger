/**
 * A tap-to-open explanation, anchored to the thing it explains.
 *
 * # Why this exists at all
 *
 * The app says hard things on the screen where they matter, and several of those
 * sentences are load-bearing. The cost is screens that read as walls of text, and
 * a wall of text is not read. So this is not a way to delete copy — it is a way
 * to move copy that a user *may want to know to understand* off the screen that
 * carries what they *must know to act*.
 *
 * **Nothing that changes a decision may live in here.** A warning is not extra
 * information: if a sentence would change whether a person taps the button, it
 * stays on the glass. `screens/onboarding/qualifications.test.tsx` is the guard
 * on the twelve sentences that may never move.
 *
 * # The rules the tests hold
 *
 *  - **Tap, never hover.** This is a phone app; a hover tooltip is invisible to
 *    the only user it has.
 *  - **The trigger is a real button** whose accessible name says *what* it
 *    explains — "About held mail", never "info". A screen-reader user decides
 *    whether to open it before it opens.
 *  - **44px of touch target** ({@link Pressable}'s `min-h-11` equivalent), even
 *    though the glyph inside it is 12px. The target is the rule; the glyph is
 *    the drawing.
 *  - **It never contains a control.** No buttons, no links that navigate, no
 *    fields. A tip is a dead end by design, so nothing important can hide in
 *    one — `InfoTip.test.tsx` asserts the rendered tree has no interactive
 *    descendant, so an edit that puts a link in a tip fails there.
 *  - **One or two sentences.** More than that is a `Dialog`, or it belongs on
 *    the screen.
 *
 * # It is not a second overlay system
 *
 * The catalog's rule is Dialog-only overlays, and that still holds for anything
 * with a decision, a control, or more than two sentences. This is deliberately
 * *not* modal: no scrim, no focus trap, no scroll lock. It is a definition or a
 * reassurance attached to a word, and it dismisses on the first sign the user
 * has moved on — outside tap, Escape, a scroll, or a second tap on the trigger.
 * A panel that survives a scroll ends up floating over unrelated content.
 *
 * # Motion
 *
 * Durations come from `lib/motion` (`DUR.fast`, which that module already names
 * as the tooltip duration). The entrance is **transform-only**: no `opacity: 0`
 * in `initial`, per the rule in `components/README.md` — `LazyMotion` resolves
 * its features in an effect, and until that chunk lands an `m.*` renders straight
 * from `initial`. A tip is not first-paint content today, but the failure mode is
 * invisible content and the cost of avoiding it is one property.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { DUR, EASE_OUT } from "../../lib/motion";
import { Info } from "./PixelIcon";
import { Pressable } from "./Pressable";

export interface InfoTipProps {
  /**
   * What this explains, as a noun phrase. The trigger's accessible name is
   * `About {about}` — "held mail" gives "About held mail".
   */
  about: string;
  /** One or two sentences. Text only; see the header. */
  children: ReactNode;
  /**
   * Which edge of the trigger the panel is aligned to.
   *
   * `start` for a tip near the left of the screen, `end` for one near the right.
   * The panel is also width-capped to the viewport, but alignment is what keeps
   * a tip on a right-hand row from opening off-screen in the first place.
   */
  align?: "start" | "end";
  testId?: string;
}

export function InfoTip({ about, children, align = "start", testId }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (e: PointerEvent) => {
      // A press inside the wrapper is either the trigger (whose onClick toggles)
      // or the panel itself. Everything else is the user moving on.
      if (root.current?.contains(e.target as Node) === true) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    // Capture, because the app scrolls an inner `<main>` rather than the
    // document, and a scroll event on that element does not bubble to window.
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <span ref={root} className="relative inline-flex align-middle">
      <Pressable
        type="button"
        aria-label={`About ${about}`}
        aria-expanded={open}
        {...(open ? { "aria-controls": panelId } : {})}
        onClick={() => setOpen((was) => !was)}
        {...(testId === undefined ? {} : { "data-testid": testId })}
        // The target is 44px; the glyph is 12. `-m-3` keeps the oversized
        // target from pushing the label it sits beside around.
        className="-m-3 h-11 w-11 inline-flex items-center justify-center text-muted hover:text-fg"
      >
        <Info size={12} aria-hidden />
      </Pressable>
      <AnimatePresence>
        {open && (
          <m.span
            id={panelId}
            role="note"
            {...(testId === undefined ? {} : { "data-testid": `${testId}-panel` })}
            initial={{ y: -4 }}
            animate={{ y: 0 }}
            exit={{ y: -4 }}
            transition={{ duration: DUR.fast, ease: EASE_OUT }}
            // No shadow: the catalog's separation rule is a `border-border`
            // hairline everywhere but the Dialog sheet, and a tip is not the
            // fifth exception to that.
            className={`absolute top-full z-40 mt-1 block w-[min(18rem,calc(100vw-2rem))] rounded-[var(--radius)] border border-border bg-surface p-3 text-xs leading-relaxed text-fg ${
              align === "end" ? "right-0" : "left-0"
            }`}
          >
            {children}
          </m.span>
        )}
      </AnimatePresence>
    </span>
  );
}
