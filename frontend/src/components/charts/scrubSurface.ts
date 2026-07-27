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
 * cancelable — which both pull-to-refresh and the chart's own scrub depend on,
 * since each claims its gesture by calling `preventDefault()` once it is sure.
 * Direction is decided by the axis lock in `lib/chartScrub.ts`, wired up in
 * dither-kit/cartesian-root.tsx: horizontal scrubs, vertical is left to the
 * page. `touch-action` would take that decision away from both of them and
 * give it to the compositor.
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
