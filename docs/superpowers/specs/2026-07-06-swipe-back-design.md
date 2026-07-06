# Swipe-Back Gesture for Drill-In Pages — Design

**Date:** 2026-07-06
**Status:** Approved (verbal, session)

## Goal

iOS-style interactive edge-swipe-back on the app's full-screen drill-in pages. The
ledger PWA runs installed (standalone) on iPhone, where the OS provides no
edge-swipe-back; today the only way out of a drill-in is the top-left back arrow.

## Scope

**In:** every surface built on the shared `SettingsPage` shell — the 7 settings
subpages (Budget, Categorization, Swipe, Currencies, Accounts, Text size, Email
ingest) plus `CategoryManager` and `RulesManager`. One wiring point covers all
nine.

**Out (explicitly):**
- Dialog sheets — they keep drag-down-to-dismiss, scrim tap, and Escape.
  (Matches iOS: edge-swipe pops pushed pages, not sheets.)
- Tab navigation — no back-history concept between tabs.
- Browser history / History-API integration — navigation stays component state.

## Interaction spec

- **Activation zone:** a drag must *start* within 24px of the left screen edge.
  The zone wins over content beneath it (filter chips, segmented controls that
  scroll horizontally near the edge) — same priority iOS gives its edge gesture.
- **Tracking:** after activation, the page follows the finger 1:1 on the X axis
  (`translateX`, GPU-only, no React re-render per move). Leftward drag past rest
  is clamped to 0 (no rubber-band — there is nothing to the left).
- **Reveal:** the hub/screen underneath is already mounted below the overlay
  (`SettingsPage` is a `fixed inset-0 z-40` layer), so the drag genuinely reveals
  the live screen behind it.
- **Commit rule:** on release, the page dismisses if dragged ≥ 1/3 of the
  viewport width OR flicked right at ≥ 0.11 px/ms (mirrors
  `SHEET_DISMISS_VELOCITY`). Otherwise it springs back to rest on the standard
  drawer curve.
- **Dismissal:** the page animates out to `translateX(100%)`, then `onClose()`
  fires (the state unmount) — same play-exit-then-unmount pattern as `Dialog`.
- **Entrance:** drill-ins gain a matching slide-in from the right
  (`translateX(100%) → 0`, `var(--ease-drawer)`, 300ms enter / 240ms exit via
  `lib/motion.ts` constants). An interactive slide-out with an instant pop-in
  entrance would feel broken.
- **Reduced motion:** with `prefers-reduced-motion`, no finger tracking and no
  slides — a completed edge flick (distance/velocity rule on release) triggers
  `onClose()` immediately. Same convention as `Dialog`/`useSheetDrag`.
- **Sheets above drill-ins** (e.g. PeriodSheet inside Categorization): the Dialog
  overlay (z-50) covers the edge strip, so the gesture is naturally inert while
  a sheet is open. No special casing.
- **Multi-touch / cancellation:** second pointers are ignored while dragging;
  `pointercancel` springs back to rest.

## Architecture

Mirrors the existing vertical dismiss stack (`lib/sheetDrag.ts` →
`hooks/useSheetDrag.ts` → `Dialog`), rotated horizontal:

| Unit | Responsibility |
|---|---|
| `frontend/src/lib/edgeBack.ts` (new) | Pure geometry, framework-free: `EDGE_ZONE_PX = 24`, `BACK_COMMIT_FRACTION = 1/3`, `BACK_COMMIT_VELOCITY = 0.11`, `edgeBackOffset(dx)` (clamp < 0 to 0), `shouldGoBack(dx, elapsedMs, viewportWidth)`, `inEdgeZone(startX)`. Unit-tested without rendering. |
| `frontend/src/hooks/useEdgeBack.ts` (new) | Pointer wiring, modeled line-for-line on `useSheetDrag`: refs for start/dx/dragging, `setPointerCapture`, drives `panel.style.transform` directly, restores the transition curve on release, calls `onBack()` on commit. Takes `(panelRef, onBack, reduced)`; returns pointer handlers to spread on the **edge strip**. |
| `frontend/src/lib/motion.ts` (extend) | `pageTransition(reduced)` — `transform 300ms var(--ease-drawer)` (enter) and the exit reuses `SHEET_EXIT_MS`; reduced → `"none"`. |
| `frontend/src/screens/settings/SettingsPage.tsx` (modify) | The single wiring point: (1) an invisible edge-strip `<div>` (`absolute left-0 inset-y-0 w-6 z-10 touch-none`) carrying the `useEdgeBack` handlers — `touch-none` scoped to the strip keeps page scrolling intact everywhere else while letting horizontal pointermoves reach us; (2) slide-in on mount + slide-out-then-`onClose` on both the back arrow and the gesture, via the same double-rAF + timer pattern `Dialog` uses. `onClose` semantics for consumers are unchanged. |

No changes to any of the nine drill-in pages — they inherit everything from the
shell.

## Testing

- `lib/edgeBack.test.ts`: commit rule (distance commit, velocity commit, short
  slow drag rejects, leftward drag rejects), offset clamping, edge-zone check.
- `SettingsPage.test.tsx` (new): renders the shell, fires pointer
  down(x=10)/move/up sequences on the edge strip — asserts `onClose` called
  after a committing drag (via `waitFor`, exit animates first) and NOT called
  after a sub-threshold drag; asserts the back arrow still calls `onClose`.
- Existing suites must stay green — `CategoryManager.test.tsx` asserts the
  shell's root classes (`fixed`, `bg-bg`); the edge strip and animation must not
  disturb them.

## Risks / edge cases

- **jsdom pointer capture:** `setPointerCapture` is optional-chained in the
  existing hook precisely because jsdom lacks it; the new hook keeps that.
- **Vertical scroll conflict:** the strip is only 24px wide; vertical scrolling
  initiated inside it is sacrificed (iOS makes the same trade). Everywhere else
  scrolling is untouched.
- **Exit-timer leak:** clearing the play-exit timer on unmount, same as Dialog.

## Success criteria

On an iPhone (installed PWA): opening any settings drill-in slides it in from
the right; dragging from the left edge tracks the finger and reveals the hub;
releasing past a third of the screen (or flicking) pops the page; a hesitant
partial drag springs back; all 9 drill-ins behave identically; full frontend
suite green.
