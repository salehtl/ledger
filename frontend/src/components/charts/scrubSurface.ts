import type { CSSProperties } from "react";

/**
 * Touch behavior for a chart you scrub with a finger to read its detail box.
 *
 * Without this the browser owns the gesture: a drag starts a native text
 * selection (the month labels highlight), the pointer stream is cancelled, and
 * `onPointerMove` never runs — so the detail box that appears on hover with a
 * mouse never appears on touch at all.
 *
 * `pan-y` rather than `none`: the page must still scroll when the drag starts
 * vertical. We claim only the horizontal axis, which is the one the scrub
 * reads. Same choice as SwipeableRow and Toast; SwipeCard uses `none` because
 * it owns both axes.
 *
 * Applied to each chart's outermost wrapper, not just its plot area — iOS
 * extends a selection into whatever text is nearest, so the labels and net-lane
 * figures have to be covered too.
 */
export const SCRUB_SURFACE: CSSProperties = {
  touchAction: "pan-y",
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
};
