# Insights UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Insights page from descriptive into a comparison view ("what changed") — month-anchored, with per-category % share + month-over-month deltas, a "biggest changes" block, a comparative need/want/saving strip, and savings rate — without any backend change.

**Architecture:** Pure-frontend. Add tested helper functions to `lib/insights.ts` (deltas, share, bucket comparison, top movers, savings rate) and `lib/scope.ts` (`insightsFocus`). Build four small presentational components under `components/insights/` and rewire `screens/Insights.tsx` to fetch the focus month + previous month + summary (shared cache with Home) + trend.

**Tech Stack:** React 18 + TS, TanStack Query, Tailwind v4, recharts, vitest + @testing-library/react. Spec: `docs/superpowers/specs/2026-06-16-insights-ux-design.md`.

---

## File structure

- `frontend/src/lib/scope.ts` — add `insightsFocus(scope)` + `InsightsFocus` type.
- `frontend/src/lib/insights.ts` — add `CategoryDelta`, `categoryDeltas`, `withShare`, `BucketComparison`, `bucketComparison`, `topMovers`, `SavingsResult`, `savingsRate`.
- `frontend/src/components/insights/DeltaBadge.tsx` — shared directional delta indicator (new dir).
- `frontend/src/components/insights/ComparativeSummary.tsx` — header card.
- `frontend/src/components/insights/TopMovers.tsx` — "Biggest changes" card.
- `frontend/src/components/insights/CategoryComparisonList.tsx` — category list with %/Δ.
- `frontend/src/screens/Insights.tsx` — rewrite orchestrator.
- `frontend/src/app/AppShell.tsx` — pass `scope` to `<Insights>` instead of `period`.
- Tests: `lib/scope.test.ts`, `lib/insights.test.ts` (extend); new `*.test.tsx` for each component; `screens/Insights.test.tsx` (update).

All money is `int64` fils; never floats for money. Percentages are ratios (plain numbers) — fine.

---

## Task 1: `insightsFocus` in scope.ts

**Files:**
- Modify: `frontend/src/lib/scope.ts`
- Test: `frontend/src/lib/scope.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/scope.test.ts`:

```ts
import { insightsFocus } from "./scope";
import { currentPeriod } from "./insights";

describe("insightsFocus", () => {
  it("returns the month with no note for a month scope", () => {
    expect(insightsFocus({ kind: "month", period: "2026-03" })).toEqual({ period: "2026-03", note: "" });
  });
  it("returns the latest month of a range with a note", () => {
    expect(insightsFocus({ kind: "range", from: "2026-01", to: "2026-04" })).toEqual({ period: "2026-04", note: "latest in range" });
  });
  it("returns the current month with a note for all-time", () => {
    expect(insightsFocus({ kind: "all" })).toEqual({ period: currentPeriod(), note: "current month" });
  });
});
```

