import { m } from "motion/react";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { PRESS_TRANSITION } from "../../lib/motion";

/**
 * The app's one press-feedback primitive: a subtle scale confirming the UI
 * heard the tap.
 *
 * This replaces the global `.press` CSS class, which was declared outside
 * every cascade layer and therefore outranked all of Tailwind's
 * `@layer utilities` rules. Because it used the `transition` shorthand it
 * also reset `transition-property` to `transform`, silently killing every
 * `transition-colors` in the app. A component owning its own motion cannot
 * reach across the codebase like that.
 *
 * `whileTap` is pointer-based, so it is correct on touch in a way `:hover`
 * never is, and Framer's global reducedMotion policy disables the scale for
 * a user who asked for less motion — no per-call-site branch needed.
 */
export type PressableProps = ComponentPropsWithoutRef<typeof m.button>;

export const Pressable = forwardRef<HTMLButtonElement, PressableProps>(
  function Pressable({ type = "button", ...rest }, ref) {
    return (
      <m.button
        ref={ref}
        type={type}
        whileTap={{ scale: 0.97 }}
        transition={PRESS_TRANSITION}
        {...rest}
      />
    );
  },
);
