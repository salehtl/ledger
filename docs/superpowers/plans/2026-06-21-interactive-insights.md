# Interactive Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Insights page interactive — tap a bucket, category, or merchant to see the transactions behind it (in a bottom sheet), add a merchant-spend breakdown, and add a month-scoped search/filter sheet.

**Architecture:** Approach A — the Insights screen fetches the focused month's transactions once and derives all analysis client-side in pure `lib/` functions. A two-field backend addition (`Kind`, `BucketSnapshot`) lets the client mirror the server's spending rule so drill-down totals reconcile with the headline. New UI reuses existing primitives: `Dialog` (the app's bottom-sheet chrome), `TransactionRow`, `FilterChips`, `applyTxnFilters`, and `monthRange`.

**Tech Stack:** Go 1.22 (stdlib, pure-Go SQLite, `CGO_ENABLED=0`); React 18 + TypeScript + Vite; TanStack Query; Tailwind v4; vitest/jsdom.

## Global Constraints

- Money is integer minor units (`int64` fils, AED × 100); amounts always positive; `direction` carries sign. Frontend never does float money math — use `formatFils`/`Money`.
- All analysis is **focused-month** scoped and **read-only** (no new persisted analytics).
- **Reconciliation rule (verbatim from `SelectCategorySpend`):** a transaction counts toward spending iff `status='confirmed' AND category.kind='spending' AND direction='debit'`, within the month; bucket = `freeze_history ? (bucket_snapshot || category.bucket) : category.bucket`. The client `spendingTxns`/`effectiveBucket` helpers must mirror this exactly.
- Pure decision logic lives in `frontend/src/lib/*.ts` with co-located `*.test.ts`; components stay thin.
- Frontend vitest is single-fork (`vite.config.ts`) — do not change it. Run one file with `bunx vitest run <path>`.
- Reuse existing primitives; do not introduce a new sheet primitive (`Dialog` already provides bottom-sheet chrome).
- Frontend must be rebuilt (`bun run build`) into `internal/web/dist/` before any deploy, but **this plan does not deploy** — building the bundle is out of scope for these tasks unless a task says otherwise.

## Reuse-driven deviations from the spec (intentional)

These were discovered reading the code; they preserve the approved behavior with less new code:
- Reuse `monthRange(period)` from `lib/transactions.ts` (returns `{from: "YYYY-MM-01", to: "YYYY-MM-32"}`, already handling the month-end timestamp boundary) instead of a new `monthBounds`.
- Reuse `applyTxnFilters` + `FilterChips` (bucket/category/direction/source) for the search sheet; add only a small `searchTxns` text helper. **Min-amount filter is dropped** (not in `FilterChips`).
- No `ui/Sheet` extraction — `Dialog` already is the shared bottom-sheet primitive (used by `CategorizeSheet`, `FilterChips`).
- Drill-down entry points are the **bucket rows** (ComparativeSummary), **category rows** (CategoryComparisonList), and **donut legend items** (DonutChart). The donut maps a slice's category name back to its id (Insights holds the `CategorySpend[]` that has ids); the folded **"Other" slice stays non-interactive**.
- Search/filter entry point is a button in the **Insights page body**, not the shared TopBar (avoids AppShell coupling; same UX).

---

## File Structure

- **Modify** `internal/store/categories.go` — add `Kind`, `BucketSnapshot` to `ReviewItem` + `SelectTransactions` SELECT + `scanReviewItems`.
- **Modify** `frontend/src/api/types.ts` — add `Kind`, `BucketSnapshot` to `Txn`.
- **Create** `frontend/src/lib/analysis.ts` (+ `analysis.test.ts`) — pure spending/breakdown/search helpers.
- **Create** `frontend/src/hooks/useTxnActions.ts` — shared transaction mutation logic (extracted from `Transactions.tsx`).
- **Modify** `frontend/src/screens/Transactions.tsx` — use `useTxnActions` (behavior-preserving) and `searchTxns`.
- **Create** `frontend/src/components/insights/DrillDownSheet.tsx` (+ test) — bottom sheet showing a target's breakdown + transactions.
- **Create** `frontend/src/components/insights/MerchantBreakdown.tsx` (+ test) — top-merchants card.
- **Create** `frontend/src/components/insights/SearchSheet.tsx` (+ test) — month-scoped search/filter sheet.
- **Modify** `frontend/src/components/insights/ComparativeSummary.tsx` + `frontend/src/components/insights/CategoryComparisonList.tsx` (+ their tests) — add optional `onSelect`.
- **Modify** `frontend/src/screens/Insights.tsx` (+ `Insights.test.tsx`) — fetch month txns, render new card, wire drill-down + search.

---

### Task 1: Backend — expose `Kind` and `BucketSnapshot` on transactions

**Files:**
- Modify: `internal/store/categories.go` (`ReviewItem` struct ~line 29; `SelectTransactions` query ~line 210; `scanReviewItems` ~line 245)
- Modify: `frontend/src/api/types.ts` (`Txn` interface)
- Test: `internal/store/categories_test.go`

**Interfaces:**
- Produces: `ReviewItem.Kind string` (from `c.kind`), `ReviewItem.BucketSnapshot string` (from `t.bucket_snapshot`). JSON keys `Kind`, `BucketSnapshot`. Frontend `Txn` gains `Kind: string; BucketSnapshot: string;`.

- [ ] **Step 1: Write the failing store test**

Add to `internal/store/categories_test.go`:

```go
func TestSelectTransactionsExposesKindAndSnapshot(t *testing.T) {
	st := testStore(t)
	catID := mustSeedSpendingCategory(t, st, "Dining", "want")
	// A confirmed debit in a category, with a frozen bucket snapshot.
	id := mustInsertTxn(t, st, store.TransactionRow{
		PostedAt: time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC),
		AmountFils: 5000, Currency: "AED", Direction: "debit",
		MerchantRaw: "Deliveroo", Status: "confirmed", CategoryID: catID,
	})
	if err := st.SetBucketSnapshot(id, "need"); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	rows, err := st.SelectTransactions("confirmed", "", "")
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	var got *store.ReviewItem
	for i := range rows {
		if rows[i].ID == id {
			got = &rows[i]
		}
	}
	if got == nil {
		t.Fatal("transaction not returned")
	}
	if got.Kind != "spending" {
		t.Errorf("Kind = %q, want %q", got.Kind, "spending")
	}
	if got.BucketSnapshot != "need" {
		t.Errorf("BucketSnapshot = %q, want %q", got.BucketSnapshot, "need")
	}
}
```

Before writing, check `internal/store/categories_test.go` for the existing helpers (`testStore`, and how other tests insert categories/transactions). If `mustSeedSpendingCategory`, `mustInsertTxn`, or `SetBucketSnapshot` do not already exist, implement the test using the helpers that DO exist (e.g. `st.InsertCategory`, `st.InsertTransaction`, and a direct `st.DB.Exec("UPDATE transactions SET bucket_snapshot=? WHERE id=?", "need", id)` to set the snapshot). The assertions on `got.Kind` and `got.BucketSnapshot` are the fixed part of this step.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/store/ -run TestSelectTransactionsExposesKindAndSnapshot`
Expected: FAIL — compile error `got.Kind undefined` / `got.BucketSnapshot undefined`.

- [ ] **Step 3: Add the fields and select them**

In `internal/store/categories.go`, add to the `ReviewItem` struct (after `Bucket`):

```go
	Kind           string // category kind: "spending" | "income" | "transfer" | "" (uncategorized)
	BucketSnapshot string // frozen bucket at categorization time; "" when unset
```

Update the `SelectTransactions` query's SELECT list to add the two columns (the `categories c` join already exists):

```go
	q := `SELECT t.id, t.posted_at, t.amount, t.currency, t.direction,
	             COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
	             t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,''),
	             COALESCE(c.kind,''), COALESCE(t.bucket_snapshot,'')
	      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
	      WHERE 1=1`
```

In `scanReviewItems`, add the two new scan targets at the end of the `rows.Scan(...)` call (after `&r.Bucket`):

```go
			&catID, &r.CategoryName, &r.Bucket,
			&r.Kind, &r.BucketSnapshot,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/store/ -run TestSelectTransactionsExposesKindAndSnapshot`
Expected: PASS.

- [ ] **Step 5: Run the full store + server suites (no regressions)**

Run: `go test ./internal/store/ ./internal/server/`
Expected: PASS. (`handleGetTransactions` encodes `ReviewItem` directly, so the new JSON fields appear automatically.)

- [ ] **Step 6: Add the fields to the frontend `Txn` type**

In `frontend/src/api/types.ts`, change the `Txn` interface to add the two fields:

```ts
export interface Txn {
  ID: number; PostedAt: string; AmountFils: number; Currency: string;
  Direction: string; MerchantRaw: string; Status: string; Confidence: number; Source: string;
  CategoryID: number | null; CategoryName: string; Bucket: string;
  Kind: string; BucketSnapshot: string;
}
```

- [ ] **Step 7: Typecheck the frontend**

Run: `cd frontend && bunx tsc --noEmit`
Expected: PASS (no new type errors from the added fields).

- [ ] **Step 8: Commit**

```bash
git add internal/store/categories.go internal/store/categories_test.go frontend/src/api/types.ts
git commit -m "feat(store): expose category kind + bucket snapshot on transactions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure analysis helpers — `lib/analysis.ts`

**Files:**
- Create: `frontend/src/lib/analysis.ts`
- Test: `frontend/src/lib/analysis.test.ts`

**Interfaces:**
- Consumes: `Txn` (with `Kind`, `BucketSnapshot` from Task 1); `monthRange` from `lib/transactions.ts`.
- Produces:
  - `isSpending(t: Txn): boolean`
  - `spendingTxns(txns: Txn[]): Txn[]`
  - `effectiveBucket(t: Txn, frozen: boolean): string`
  - `CategoryBreakdownRow { categoryId: number | null; name: string; bucket: string; spent: number; count: number; share: number }`
  - `BucketBreakdownRow { bucket: string; spent: number; share: number; categories: CategoryBreakdownRow[] }`
  - `bucketBreakdown(txns: Txn[], frozen: boolean): BucketBreakdownRow[]`
  - `MerchantRow { merchant: string; spent: number; count: number; share: number }`
  - `merchantBreakdown(txns: Txn[], topN?: number): MerchantRow[]`
  - `searchTxns(rows: Txn[], term: string): Txn[]`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/analysis.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Txn } from "../api/types";
