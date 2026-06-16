# Transactions UI Polish + Month Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Transactions screen layout and add a month input that scopes the list to a single month.

**Architecture:** The Go backend already filters `/api/transactions` by `from`/`to` query params (`SelectTransactions(status, from, to)`), so this is a frontend-only change. We add a `month` state, two pure helpers (`monthRange`, `txnTotals`), and restructure the screen header into a Home-consistent layout: title + month input, a stable controls row, and a scope-summary bar (count + total spent). We harmonize the row with the existing bucket-color system.

**Tech Stack:** React 18 + TypeScript, TanStack Query, Tailwind v4 (CSS-first tokens in `frontend/src/styles/app.css`), lucide-react icons, vitest + Testing Library.

---

## Design rationale (frontend-design)

This is an existing, deliberately-designed app, so the move is **harmonization, not reinvention**. The frontend-design skill says: in existing codebases, follow established patterns. We reuse the locked-in token system and spend our one "risk" on a single information-bearing signature.

**Color** — reuse existing tokens (no new palette):
- `--color-accent: #4f46e5` (indigo) — primary actions (Swipe button).
- Bucket colors `--color-need #2563eb` / `--color-want #d97706` / `--color-save #059669` — used as a thin per-row indicator so the bucket is legible at a glance.
- `--color-surface #fff`, `--color-bg #f6f7f9`, `--color-border #e6e8ec`, `--color-muted #6b7280`.

**Type** — reuse `--font-sans` and the established scale (`text-xl font-semibold` H1, `text-sm` controls, `.tnum` tabular figures for money). No new faces.

**Layout** — mirror the Home screen's header grammar (`<h1>` left, month control right) so the two list/summary screens feel like one product:

```
┌────────────────────────────────────────────────┐
│ Transactions                  This month [ 2026-06 ]│  title + month input
│                                                  │
│ [ All | Needs review | Confirmed ]      [⚡ Swipe]│  controls (stable, no reflow)
│ 🔍 Search merchant…                              │  search w/ icon
│                                                  │
│ All time · 12 transactions            1,234.56 spent│  scope summary bar
├────────────────────────────────────────────────┤
│ ▎ SPINNEYS                              (50.00)  │  ▎ = bucket-color tab
│   Jun 10 · Groceries          [Needs review]     │
│   …                                              │
└────────────────────────────────────────────────┘
```

**Signature** — the **scope-summary bar**: it answers the page's real question ("what did this slice cost?") with a single total that updates live with the month/status/search scope. This is the one memorable, information-bearing element; everything else stays quiet. Why this and not the AI-default (a big hero number with a gradient): the value here is the *relationship* between the chosen scope and its total, not a decorative figure — so the total lives inline with the count it describes.

**Restraint** — default scope is **all time** (no hidden data on load; also keeps fixed-date tests deterministic). The month input is opt-in. Touch targets meet ~40px on the row actions. Keyboard focus and reduced-motion inherit from existing components.

---

## File structure

- **Create** `frontend/src/lib/transactions.ts` — pure helpers: `monthRange(period)` (inclusive query bounds) and `txnTotals(rows)` (count + spend). One responsibility: transactions-list math, mirroring `lib/insights.ts`.
- **Create** `frontend/src/lib/transactions.test.ts` — unit tests for the two helpers.
- **Modify** `frontend/src/screens/Transactions.tsx` — add month state + scoped query, restructured header/controls/summary.
- **Modify** `frontend/src/screens/Transactions.test.tsx` — stub honors `from`/`to`; add month-scope + clear-scope tests.
- **Modify** `frontend/src/components/transactions/TransactionRow.tsx` — bucket-color indicator + larger action hit areas.

`TransactionRow.test.tsx` should keep passing unchanged (queries by text/aria-label, which we preserve).

---

## Task 1: Pure helpers (`monthRange`, `txnTotals`)

