import { useEffect, useState } from "react";

export interface ViewportBox {
  /** Height of the area actually visible to the user, in CSS px. */
  height: number;
  /** How far the visible area is offset from the top of the layout viewport. */
  offsetTop: number;
  /** True while the visible area is materially shorter than the layout
   *  viewport — i.e. the software keyboard is up. */
  keyboardOpen: boolean;
}

/**
 * Tracks `window.visualViewport`.
 *
 * This exists because of one iOS behaviour: when the software keyboard opens,
 * the *layout* viewport does not change. `100dvh`, `100vh` and `position:
 * fixed` all keep addressing the full screen, so a bottom-anchored sheet stays
 * anchored to the bottom of the display — underneath the keyboard. On the Plan
 * sheets that put the amount field and the Save button behind the keyboard with
 * no overflow to scroll, which made them impossible to use.
 *
 * `visualViewport` is the only thing that does shrink, so anything that must
 * stay clear of the keyboard has to size itself from this rather than from vh.
 *
 * Falls back to `window.innerHeight` where the API is missing (older browsers,
 * jsdom), which reproduces the previous behaviour rather than breaking.
 */
export function useVisualViewport(): ViewportBox {
  const read = (): ViewportBox => {
    if (typeof window === "undefined") return { height: 0, offsetTop: 0, keyboardOpen: false };
    const vv = window.visualViewport;
    if (!vv) return { height: window.innerHeight, offsetTop: 0, keyboardOpen: false };
    return {
      height: vv.height,
      offsetTop: vv.offsetTop,
      // 120px of lost height is well past browser-chrome jitter and well under
      // any real keyboard, so it separates the two without guessing at devices.
      keyboardOpen: window.innerHeight - vv.height > 120,
    };
  };

  const [box, setBox] = useState<ViewportBox>(read);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setBox(read());
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return box;
}