import { isSpending, spendingTxns, effectiveBucket, bucketBreakdown, merchantBreakdown, searchTxns } from "./analysis";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "M", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 1, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "",
    ...p,
  };
}

describe("isSpending / spendingTxns", () => {
  it("keeps only confirmed spending debits", () => {
    const rows = [
      txn({ ID: 1 }),                                   // counts
      txn({ ID: 2, Status: "needs_review" }),           // not confirmed
      txn({ ID: 3, Direction: "credit" }),              // not a debit
      txn({ ID: 4, Kind: "income" }),                   // not spending
      txn({ ID: 5, Kind: "" }),                         // uncategorized
    ];
    expect(rows.filter(isSpending).map((t) => t.ID)).toEqual([1]);
    expect(spendingTxns(rows).map((t) => t.ID)).toEqual([1]);
  });
});

describe("effectiveBucket", () => {
  it("uses live bucket when not frozen", () => {
    expect(effectiveBucket(txn({ Bucket: "want", BucketSnapshot: "need" }), false)).toBe("want");
  });
  it("prefers snapshot when frozen and present", () => {
    expect(effectiveBucket(txn({ Bucket: "want", BucketSnapshot: "need" }), true)).toBe("need");
  });
  it("falls back to live bucket when frozen but snapshot empty", () => {
    expect(effectiveBucket(txn({ Bucket: "want", BucketSnapshot: "" }), true)).toBe("want");
  });
});

describe("bucketBreakdown", () => {
  it("groups spending by bucket then category with shares, reconciling per category", () => {
    const rows = [
      txn({ ID: 1, AmountFils: 600, CategoryID: 10, CategoryName: "Dining", Bucket: "want" }),
      txn({ ID: 2, AmountFils: 400, CategoryID: 10, CategoryName: "Dining", Bucket: "want" }),
      txn({ ID: 3, AmountFils: 1000, CategoryID: 11, CategoryName: "Rent", Bucket: "need" }),
      txn({ ID: 4, AmountFils: 999, Status: "needs_review", CategoryID: 10, Bucket: "want" }), // excluded
    ];
    const out = bucketBreakdown(rows, false);
    // need (1000) sorts before want (1000)? tie -> sorted by spent desc; both 1000.
    const want = out.find((b) => b.bucket === "want")!;
    const need = out.find((b) => b.bucket === "need")!;
    expect(want.spent).toBe(1000);
    expect(need.spent).toBe(1000);
    const dining = want.categories.find((c) => c.categoryId === 10)!;
    expect(dining.spent).toBe(1000);   // reconciles: 600 + 400, excludes the needs_review 999
    expect(dining.count).toBe(2);
    expect(want.share).toBeCloseTo(0.5, 5); // 1000 / 2000 total
  });
});

