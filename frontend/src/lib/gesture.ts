// The one release-gesture rule every draggable surface in the app shares.
//
// Five surfaces answer the same question in their `onDragEnd` — the toast, the
// bottom sheet, the edge-back page, the list row and the sorting card — and all
// five answer it the same way: commit if the drag went far enough, OR if it was
// travelling fast enough when released. The distance half differs per surface
// (a sheet is not a toast) and stays with each predicate. The *velocity* half is
// identical everywhere and lives here, because it needs three guards and four of
// the five predicates were only carrying one of them.
//
// Why a velocity clause needs a distance floor at all: Framer's `PanSession`
// starts a drag once movement crosses ~3px and reports `info.velocity` sampled
// over roughly the last 100ms, so a jittery tap — a finger that lands, shivers
// five pixels and lifts — is reported at 600px/s. That is past every
// `*_FLICK_VELOCITY` in the app. Without a floor, the tap commits: the toast
// vanishes, the sheet closes, the row archives. It cannot even fall back to
// being a tap, because `onDragStart` has already fired and armed each
// component's press-suppression guard. This was found on the card deck (see
// `swipe.ts`'s `commitDirection`, the one predicate that had the floor) and is
// mechanically identical on the other four; only the surface differs.
//
// The floor is measured on the axis being judged, never on total travel, so
// 30px of vertical drag can never license a horizontal velocity commit.

/**
 * Minimum travel (px) on the judged axis before velocity alone may commit a
 * gesture. 24px is comfortably past both Framer's ~3px pan threshold and the
 * ~10px `dragDirectionLock` threshold, and well under every surface's distance
 * threshold, so it only ever rules out gestures that were never a real drag.
 */
export const FLICK_MIN_PX = 24;

/**
 * Was a released drag a flick — fast enough, far enough, and still heading the
 * way it started?
 *
 * @param offset   signed travel on the judged axis (Framer's `info.offset`)
 * @param velocity signed px/s on the same axis (Framer's `info.velocity`)
 * @param minPx    distance floor; pass `FLICK_MIN_PX` unless a surface has a
 *                 documented reason to differ
 * @param minVel   the surface's own flick speed threshold
 *
 * The sign check is what stops a card flung back toward centre from committing
 * to the edge it is leaving: fast, but heading home is a cancellation, not a
 * flick. `Math.sign(0) === 0`, so a zero velocity never agrees with a non-zero
 * offset and a zero offset never clears `minPx` — both fall out for free.
 */
export function flicked(offset: number, velocity: number, minPx: number, minVel: number): boolean {
  return (
    Math.abs(offset) >= minPx &&
    Math.sign(velocity) === Math.sign(offset) &&
    Math.abs(velocity) >= minVel
  );
}
