# Scope-aware Review (swipe) screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Swipe to Categorize" feature obey the app-wide time scope set in the TopBar (month / custom range / all-time), as a first-class "Review" BottomNav tab.

**Architecture:** Convert the swipe feature from a fullscreen overlay (`ReviewSwipe`) into a normal `Review` screen rendered beneath the persistent `TopBar`, fed by the existing global `Scope`. Both the swipe deck and the BottomNav count badge read one scoped query (`['review', from, to]`) that hits `GET /api/transactions?status=needs_review&from&to` — no new backend endpoint. The now-dead `/api/review` endpoint and `store.SelectNeedsReview()` are removed.

**Tech Stack:** React 18 + TypeScript + Vite, TanStack Query, Tailwind v4, vitest/jsdom (frontend); Go stdlib `net/http`, SQLite via `store` (backend).

## Global Constraints

- Money is integer minor units (`int64` fils) — not touched here, but never introduce floats.
- Frontend tests run under a single non-parallel vitest fork (`fileParallelism: false`, `singleFork` in `vite.config.ts`). Do not change this.
- Frontend builds to `internal/web/dist/` which Go embeds; **rebuild the combined dist before finishing the branch** (`cd frontend && bun install && bun run build`).
- API client uses relative URLs (`/api/...`); reuse `getJSON`/`postJSON` from `frontend/src/api/client.ts`.
- react-query v5 `invalidateQueries({ queryKey: ['review'] })` is a **prefix match** — it invalidates `['review', from, to]`. `useLiveEvents` already invalidates `['review']`.
- Go: `CGO_ENABLED=0`. Run `go test ./...` for backend; `cd frontend && bun run test` for frontend.

## File Structure

- `frontend/src/screens/Review.tsx` (new) — scope-aware Review screen; fetches scoped needs-review list, renders `SwipeDeck` keyed on scope, scope-aware empty state. Replaces `screens/ReviewSwipe.tsx`.
- `frontend/src/screens/Review.test.tsx` (new) — unit tests for the Review screen.
- `frontend/src/app/nav.ts` (modify) — add `review` tab.
- `frontend/src/components/ui/BottomNav.tsx` (modify) — 5-column grid; badge on `review` tab.
- `frontend/src/components/ui/BottomNav.test.tsx` (new) — badge-placement tests.
- `frontend/src/app/AppShell.tsx` (modify) — render Review tab under TopBar; scoped badge query; remove overlay; Transactions button navigates to Review tab.
- `frontend/src/app/AppShell.test.tsx` (modify) — 5 tabs; Review tab navigation.
- `frontend/src/screens/ReviewSwipe.tsx` (delete in Task 2).
- `internal/server/server.go`, `internal/server/review.go`, `internal/server/review_test.go`, `internal/server/transactions_test.go`, `internal/store/categories.go`, `internal/store/categories_test.go` (modify/delete in Task 3) — remove dead `/api/review` path.

---

### Task 1: Scope-aware Review screen component

Creates the new `Review` screen as a standalone, fully-tested component. It is not wired into the app yet (Task 2 does that), so the old overlay keeps working and the suite stays green.

**Files:**
- Create: `frontend/src/screens/Review.tsx`
- Test: `frontend/src/screens/Review.test.tsx`

**Interfaces:**
- Consumes: `Scope`, `scopeBounds(scope)`, `scopeLabel(scope)` from `frontend/src/lib/scope.ts`; `SwipeDeck` from `frontend/src/components/swipe/SwipeDeck.tsx` (props `{ transactions: Txn[]; categories: Category[]; config?: SwipeConfig }`); `loadSwipeConfig` from `frontend/src/lib/swipe.ts`; `getJSON` from `frontend/src/api/client.ts`.
- Produces: `export function Review({ scope }: { scope: Scope }): JSX.Element`. Fetches with query key `["review", bounds.from ?? "", bounds.to ?? ""]` where `bounds = scopeBounds(scope)`. AppShell (Task 2) must use the **same** badge query key.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/screens/Review.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Review } from "./Review";
import type { Scope } from "../lib/scope";

