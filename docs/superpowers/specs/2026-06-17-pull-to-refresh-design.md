# Pull-to-Refresh — Design

**Date:** 2026-06-17
**Status:** Approved

## Goal

Add a mobile pull-to-refresh gesture to the PWA: pulling down from the top of
the scroll container refetches the current screen's data and shows a spinner.

## Background

`AppShell.tsx` renders a single shared scroll container — `<main className="flex-1
min-h-0 overflow-y-auto overscroll-contain">` — that wraps every tab's content.
Server cache is react-query (v5); `useLiveEvents` already invalidates a known set
of keys on SSE pushes. There is **no** pull-to-refresh library, and in a
standalone PWA the browser's native pull-to-refresh is unavailable — so this is a
custom gesture. The codebase favors zero extra deps and thin hooks with pure
logic in `lib/` (`useOnline`, `useLiveEvents`, `lib/transactions`).

## Decisions

- **Scope:** the gesture lives on the shared `<main>` container, so **all tabs**
  (Home, Transactions, Insights, Settings) respond. One hook in `AppShell`.
- **Refresh action:** `queryClient.invalidateQueries()` with no filter — refetches
  every active query (current screen + the review badge). Its returned promise
  resolves when refetching settles, which drives the spinner lifecycle.
- **No new dependency.** Custom `usePullToRefresh` hook + a `Loader2`
  (`lucide-react`) spinner indicator, matching existing patterns.
- **Engage only at the top.** Tracking begins on `touchstart` only when
  `el.scrollTop <= 0`; otherwise normal scrolling is untouched.
- **Rubber-band feel:** raw finger travel is damped (×0.5) and capped; the
  indicator's spinner fades/rotates with pull progress, then spins while
  refreshing.

## Components & data flow

- **`lib/pullToRefresh.ts`** (pure, unit-tested): `resist(rawDelta)` →
  damped+capped distance, `shouldTrigger(distance)` → past threshold?, plus
  `PULL_THRESHOLD` / `MAX_PULL` constants.
- **`components/PullToRefreshIndicator.tsx`**: presentational. Props
  `{ pullDistance, refreshing }`; renders a top overlay whose height follows the
  pull and a `Loader2` that spins while refreshing.
- **`hooks/usePullToRefresh.ts`**: attaches `touchstart/move/end/cancel` to a
  passed `RefObject<HTMLElement>`, owns `pullDistance`/`refreshing` state, calls
  an injected `onRefresh: () => Promise<unknown>`. Uses refs to avoid stale
  closures and `{ passive: false }` on `touchmove` so it can `preventDefault`
  the native scroll while pulling.
- **`app/AppShell.tsx`** (modify): add a `mainRef`, call
  `usePullToRefresh(mainRef, () => qc.invalidateQueries())`, mark `<main>`
  `relative`, and render `<PullToRefreshIndicator>` inside it.

## Testing

- `lib/pullToRefresh.test.ts`: `resist` (zero/negative → 0, damping, cap),
  `shouldTrigger` (boundary).
- `components/PullToRefreshIndicator.test.tsx`: spinner spins + height when
  refreshing; height follows `pullDistance`; hidden at rest.
- `hooks/usePullToRefresh.test.ts`: tracks a top-of-page pull; ignores pulls when
  not scrolled to top; fires `onRefresh` past threshold and clears `refreshing`
  after the promise resolves; ignores sub-threshold pulls.
- `app/AppShell.test.tsx` (extend): a full pull gesture on `<main>` triggers a
  data refetch.

## Out of scope (YAGNI)

- No per-screen customization of what refreshes.
- No content translate/parallax — the indicator overlays the top.
- No desktop/mouse drag support (touch only).