describe("merchantBreakdown", () => {
  it("groups by merchant, sorts desc, folds Other when topN given", () => {
    const rows = [
      txn({ ID: 1, MerchantRaw: "Deliveroo", AmountFils: 300 }),
      txn({ ID: 2, MerchantRaw: "Deliveroo", AmountFils: 200 }),
      txn({ ID: 3, MerchantRaw: "Noon", AmountFils: 400 }),
      txn({ ID: 4, MerchantRaw: "Talabat", AmountFils: 100 }),
    ];
    const all = merchantBreakdown(rows);
    expect(all.map((m) => [m.merchant, m.spent, m.count])).toEqual([
      ["Deliveroo", 500, 2], ["Noon", 400, 1], ["Talabat", 100, 1],
    ]);
    expect(all[0].share).toBeCloseTo(0.5, 5); // 500 / 1000
    const top2 = merchantBreakdown(rows, 2);
    expect(top2.map((m) => m.merchant)).toEqual(["Deliveroo", "Noon", "Other"]);
    expect(top2[2].spent).toBe(100); // Talabat folded into Other
  });
});

describe("searchTxns", () => {
  it("matches merchant substring case-insensitively, empty term returns all", () => {
    const rows = [txn({ ID: 1, MerchantRaw: "Deliveroo DMCC" }), txn({ ID: 2, MerchantRaw: "Noon" })];
    expect(searchTxns(rows, "deliv").map((t) => t.ID)).toEqual([1]);
    expect(searchTxns(rows, "  ").map((t) => t.ID)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && bunx vitest run src/lib/analysis.test.ts`
Expected: FAIL — cannot resolve `./analysis`.

- [ ] **Step 3: Implement `lib/analysis.ts`**

Create `frontend/src/lib/analysis.ts`:

```ts
import type { Txn } from "../api/types";

/** A transaction counts toward spending iff it mirrors SelectCategorySpend:
 *  confirmed, debit, and in a spending-kind category. */
export function isSpending(t: Txn): boolean {
  return t.Status === "confirmed" && t.Direction === "debit" && t.Kind === "spending";
}

export function spendingTxns(txns: Txn[]): Txn[] {
  return txns.filter(isSpending);
}

/** The bucket a spending txn belongs to: the frozen snapshot when freeze_history
 *  is on and present, otherwise the category's live bucket. */
export function effectiveBucket(t: Txn, frozen: boolean): string {
  return frozen && t.BucketSnapshot ? t.BucketSnapshot : t.Bucket;
}

export interface CategoryBreakdownRow {
  categoryId: number | null;
  name: string;
  bucket: string;
  spent: number;
  count: number;
  share: number;
}

export interface BucketBreakdownRow {
  bucket: string;
  spent: number;
  share: number;
  categories: CategoryBreakdownRow[];
}

/** Group spending transactions by effective bucket, then by category.
 *  Shares are fractions of the total spending in the input. */
export function bucketBreakdown(txns: Txn[], frozen: boolean): BucketBreakdownRow[] {
  const spending = spendingTxns(txns);
  const total = spending.reduce((s, t) => s + t.AmountFils, 0);

  const buckets = new Map<string, { spent: number; cats: Map<string, CategoryBreakdownRow> }>();
  for (const t of spending) {
    const bucket = effectiveBucket(t, frozen);
    const b = buckets.get(bucket) ?? { spent: 0, cats: new Map() };
    b.spent += t.AmountFils;
    const key = t.CategoryID === null ? "uncategorized" : String(t.CategoryID);
    const c = b.cats.get(key) ?? { categoryId: t.CategoryID, name: t.CategoryName || "Uncategorized", bucket, spent: 0, count: 0, share: 0 };
    c.spent += t.AmountFils;
    c.count += 1;
    b.cats.set(key, c);
    buckets.set(bucket, b);
  }

  const out: BucketBreakdownRow[] = [];
  for (const [bucket, b] of buckets) {
    const categories = [...b.cats.values()]
      .map((c) => ({ ...c, share: total > 0 ? c.spent / total : 0 }))
      .sort((a, c) => c.spent - a.spent);
    out.push({ bucket, spent: b.spent, share: total > 0 ? b.spent / total : 0, categories });
  }
  return out.sort((a, c) => c.spent - a.spent);
}

export interface MerchantRow {
  merchant: string;
  spent: number;
  count: number;
  share: number;
}

/** Spending grouped by merchant_raw, sorted by spend desc. When topN is given
 *  and there are more merchants, the remainder is folded into an "Other" row. */
export function merchantBreakdown(txns: Txn[], topN?: number): MerchantRow[] {
  const spending = spendingTxns(txns);
  const total = spending.reduce((s, t) => s + t.AmountFils, 0);
  const byMerchant = new Map<string, { spent: number; count: number }>();
  for (const t of spending) {
    const name = t.MerchantRaw || "—";
    const m = byMerchant.get(name) ?? { spent: 0, count: 0 };
    m.spent += t.AmountFils;
    m.count += 1;
    byMerchant.set(name, m);
  }
  const rows = [...byMerchant.entries()]
    .map(([merchant, m]) => ({ merchant, spent: m.spent, count: m.count, share: total > 0 ? m.spent / total : 0 }))
    .sort((a, b) => b.spent - a.spent);

  if (topN === undefined || rows.length <= topN) return rows;
  const head = rows.slice(0, topN);
  const rest = rows.slice(topN);
  const restSpent = rest.reduce((s, r) => s + r.spent, 0);
  const restCount = rest.reduce((s, r) => s + r.count, 0);
  head.push({ merchant: "Other", spent: restSpent, count: restCount, share: total > 0 ? restSpent / total : 0 });
  return head;
}

/** Case-insensitive merchant substring filter. Empty/blank term returns all. */
export function searchTxns(rows: Txn[], term: string): Txn[] {
  const q = term.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((t) => (t.MerchantRaw || "").toLowerCase().includes(q));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && bunx vitest run src/lib/analysis.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/analysis.ts frontend/src/lib/analysis.test.ts
git commit -m "feat(insights): pure spending/bucket/merchant breakdown helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Extract shared transaction actions — `useTxnActions`

**Files:**
- Create: `frontend/src/hooks/useTxnActions.ts`
- Modify: `frontend/src/screens/Transactions.tsx` (replace inline mutation handlers; use `searchTxns`)
- Test: `frontend/src/screens/Transactions.test.tsx` (existing — must still pass)

**Interfaces:**
- Consumes: `useQueryClient`, `useToast`, `postJSON`, `searchTxns` (Task 2).
- Produces: `useTxnActions(): { invalidate(): void; setStatus(t: Txn, status: string): Promise<void>; archiveTxn(t: Txn): Promise<void>; restoreTxn(t: Txn): Promise<void>; categorize(t: Txn, body: { category_id: number; make_rule: boolean }): Promise<boolean> }`. `categorize` resolves `true` on success (caller closes its own sheet), `false` on failure.

- [ ] **Step 1: Create the hook**

Create `frontend/src/hooks/useTxnActions.ts` — move the mutation logic out of `Transactions.tsx` verbatim (same endpoints, toasts, undo, and invalidation keys):

```ts
import { useQueryClient } from "@tanstack/react-query";
import { postJSON } from "../api/client";
import type { Txn } from "../api/types";
import { useToast } from "../components/Toast";

/** Shared transaction mutations (status, archive, restore, categorize) with
 *  toasts, undo, and query invalidation. Used by the Transactions screen and
 *  the Insights drill-down/search sheets. */
export function useTxnActions() {
  const qc = useQueryClient();
  const { show } = useToast();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
    qc.invalidateQueries({ queryKey: ["review"] });
    qc.invalidateQueries({ queryKey: ["insights-categories"] });
    qc.invalidateQueries({ queryKey: ["insights-trend"] });
  };

  const setStatus = async (t: Txn, newStatus: string) => {
    const name = t.MerchantRaw || "transaction";
    const verb = newStatus === "ignored" ? "Ignored" : newStatus === "transfer" ? "Marked transfer" : "Updated";
    try {
      await postJSON(`/api/transactions/${t.ID}/status`, { status: newStatus });
      invalidate();
      show({ message: `${verb} ${name}`, action: { label: "Undo", onAction: () => { void postJSON(`/api/transactions/${t.ID}/status`, { status: "needs_review" }).then(invalidate).catch(() => show({ message: `Couldn't undo`, tone: "error" })); } } });
    } catch { show({ message: `Couldn't update ${name}`, tone: "error" }); }
  };

  const archiveTxn = async (t: Txn) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/archive`, {});
      invalidate();
      show({ message: `Archived ${name}`, action: { label: "Undo", onAction: () => { void postJSON(`/api/transactions/${t.ID}/restore`, {}).then(invalidate).catch(() => show({ message: `Couldn't undo`, tone: "error" })); } } });
    } catch { show({ message: `Couldn't archive ${name}`, tone: "error" }); }
  };

  const restoreTxn = async (t: Txn) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/restore`, {});
      invalidate();
      show({ message: `Restored ${name}` });
    } catch { show({ message: `Couldn't restore ${name}`, tone: "error" }); }
  };

  const categorize = async (t: Txn, body: { category_id: number; make_rule: boolean }): Promise<boolean> => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/categorize`, { ...body, merchant_raw: t.MerchantRaw });
      invalidate();
      show({ message: `Categorized ${name}`, tone: "success" });
      return true;
    } catch { show({ message: `Couldn't categorize ${name}`, tone: "error" }); return false; }
  };

  return { invalidate, setStatus, archiveTxn, restoreTxn, categorize };
}
```

- [ ] **Step 2: Refactor `Transactions.tsx` to use the hook**

In `frontend/src/screens/Transactions.tsx`:
1. Add import: `import { useTxnActions } from "../hooks/useTxnActions";` and `import { searchTxns } from "../lib/analysis";`
2. Remove the local `invalidate`, `setStatus`, `archiveTxn`, `restoreTxn`, and the categorize POST/invalidate/toast body. Replace with:

```ts
  const { invalidate, setStatus, archiveTxn, restoreTxn, categorize } = useTxnActions();
