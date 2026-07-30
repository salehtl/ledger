import { LazyMotion, MotionConfig, type LazyFeatureBundle } from "motion/react";
import type { ReactNode } from "react";

/**
 * `domMax` — not `domAnimation` — because the app needs drag (sheets, the
 * swipe deck, list rows) and layout animations. Imported as a thunk so the
 * feature bundle lands in its own chunk and never blocks first paint.
 */
const loadDomMax: LazyFeatureBundle = () => import("motion/react").then((m) => m.domMax);

/**
 * The app's one motion root.
 *
 * `strict` makes a bare `motion.div` throw instead of silently pulling the
 * full feature set into the entry chunk. Every component uses `m.*`.
 *
 * `reducedMotion="user"` is the app-wide accessibility policy: Framer
 * disables transform and layout animations for a user who asked the OS to
 * minimise motion, while leaving opacity and colour alone. That is exactly
 * the "gentler, not zero" reading the app already applied by hand in
 * styles/app.css. Components must NOT re-implement this per-component —
 * the previous hand-rolled version is how the swipe card's 800px fly-out
 * ended up ignoring the preference entirely.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadDomMax} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
