/**
 * The `domMax` feature bundle, alone in its own module, so the bundler can put
 * it in its own chunk.
 *
 * This file exists purely for code-splitting and is the difference between a
 * 760KB entry chunk and an 826KB one. `MotionProvider` used to inline the
 * thunk as `() => import("motion/react").then((m) => m.domMax)`, which looks
 * like it splits and does not, for two compounding reasons:
 *
 *  1. `motion/react` is a barrel (`export * from "framer-motion"`) that the
 *     app also imports *statically* — every `m`, `AnimatePresence`,
 *     `useMotionValue`. Rollup will not move a module into a lazy chunk while
 *     something in the entry graph still needs it, so the dynamic import
 *     resolved straight back into the entry chunk.
 *  2. A dynamic `import()` of a barrel asks for its whole namespace object, so
 *     nothing in it can be tree-shaken. The entry chunk got *all* of
 *     framer-motion, not just the parts the app uses.
 *
 * Importing the single named export here restores both: this module is only
 * ever reached dynamically, so it becomes a chunk, and the named import lets
 * Rollup drop everything `domMax` does not reach.
 *
 * `domMax` rather than `domAnimation` because the app needs drag (sheets, the
 * swipe deck, list rows) and layout animations. If the entry chunk ever jumps
 * by ~180KB again, check that nothing has started importing `domMax` — or the
 * `motion/react` namespace — from a statically-reachable module.
 */
import { domMax } from "motion/react";

export default domMax;