```

3. Keep `createTxn` local (it manages `setAddOpen`) but have it call `invalidate()` from the hook (already destructured).
4. Replace the categorize handler passed to `CategorizeSheet` with one that closes the sheet on success:

```ts
        <CategorizeSheet
          txn={active}
          categories={cats.data}
          onSubmit={async (body) => { if (await categorize(active, body)) setActive(null); }}
          onClose={() => setActive(null)}
        />
```

5. Replace the inline search filter with `searchTxns`:

```ts
  const rows = useMemo(() => {
    const filtered = applyTxnFilters(q.data ?? [], filters);
    return searchTxns(filtered, search);
  }, [q.data, search, filters]);
```

(`useToast`, `useQueryClient`, and the `postJSON` import in `Transactions.tsx` may become unused after removing the handlers — delete any now-unused imports so `tsc` stays clean. `useQuery`, `getJSON`, `postJSON` for `createTxn` are still used; verify before deleting.)

- [ ] **Step 3: Run the existing Transactions tests**

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: PASS — behavior is unchanged (same endpoints, toasts, filtering, undo).

- [ ] **Step 4: Typecheck**

Run: `cd frontend && bunx tsc --noEmit`
Expected: PASS (no unused imports, no type errors).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useTxnActions.ts frontend/src/screens/Transactions.tsx
git commit -m "refactor(txn): extract useTxnActions hook for reuse in Insights

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `DrillDownSheet` component

**Files:**
- Create: `frontend/src/components/insights/DrillDownSheet.tsx`
- Test: `frontend/src/components/insights/DrillDownSheet.test.tsx`

**Interfaces:**
- Consumes: `Dialog`; `TransactionRow`; `useTxnActions` (Task 3); `bucketBreakdown`, `effectiveBucket`, `spendingTxns`, `isSpending` (Task 2); `Money`, `EmptyState`, `formatFils`, `BUCKET_LABEL`.
- Produces: `DrillTarget = { type: "bucket"; bucket: string } | { type: "category"; categoryId: number | null; name: string } | { type: "merchant"; merchant: string }` and `DrillDownSheet({ target, txns, frozen, categories, onClose }: { target: DrillTarget; txns: Txn[]; frozen: boolean; categories: Category[]; onClose: () => void })`. Exports `DrillTarget`. Tasks 5 & 8 construct `DrillTarget` values.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/insights/DrillDownSheet.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Txn } from "../../api/types";
import { ToastProvider } from "../../components/Toast";
import { DrillDownSheet, type DrillTarget } from "./DrillDownSheet";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Deliveroo", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 10, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "",
    ...p,
  };
}

function renderSheet(target: DrillTarget, txns: Txn[]) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DrillDownSheet target={target} txns={txns} frozen={false} categories={[]} onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("DrillDownSheet", () => {
  const rows = [
    txn({ ID: 1, CategoryID: 10, CategoryName: "Dining", Bucket: "want", AmountFils: 600, MerchantRaw: "Deliveroo" }),
    txn({ ID: 2, CategoryID: 11, CategoryName: "Shopping", Bucket: "want", AmountFils: 400, MerchantRaw: "Noon" }),
    txn({ ID: 3, CategoryID: 12, CategoryName: "Rent", Bucket: "need", AmountFils: 1000, MerchantRaw: "Landlord" }),
  ];

  it("bucket target lists its categories and transactions, and narrows to a category", () => {
    renderSheet({ type: "bucket", bucket: "want" }, rows);
    // categories in the bucket
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.getByText("Shopping")).toBeInTheDocument();
    // want-bucket transactions shown, need-bucket excluded
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    expect(screen.queryByText("Landlord")).not.toBeInTheDocument();
    // narrow to Dining
    fireEvent.click(screen.getByRole("button", { name: /drill into Dining/i }));
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    expect(screen.queryByText("Noon")).not.toBeInTheDocument();
    // back returns to the bucket view
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText("Shopping")).toBeInTheDocument();
  });

  it("merchant target lists only that merchant's transactions", () => {
    renderSheet({ type: "merchant", merchant: "Deliveroo" }, rows);
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    expect(screen.queryByText("Noon")).not.toBeInTheDocument();
  });
});
```

