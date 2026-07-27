import type { CSSProperties } from "react";

/**
 * Touch behavior for a chart you scrub with a finger to read its detail box.
 *
 * Without this the browser treats a finger-drag as a native text selection: the
 * month labels highlight, the pointer stream is cancelled, and `onPointerMove`
 * never runs — so the detail box that appears on hover with a mouse never
 * appears on touch at all. Suppressing selection is the whole fix.
 *
 * Applied to each chart's outermost wrapper, not just its plot area — iOS
 * extends a selection into whatever text is nearest, so the labels and net-lane
 * figures have to be covered too.
 *
 * **Deliberately no `touch-action`.** An earlier version set `pan-y` here,
 * copying SwipeableRow and Toast, and it broke pull-to-refresh on every screen
 * with a chart. Declaring a `touch-action` that permits the pan hands that axis
 * to the browser's compositor, which dispatches `touchmove` as non-cancelable —
 * and `usePullToRefresh` owns its gesture by calling `preventDefault()` on a
 * non-passive `touchmove`. That call silently stopped working, and because
 * `<main>` is `overscroll-contain`, a downward drag at the top of the page did
 * nothing at all. Leaving `touch-action` at its default keeps those events
 * cancelable, so the pull still works when it starts on a chart; the scrub
 * needs nothing from `touch-action` because it reads pointer events, and
 * `onPointerCancel` (see dither-kit/cartesian-root.tsx) cleans up if the
 * browser does claim the gesture for a scroll.
 *
 * SwipeableRow and Toast still declare `pan-y`. That is the same latent bug,
 * but their surfaces are rarely at `scrollTop: 0` where a pull can start, so it
 * has never surfaced. Fix them if a pull is ever reported dead over a row.
 */
export const SCRUB_SURFACE: CSSProperties = {
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
};