// fetch mock: needs-review txns vary by the `from` query param so we can prove
// the deck re-renders for a different scope; categories return one entry.
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/categories")) {
        return new Response(JSON.stringify([{ ID: 1, Name: "Groceries", Kind: "expense", Bucket: "need", IsActive: true }]));
      }
      if (url.includes("/api/transactions")) {
        const txn = (merchant: string) => ({
          ID: merchant.length, PostedAt: "2026-06-10T00:00:00Z", AmountFils: 1000, Currency: "AED",
          Direction: "debit", MerchantRaw: merchant, Status: "needs_review", Confidence: 0, Source: "",
          CategoryID: null, CategoryName: "", Bucket: "",
        });
        if (url.includes("from=2026-06-01")) return new Response(JSON.stringify([txn("JUNE SHOP")]));
        if (url.includes("from=2026-05-01")) return new Response(JSON.stringify([txn("MAY SHOP")]));
        return new Response("[]"); // empty scope
      }
      return new Response("[]");
    }),
  );
}

function wrap(scope: Scope) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Review scope={scope} /></QueryClientProvider>);
}

beforeEach(() => stubFetch());

describe("Review screen", () => {
  it("queries scoped needs-review transactions", async () => {
    wrap({ kind: "month", period: "2026-06" });
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).includes("/api/transactions?status=needs_review&from=2026-06-01&to=2026-06-32"),
        ),
      ).toBe(true),
    );
  });

  it("shows a scope-aware empty state when nothing needs review", async () => {
    wrap({ kind: "month", period: "2026-03" }); // fetch returns [] for this month
    expect(await screen.findByText(/everything in mar 2026 is categorized/i)).toBeInTheDocument();
  });

  it("re-renders the deck when the scope changes", async () => {
    const { rerender } = wrap({ kind: "month", period: "2026-06" });
    expect(await screen.findByText("JUNE SHOP")).toBeInTheDocument();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(<QueryClientProvider client={qc}><Review scope={{ kind: "month", period: "2026-05" }} /></QueryClientProvider>);
    expect(await screen.findByText("MAY SHOP")).toBeInTheDocument();
    expect(screen.queryByText("JUNE SHOP")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/screens/Review.test.tsx`
Expected: FAIL — `Failed to resolve import "./Review"` (file does not exist yet).

- [ ] **Step 3: Implement the Review screen**

Create `frontend/src/screens/Review.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { getJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { SwipeDeck } from "../components/swipe/SwipeDeck";
import { loadSwipeConfig } from "../lib/swipe";
import { type Scope, scopeBounds, scopeLabel } from "../lib/scope";

export function Review({ scope }: { scope: Scope }) {
  const [config] = useState(loadSwipeConfig);
  const bounds = scopeBounds(scope);

  const txns = useQuery({
    queryKey: ["review", bounds.from ?? "", bounds.to ?? ""],
    queryFn: () => {
      const params = new URLSearchParams({ status: "needs_review" });
      if (bounds.from) params.set("from", bounds.from);
      if (bounds.to) params.set("to", bounds.to);
      return getJSON<Txn[]>(`/api/transactions?${params.toString()}`);
    },
  });
  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: () => getJSON<Category[]>("/api/categories"),
  });

  const loading = txns.isPending || cats.isPending;
  const empty = !loading && (txns.data?.length ?? 0) === 0;
  // Remount the deck when the scope changes: SwipeDeck freezes its transaction
  // list at mount, so a fresh scope needs a fresh mount to re-freeze.
  const deckKey = `${bounds.from ?? "all"}:${bounds.to ?? "all"}`;

  return (
    <div className="flex flex-col min-h-[60vh]">
      {loading && (
        <div className="flex-1 flex items-center justify-center py-16">
          <Loader2 size={36} className="animate-spin text-muted" />
        </div>
      )}

      {!loading && empty && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
          <p className="text-5xl">✅</p>
          <h2 className="text-xl font-bold text-fg">All caught up here</h2>
          <p className="text-muted">Everything in {scopeLabel(scope)} is categorized.</p>
        </div>
      )}

      {!loading && !empty && (
        <SwipeDeck key={deckKey} transactions={txns.data!} categories={cats.data!} config={config} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/screens/Review.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `cd frontend && bunx tsc --noEmit`
Expected: no errors.

```bash
git add frontend/src/screens/Review.tsx frontend/src/screens/Review.test.tsx
git commit -m "feat(frontend): scope-aware Review screen component"
```

---

### Task 2: Wire Review as a BottomNav tab under the persistent TopBar

Adds the `review` tab, moves the count badge onto it, renders the `Review` screen under the TopBar with the global scope, scopes the badge query, removes the old overlay, and points the Transactions "swipe" button at the Review tab. Deletes `ReviewSwipe.tsx`.

**Files:**
- Modify: `frontend/src/app/nav.ts`
- Modify: `frontend/src/components/ui/BottomNav.tsx`
- Create: `frontend/src/components/ui/BottomNav.test.tsx`
- Modify: `frontend/src/app/AppShell.tsx`
- Modify: `frontend/src/app/AppShell.test.tsx`
- Delete: `frontend/src/screens/ReviewSwipe.tsx`

**Interfaces:**
- Consumes: `Review` from `frontend/src/screens/Review.tsx` (`{ scope: Scope }`); the badge query key `["review", bounds.from ?? "", bounds.to ?? ""]` from Task 1; `scopeBounds`, `scopeAnchor` from `frontend/src/lib/scope.ts`.
- Produces: `TabId` now includes `"review"`; `TABS` includes a `review` entry; `BottomNav` renders the badge on the `review` tab.

- [ ] **Step 1: Write the failing BottomNav test**

Create `frontend/src/components/ui/BottomNav.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BottomNav } from "./BottomNav";

describe("BottomNav", () => {
  it("renders five tabs including Review", () => {
    render(<BottomNav active="home" reviewCount={0} onNavigate={() => {}} />);
    for (const name of [/home/i, /transactions/i, /review/i, /insights/i, /settings/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("shows the count badge on the Review tab, not Transactions", () => {
    render(<BottomNav active="home" reviewCount={3} onNavigate={() => {}} />);
    const review = screen.getByRole("button", { name: /review, 3 need review/i });
    expect(review).toHaveTextContent("3");
    const txns = screen.getByRole("button", { name: /^transactions$/i });
    expect(txns).not.toHaveTextContent("3");
  });

  it("fires onNavigate with the tab id", () => {
    const onNavigate = vi.fn();
    render(<BottomNav active="home" reviewCount={0} onNavigate={onNavigate} />);
    screen.getByRole("button", { name: /review/i }).click();
    expect(onNavigate).toHaveBeenCalledWith("review");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/ui/BottomNav.test.tsx`
Expected: FAIL — no `review` tab / badge not on Review (`Unable to find role="button" name /review/i`).

- [ ] **Step 3: Add the Review tab to nav.ts**

Edit `frontend/src/app/nav.ts` to:

```tsx
import { Home, ListOrdered, Inbox, PieChart, Settings, type LucideIcon } from "lucide-react";

export type TabId = "home" | "transactions" | "review" | "insights" | "settings";

export const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "transactions", label: "Transactions", icon: ListOrdered },
  { id: "review", label: "Review", icon: Inbox },
  { id: "insights", label: "Insights", icon: PieChart },
  { id: "settings", label: "Settings", icon: Settings },
];
```

- [ ] **Step 4: Update BottomNav.tsx (5-col grid, badge on Review)**

Edit `frontend/src/components/ui/BottomNav.tsx`:
- Change `grid-cols-4` to `grid-cols-5`.
- Replace both `t.id === "transactions"` occurrences with `t.id === "review"`.

Resulting file:

```tsx
import { TABS, type TabId } from "../../app/nav";

export function BottomNav({
  active, reviewCount, onNavigate,
}: { active: TabId; reviewCount: number; onNavigate: (id: TabId) => void }) {
  return (
    <nav className="shrink-0 bg-surface border-t border-border grid grid-cols-5 pb-[env(safe-area-inset-bottom)]">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            aria-label={t.id === "review" && reviewCount > 0 ? `Review, ${reviewCount} need review` : t.label}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onNavigate(t.id)}
            className={`min-h-14 flex flex-col items-center justify-center gap-0.5 text-xs ${isActive ? "text-accent" : "text-muted"}`}
          >
            <span className="relative">
              <Icon size={22} aria-hidden />
              {t.id === "review" && reviewCount > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-bad text-white text-[10px] leading-4 text-center">
                  {reviewCount}
                </span>
              )}
            </span>
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 5: Run the BottomNav test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/ui/BottomNav.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Update the AppShell test for the new tab + navigation**

Edit `frontend/src/app/AppShell.test.tsx`:

Replace the `"shows four tabs and starts on Home"` test with:

```tsx
  it("shows five tabs and starts on Home", async () => {
    wrap();
    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /transactions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /insights/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
  });
```

Add a new test after it:

```tsx
  it("opens the Review screen under the persistent TopBar", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    // TopBar renders the active screen's title as the page heading and keeps the scope control.
    expect(await screen.findByRole("heading", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\d{4}/ })).toBeInTheDocument(); // month label still present
  });
```

- [ ] **Step 7: Run the AppShell test to verify it fails**

Run: `cd frontend && bunx vitest run src/app/AppShell.test.tsx`
Expected: FAIL — clicking Review does not render a "Review" heading yet (AppShell still renders the overlay path).

- [ ] **Step 8: Wire AppShell — render Review tab, scope the badge, drop the overlay**

Edit `frontend/src/app/AppShell.tsx`:

1. Replace the import on line 18:
   - From: `import { ReviewSwipe } from "../screens/ReviewSwipe";`
   - To: `import { Review } from "../screens/Review";`
2. In `TITLES`, add `review: "Review",`.
3. Delete the `const [inSwipeMode, setInSwipeMode] = useState(false);` line.
4. Replace the badge query block:
   - From: `const review = useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") });`
   - To:
     ```tsx
     const review = useQuery({
       queryKey: ["review", bounds.from ?? "", bounds.to ?? ""],
       queryFn: () => {
         const params = new URLSearchParams({ status: "needs_review" });
         if (bounds.from) params.set("from", bounds.from);
         if (bounds.to) params.set("to", bounds.to);
         return getJSON<Txn[]>(`/api/transactions?${params.toString()}`);
       },
     });
     ```
   - Note: `bounds` is declared at `const bounds = scopeBounds(scope);`. Move the `const bounds = ...` / `const anchor = ...` lines **above** this query so `bounds` is in scope (they currently sit below the query at lines 43-44).
5. In the Transactions render, change `onOpenSwipeMode={() => setInSwipeMode(true)}` to `onOpenSwipeMode={() => setTab("review")}`.
6. Add the Review screen to the tab switch (after the Insights line):
   ```tsx
   {tab === "review" && <Review scope={scope} />}
   ```
7. Delete the overlay line at the bottom: `{inSwipeMode && <ReviewSwipe onClose={() => setInSwipeMode(false)} />}`.

The resulting body of `AppShell` (for reference) reads:

```tsx
  const qc = useQueryClient();
  const mainRef = useRef<HTMLElement>(null);
  const { pullDistance, refreshing } = usePullToRefresh(mainRef, () => qc.invalidateQueries());

  const bounds = scopeBounds(scope);
  const anchor = scopeAnchor(scope);

  const review = useQuery({
    queryKey: ["review", bounds.from ?? "", bounds.to ?? ""],
    queryFn: () => {
      const params = new URLSearchParams({ status: "needs_review" });
      if (bounds.from) params.set("from", bounds.from);
      if (bounds.to) params.set("to", bounds.to);
      return getJSON<Txn[]>(`/api/transactions?${params.toString()}`);
    },
  });
  const reviewCount = review.data?.length ?? 0;

  return (
    <div className="flex flex-col h-[100svh] overflow-hidden">
      <TopBar title={TITLES[tab]} scope={scope} onScopeChange={setScope} showScope={tab !== "settings"} />
      {!online && (
        <div role="status" className="shrink-0 bg-warn/15 text-warn text-sm text-center py-1">Offline — showing last loaded data</div>
      )}
      <main ref={mainRef} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />
        <div className="max-w-screen-sm w-full mx-auto px-4 py-4">
          {tab === "home" && <Home period={anchor} />}
          {tab === "transactions" && <Transactions from={bounds.from} to={bounds.to} onOpenSwipeMode={() => setTab("review")} />}
          {tab === "review" && <Review scope={scope} />}
          {tab === "insights" && <Insights scope={scope} />}
          {tab === "settings" && <Settings scope={scope} />}
        </div>
      </main>
      <BottomNav active={tab} reviewCount={reviewCount} onNavigate={setTab} />
    </div>
  );
```

- [ ] **Step 9: Delete the obsolete overlay screen**

```bash
git rm frontend/src/screens/ReviewSwipe.tsx
```

- [ ] **Step 10: Run the full frontend suite + typecheck**

Run: `cd frontend && bunx tsc --noEmit && bun run test`
Expected: PASS — all files green, no references to `ReviewSwipe` or `/api/review`.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/app/nav.ts frontend/src/components/ui/BottomNav.tsx frontend/src/components/ui/BottomNav.test.tsx frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx
git rm frontend/src/screens/ReviewSwipe.tsx
git commit -m "feat(frontend): Review tab under TopBar with scoped deck and badge"
```

---

### Task 3: Remove the dead `/api/review` endpoint and `SelectNeedsReview`

With the frontend no longer calling `/api/review`, remove the endpoint, its handler, the store method, and their tests. The shared `seedTestTransaction` helper and the two transaction-endpoint tests living in `review_test.go` are relocated to `transactions_test.go` so they survive.

**Files:**
- Modify: `internal/server/server.go:160` (remove route)
- Delete: `internal/server/review.go`
- Modify/Delete: `internal/server/review_test.go` (relocate helper + 2 tests, delete file)
- Modify: `internal/server/transactions_test.go` (receive relocated helper + tests)
- Modify: `internal/server/server.go:49` (remove from `CategoryStore` interface)
- Modify: `internal/store/categories.go:208-222` (remove `SelectNeedsReview`)
- Modify: `internal/store/categories_test.go` (remove `TestSelectNeedsReview`)

**Interfaces:**
- Consumes: nothing from earlier tasks (backend-only).
- Produces: no `/api/review` route, no `CategoryStore.SelectNeedsReview`, no `store.SelectNeedsReview`. `seedTestTransaction(t *testing.T, st *store.Store) int64` now lives in `internal/server/transactions_test.go`.

- [ ] **Step 1: Relocate the shared helper and transaction tests into transactions_test.go**

Append `seedTestTransaction`, `TestGetTransactions`, and `TestGetTransactionsStatusFilter` (verbatim from `review_test.go` lines 12-43, 65-82, 84-102) to the end of `internal/server/transactions_test.go`. Ensure `transactions_test.go` imports include `encoding/json`, `net/http`, `net/http/httptest`, `testing`, `time`, and `ledger/internal/store` (add any missing ones).

- [ ] **Step 2: Delete review.go and review_test.go**

```bash
git rm internal/server/review.go internal/server/review_test.go
```

- [ ] **Step 3: Remove the route and interface method in server.go**

Edit `internal/server/server.go`:
- Delete the line: `s.mux.HandleFunc("GET /api/review", s.handleGetReview)`
- In the `CategoryStore` interface, delete the line: `SelectNeedsReview() ([]store.ReviewItem, error)`

- [ ] **Step 4: Remove SelectNeedsReview from the store**

Edit `internal/store/categories.go` — delete the doc comment and method (lines 208-222):

```go
// SelectNeedsReview returns transactions with status='needs_review', newest first.
func (s *Store) SelectNeedsReview() ([]ReviewItem, error) {
	...
	return scanReviewItems(rows)
}
```

- [ ] **Step 5: Remove the store test**

Edit `internal/store/categories_test.go` — delete the entire `func TestSelectNeedsReview(t *testing.T) { ... }` (lines 214-242).

- [ ] **Step 6: Build and test the backend**

Run: `CGO_ENABLED=0 go build ./... && go test ./...`
Expected: PASS — no `undefined: SelectNeedsReview`, no `handleGetReview`, all packages green.

Note: `internal/config` `TestAIConfigEnabledRequiresAPIKey` may fail in this sandbox because `LEDGER_AI_API_KEY` is set in the environment — that is a known false failure, not caused by this change.

- [ ] **Step 7: Commit**

```bash
git add internal/server/server.go internal/server/transactions_test.go internal/store/categories.go internal/store/categories_test.go
git rm internal/server/review.go internal/server/review_test.go
git commit -m "refactor: remove dead /api/review endpoint and SelectNeedsReview"
```

---

### Task 4: Rebuild the embedded dist

The PWA bundle Go embeds must match the new frontend source before the branch is finished.

**Files:**
- Modify: `internal/web/dist/**` (generated)

- [ ] **Step 1: Rebuild the frontend bundle**

Run: `cd frontend && bun install && bun run build`
Expected: build succeeds, writes `internal/web/dist/`.

- [ ] **Step 2: Rebuild the binary to confirm the embed compiles**

Run: `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`
Expected: builds with no error.

- [ ] **Step 3: Commit the rebuilt dist**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for scope-aware Review"
```

---

## Self-Review

**Spec coverage:**
- "Keep the real TopBar visible" → Task 2 renders `Review` inside `<main>` under the persistent `TopBar` (Step 8); AppShell test asserts the heading + scope control (Step 6). ✓
- "Promote Review to a first-class tab" → Task 2 nav.ts + BottomNav (Steps 3-4). ✓
- "Deck scoped, badge scoped" → Task 1 scoped deck query; Task 2 scoped badge query, both keyed `["review", from, to]`. ✓
- "Keep Transactions button as shortcut → navigates to Review tab" → Task 2 Step 8 item 5. ✓
- "Remove /api/review + SelectNeedsReview" → Task 3. ✓
- "Scope-aware empty copy, not celebratory 🎉" → Task 1 empty state "Everything in {scopeLabel} is categorized." ✓
- "Remount deck on scope change (frozenTxns)" → Task 1 `key={deckKey}` + re-render test. ✓
- "All time → no bounds → all needs_review" → `scopeBounds({kind:"all"})` returns `{}`, query omits from/to. ✓
- "Rebuild embedded dist before finishing" → Task 4. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**Type consistency:** `Review({ scope }: { scope: Scope })` used identically in Task 1 and Task 2. Badge query key `["review", bounds.from ?? "", bounds.to ?? ""]` identical in Task 1 (Review) and Task 2 (AppShell) — required for react-query dedup. `TabId` includes `"review"` before AppShell references it. `seedTestTransaction(t, st)` signature unchanged when relocated. ✓