Before implementing, confirm the `ToastProvider` export name in `frontend/src/components/Toast.tsx` (the test imports it); if it differs, match the real export. `useTxnActions` requires a `QueryClientProvider` and the toast context — both are provided in `renderSheet`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/insights/DrillDownSheet.test.tsx`
Expected: FAIL — cannot resolve `./DrillDownSheet`.

- [ ] **Step 3: Implement `DrillDownSheet.tsx`**

Create `frontend/src/components/insights/DrillDownSheet.tsx`:

```tsx
import { useState } from "react";
import type { Category, Txn } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { Money } from "../Money";
import { EmptyState } from "../EmptyState";
import { TransactionRow } from "../transactions/TransactionRow";
import { CategorizeSheet } from "../transactions/CategorizeSheet";
import { useTxnActions } from "../../hooks/useTxnActions";
import { bucketBreakdown, effectiveBucket, isSpending } from "../../lib/analysis";
import { BUCKET_LABEL } from "../../lib/insights";

export type DrillTarget =
  | { type: "bucket"; bucket: string }
  | { type: "category"; categoryId: number | null; name: string }
  | { type: "merchant"; merchant: string };

export function DrillDownSheet({ target, txns, frozen, categories, onClose }: {
  target: DrillTarget;
  txns: Txn[];
  frozen: boolean;
  categories: Category[];
  onClose: () => void;
}) {
  // Within a bucket sheet, the user can narrow to one category (nested drill).
  const [narrowed, setNarrowed] = useState<{ categoryId: number | null; name: string } | null>(null);
  const { setStatus, archiveTxn, restoreTxn, categorize } = useTxnActions();
  const [active, setActive] = useState<Txn | null>(null);

  const spending = txns.filter(isSpending);

  // Resolve the active view (target, or the narrowed category inside a bucket).
  let title: string;
  let rows: Txn[];
  let subRows: { categoryId: number | null; name: string; spent: number; count: number }[] = [];

  if (target.type === "bucket" && !narrowed) {
    title = BUCKET_LABEL[target.bucket] ?? target.bucket;
    const bucket = bucketBreakdown(txns, frozen).find((b) => b.bucket === target.bucket);
    subRows = (bucket?.categories ?? []).map((c) => ({ categoryId: c.categoryId, name: c.name, spent: c.spent, count: c.count }));
    rows = spending.filter((t) => effectiveBucket(t, frozen) === target.bucket);
  } else if (target.type === "bucket" && narrowed) {
    title = narrowed.name;
    rows = spending.filter((t) => effectiveBucket(t, frozen) === target.bucket && t.CategoryID === narrowed.categoryId);
  } else if (target.type === "category") {
    title = target.name;
    rows = spending.filter((t) => t.CategoryID === target.categoryId);
  } else {
    title = target.merchant;
    rows = spending.filter((t) => (t.MerchantRaw || "—") === target.merchant);
  }

  const total = rows.reduce((s, t) => s + t.AmountFils, 0);

  return (
    <Dialog title={title} onClose={onClose}>
      {target.type === "bucket" && narrowed && (
        <button aria-label="Back" className="text-sm text-accent mb-2" onClick={() => setNarrowed(null)}>← Back</button>
      )}
      <p className="text-sm text-muted mb-3">{rows.length} transaction{rows.length === 1 ? "" : "s"} · <span className="tnum"><Money fils={-total} /></span></p>

      {subRows.length > 0 && (
        <ul className="mb-3 divide-y divide-border">
          {subRows.map((c) => (
            <li key={c.categoryId ?? "uncat"}>
              <button
                aria-label={`Drill into ${c.name}`}
                className="w-full flex items-center justify-between gap-3 py-2 text-left"
                onClick={() => setNarrowed({ categoryId: c.categoryId, name: c.name })}
              >
                <span className="truncate">{c.name}</span>
                <span className="tnum text-muted"><Money fils={c.spent} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No transactions" />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((t) => (
            <li key={t.ID}>
              <TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} onArchive={archiveTxn} onRestore={restoreTxn} />
            </li>
          ))}
        </ul>
      )}

      {active && (
        <CategorizeSheet
          txn={active}
          categories={categories}
          onSubmit={async (body) => { if (await categorize(active, body)) setActive(null); }}
          onClose={() => setActive(null)}
        />
      )}
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/insights/DrillDownSheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/insights/DrillDownSheet.tsx frontend/src/components/insights/DrillDownSheet.test.tsx
git commit -m "feat(insights): DrillDownSheet for bucket/category/merchant transactions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `MerchantBreakdown` card

**Files:**
- Create: `frontend/src/components/insights/MerchantBreakdown.tsx`
- Test: `frontend/src/components/insights/MerchantBreakdown.test.tsx`

**Interfaces:**
- Consumes: `merchantBreakdown` (Task 2); `Card`, `Money`, `EmptyState`, `withShare`-style share (already in `MerchantRow.share`).
- Produces: `MerchantBreakdown({ txns, onSelect }: { txns: Txn[]; onSelect: (merchant: string) => void })`. Renders top-8 merchants (+ "Other"); each non-"Other" row calls `onSelect(merchant)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/insights/MerchantBreakdown.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Txn } from "../../api/types";
import { MerchantBreakdown } from "./MerchantBreakdown";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Deliveroo", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 10, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "",
    ...p,
  };
}

describe("MerchantBreakdown", () => {
  it("lists merchants by spend and fires onSelect on tap", () => {
    const onSelect = vi.fn();
    render(<MerchantBreakdown txns={[
      txn({ ID: 1, MerchantRaw: "Deliveroo", AmountFils: 600 }),
      txn({ ID: 2, MerchantRaw: "Noon", AmountFils: 400 }),
    ]} onSelect={onSelect} />);
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Deliveroo/ }));
    expect(onSelect).toHaveBeenCalledWith("Deliveroo");
  });

  it("shows an empty state when there is no spending", () => {
    render(<MerchantBreakdown txns={[]} onSelect={() => {}} />);
    expect(screen.getByText(/no spending/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/insights/MerchantBreakdown.test.tsx`
Expected: FAIL — cannot resolve `./MerchantBreakdown`.

- [ ] **Step 3: Implement `MerchantBreakdown.tsx`**

Create `frontend/src/components/insights/MerchantBreakdown.tsx`:

```tsx
import type { Txn } from "../../api/types";
import { Card } from "../ui/Card";
import { Money } from "../Money";
import { EmptyState } from "../EmptyState";
import { merchantBreakdown } from "../../lib/analysis";

export function MerchantBreakdown({ txns, onSelect }: { txns: Txn[]; onSelect: (merchant: string) => void }) {
  const rows = merchantBreakdown(txns, 8);
  return (
    <Card className="!p-0">
      <p className="text-sm font-medium px-4 pt-4">Top merchants</p>
      {rows.length === 0 ? (
        <EmptyState title="No spending this month" />
      ) : (
        <ul className="divide-y divide-border px-4 pb-2">
          {rows.map((m) => {
            const isOther = m.merchant === "Other";
            const content = (
              <span className="flex items-center justify-between gap-3 w-full">
                <span className="truncate">{m.merchant}</span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-muted tnum">{Math.round(m.share * 100)}%</span>
                  <span className="tnum font-medium"><Money fils={m.spent} /></span>
                </span>
              </span>
            );
            return (
              <li key={m.merchant} className="py-2.5">
                {isOther ? (
                  <div className="flex text-muted">{content}</div>
                ) : (
                  <button aria-label={`Drill into ${m.merchant}`} className="w-full text-left" onClick={() => onSelect(m.merchant)}>
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/insights/MerchantBreakdown.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/insights/MerchantBreakdown.tsx frontend/src/components/insights/MerchantBreakdown.test.tsx
git commit -m "feat(insights): top-merchants breakdown card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `SearchSheet` component

**Files:**
- Create: `frontend/src/components/insights/SearchSheet.tsx`
- Test: `frontend/src/components/insights/SearchSheet.test.tsx`

**Interfaces:**
- Consumes: `Dialog`, `FilterChips`, `TransactionRow`, `CategorizeSheet`; `applyTxnFilters`, `EMPTY_FILTERS`, `TxnFilters` (`lib/transactions`); `searchTxns` (Task 2); `useTxnActions` (Task 3).
- Produces: `SearchSheet({ txns, categories, onClose }: { txns: Txn[]; categories: Category[]; onClose: () => void })`. Self-contained search input + filter chips + live results list over the given month txns.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/insights/SearchSheet.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Txn } from "../../api/types";
import { ToastProvider } from "../../components/Toast";
import { SearchSheet } from "./SearchSheet";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Deliveroo", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 10, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "",
    ...p,
  };
}

describe("SearchSheet", () => {
  it("filters the list by merchant text", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <SearchSheet
            txns={[txn({ ID: 1, MerchantRaw: "Deliveroo" }), txn({ ID: 2, MerchantRaw: "Noon" })]}
            categories={[]}
            onClose={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    expect(screen.getByText("Noon")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/search merchant/i), { target: { value: "deliv" } });
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    expect(screen.queryByText("Noon")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/insights/SearchSheet.test.tsx`
Expected: FAIL — cannot resolve `./SearchSheet`.

- [ ] **Step 3: Implement `SearchSheet.tsx`**

Create `frontend/src/components/insights/SearchSheet.tsx`:

```tsx
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Category, Txn } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../EmptyState";
import { FilterChips } from "../transactions/FilterChips";
import { TransactionRow } from "../transactions/TransactionRow";
import { CategorizeSheet } from "../transactions/CategorizeSheet";
import { useTxnActions } from "../../hooks/useTxnActions";
import { applyTxnFilters, EMPTY_FILTERS, type TxnFilters } from "../../lib/transactions";
import { searchTxns } from "../../lib/analysis";

export function SearchSheet({ txns, categories, onClose }: {
  txns: Txn[];
  categories: Category[];
  onClose: () => void;
}) {
  const [term, setTerm] = useState("");
  const [filters, setFilters] = useState<TxnFilters>(EMPTY_FILTERS);
  const [active, setActive] = useState<Txn | null>(null);
  const { setStatus, archiveTxn, restoreTxn, categorize } = useTxnActions();

  const rows = useMemo(() => searchTxns(applyTxnFilters(txns, filters), term), [txns, filters, term]);

  return (
    <Dialog title="Search & filter" onClose={onClose}>
      <div className="relative mb-3">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
        <input
          type="search"
          placeholder="Search merchant…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          className="w-full pl-9 pr-3 py-2 rounded-md border border-border bg-surface text-sm"
        />
      </div>
      <div className="mb-3">
        <FilterChips filters={filters} categories={categories} txns={txns} onChange={setFilters} />
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No transactions match" />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((t) => (
            <li key={t.ID}>
              <TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} onArchive={archiveTxn} onRestore={restoreTxn} />
            </li>
          ))}
        </ul>
      )}
      {active && (
        <CategorizeSheet
          txn={active}
          categories={categories}
          onSubmit={async (body) => { if (await categorize(active, body)) setActive(null); }}
          onClose={() => setActive(null)}
        />
      )}
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/insights/SearchSheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/insights/SearchSheet.tsx frontend/src/components/insights/SearchSheet.test.tsx
git commit -m "feat(insights): month-scoped search & filter sheet

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Make bucket rows, category rows, and donut legend tappable (`onSelect`)

**Files:**
- Modify: `frontend/src/components/insights/ComparativeSummary.tsx`
- Modify: `frontend/src/components/insights/CategoryComparisonList.tsx`
- Modify: `frontend/src/components/charts/DonutChart.tsx`
- Test: `frontend/src/components/insights/ComparativeSummary.test.tsx`, `frontend/src/components/insights/CategoryComparisonList.test.tsx`, `frontend/src/components/charts/DonutChart.test.tsx` (create if absent)

**Interfaces:**
- Produces: `ComparativeSummary` gains optional `onSelectBucket?: (bucket: string) => void` — when present, each bucket row becomes a button calling it. `CategoryComparisonList` gains optional `onSelectCategory?: (categoryId: number, name: string) => void` — when present, each category row becomes a button. `DonutChart` gains optional `onSelect?: (name: string) => void` — when present, each legend item (except a slice named `"Other"`) becomes a button calling `onSelect(slice.name)`. When a prop is absent, rendering/behavior is unchanged (backward compatible).

- [ ] **Step 1: Write the failing tests**

Create/extend `frontend/src/components/insights/ComparativeSummary.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ComparativeSummary } from "./ComparativeSummary";