(If `scope.test.ts` already imports from `./scope`, merge the import rather than duplicating it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/scope.test.ts`
Expected: FAIL — `insightsFocus` is not exported.

- [ ] **Step 3: Implement**

Add to `frontend/src/lib/scope.ts` (after `scopeAnchor`):

```ts
export interface InsightsFocus { period: string; note: string; }

/** The single month Insights evaluates, plus a qualifier when the scope spans more than one month. */
export function insightsFocus(scope: Scope): InsightsFocus {
  if (scope.kind === "month") return { period: scope.period, note: "" };
  if (scope.kind === "range") return { period: scope.to, note: "latest in range" };
  return { period: currentPeriod(), note: "current month" };
}
```

`currentPeriod` is already imported at the top of `scope.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/scope.ts frontend/src/lib/scope.test.ts
git commit -m "feat(frontend): add insightsFocus scope helper"
```

---

## Task 2: `categoryDeltas` + `CategoryDelta`

**Files:**
- Modify: `frontend/src/lib/insights.ts`
- Test: `frontend/src/lib/insights.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/insights.test.ts`:

```ts
import { categoryDeltas } from "./insights";
import type { CategorySpend } from "../api/types";

describe("categoryDeltas", () => {
  const cur: CategorySpend[] = [
    { category_id: 1, name: "Groceries", bucket: "need", spent: 2000 },
    { category_id: 2, name: "Dining", bucket: "want", spent: 500 },
    { category_id: 3, name: "Gifts", bucket: "want", spent: 300 }, // new
  ];
  const prev: CategorySpend[] = [
    { category_id: 1, name: "Groceries", bucket: "need", spent: 1000 },
    { category_id: 2, name: "Dining", bucket: "want", spent: 800 },
    { category_id: 4, name: "Travel", bucket: "want", spent: 600 }, // gone
  ];

  it("computes delta and deltaPct for matched categories", () => {
    const d = categoryDeltas(cur, prev);
    const groceries = d.find((x) => x.category_id === 1)!;
    expect(groceries.delta).toBe(1000);
    expect(groceries.deltaPct).toBeCloseTo(1.0);
    expect(groceries.isNew).toBe(false);
  });
  it("marks a category absent last month as new with null deltaPct", () => {
    const gifts = categoryDeltas(cur, prev).find((x) => x.category_id === 3)!;
    expect(gifts.isNew).toBe(true);
    expect(gifts.deltaPct).toBeNull();
    expect(gifts.delta).toBe(300);
  });
  it("includes a category present last month but gone this month with spent 0", () => {
    const travel = categoryDeltas(cur, prev).find((x) => x.category_id === 4)!;
    expect(travel.spent).toBe(0);
    expect(travel.prevSpent).toBe(600);
    expect(travel.delta).toBe(-600);
    expect(travel.deltaPct).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/insights.test.ts`
Expected: FAIL — `categoryDeltas` not exported.

- [ ] **Step 3: Implement**

Add to `frontend/src/lib/insights.ts`:

```ts
export interface CategoryDelta {
  category_id: number;
  name: string;
  bucket: string;
  spent: number;
  prevSpent: number;
  delta: number;            // spent - prevSpent
  deltaPct: number | null;  // prevSpent > 0 ? delta / prevSpent : null
  isNew: boolean;           // prevSpent === 0 && spent > 0
}

/** Pair each category's spend with its previous-month spend. Includes "gone" categories (present last month only) with spent 0. */
export function categoryDeltas(cur: CategorySpend[], prev: CategorySpend[]): CategoryDelta[] {
  const prevMap = new Map(prev.map((c) => [c.category_id, c]));
  const out: CategoryDelta[] = cur.map((c) => {
    const prevSpent = prevMap.get(c.category_id)?.spent ?? 0;
    const delta = c.spent - prevSpent;
    return {
      category_id: c.category_id, name: c.name, bucket: c.bucket,
      spent: c.spent, prevSpent, delta,
      deltaPct: prevSpent > 0 ? delta / prevSpent : null,
      isNew: prevSpent === 0 && c.spent > 0,
    };
  });
  const curIds = new Set(cur.map((c) => c.category_id));
  for (const p of prev) {
    if (!curIds.has(p.category_id)) {
      out.push({
        category_id: p.category_id, name: p.name, bucket: p.bucket,
        spent: 0, prevSpent: p.spent, delta: -p.spent, deltaPct: -1, isNew: false,
      });
    }
  }
  return out;
}
```

`CategorySpend` is already imported at the top of `insights.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/insights.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/insights.ts frontend/src/lib/insights.test.ts
git commit -m "feat(frontend): add categoryDeltas (month-over-month)"
```

---

## Task 3: `withShare` + `bucketComparison`

**Files:**
- Modify: `frontend/src/lib/insights.ts`
- Test: `frontend/src/lib/insights.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/insights.test.ts`:

```ts
import { withShare, bucketComparison } from "./insights";

describe("withShare", () => {
  it("adds a pct field as a fraction of total", () => {
    const rows = withShare([{ spent: 250 }, { spent: 750 }], 1000);
    expect(rows[0].pct).toBeCloseTo(0.25);
    expect(rows[1].pct).toBeCloseTo(0.75);
  });
  it("uses 0 when total is 0", () => {
    expect(withShare([{ spent: 0 }], 0)[0].pct).toBe(0);
  });
});

describe("bucketComparison", () => {
  it("sums by bucket in need/want/saving order with deltas", () => {
    const cur: CategorySpend[] = [
      { category_id: 1, name: "A", bucket: "need", spent: 100 },
      { category_id: 2, name: "B", bucket: "need", spent: 50 },
      { category_id: 3, name: "C", bucket: "want", spent: 200 },
    ];
    const prev: CategorySpend[] = [
      { category_id: 1, name: "A", bucket: "need", spent: 120 },
      { category_id: 3, name: "C", bucket: "want", spent: 150 },
    ];
    const res = bucketComparison(cur, prev);
    expect(res.map((b) => b.bucket)).toEqual(["need", "want", "saving"]);
    expect(res[0]).toMatchObject({ bucket: "need", spent: 150, prevSpent: 120, delta: 30 });
    expect(res[1]).toMatchObject({ bucket: "want", spent: 200, prevSpent: 150, delta: 50 });
    expect(res[2]).toMatchObject({ bucket: "saving", spent: 0, prevSpent: 0, delta: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/insights.test.ts`
Expected: FAIL — `withShare`/`bucketComparison` not exported.

- [ ] **Step 3: Implement**

Add to `frontend/src/lib/insights.ts`:

```ts
/** Add a `pct` field (fraction of `total`) to each row. */
export function withShare<T extends { spent: number }>(rows: T[], total: number): (T & { pct: number })[] {
  return rows.map((r) => ({ ...r, pct: total > 0 ? r.spent / total : 0 }));
}

export interface BucketComparison { bucket: string; spent: number; prevSpent: number; delta: number; }

const BUCKET_ORDER = ["need", "want", "saving"] as const;

/** Per-bucket spend this month vs last, in fixed need/want/saving order. */
export function bucketComparison(cur: CategorySpend[], prev: CategorySpend[]): BucketComparison[] {
  const sumBy = (rows: CategorySpend[], bucket: string) =>
    rows.filter((c) => c.bucket === bucket).reduce((s, c) => s + c.spent, 0);
  return BUCKET_ORDER.map((bucket) => {
    const spent = sumBy(cur, bucket);
    const prevSpent = sumBy(prev, bucket);
    return { bucket, spent, prevSpent, delta: spent - prevSpent };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/insights.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/insights.ts frontend/src/lib/insights.test.ts
git commit -m "feat(frontend): add withShare + bucketComparison"
```

---

## Task 4: `topMovers` + `savingsRate`

**Files:**
- Modify: `frontend/src/lib/insights.ts`
- Test: `frontend/src/lib/insights.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/insights.test.ts`:

```ts
import { topMovers, savingsRate } from "./insights";
import type { CategoryDelta } from "./insights";

function delta(id: number, d: number): CategoryDelta {
  return { category_id: id, name: `c${id}`, bucket: "want", spent: Math.max(d, 0), prevSpent: 0, delta: d, deltaPct: null, isNew: false };
}

describe("topMovers", () => {
  it("returns the n biggest movers by absolute fils delta, excluding zero", () => {
    const res = topMovers([delta(1, 300), delta(2, -900), delta(3, 0), delta(4, 100)], 2);
    expect(res.map((m) => m.category_id)).toEqual([2, 1]);
  });
});

describe("savingsRate", () => {
  it("computes net and rate", () => {
    expect(savingsRate(1000, 800)).toEqual({ net: 200, rate: 0.2 });
  });
  it("returns null rate when income is 0", () => {
    expect(savingsRate(0, 500)).toEqual({ net: -500, rate: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/insights.test.ts`
Expected: FAIL — `topMovers`/`savingsRate` not exported.

- [ ] **Step 3: Implement**

Add to `frontend/src/lib/insights.ts`:

```ts
/** The `n` categories that moved most this month, by absolute fils change; zero-deltas excluded. */
export function topMovers(deltas: CategoryDelta[], n = 3): CategoryDelta[] {
  return deltas
    .filter((d) => d.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, n);
}

export interface SavingsResult { net: number; rate: number | null; }

/** Net (income − spent) and savings rate; rate is null when there's no income to divide by. */
export function savingsRate(income: number, spent: number): SavingsResult {
  return { net: income - spent, rate: income > 0 ? (income - spent) / income : null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/insights.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/insights.ts frontend/src/lib/insights.test.ts
git commit -m "feat(frontend): add topMovers + savingsRate"
```

---

## Task 5: `DeltaBadge` component

**Files:**
- Create: `frontend/src/components/insights/DeltaBadge.tsx`
- Test: `frontend/src/components/insights/DeltaBadge.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/insights/DeltaBadge.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeltaBadge } from "./DeltaBadge";

describe("DeltaBadge", () => {
  it("shows an up percentage with a vs-last-month label for an increase", () => {
    render(<DeltaBadge delta={320} deltaPct={0.32} />);
    expect(screen.getByText("32%")).toBeInTheDocument();
    expect(screen.getByLabelText(/up 32% vs last month/i)).toBeInTheDocument();
  });
  it("shows 'new' when the category is new", () => {
    render(<DeltaBadge delta={300} deltaPct={null} isNew />);
    expect(screen.getByText("new")).toBeInTheDocument();
  });
  it("shows 'gone' when spending stopped", () => {
    render(<DeltaBadge delta={-600} deltaPct={-1} isGone />);
    expect(screen.getByText("gone")).toBeInTheDocument();
  });
  it("shows an em dash for no change", () => {
    render(<DeltaBadge delta={0} deltaPct={0} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
  it("falls back to a fils amount when deltaPct is null but it's not new", () => {
    render(<DeltaBadge delta={-500} deltaPct={null} />);
    expect(screen.getByText("5.00")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/insights/DeltaBadge.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `frontend/src/components/insights/DeltaBadge.tsx`:

```tsx
import { ArrowUp, ArrowDown } from "lucide-react";
import { formatFils } from "../../lib/money";

/** Magnitude text: a rounded percent when available, else an absolute fils amount. */
function magnitude(deltaPct: number | null, delta: number): string {
  return deltaPct != null ? `${Math.round(Math.abs(deltaPct) * 100)}%` : formatFils(Math.abs(delta));
}

/** Directional month-over-month change indicator. Spending up = warn, down = good. */
export function DeltaBadge({ delta, deltaPct, isNew = false, isGone = false }: {
  delta: number; deltaPct: number | null; isNew?: boolean; isGone?: boolean;
}) {
  if (isNew) return <span className="text-xs text-muted">new</span>;
  if (isGone) return <span className="text-xs text-good" aria-label="gone vs last month">gone</span>;
  if (delta === 0) return <span className="text-xs text-muted" aria-label="no change vs last month">—</span>;
  const up = delta > 0;
  const text = magnitude(deltaPct, delta);
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? "text-warn" : "text-good"}`}
      aria-label={`${up ? "up" : "down"} ${text} vs last month`}
    >
      <Icon size={12} aria-hidden />{text}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/insights/DeltaBadge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/insights/DeltaBadge.tsx frontend/src/components/insights/DeltaBadge.test.tsx
git commit -m "feat(frontend): add DeltaBadge indicator"
```

---

## Task 6: `ComparativeSummary` component

**Files:**
- Create: `frontend/src/components/insights/ComparativeSummary.tsx`
- Test: `frontend/src/components/insights/ComparativeSummary.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/insights/ComparativeSummary.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComparativeSummary } from "./ComparativeSummary";

const buckets = [
  { bucket: "need", spent: 400000, prevSpent: 380000, delta: 20000 },
  { bucket: "want", spent: 210000, prevSpent: 240000, delta: -30000 },
  { bucket: "saving", spent: 90000, prevSpent: 80000, delta: 10000 },
];
// Note: no bucket has delta 0, so DeltaBadge never renders "—"; the only em dash
// in the null-rate test below is the savings rate itself.

describe("ComparativeSummary", () => {
  it("renders the focus label, note, savings rate and bucket rows", () => {
    render(<ComparativeSummary label="Jun 2026" note="latest in range" net={120000} savings={{ net: 120000, rate: 0.18 }} buckets={buckets} />);
    expect(screen.getByText("Jun 2026")).toBeInTheDocument();
    expect(screen.getByText("latest in range")).toBeInTheDocument();
    expect(screen.getByText("18%")).toBeInTheDocument();
    expect(screen.getByText("Needs")).toBeInTheDocument();
    expect(screen.getByText("Wants")).toBeInTheDocument();
    expect(screen.getByText("Savings")).toBeInTheDocument();
  });
  it("shows an em dash for savings rate when rate is null", () => {
    render(<ComparativeSummary label="Jun 2026" note="" net={-5000} savings={{ net: -5000, rate: null }} buckets={buckets} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/insights/ComparativeSummary.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `frontend/src/components/insights/ComparativeSummary.tsx`:

```tsx
import { Card } from "../ui/Card";
import { Money } from "../Money";
import { bucketColor } from "../../lib/insights";
import type { BucketComparison, SavingsResult } from "../../lib/insights";
import { DeltaBadge } from "./DeltaBadge";

const BUCKET_LABEL: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

export function ComparativeSummary({ label, note, net, savings, buckets }: {
  label: string; note: string; net: number; savings: SavingsResult; buckets: BucketComparison[];
}) {
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted">Net this month</p>
          <p className="text-2xl font-bold tnum"><Money fils={net} /></p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted">Saved</p>
          <p className="text-lg font-semibold tnum">{savings.rate != null ? `${Math.round(savings.rate * 100)}%` : "—"}</p>
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        {buckets.map((b) => (
          <div key={b.bucket} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: bucketColor(b.bucket) }} aria-hidden />
              {BUCKET_LABEL[b.bucket] ?? b.bucket}
            </span>
            <span className="flex items-center gap-2">
              <span className="tnum text-muted"><Money fils={b.spent} /></span>
              <DeltaBadge delta={b.delta} deltaPct={b.prevSpent > 0 ? b.delta / b.prevSpent : null} isNew={b.prevSpent === 0 && b.spent > 0} />
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/insights/ComparativeSummary.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/insights/ComparativeSummary.tsx frontend/src/components/insights/ComparativeSummary.test.tsx
git commit -m "feat(frontend): add ComparativeSummary card"
```

---

## Task 7: `TopMovers` component

**Files:**
- Create: `frontend/src/components/insights/TopMovers.tsx`
- Test: `frontend/src/components/insights/TopMovers.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/insights/TopMovers.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopMovers } from "./TopMovers";
import type { CategoryDelta } from "../../lib/insights";

const movers: CategoryDelta[] = [
  { category_id: 1, name: "Groceries", bucket: "need", spent: 2000, prevSpent: 1520, delta: 480, deltaPct: 0.32, isNew: false },
  { category_id: 2, name: "Dining", bucket: "want", spent: 950, prevSpent: 1160, delta: -210, deltaPct: -0.18, isNew: false },
];

describe("TopMovers", () => {
  it("lists movers with names", () => {
    render(<TopMovers movers={movers} hasPrev />);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Dining")).toBeInTheDocument();
  });
  it("shows a no-prior-month message when there's no comparison baseline", () => {
    render(<TopMovers movers={[]} hasPrev={false} />);
    expect(screen.getByText(/no prior month to compare/i)).toBeInTheDocument();
  });
  it("shows a no-changes message when there's a baseline but nothing moved", () => {
    render(<TopMovers movers={[]} hasPrev />);
    expect(screen.getByText(/no notable changes/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/insights/TopMovers.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `frontend/src/components/insights/TopMovers.tsx`:

```tsx
import { Card } from "../ui/Card";
import { Money } from "../Money";
import type { CategoryDelta } from "../../lib/insights";
import { DeltaBadge } from "./DeltaBadge";

export function TopMovers({ movers, hasPrev }: { movers: CategoryDelta[]; hasPrev: boolean }) {
  return (
    <Card>
      <p className="text-sm font-medium mb-2">Biggest changes</p>
      {!hasPrev ? (
        <p className="text-sm text-muted">No prior month to compare.</p>
      ) : movers.length === 0 ? (
        <p className="text-sm text-muted">No notable changes.</p>
      ) : (
        <ul className="space-y-2">
          {movers.map((m) => (
            <li key={m.category_id} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{m.name}</span>
              <span className="flex items-center gap-2">
                <span className="tnum text-muted"><Money fils={m.delta} /></span>
                <DeltaBadge delta={m.delta} deltaPct={m.deltaPct} isNew={m.isNew} isGone={m.spent === 0 && m.prevSpent > 0} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/insights/TopMovers.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/insights/TopMovers.tsx frontend/src/components/insights/TopMovers.test.tsx
git commit -m "feat(frontend): add TopMovers card"
```

---

## Task 8: `CategoryComparisonList` component

**Files:**
- Create: `frontend/src/components/insights/CategoryComparisonList.tsx`
- Test: `frontend/src/components/insights/CategoryComparisonList.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/insights/CategoryComparisonList.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryComparisonList } from "./CategoryComparisonList";
import type { CategoryDelta } from "../../lib/insights";

type Row = CategoryDelta & { pct: number };
const rows: Row[] = [
  { category_id: 1, name: "Groceries", bucket: "need", spent: 2000, prevSpent: 1520, delta: 480, deltaPct: 0.32, isNew: false, pct: 0.21 },
  { category_id: 2, name: "Gifts", bucket: "want", spent: 300, prevSpent: 0, delta: 300, deltaPct: null, isNew: true, pct: 0.03 },
];

describe("CategoryComparisonList", () => {
  it("renders each category with its share percent and delta", () => {
    render(<CategoryComparisonList rows={rows} />);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("21%")).toBeInTheDocument();
    expect(screen.getByText("32%")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.getByText("Needs")).toBeInTheDocument();
  });
  it("shows an empty state when there are no rows", () => {
    render(<CategoryComparisonList rows={[]} />);
    expect(screen.getByText(/nothing to break down yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/insights/CategoryComparisonList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `frontend/src/components/insights/CategoryComparisonList.tsx`:

```tsx
import { Card } from "../ui/Card";
import { Money } from "../Money";
import { Pill, type Tone } from "../ui/Pill";
import { EmptyState } from "../EmptyState";
import type { CategoryDelta } from "../../lib/insights";
import { DeltaBadge } from "./DeltaBadge";

const BUCKET_TONE: Record<string, Tone> = { need: "neutral", want: "warn", saving: "good" };
const BUCKET_LABEL: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

export function CategoryComparisonList({ rows }: { rows: (CategoryDelta & { pct: number })[] }) {
  return (
    <Card className="!p-0">
      <p className="text-sm font-medium px-4 pt-4">By category</p>
      {rows.length === 0 ? (
        <EmptyState title="Nothing to break down yet" />
      ) : (
        <ul className="divide-y divide-border px-4 pb-2">
          {rows.map((c) => (
            <li key={c.category_id} className="py-2.5 flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 min-w-0">
                <span className="truncate">{c.name}</span>
                <Pill tone={BUCKET_TONE[c.bucket] ?? "muted"}>{BUCKET_LABEL[c.bucket] ?? c.bucket}</Pill>
              </span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-muted tnum">{Math.round(c.pct * 100)}%</span>
                <span className="tnum font-medium"><Money fils={c.spent} /></span>
                <DeltaBadge delta={c.delta} deltaPct={c.deltaPct} isNew={c.isNew} isGone={c.spent === 0 && c.prevSpent > 0} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/insights/CategoryComparisonList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/insights/CategoryComparisonList.tsx frontend/src/components/insights/CategoryComparisonList.test.tsx
git commit -m "feat(frontend): add CategoryComparisonList"
```

---

## Task 9: Rewire `Insights.tsx` + AppShell + update screen test

**Files:**
- Rewrite: `frontend/src/screens/Insights.tsx`
- Modify: `frontend/src/app/AppShell.tsx`
- Update: `frontend/src/screens/Insights.test.tsx`

- [ ] **Step 1: Update the screen test (write the new expectations first)**

Replace the body of `frontend/src/screens/Insights.test.tsx` with:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Insights } from "./Insights";
import type { CategorySpend, MonthlyTotal, Summary } from "../api/types";

const cats: CategorySpend[] = [
  { category_id: 1, name: "Groceries", bucket: "need", spent: 210000 },
  { category_id: 2, name: "Dining", bucket: "want", spent: 80000 },
];
const trend: MonthlyTotal[] = [{ period: "2026-06", spent: 290000, income: 1500000 }];
const summary: Summary = {
  period: "2026-06", income: 1500000, month_progress: 0.5,
  buckets: [], recent: [],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/insights/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
    if (url.includes("/api/summary")) return new Response(JSON.stringify(summary));
    return new Response("[]");
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Insights scope={{ kind: "month", period: "2026-06" }} /></QueryClientProvider>);
}

describe("Insights", () => {
  it("shows the focus month and the comparative summary", async () => {
    wrap();
    expect(await screen.findByText("Jun 2026")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
  it("lists categories by spend with the biggest-changes block", async () => {
    wrap();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Biggest changes")).toBeInTheDocument();
    expect(screen.getByText("By category")).toBeInTheDocument();
  });
});
```

(The fetch mock returns the same `cats` for both the focus-month and previous-month category calls, so deltas are zero — that's fine; the test asserts structure, not specific deltas.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/screens/Insights.test.tsx`
Expected: FAIL — `Insights` still takes `period`, not `scope`; new sections absent.

- [ ] **Step 3: Rewrite the Insights screen**

Replace the entire contents of `frontend/src/screens/Insights.tsx` with:

```tsx
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { CategorySpend, MonthlyTotal, Summary } from "../api/types";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { DonutChart } from "../components/charts/DonutChart";
import { TrendBars } from "../components/charts/TrendBars";
import { ComparativeSummary } from "../components/insights/ComparativeSummary";
import { TopMovers } from "../components/insights/TopMovers";
import { CategoryComparisonList } from "../components/insights/CategoryComparisonList";
import {
  donutSlices, trendSeries, trailingPeriods, currentPeriod, monthLabel,
  categoryDeltas, withShare, bucketComparison, topMovers, savingsRate,
} from "../lib/insights";
import { addMonth, insightsFocus, DEFAULT_SCOPE, type Scope } from "../lib/scope";
import { AlertTriangle } from "lucide-react";

export function Insights({ scope = DEFAULT_SCOPE }: { scope?: Scope }) {
  const focus = insightsFocus(scope);
  const focusMonth = focus.period;
  const prevMonth = addMonth(focusMonth, -1);
  // The 6-month trend is always the trailing 6 real months (matches the static endpoint).
  const periods = trailingPeriods(currentPeriod(), 6);

  const cur = useQuery({ queryKey: ["insights-categories", focusMonth], queryFn: () => getJSON<CategorySpend[]>(`/api/insights/categories?period=${focusMonth}`) });
  const prev = useQuery({ queryKey: ["insights-categories", prevMonth], queryFn: () => getJSON<CategorySpend[]>(`/api/insights/categories?period=${prevMonth}`) });
  const summary = useQuery({ queryKey: ["summary", focusMonth], queryFn: () => getJSON<Summary>(`/api/summary?period=${focusMonth}`) });
  const trend = useQuery({ queryKey: ["insights-trend"], queryFn: () => getJSON<MonthlyTotal[]>("/api/insights/trend?months=6") });

  if (cur.isLoading) return <Skeleton rows={8} />;
  if (cur.isError) return <EmptyState icon={AlertTriangle} title="Couldn't load insights" hint="Check your connection and try again." />;

  const curData = cur.data ?? [];
  const prevData = prev.data ?? [];
  const total = curData.reduce((s, c) => s + c.spent, 0);
  const deltas = categoryDeltas(curData, prevData);
  const listRows = withShare([...deltas].sort((a, b) => b.spent - a.spent), total);
  const movers = topMovers(deltas, 3);
  const buckets = bucketComparison(curData, prevData);
  const income = summary.data?.income ?? 0;
  const savings = savingsRate(income, total);
  const slices = donutSlices(curData);
  const points = trendSeries(trend.data ?? [], periods);
  const label = `${monthLabel(focusMonth)} ${focusMonth.slice(0, 4)}`;

  return (
    <div className="space-y-4">
      <ComparativeSummary label={label} note={focus.note} net={savings.net} savings={savings} buckets={buckets} />
      <TopMovers movers={movers} hasPrev={prevData.length > 0} />
      <Card>
        <p className="text-sm font-medium mb-2">Where the money went</p>
        {slices.length === 0 ? <EmptyState title="No spending this month" /> : <DonutChart slices={slices} centerLabel="Spent" centerValue={total} />}
      </Card>
      <CategoryComparisonList rows={listRows} />
      <Card>
        <p className="text-sm font-medium mb-2">6-month spending trend</p>
        {trend.isError
          ? <p className="text-sm text-muted text-center py-6">Trend unavailable</p>
          : <TrendBars points={points} activePeriod={focusMonth} />}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Update AppShell to pass `scope`**

In `frontend/src/app/AppShell.tsx`, change the Insights render line from:

```tsx
          {tab === "insights" && <Insights period={anchor} />}
```

to:

```tsx
          {tab === "insights" && <Insights scope={scope} />}
```

(`scope` is already in AppShell state; `anchor` stays in use by `Home`.)

- [ ] **Step 5: Run tests + type-check**

Run: `cd frontend && bunx tsc --noEmit && bunx vitest run src/screens/Insights.test.tsx src/app/AppShell.test.tsx`
Expected: no type errors; both files PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens/Insights.tsx frontend/src/screens/Insights.test.tsx frontend/src/app/AppShell.tsx
git commit -m "feat(frontend): rebuild Insights as a comparison view"
```

---

## Task 10: Full verification + rebuild embedded bundle

**Files:**
- Modify: `internal/web/dist/*` (regenerated build artifact)

- [ ] **Step 1: Full frontend suite**

Run: `cd frontend && bun run test`
Expected: all files PASS (existing 101 + the new lib/component/screen tests).

- [ ] **Step 2: Type-check**

Run: `cd frontend && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Re-check main + rebuild the embedded bundle**

Per CLAUDE.md, `internal/web/dist/` is a committed artifact that must match the frontend source. From the worktree root:

```bash
git fetch origin main
cd frontend && bun install && bun run build
```

- [ ] **Step 4: Build the binary to confirm embed + compile**

From the worktree root:

```bash
CGO_ENABLED=0 go build -o /tmp/ledger-insights ./cmd/ledger
```

Expected: builds with no error.

- [ ] **Step 5: Commit the rebuilt bundle**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for Insights redesign"
```

---

## Self-review notes (plan vs spec)

- **Comparative summary** (net + savings rate + bucket strip with deltas) → Task 6 + Task 9. ✓
- **Top movers (signature)** → Task 4 (`topMovers`) + Task 7. ✓
- **Per-category % + MoM delta** → Task 2 (`categoryDeltas`) + Task 3 (`withShare`) + Task 5 (`DeltaBadge`) + Task 8. ✓
- **Savings rate / net** → Task 4 (`savingsRate`) + Task 6. ✓
- **Scope coherence (focus + note)** → Task 1 (`insightsFocus`) + Task 9 (label + note, AppShell passes `scope`). ✓
- **Donut + trend reused, focus highlighted** → Task 9. ✓
- **States + a11y** (Skeleton, EmptyState, "Needs/Wants/Savings", Δ aria-labels, donut label already present) → Tasks 5–9. ✓
- **No backend change** → confirmed; only `/api/insights/categories` (x2), `/api/summary`, `/api/insights/trend`. ✓
- **Out of scope** (drill-down, sort/filter, trend income overlay, net MoM arrow) → not present in any task. ✓
- **Type consistency:** `CategoryDelta`, `BucketComparison`, `SavingsResult`, `InsightsFocus` defined in Tasks 1–4 and consumed with matching shapes in Tasks 5–9. `DeltaBadge` props `{delta, deltaPct, isNew?, isGone?}` consistent across Tasks 5–8. ✓
