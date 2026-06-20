# Scope-aware Review (swipe) screen — Design

**Date:** 2026-06-20
**Status:** Approved (pending written-spec review)

## Goal

Make the "Swipe to Categorize" feature obey the app-wide time scope set in the
TopBar (month, custom range, or all-time), exactly like every other screen.
The user can navigate months and set custom ranges from the TopBar, and the
swipe deck and its count badge reflect that scope.

## Background / current state

- A global `Scope` (`{kind:"month"} | {kind:"range"} | {kind:"all"}`) lives in
  `AppShell` (`frontend/src/app/AppShell.tsx`) and already drives Home,
  Transactions, Insights, and Settings via `scopeBounds()` / `scopeAnchor()`
  (`frontend/src/lib/scope.ts`).
- The `TopBar` (`frontend/src/components/ui/TopBar.tsx`) already provides month
  prev/next navigation and a custom-range / all-time picker (`PeriodSheet`).
- **The swipe feature is the only screen that ignores scope.** `ReviewSwipe`
  (`frontend/src/screens/ReviewSwipe.tsx`) renders as a **fullscreen overlay**
  (covering the TopBar), with its own header + back-arrow, and fetches
  `GET /api/review` → `store.SelectNeedsReview()` (all `needs_review` txns, no
  date filter). It is launched as a transient mode from the Transactions screen
  (`onOpenSwipeMode`) via `inSwipeMode` state in `AppShell`.
- The BottomNav review-count badge (`reviewCount`) is currently fetched from
  `GET /api/review` in `AppShell` and rendered on the **Transactions** tab.
- The backend already supports scoped review data with **no new endpoint**:
  `GET /api/transactions?status=needs_review&from=..&to=..` →
  `store.SelectTransactions(status, from, to)`
  (`internal/store/categories.go:226`). It returns the same `ReviewItem` shape
  the frontend already types as `Txn[]` (used by the Transactions screen).

## Decisions (from brainstorming)

1. **Keep the real TopBar visible** in swipe mode — convert the swipe feature
   from a fullscreen overlay into a normal screen rendered beneath the
   persistent TopBar, reusing the exact same scope control as the rest of the
   PWA.
2. **Promote Review to a first-class BottomNav tab** (not a transient overlay).
3. **Deck scoped, badge scoped** — both the swipe deck and the tab's count badge
   reflect the current scope (selected month/range/all). The badge changes as
   the user changes months.
4. **Keep the Transactions "swipe" button** as a shortcut that navigates to the
   Review tab (discoverability), rather than removing it.
5. **Remove the now-dead `/api/review` endpoint and `store.SelectNeedsReview()`**
   (plus their tests) after the frontend stops using them.

## Architecture

Scope stays the single source of truth in `AppShell`. The change wires the
swipe feature into that source and renders it as a routed screen:

```
TopBar scope change
  → AppShell scope state
  → scopeBounds(scope) → {from?, to?}
  → scoped query ['review', from, to] hits
      GET /api/transactions?status=needs_review&from&to
  → consumed by BOTH:
      • BottomNav badge (reviewCount = list length)
      • Review screen → SwipeDeck (keyed on scope so it remounts cleanly)
```