const buckets = [
  { bucket: "need", spent: 1000, prevSpent: 800, delta: 200 },
  { bucket: "want", spent: 500, prevSpent: 500, delta: 0 },
];
const savings = { net: 1500, rate: 0.2 } as any;

describe("ComparativeSummary onSelectBucket", () => {
  it("fires onSelectBucket when a bucket row is tapped", () => {
    const onSelectBucket = vi.fn();
    render(<ComparativeSummary label="June 2026" note="" net={1500} savings={savings} buckets={buckets as any} onSelectBucket={onSelectBucket} />);
    fireEvent.click(screen.getByRole("button", { name: /Needs/ }));
    expect(onSelectBucket).toHaveBeenCalledWith("need");
  });
});
```

Create/extend `frontend/src/components/insights/CategoryComparisonList.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategoryComparisonList } from "./CategoryComparisonList";

const rows = [
  { category_id: 10, name: "Dining", bucket: "want", spent: 600, prevSpent: 400, delta: 200, deltaPct: 0.5, isNew: false, pct: 0.6 },
] as any;

describe("CategoryComparisonList onSelectCategory", () => {
  it("fires onSelectCategory when a category row is tapped", () => {
    const onSelectCategory = vi.fn();
    render(<CategoryComparisonList rows={rows} onSelectCategory={onSelectCategory} />);
    fireEvent.click(screen.getByRole("button", { name: /Dining/ }));
    expect(onSelectCategory).toHaveBeenCalledWith(10, "Dining");
  });
});
```

Create/extend `frontend/src/components/charts/DonutChart.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DonutChart } from "./DonutChart";