**Files:**
- Create: `frontend/src/lib/transactions.ts`
- Test: `frontend/src/lib/transactions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/transactions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { monthRange, txnTotals } from "./transactions";
import type { Txn } from "../api/types";

describe("monthRange", () => {
  it("brackets a month inclusive of timestamped posted_at values", () => {
    const { from, to } = monthRange("2026-06");
    expect(from).toBe("2026-06-01");
    // posted_at is an RFC3339 timestamp; the upper bound must sort after any
    // day+time within June yet before July (backend filter is inclusive <=).
    expect("2026-06-01T00:00:00Z" >= from).toBe(true);
    expect("2026-06-30T23:59:59Z" <= to).toBe(true);
    expect("2026-07-01T00:00:00Z" <= to).toBe(false);
  });

  it("covers the 31st of 31-day months", () => {
    const { to } = monthRange("2026-07");
    expect("2026-07-31T12:00:00Z" <= to).toBe(true);
    expect("2026-08-01T00:00:00Z" <= to).toBe(false);
  });
});

describe("txnTotals", () => {
  const mk = (over: Partial<Txn>): Txn => ({
    ID: 1, PostedAt: "2026-06-10", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "X", Status: "confirmed", Confidence: 0,
    Source: "email", CategoryID: null, CategoryName: "", Bucket: "", ...over,
  });

  it("sums debits as spend and ignores credits", () => {
    const rows = [
      mk({ AmountFils: 5000, Direction: "debit" }),
      mk({ AmountFils: 2000, Direction: "credit" }),
      mk({ AmountFils: 1500, Direction: "debit" }),
    ];
    expect(txnTotals(rows)).toEqual({ count: 3, spentFils: 6500 });
  });

  it("returns zeroes for an empty list", () => {
    expect(txnTotals([])).toEqual({ count: 0, spentFils: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/transactions.test.ts`
Expected: FAIL — cannot resolve `./transactions` (module not created yet).

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/transactions.ts`:

```ts
import type { Txn } from "../api/types";

/**
 * Inclusive query bounds for a "YYYY-MM" month, matching the backend filter
 * `posted_at >= from AND posted_at <= to`. posted_at is stored as an RFC3339
 * timestamp, so the upper bound uses day "32": it sorts after every real
 * day+time in the month (e.g. "...-31T23:59:59Z") yet before the next month,
 * which an inclusive end-of-month date string would not (it would drop the
 * 31st's timestamped rows).
 */
export function monthRange(period: string): { from: string; to: string } {
  return { from: `${period}-01`, to: `${period}-32` };
}

export interface TxnTotals {
  count: number;
  spentFils: number;
}

