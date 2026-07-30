// The single source of truth for every duration, curve and spring in the app.
//
// Durations are SECONDS (Framer Motion's unit), not milliseconds. Curves are
// cubic-bezier control-point tuples rather than `var(--ease-*)` strings,
// because Framer interpolates in JS and never reads the stylesheet.
//
// The `--ease-*` custom properties in styles/app.css survive as the published
// token names, but nothing consumes them any more: the two exempt CSS
// animations (the pixel spinner, the skeleton pulse) are `steps()` and a
// Tailwind pulse respectively, and the stagger that did use them has moved
// here. Keep the two numerically in sync anyway — this file is the one that
// ships.
import type { HTMLMotionProps, Transition } from "motion/react";

/** Entering/exiting UI. Strong, front-loaded — built-in easings are too weak. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const satisfies readonly [number, number, number, number];
/** iOS-like sheet curve. Front-loaded harder than EASE_OUT. */
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const satisfies readonly [number, number, number, number];

/**
 * Every duration in the app, in seconds. The 300ms ceiling is the UI budget:
 * anything slower on a UI element needs a written justification, and there
 * currently is not one. motion.test.ts enforces the ceiling.
 */
export const DUR = {
  press: 0.14,  // button press feedback
  fast: 0.16,   // tooltip fade, wash opacity
  base: 0.2,    // toast, row snap-back, scrim
  sheet: 0.3,   // bottom sheet / drill-in page enter
} as const;

export const PRESS_TRANSITION: Transition = { duration: DUR.press, ease: EASE_OUT };
export const FADE: Transition = { duration: DUR.base, ease: EASE_OUT };
export const SHEET_ENTER: Transition = { duration: DUR.sheet, ease: EASE_DRAWER };
/** Exit is snappier than enter — the user has already decided. */
export const SHEET_EXIT: Transition = { duration: 0.24, ease: EASE_DRAWER };

/**
 * Springs, for anything a hand can be holding. A spring retargets from its
 * current position AND velocity, so an interrupted gesture never restarts
 * from zero and a hard flick finishes faster than a slow drag — which a
 * fixed-duration transition cannot express.
 */
export const SPRING_SNAP: Transition = { type: "spring", stiffness: 550, damping: 32, mass: 0.9 };

/**
 * `dragTransition` is not a `Transition` — Framer types it `InertiaOptions`.
 * Whatever you pass is spread into a default `{ type: "inertia", … }` object
 * (`startAnimation()` in
 * `framer-motion/dist/es/gestures/drag/VisualElementDragControls.mjs`), so
 * there are two different animators reachable through the one prop:
 *
 *   - Leave `type` alone and you tune the **inertia bounce** — the spring that
 *     pulls the value back inside `dragConstraints`, or under
 *     `dragSnapToOrigin` back to 0. It is parameterised by
 *     `bounceStiffness`/`bounceDamping` and has no `mass` term.
 *   - Spread a spring `Transition` in and `type: "spring"` overwrites
 *     `"inertia"`, replacing the whole animator with an ordinary mass-spring.
 *     `Toast` does exactly that with `SPRING_SNAP`.
 *
 * Both are legitimate; they are not interchangeable, and reusing one's numbers
 * as the other's is a silent reinterpretation. Hence a separately-typed token
 * for the bounce, so the type system says which animator a token is for.
 *
 * Derived rather than imported: Framer does not re-export `InertiaOptions`
 * from `motion/react`, and going through the prop stays correct if it moves.
 */
type DragTransition = NonNullable<HTMLMotionProps<"div">["dragTransition"]>;

/**
 * `SwipeableRow`'s release. These are the numbers the retired `SPRING_ROW`
 * spring carried, but say plainly that they now drive a *different model*: an
 * inertia bounce, not a mass-spring. The spring's `mass: 0.7` is dropped
 * because the bounce has nowhere to put it — that is not an omission, it is
 * the reason this is its own token rather than a spread of a spring.
 */
export const INERTIA_ROW: DragTransition = { bounceStiffness: 600, bounceDamping: 38 };