const slices = [
  { name: "Dining", value: 600, color: "#1373d9" },
  { name: "Other", value: 400, color: "var(--color-muted)" },
];

describe("DonutChart onSelect", () => {
  it("fires onSelect for a named slice but not for Other", () => {
    const onSelect = vi.fn();
    render(<DonutChart slices={slices} centerLabel="Spent" centerValue={1000} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Dining/ }));
    expect(onSelect).toHaveBeenCalledWith("Dining");
    // "Other" is not a button
    expect(screen.queryByRole("button", { name: /Other/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && bunx vitest run src/components/insights/ComparativeSummary.test.tsx src/components/insights/CategoryComparisonList.test.tsx src/components/charts/DonutChart.test.tsx`
Expected: FAIL — `onSelectBucket` / `onSelectCategory` / donut `onSelect` not wired (no matching button role/name).

- [ ] **Step 3: Wire `onSelectBucket` into `ComparativeSummary`**

In `frontend/src/components/insights/ComparativeSummary.tsx`, add `onSelectBucket?: (bucket: string) => void;` to the props type, and make each bucket row a button when the callback is present. Replace the `buckets.map(...)` block with:

```tsx
        {buckets.map((b) => {
          const inner = (
            <>
              <span className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: bucketColor(b.bucket) }} aria-hidden />
                {BUCKET_LABEL[b.bucket] ?? b.bucket}
              </span>
              <span className="flex items-center gap-2">
                <span className="tnum text-muted"><Money fils={b.spent} /></span>
                <DeltaBadge delta={b.delta} deltaPct={b.prevSpent > 0 ? b.delta / b.prevSpent : null} isNew={b.prevSpent === 0 && b.spent > 0} />
              </span>
            </>
          );
          return onSelectBucket ? (
            <button key={b.bucket} className="w-full flex items-center justify-between gap-2 text-sm text-left" onClick={() => onSelectBucket(b.bucket)}>
              {inner}
            </button>
          ) : (
            <div key={b.bucket} className="flex items-center justify-between gap-2 text-sm">{inner}</div>
          );
        })}
```

- [ ] **Step 4: Wire `onSelectCategory` into `CategoryComparisonList`**

In `frontend/src/components/insights/CategoryComparisonList.tsx`, add `onSelectCategory?: (categoryId: number, name: string) => void;` to the props. Wrap each `<li>`'s content in a button when present. Replace the `rows.map(...)` block with:

```tsx
          {rows.map((c) => {
            const inner = (
              <>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{c.name}</span>
                  <Pill tone={BUCKET_TONE[c.bucket] ?? "muted"}>{BUCKET_LABEL[c.bucket] ?? c.bucket}</Pill>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted tnum">{Math.round(c.pct * 100)}%</span>
                  <span className="tnum font-medium"><Money fils={c.spent} /></span>
                  <DeltaBadge delta={c.delta} deltaPct={c.deltaPct} isNew={c.isNew} isGone={c.spent === 0 && c.prevSpent > 0} />
                </span>
              </>
            );
            return (
              <li key={c.category_id} className="py-2.5">
                {onSelectCategory ? (
                  <button className="w-full flex items-center justify-between gap-3 text-left" onClick={() => onSelectCategory(c.category_id, c.name)}>
                    {inner}
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-3">{inner}</div>
                )}
              </li>
            );
          })}
```

- [ ] **Step 5: Wire `onSelect` into `DonutChart`**

In `frontend/src/components/charts/DonutChart.tsx`, add `onSelect?: (name: string) => void;` to the props type. Make each legend `<li>` a button when `onSelect` is present and the slice is not `"Other"`. Replace the legend `slices.map(...)` block with:

```tsx
        {slices.map((s, i) => {
          const inner = (
            <>
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden />
              <span className="truncate">{s.name}</span>
              <span className="ml-auto tnum text-muted shrink-0">{share(s.value)}%</span>
            </>
          );
          const tappable = onSelect && s.name !== "Other";
          return (
            <li key={i} className="min-w-0 text-sm">
              {tappable ? (
                <button aria-label={`Drill into ${s.name}`} className="flex items-center gap-2 w-full text-left" onClick={() => onSelect!(s.name)}>
                  {inner}
                </button>
              ) : (
                <span className="flex items-center gap-2">{inner}</span>
              )}
            </li>
          );
        })}
```

(The pie itself stays non-interactive; the legend is the tappable, testable affordance.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/insights/ComparativeSummary.test.tsx src/components/insights/CategoryComparisonList.test.tsx src/components/charts/DonutChart.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/insights/ComparativeSummary.tsx frontend/src/components/insights/CategoryComparisonList.tsx frontend/src/components/charts/DonutChart.tsx frontend/src/components/insights/ComparativeSummary.test.tsx frontend/src/components/insights/CategoryComparisonList.test.tsx frontend/src/components/charts/DonutChart.test.tsx
git commit -m "feat(insights): tappable bucket rows, category rows, donut legend (onSelect)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Assemble — wire drill-down, merchant card, and search into Insights

**Files:**
- Modify: `frontend/src/screens/Insights.tsx`
- Test: `frontend/src/screens/Insights.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2–7; `getJSON`; `monthRange` (`lib/transactions`); `Txn`, `Category`, `BudgetConfig` types.

- [ ] **Step 1: Write the failing integration test**

Open `frontend/src/screens/Insights.test.tsx` to confirm its existing harness (how it mocks `getJSON`/fetch and renders `<Insights scope=… />`). Add a test that, given a mocked month transactions response, tapping a bucket opens the drill-down sheet showing a transaction. Mirror the existing mocking style in that file; the fixed assertions are:

```tsx
// after rendering Insights with mocked endpoints incl. /api/transactions returning
// one confirmed spending debit "Deliveroo" in bucket "want":
fireEvent.click(await screen.findByRole("button", { name: /Wants/ }));
expect(await screen.findByText("Deliveroo")).toBeInTheDocument();
```

Also assert the "Top merchants" card renders: `expect(screen.getByText(/top merchants/i)).toBeInTheDocument();`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && bunx vitest run src/screens/Insights.test.tsx`
Expected: FAIL — no "Top merchants" card / bucket rows not tappable yet.

- [ ] **Step 3: Integrate into `Insights.tsx`**

Edit `frontend/src/screens/Insights.tsx`:
1. Add imports:

```tsx
import { useState } from "react";
import type { Txn, Category, BudgetConfig } from "../api/types";
import { monthRange } from "../lib/transactions";
import { MerchantBreakdown } from "../components/insights/MerchantBreakdown";
import { DrillDownSheet, type DrillTarget } from "../components/insights/DrillDownSheet";
import { SearchSheet } from "../components/insights/SearchSheet";
import { Search } from "lucide-react";
```

2. Inside the component, add queries + state (alongside the existing ones):

```tsx
  const { from, to } = monthRange(focusMonth);
  const monthTxns = useQuery({
    queryKey: ["transactions", "insights-month", from, to],
    queryFn: () => getJSON<Txn[]>(`/api/transactions?from=${from}&to=${to}`),
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });

  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const txns = monthTxns.data ?? [];
  const frozen = budget.data?.freeze_history ?? false;
```

3. Pass the new callbacks into the existing components and add the new card + search affordance. In the returned JSX:
   - Add a search button above the cards:

```tsx
      <div className="flex justify-end">
        <button
          aria-label="Search & filter"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-2 text-sm text-muted"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={16} /> Search & filter
        </button>
      </div>
```

   - Change `<ComparativeSummary … />` to add `onSelectBucket={(bucket) => setDrill({ type: "bucket", bucket })}`.
   - Change `<CategoryComparisonList rows={listRows} />` to `<CategoryComparisonList rows={listRows} onSelectCategory={(categoryId, name) => setDrill({ type: "category", categoryId, name })} />`.
   - Make the donut tappable: change `<DonutChart slices={slices} … />` to add `onSelect={(name) => { const cat = curData.find((c) => c.name === name); if (cat) setDrill({ type: "category", categoryId: cat.category_id, name }); }}`. (`curData` is the `CategorySpend[]` already in scope; it carries `category_id`. The "Other" slice never matches and is non-interactive in `DonutChart`.)
   - After the donut card (or wherever sensible in the flow), add `<MerchantBreakdown txns={txns} onSelect={(merchant) => setDrill({ type: "merchant", merchant })} />`.
   - At the end of the root `<div>`, render the sheets:

```tsx
      {drill && (
        <DrillDownSheet target={drill} txns={txns} frozen={frozen} categories={cats.data ?? []} onClose={() => setDrill(null)} />
      )}
      {searchOpen && (
        <SearchSheet txns={txns} categories={cats.data ?? []} onClose={() => setSearchOpen(false)} />
      )}
```

4. Do not block the page on `monthTxns`/`cats`/`budget` loading — keep the existing `if (cur.isLoading || prev.isLoading || summary.isLoading) return <Skeleton …/>` gate as-is. The drill/merchant/search features simply operate on `txns` (empty array until loaded).

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `cd frontend && bunx vitest run src/screens/Insights.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full frontend suite + typecheck**

Run: `cd frontend && bunx tsc --noEmit && bun run test`
Expected: PASS (all vitest files; single-fork). Investigate any failure before committing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens/Insights.tsx frontend/src/screens/Insights.test.tsx
git commit -m "feat(insights): interactive drill-down, merchant breakdown, search

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Evolve Insights in place → Task 8 (keeps route/components, adds interactivity). ✅
- Bottom-sheet drill-down with nested bucket→category narrowing → Task 4. ✅
- Reconciliation with headline (mirror `SelectCategorySpend`) → Task 2 `spendingTxns`/`effectiveBucket` + reconciliation assertion in `analysis.test.ts`. ✅
- Merchant breakdown → Tasks 2 (`merchantBreakdown`) + 5 (card) + 8 (drill on tap). ✅
- Search + combinable filters → Task 6 (reuses `FilterChips` + `applyTxnFilters` + `searchTxns`). ✅
- Focused-month scope → Task 8 fetches `monthRange(focusMonth)`. ✅
- Backend `Kind`/`BucketSnapshot` → Task 1. ✅
- Testing (pure lib, components, store) → Tasks 1–8 each include tests. ✅
- Donut click-to-drill (by category-name→id mapping) → Task 7 (`DonutChart onSelect`) + Task 8 wiring. ✅
- Deviations (min-amount dropped, in-page search, no `ui/Sheet`, `useTxnActions` extraction) are listed up top; all confirmed with the user. Donut is now tappable per the user's choice.

**2. Placeholder scan:** No TBD/TODO. Steps that must adapt to existing harnesses (store test helpers in Task 1 Step 1; Insights test harness in Task 8 Step 1; `ToastProvider` name in Task 4) name the exact thing to check and pin the fixed assertions. No "handle edge cases" hand-waving.

**3. Type consistency:** `DrillTarget` defined in Task 4 and constructed identically in Task 8. `useTxnActions` return shape (Task 3) matches its consumers in Tasks 4 & 6 (`setStatus`, `archiveTxn`, `restoreTxn`, `categorize` returning `Promise<boolean>`). `Txn` fields `Kind`/`BucketSnapshot` (Task 1) are used by `lib/analysis` (Task 2). `onSelectBucket`/`onSelectCategory` signatures (Task 7) match the calls in Task 8. `merchantBreakdown(txns, topN)` and `bucketBreakdown(txns, frozen)` signatures are consistent across tasks.
