/**
 * Reduced motion, read once and shared.
 *
 * `app/src/components/README.md` says reduced motion is honoured **globally,
 * never re-implemented per component**, and that the React Native equivalent of
 * v1's `MotionConfig reducedMotion="user"` gets wired "when the first real
 * animation lands". The review deck is that animation, so this is that wiring.
 *
 * It is a hook rather than a context because `AccessibilityInfo` is already a
 * process-wide source of truth: a provider would add a second place the answer
 * could be, which is the failure the README's rule is about. Components ask
 * this, and nothing else asks the platform.
 *
 * The subscription matters. iOS lets the setting change while the app is
 * foregrounded (Settings → Accessibility → Motion), and a value read once at
 * mount leaves a screen animating for a user who has just asked it not to.
 */

import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let live = true;
    // Not awaited into state without the guard: the promise can resolve after
    // an unmount, and a setState then is a warning at best and a leak at worst.
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (live) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => setReduced(v));
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  return reduced;
}
