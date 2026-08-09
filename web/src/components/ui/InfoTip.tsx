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
 *
 * # The panel is placed against the VIEWPORT, not against its trigger
 *
 * The first version pinned the panel with `left-0` / `right-0` and capped its
 * width at `min(18rem, 100vw - 2rem)`. **A width cap is not a position cap.** A
 * trigger 272px from the left opened an 288px panel from x=272 and ran 170px off
 * a 390px screen — measured, on the forwarding step, by `harness/v2shoot.mjs`.
 * `align="end"` did not fix it either; it moved the same overflow to the other
 * edge, because both are anchored to the trigger and the trigger is the thing
 * that is near an edge.
 *
 * So the panel now measures itself once, on open, and shifts along x by whatever
 * it takes to sit inside the viewport with a {@link GUTTER} margin — and flips
 * above the trigger when there is no room below. `align` survives as the
 * *preferred* side; collision handling overrides it when preference does not fit.
 *
 * Two implementation notes that are not arbitrary:
 *
 *  - **`useLayoutEffect`, not `useEffect`.** The measurement has to land before
 *    the browser paints, or the panel is visibly drawn in the wrong place and
 *    then jumps.
 *  - **The shift is a `margin`, not a `transform`.** The entrance animates `y`
 *    through Framer, and a second transform on the same element would fight it —
 *    the panel would slide in from the side on every open. A margin composes with
 *    the animated transform and does not animate.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { DUR, EASE_OUT } from "../../lib/motion";
import { Info } from "./PixelIcon";
import { Pressable } from "./Pressable";

/** The margin the panel keeps from the viewport edge. Matches the app's `px-4`. */
const GUTTER = 16;

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
  const panel = useRef<HTMLSpanElement>(null);
  /** The correction, in px, that puts the panel inside the viewport. */
  const [shift, setShift] = useState(0);
  const [above, setAbove] = useState(false);

  /**
   * Measure once per open, before paint.
   *
   * `shift` is reset to 0 on close so the next open measures from the CSS
   * position rather than from the last correction — a stale shift is how a tip
   * that opened correctly once starts opening 170px to the left.
   */
  const place = useCallback(() => {
    const el = panel.current;
    const trigger = root.current;
    if (el === null || trigger === null) return;

    // Measure with no correction applied, so `left` is the position the CSS
    // alone produces and the shift is absolute rather than incremental.
    el.style.marginLeft = "0px";
    const box = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const wanted = Math.min(Math.max(box.left, GUTTER), Math.max(GUTTER, vw - box.width - GUTTER));
    setShift(Math.round(wanted - box.left));

    // Flip above the trigger when the panel would run off the bottom. Measured
    // against the viewport, not against the bottom nav: inside a Dialog the
    // panel paints above the nav, so the nav is not what would hide it.
    const vh = document.documentElement.clientHeight;
    const triggerBox = trigger.getBoundingClientRect();
    const roomBelow = vh - triggerBox.bottom - GUTTER;
    const roomAbove = triggerBox.top - GUTTER;
    setAbove(box.height > roomBelow && roomAbove > roomBelow);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      setAbove(false);
      return;
    }
    place();
  }, [open, place]);

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
            ref={panel}
            id={panelId}
            role="note"
            {...(testId === undefined ? {} : { "data-testid": `${testId}-panel` })}
            // Entering from the side the panel sits on, so it reads as coming
            // out of the trigger rather than drifting onto it.
            initial={{ y: above ? 4 : -4 }}
            animate={{ y: 0 }}
            exit={{ y: above ? 4 : -4 }}
            transition={{ duration: DUR.fast, ease: EASE_OUT }}
            // The collision correction. A margin rather than a transform: the
            // entrance animates `y` and a second transform here would fight it.
            style={{ marginLeft: shift }}
            // No shadow: the catalog's separation rule is a `border-border`
            // hairline everywhere but the Dialog sheet, and a tip is not the
            // fifth exception to that.
            className={`absolute z-40 block w-[min(18rem,calc(100vw-2rem))] rounded-[var(--radius)] border border-border bg-surface p-3 text-xs leading-relaxed text-fg ${
              above ? "bottom-full mb-1" : "top-full mt-1"
            } ${align === "end" ? "right-0" : "left-0"}`}
          >
            {children}
          </m.span>
        )}
      </AnimatePresence>
    </span>
  );
}