react-query dedupes the two consumers because they share the query key.
Categorizing a card POSTs exactly as today and calls
`invalidateQueries({ queryKey: ['review'] })`; in react-query v5 that is a
**prefix match**, so it invalidates the scoped `['review', from, to]` key.
`useLiveEvents` already invalidates `['review']` (prefix match) on SSE `tx`
events, so live updates keep working. `"All time"` scope yields no date bounds
→ every `needs_review` txn shows (today's behavior preserved).

## Component changes

### `frontend/src/app/nav.ts`
- Add `"review"` to the `TabId` union.
- Add a `review` tab to `TABS` (label `"Review"`, an inbox/check icon from
  lucide, e.g. `Inbox`). Order: place it between `transactions` and `insights`.

### `frontend/src/components/ui/BottomNav.tsx`
- Grid changes from `grid-cols-4` to `grid-cols-5`.
- The review-count badge logic moves from `t.id === "transactions"` to
  `t.id === "review"` (both the badge render and the `aria-label`).

### `frontend/src/app/AppShell.tsx`
- Add `review: "Review"` to `TITLES`.
- Remove `inSwipeMode` state and the `{inSwipeMode && <ReviewSwipe .../>}`
  overlay render.
- Replace the badge query:
  - From: `useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") })`
  - To: a scoped query keyed `["review", bounds.from ?? "", bounds.to ?? ""]`
    that builds `/api/transactions?status=needs_review&from&to` from
    `bounds` (mirrors the URL-building in `Transactions.tsx:39-46`).
  - `reviewCount = q.data?.length ?? 0`.
- Render `{tab === "review" && <ReviewScreen from={bounds.from} to={bounds.to} />}`
  inside `<main>` (under the TopBar). `showScope` stays `tab !== "settings"`
  (true for review).
- The Transactions screen's `onOpenSwipeMode` callback now does `setTab("review")`.

### `frontend/src/screens/ReviewSwipe.tsx` → Review screen
- Drop the overlay wrapper (`fixed inset-x-0 top-0 h-[100dvh] z-40 ...`) and its
  own header/back-arrow — the persistent TopBar now provides chrome. Render into
  the normal content flow (a flex column that fills the main area).
- Accept `from?: string` and `to?: string` props.
- Fetch the scoped needs-review list with the **same** query key
  `["review", from ?? "", to ?? ""]` and the same URL builder as the badge
  (deduped with AppShell's query).
- Pass a stable `key` to `<SwipeDeck>` derived from the scope bounds
  (e.g. `key={`${from ?? "all"}:${to ?? "all"}`}`) so changing month/range
  remounts the deck and re-freezes the new list (`SwipeDeck` freezes
  `transactions` at mount via `frozenTxns`, `SwipeDeck.tsx:85`).
- **Scope-aware empty state:** instead of the celebratory "Nothing to review 🎉"
  (which wrongly implies the user finished *everything*), show copy scoped to the
  period, e.g. heading "All caught up here" and body
  "Everything in {scopeLabel(scope)} is categorized." Empty months are now
  common, so the copy must not imply global completion.

### `frontend/src/screens/Transactions.tsx`
- No structural change beyond `onOpenSwipeMode` now meaning "go to Review tab".
  The existing button stays as a shortcut.

### Backend cleanup (after frontend no longer calls `/api/review`)
- `internal/server/server.go`: remove the
  `s.mux.HandleFunc("GET /api/review", s.handleGetReview)` registration.
- Delete `internal/server/review.go` (`handleGetReview`).
- Delete `internal/server/review_test.go`.
- `internal/store/categories.go`: remove `SelectNeedsReview()`.
- `internal/store/categories_test.go`: remove `TestSelectNeedsReview`.
- Do **not** touch `.claude/worktrees/` copies — those are separate worktrees
  owned by parallel sessions.

## Visual / frontend-design notes

The Review screen is now permanent UI under the app chrome, not a modal. During
implementation, apply `frontend-design` guidance to:
- The Review screen's relationship to the TopBar (the deck already renders its
  own "Remaining / X of Y sorted" header + progress bar — keep it; it now sits
  below the scope control rather than below a bespoke modal header).
- The scope-aware empty state (distinct from the end-of-deck "All caught up!"
  state, which counts a finished session).

## Testing

Frontend (vitest, jsdom — single non-parallel fork per `vite.config.ts`):
- `nav` / `BottomNav`: renders 5 tabs; review-count badge appears on the Review
  tab (not Transactions); `grid-cols-5`.
- `AppShell`: `tab === "review"` renders the Review screen under the TopBar
  (TopBar still in document, `showScope` true); badge query targets
  `/api/transactions?status=needs_review&...`; Transactions button navigates to
  the Review tab.
- Review screen: passes a scope-derived `key` to `SwipeDeck` so a scope change
  remounts it; renders the scope-aware empty state when the scoped list is empty.
- Badge reflects the scoped count (changes with scope).

Backend (go test):
- `store.SelectTransactions` date-filter behavior is already covered by
  `TestSelectTransactions` — that is the data path the deck now uses.
- Removing `/api/review` deletes `review_test.go` and `TestSelectNeedsReview`;
  confirm `go test ./...` still passes.

## Out of scope / non-goals

- No new backend endpoint.
- No change to the swipe gesture mechanics, `SwipeCard`, `SubcategoryPanel`, or
  `lib/swipe` config.
- No change to the `Scope` type, `PeriodSheet`, or TopBar controls themselves —
  they already support month nav and custom ranges.

## Edge cases

- **Scope change mid-deck:** remount resets the "X sorted this session" counter.
  Acceptable and expected — a new scope is a new sorting session.
- **`"All time"` scope:** no date bounds → all `needs_review` txns (today's set).
- **Empty month:** common now → scope-aware empty copy, not global-completion 🎉.
- **Last card in a month categorized:** deck shows end-of-session "All caught
  up!"; badge for that scope drops to 0 via invalidation.

## Definition of done

- Review is a BottomNav tab; the swipe deck and badge both respect the TopBar
  scope; month nav + custom range work from the TopBar while reviewing.
- Transactions "swipe" button navigates to the Review tab.
- `/api/review` + `SelectNeedsReview()` removed; `go test ./...` and
  `bun run test` green; embedded dist rebuilt before finishing.