/** Count plus total spend (sum of debit amounts) across the given rows. */
export function txnTotals(rows: Txn[]): TxnTotals {
  let spentFils = 0;
  for (const t of rows) {
    if (t.Direction === "debit") spentFils += t.AmountFils;
  }
  return { count: rows.length, spentFils };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/transactions.test.ts`
Expected: PASS (5 assertions across 4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/transactions.ts frontend/src/lib/transactions.test.ts
git commit -m "feat(frontend): add monthRange + txnTotals helpers for txn scoping"
```

---

## Task 2: Scope the query by month

**Files:**
- Modify: `frontend/src/screens/Transactions.tsx`
- Modify: `frontend/src/screens/Transactions.test.tsx`

- [ ] **Step 1: Update the test stub to honor `from`/`to`, then add scope tests**

In `frontend/src/screens/Transactions.test.tsx`, replace the `beforeEach` fetch stub's `/api/transactions` branch so it filters by `from`/`to` like the backend:

```ts
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/transactions")) {
      const sp = new URL("http://x" + url.replace(/^[^/]*/, "")).searchParams;
      const status = sp.get("status");
      const from = sp.get("from");
      const to = sp.get("to");
      let rows = status ? all.filter((t) => t.Status === status) : all;
      if (from) rows = rows.filter((t) => t.PostedAt >= from);
      if (to) rows = rows.filter((t) => t.PostedAt <= to);
      return new Response(JSON.stringify(rows));
    }
    return new Response("[]");
  }));
});
```

Then add two tests after the existing `client-filters by search text` test (still inside the `describe("Transactions", ...)` block):

```ts
  it("scopes the list to a selected month", async () => {
    wrap();
    await screen.findByText("SPINNEYS");
    // sample rows are June 2026; selecting May yields none
    fireEvent.change(screen.getByLabelText(/^month$/i), { target: { value: "2026-05" } });
    expect(await screen.findByText(/no transactions/i)).toBeInTheDocument();
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
  });

  it("clears the month scope with All time", async () => {
    wrap();
    await screen.findByText("SPINNEYS");
    fireEvent.change(screen.getByLabelText(/^month$/i), { target: { value: "2026-05" } });
    await screen.findByText(/no transactions/i);
    fireEvent.click(screen.getByRole("button", { name: /all time/i }));
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: the two new tests FAIL (no month input / "All time" button yet); the three existing tests still PASS.

- [ ] **Step 3: Add month state + scoped query in the screen**

In `frontend/src/screens/Transactions.tsx`, add the import near the other lib imports:

```ts
import { monthRange } from "../lib/transactions";
```

Add `month` state next to the existing `search` state:

```ts
  const [month, setMonth] = useState("");
```

Replace the existing `status` + `useQuery` block (lines ~29-33):

```ts
  const status = filter === "all" ? "" : filter;
  const q = useQuery({
    queryKey: ["transactions", status, month],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (month) {
        const { from, to } = monthRange(month);
        params.set("from", from);
        params.set("to", to);
      }
      const qs = params.toString();
      return getJSON<Txn[]>(qs ? `/api/transactions?${qs}` : "/api/transactions");
    },
  });
```

(`invalidate()` already targets the `["transactions"]` key prefix, so it keeps working with the extra key segment — no change needed there.)

Then add a temporary month input inside the existing `flex flex-col gap-2` controls block, right after the `<SegmentedControl .../>` line, so the new tests can find it (Task 3 moves it to its final position):

```tsx
        <input type="month" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} />
        {month && (
          <button onClick={() => setMonth("")}>All time</button>
        )}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: all five tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/Transactions.tsx frontend/src/screens/Transactions.test.tsx
