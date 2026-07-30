// The single source of truth for every duration, curve and spring in the app.
//
// Durations are SECONDS (Framer Motion's unit), not milliseconds. Curves are
// cubic-bezier control-point tuples rather than `var(--ease-*)` strings,
// because Framer interpolates in JS and never reads the stylesheet.
//
// The CSS custom properties in styles/app.css are retained for the two
// exempt CSS keyframe animations (the pixel spinner and the skeleton pulse)
// and must be kept numerically in sync with the tuples here — tokens.test.ts
// asserts that.
import type { Transition } from "motion/react";

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
export const SPRING_SHEET: Transition = { type: "spring", stiffness: 420, damping: 40, mass: 1 };
export const SPRING_ROW: Transition = { type: "spring", stiffness: 600, damping: 38, mass: 0.7 };