git commit -m "feat(frontend): scope transactions list by selected month"
```

---

## Task 3: Restructure the header (title + month input)

**Files:**
- Modify: `frontend/src/screens/Transactions.tsx`

- [ ] **Step 1: Replace the header + controls markup**

In `frontend/src/screens/Transactions.tsx`, add to the lucide import (currently `import { AlertTriangle, ListOrdered } from "lucide-react";`):

```ts
import { AlertTriangle, ListOrdered, Search, Zap } from "lucide-react";
```

Add this import for the month label/quick-set helpers:

```ts
import { monthLabel, currentPeriod } from "../lib/insights";
```

Replace the entire header block — from `<h1 className="text-xl font-semibold">Transactions</h1>` through the closing `</div>` of the `flex flex-col gap-2` controls group (the temporary month input from Task 2 lives here) — with:

```tsx
      {/* title + month scope (mirrors the Home header) */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Transactions</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMonth(month ? "" : currentPeriod())}
            className="text-xs text-muted hover:text-fg transition-colors"
          >
            {month ? "All time" : "This month"}
          </button>
          <input
            type="month"
            aria-label="Month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="bg-surface border border-border rounded-lg px-2 py-1 text-sm tnum"
          />
        </div>
      </div>

      {/* status filter + swipe entry (right-aligned so it never reflows search) */}
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />
        {filter === "needs_review" && onOpenSwipeMode && (
          <button
            onClick={onOpenSwipeMode}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity whitespace-nowrap"
          >
            <Zap size={16} /> Swipe
          </button>
        )}
      </div>

      {/* search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
        <input
          type="search"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-sm"
        />
      </div>
```

This removes the old emoji ⚡ Swipe button and the old full-width search; both are re-created above with the polished styling. The `"All time"` button still satisfies Task 2's clear-scope test, and `aria-label="Month"` still satisfies the month-scope test.

- [ ] **Step 2: Run the screen tests**

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: all five tests PASS (count/search/filter/month/clear).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screens/Transactions.tsx
git commit -m "style(frontend): restructure transactions header with month input"
```

---

## Task 4: Scope-summary bar (count + total spent)

**Files:**
- Modify: `frontend/src/screens/Transactions.tsx`

- [ ] **Step 1: Add the summary computation and import**

In `frontend/src/screens/Transactions.tsx`, extend the transactions helper import:

```ts
import { monthRange, txnTotals } from "../lib/transactions";
```

Add the money formatter import (next to the `Money` import):

```ts
import { formatFils } from "../lib/money";
```

After the existing `rows` `useMemo`, add:

```ts
  const totals = useMemo(() => txnTotals(rows), [rows]);
```

- [ ] **Step 2: Render the summary bar and remove the buried count**

In the results `<Card className="!p-0">` block, delete this line:

```tsx
          <p className="text-xs text-muted px-4 pt-3">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>
```

Then insert a summary bar immediately **before** the `<Card className="!p-0">` (so it shows above the list, and only when there are rows — it sits inside the same `else` branch that renders the Card):

```tsx
          <div className="flex items-center justify-between px-1">
            <p className="text-sm text-muted">
              {month ? `${monthLabel(month)} ${month.slice(0, 4)}` : "All time"} ·{" "}
              {rows.length} transaction{rows.length === 1 ? "" : "s"}
            </p>
            {totals.spentFils > 0 && (
              <p className="text-sm text-muted tnum">{formatFils(totals.spentFils)} spent</p>
            )}
          </div>
```

To keep the summary bar and the Card grouped as one element in the ternary branch, wrap them in a fragment. The branch becomes:

```tsx
      ) : (
        <>
          <div className="flex items-center justify-between px-1">
            <p className="text-sm text-muted">
              {month ? `${monthLabel(month)} ${month.slice(0, 4)}` : "All time"} ·{" "}
              {rows.length} transaction{rows.length === 1 ? "" : "s"}
            </p>
            {totals.spentFils > 0 && (
              <p className="text-sm text-muted tnum">{formatFils(totals.spentFils)} spent</p>
            )}
          </div>
          <Card className="!p-0">
            <ul className="divide-y divide-border px-4">
              {rows.map((t) => (
                <li key={t.ID}><TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} /></li>
              ))}
            </ul>
          </Card>
        </>
      )}
```

The count text remains `"N transactions"` (now inside the bar), so the existing `/2 transactions/i` assertion still matches via the `<p>` element's text content.

- [ ] **Step 3: Run the screen tests**

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: all five tests PASS. The first test still finds `/2 transactions/i` and now also a `75.00 spent` total is present (not asserted).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/screens/Transactions.tsx
git commit -m "feat(frontend): add scope summary bar with live spend total"
```

---

## Task 5: Row polish — bucket indicator + larger touch targets

**Files:**
- Modify: `frontend/src/components/transactions/TransactionRow.tsx`

- [ ] **Step 1: Add the bucket-color indicator and enlarge action buttons**

In `frontend/src/components/transactions/TransactionRow.tsx`, add the import:

```ts
import { bucketColor } from "../../lib/insights";
```

Replace the component's returned JSX (the `return ( ... )` body) with:

```tsx
  return (
    <div className="py-2.5 flex items-stretch gap-3">
      <span
        aria-hidden
        className="w-1 rounded-full shrink-0"
        style={{ background: txn.Bucket ? bucketColor(txn.Bucket) : "var(--color-border)" }}
      />
      <button className="flex-1 min-w-0 text-left self-center" aria-label={`Open ${txn.MerchantRaw || "transaction"}`} onClick={() => onOpen(txn)}>
        <p className="truncate font-medium">{txn.MerchantRaw || "—"}</p>
        <p className="text-xs text-muted truncate">{subtitle || "Uncategorized"}</p>
      </button>
      <div className="flex flex-col items-end gap-1 self-center">
        <span className="tnum font-medium"><Money fils={txn.Direction === "credit" ? txn.AmountFils : -txn.AmountFils} /></span>
        <Pill tone={statusTone(txn.Status)}>{statusLabel(txn.Status)}</Pill>
      </div>
      {needsReview && (
        <div className="flex flex-col gap-1 self-center">
          <button aria-label="Categorize" className="p-2 rounded-lg hover:bg-bg text-accent" onClick={() => onOpen(txn)}><Tag size={16} /></button>
          <button aria-label="Transfer" className="p-2 rounded-lg hover:bg-bg text-muted" onClick={() => onStatus(txn, "transfer")}><ArrowLeftRight size={16} /></button>
          <button aria-label="Ignore" className="p-2 rounded-lg hover:bg-bg text-muted" onClick={() => onStatus(txn, "ignored")}><X size={16} /></button>
        </div>
      )}
    </div>
  );
```

Changes: the row is now `items-stretch` so the new 4px bucket-color tab spans the full row height; content blocks are `self-center`; action buttons grow from `p-1.5` to `p-2` for a ~40px hit area. Confirmed rows show their bucket color (blue/amber/green); uncategorized rows show a neutral border-colored tab.

- [ ] **Step 2: Run the row tests**

Run: `cd frontend && bunx vitest run src/components/transactions/TransactionRow.test.tsx`
Expected: both tests PASS (merchant/status/category text + Categorize/Ignore aria-labels unchanged).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/transactions/TransactionRow.tsx
git commit -m "style(frontend): add bucket-color row indicator and larger touch targets"
```

---

## Task 6: Full verification + rebuild embedded bundle

**Files:**
- Modify: `internal/web/dist/**` (regenerated build artifact)

- [ ] **Step 1: Run the full frontend test suite**

Run: `cd frontend && bun run test`
Expected: PASS — all suites green (including `lib/transactions.test.ts`, `screens/Transactions.test.tsx`, `components/transactions/TransactionRow.test.tsx`).

- [ ] **Step 2: Run the full Go test suite**

Run: `go test ./...`
Expected: PASS (no Go changed, but confirm nothing regressed).

- [ ] **Step 3: Rebuild the embedded PWA bundle**

Per CLAUDE.md, `internal/web/dist/` is a committed artifact and must match the frontend source before finishing.

Run: `cd frontend && bun install && bun run build`
Expected: build succeeds, writing to `internal/web/dist/`.

- [ ] **Step 4: Confirm the binary still builds with the new bundle**

Run: `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`
Expected: builds with no errors.

- [ ] **Step 5: Commit the rebuilt bundle**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for transactions UI polish"
```

---

## Self-review checklist (run after building)

- **Spec coverage:** month input that scopes to a specific month → Tasks 2-3; "better layout" → Tasks 3-5 (header grammar, stable controls, summary bar, row indicator).
- **Type consistency:** `monthRange` returns `{ from, to }` (used in Task 2's query and Task 1's test); `txnTotals` returns `{ count, spentFils }` (`TxnTotals`), consumed as `totals.spentFils` in Task 4. `month` state is `string` (`""` = all) throughout. Imports: `monthRange`/`txnTotals` from `../lib/transactions`; `monthLabel`/`currentPeriod`/`bucketColor` from `../lib/insights` (`../../lib/insights` in the row); `formatFils` from `../lib/money`.
- **Behavior preservation:** default scope is `""` (all time) → fixed-date sample data stays visible → no flaky wall-clock dependency. The `"N transactions"` count string is preserved (relocated to the summary bar) so the existing assertion holds.
