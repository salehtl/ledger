# Transaction Filter Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dropdown filter chips (bucket, category, direction, source) to the Transactions screen, filtering the already-loaded rows client-side.

**Architecture:** Pure filter helpers live in `lib/transactions.ts` (unit-testable, no React). A new `FilterChips` component renders one dropdown chip per dimension and opens the existing `ui/Dialog` as a multi-select checklist. `Transactions.tsx` holds the filter state and folds `applyTxnFilters` into its existing `rows` memo, before the search filter. Multi-select is OR within a dimension, AND across dimensions.

**Tech Stack:** React 18 + TypeScript, TanStack Query, Tailwind v4, lucide-react, vitest + @testing-library/react (jsdom). Run frontend tests with `cd frontend && bunx vitest run <file>`.

---

## File Structure

- `frontend/src/lib/transactions.ts` — **modify**: add `TxnFilters`, `EMPTY_FILTERS`, `applyTxnFilters`, `filtersActive`, `sourceLabel`.
- `frontend/src/lib/transactions.test.ts` — **create**: tests for the new helpers.
- `frontend/src/components/transactions/FilterChips.tsx` — **create**: chip row + Dialog checklist.
- `frontend/src/components/transactions/FilterChips.test.tsx` — **create**: component tests.
- `frontend/src/screens/Transactions.tsx` — **modify**: filter state + render `FilterChips` + extend `rows` memo.
- `frontend/src/screens/Transactions.test.tsx` — **modify**: add chip-filtering tests.

---

## Task 1: Filter helpers in `lib/transactions.ts`

**Files:**
- Modify: `frontend/src/lib/transactions.ts`
- Test: `frontend/src/lib/transactions.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/transactions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  applyTxnFilters,
  filtersActive,
  sourceLabel,
  EMPTY_FILTERS,
  type TxnFilters,
} from "./transactions";
import type { Txn } from "../api/types";

const mk = (over: Partial<Txn>): Txn => ({
  ID: 1, PostedAt: "2026-06-10", AmountFils: 1000, Currency: "AED",
  Direction: "debit", MerchantRaw: "X", Status: "confirmed", Confidence: 0,
  Source: "email", CategoryID: null, CategoryName: "", Bucket: "", ...over,
});

const rows: Txn[] = [
  mk({ ID: 1, Bucket: "need", Direction: "debit", CategoryID: 1, Source: "email" }),
  mk({ ID: 2, Bucket: "want", Direction: "debit", CategoryID: 2, Source: "import" }),
  mk({ ID: 3, Bucket: "want", Direction: "credit", CategoryID: null, Source: "ai" }),
];

describe("applyTxnFilters", () => {
  it("returns all rows when filters are empty", () => {
    expect(applyTxnFilters(rows, EMPTY_FILTERS)).toHaveLength(3);
  });

  it("ORs values within a dimension", () => {
    const f: TxnFilters = { ...EMPTY_FILTERS, buckets: ["need", "want"] };
    expect(applyTxnFilters(rows, f).map((t) => t.ID)).toEqual([1, 2, 3]);
  });

  it("ANDs across dimensions", () => {
    const f: TxnFilters = { ...EMPTY_FILTERS, buckets: ["want"], directions: ["debit"] };
    expect(applyTxnFilters(rows, f).map((t) => t.ID)).toEqual([2]);
  });

  it("matches categories by id and excludes null categories", () => {
    const f: TxnFilters = { ...EMPTY_FILTERS, categoryIds: [2] };
    expect(applyTxnFilters(rows, f).map((t) => t.ID)).toEqual([2]);
    const none: TxnFilters = { ...EMPTY_FILTERS, categoryIds: [99] };
    expect(applyTxnFilters(rows, none)).toHaveLength(0);
  });

  it("filters by source", () => {
    const f: TxnFilters = { ...EMPTY_FILTERS, sources: ["ai"] };
    expect(applyTxnFilters(rows, f).map((t) => t.ID)).toEqual([3]);
  });
});

describe("filtersActive", () => {
  it("counts selected values across dimensions", () => {
    expect(filtersActive(EMPTY_FILTERS)).toBe(0);
    expect(filtersActive({ buckets: ["need"], categoryIds: [1, 2], directions: [], sources: ["ai"] })).toBe(4);
  });
});

describe("sourceLabel", () => {
  it("maps known sources", () => {
    expect(sourceLabel("email")).toBe("Email");
    expect(sourceLabel("ai")).toBe("AI");
  });
  it("prettifies unknown sources", () => {
    expect(sourceLabel("import_derived")).toBe("Import Derived");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/transactions.test.ts`
Expected: FAIL — `applyTxnFilters`, `filtersActive`, `sourceLabel`, `EMPTY_FILTERS`, `TxnFilters` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/lib/transactions.ts` (the file already imports `Txn` from `../api/types` and exports `txnTotals`):

```ts
export interface TxnFilters {
  buckets: string[];
  categoryIds: number[];
  directions: string[];
  sources: string[];
}

export const EMPTY_FILTERS: TxnFilters = { buckets: [], categoryIds: [], directions: [], sources: [] };

/** True only when at least one value is selected in any dimension. */
export function filtersActive(f: TxnFilters): number {
  return f.buckets.length + f.categoryIds.length + f.directions.length + f.sources.length;
}

/** OR within a dimension, AND across dimensions. Empty dimensions are skipped. */
export function applyTxnFilters(rows: Txn[], f: TxnFilters): Txn[] {
  return rows.filter((t) => {
    if (f.buckets.length && !f.buckets.includes(t.Bucket)) return false;
    if (f.directions.length && !f.directions.includes(t.Direction)) return false;
    if (f.categoryIds.length && (t.CategoryID === null || !f.categoryIds.includes(t.CategoryID))) return false;
    if (f.sources.length && !f.sources.includes(t.Source)) return false;
    return true;
  });
}

const SOURCE_LABEL: Record<string, string> = {
  email: "Email", import: "Import", import_derived: "Import Derived",
  manual: "Manual", ai: "AI", ai_confirmed: "AI", heuristic: "Heuristic",
  dib: "DIB", enbd: "ENBD", rule: "Rule",
};

/** Friendly label for a transaction source string; prettifies unknown values. */
export function sourceLabel(s: string): string {
  if (SOURCE_LABEL[s]) return SOURCE_LABEL[s];
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/transactions.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/transactions.ts frontend/src/lib/transactions.test.ts
git commit -m "feat(frontend): pure txn filter helpers (applyTxnFilters, sourceLabel)"
```

---

## Task 2: `FilterChips` component

**Files:**
- Create: `frontend/src/components/transactions/FilterChips.tsx`
- Test: `frontend/src/components/transactions/FilterChips.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/transactions/FilterChips.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterChips } from "./FilterChips";
import { EMPTY_FILTERS, type TxnFilters } from "../../lib/transactions";
import type { Category, Txn } from "../../api/types";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];
const txns: Txn[] = [
  { ID: 1, PostedAt: "2026-06-10", AmountFils: 1000, Currency: "AED", Direction: "debit", MerchantRaw: "X", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 1, CategoryName: "Groceries", Bucket: "need" },
  { ID: 2, PostedAt: "2026-06-09", AmountFils: 2000, Currency: "AED", Direction: "credit", MerchantRaw: "Y", Status: "confirmed", Confidence: 0, Source: "ai", CategoryID: 2, CategoryName: "Dining", Bucket: "want" },
];

function setup(filters: TxnFilters = EMPTY_FILTERS) {
  const onChange = vi.fn();
  render(<FilterChips filters={filters} categories={cats} txns={txns} onChange={onChange} />);
  return { onChange };
}

describe("FilterChips", () => {
  it("renders a chip per dimension", () => {
    setup();
    expect(screen.getByRole("button", { name: /bucket/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /category/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /direction/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /source/i })).toBeInTheDocument();
  });

  it("opens a picker and toggling a value calls onChange", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /bucket/i }));
    fireEvent.click(screen.getByLabelText("Needs"));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, buckets: ["need"] });
  });

  it("derives source options from the loaded rows", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /source/i }));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("AI")).toBeInTheDocument();
  });

  it("maps category checkbox to its numeric id", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /category/i }));
    fireEvent.click(screen.getByLabelText("Dining"));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, categoryIds: [2] });
  });

  it("shows a count on an active chip and a Clear-all that resets", () => {
    const { onChange } = setup({ ...EMPTY_FILTERS, buckets: ["need", "want"] });
    expect(screen.getByRole("button", { name: /bucket · 2/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTERS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/transactions/FilterChips.test.tsx`
Expected: FAIL — `./FilterChips` has no `FilterChips` export.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/components/transactions/FilterChips.tsx`:

```tsx
import { useMemo, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { EMPTY_FILTERS, filtersActive, sourceLabel, type TxnFilters } from "../../lib/transactions";
import type { Category, Txn } from "../../api/types";

type Dim = "bucket" | "category" | "direction" | "source";

const BUCKET_OPTS = [
  { value: "need", label: "Needs" },
  { value: "want", label: "Wants" },
  { value: "saving", label: "Savings" },
];
const DIRECTION_OPTS = [
  { value: "debit", label: "Spending" },
  { value: "credit", label: "Income" },
];

interface DimConfig {
  key: Dim;
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}

export function FilterChips({ filters, categories, txns, onChange }: {
  filters: TxnFilters;
  categories: Category[];
  txns: Txn[];
  onChange: (f: TxnFilters) => void;
}) {
  const [open, setOpen] = useState<Dim | null>(null);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const t of txns) if (t.Source) set.add(t.Source);
    return [...set].sort();
  }, [txns]);

  const dims: DimConfig[] = [
    {
      key: "bucket", label: "Bucket", options: BUCKET_OPTS,
      selected: filters.buckets,
      onChange: (next) => onChange({ ...filters, buckets: next }),
    },
    {
      key: "category", label: "Category",
      options: categories.filter((c) => c.IsActive).map((c) => ({ value: String(c.ID), label: c.Name })),
      selected: filters.categoryIds.map(String),
      onChange: (next) => onChange({ ...filters, categoryIds: next.map(Number) }),
    },
    {
      key: "direction", label: "Direction", options: DIRECTION_OPTS,
      selected: filters.directions,
      onChange: (next) => onChange({ ...filters, directions: next }),
    },
    {
      key: "source", label: "Source",
      options: sources.map((s) => ({ value: s, label: sourceLabel(s) })),
      selected: filters.sources,
      onChange: (next) => onChange({ ...filters, sources: next }),
    },
  ];

  const current = dims.find((d) => d.key === open) ?? null;
  const active = filtersActive(filters);

  const toggle = (dim: DimConfig, value: string) => {
    const next = dim.selected.includes(value)
      ? dim.selected.filter((v) => v !== value)
      : [...dim.selected, value];
    dim.onChange(next);
  };

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {dims.map((d) => {
        const count = d.selected.length;
        return (
          <button
            key={d.key}
            onClick={() => setOpen(d.key)}
            aria-expanded={open === d.key}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-full border text-sm font-medium whitespace-nowrap transition-colors ${
              count > 0 ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface text-fg"
            }`}
          >
            {d.label}{count > 0 ? ` · ${count}` : ""}
            <ChevronDown size={14} aria-hidden />
          </button>
        );
      })}

      {active > 0 && (
        <button
          onClick={() => onChange(EMPTY_FILTERS)}
          className="flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium text-muted whitespace-nowrap hover:text-fg"
        >
          <X size={14} aria-hidden /> Clear
        </button>
      )}

      {current && (
        <Dialog title={current.label} onClose={() => setOpen(null)}>
          {current.options.length === 0 ? (
            <p className="text-sm text-muted py-2">No options available.</p>
          ) : (
            <ul className="space-y-1">
              {current.options.map((o) => (
                <li key={o.value}>
                  <label className="flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-bg cursor-pointer">
                    <input
                      type="checkbox"
                      checked={current.selected.includes(o.value)}
                      onChange={() => toggle(current, o.value)}
                      className="h-4 w-4 accent-accent"
                    />
                    <span className="text-sm">{o.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between items-center pt-3 mt-2 border-t border-border">
            <button
              onClick={() => current.onChange([])}
              disabled={current.selected.length === 0}
              className="text-sm text-muted disabled:opacity-40"
            >
              Clear
            </button>
            <button
              onClick={() => setOpen(null)}
              className="px-4 py-1.5 rounded-lg bg-accent text-accent-fg text-sm font-medium"
            >
              Done
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/transactions/FilterChips.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/transactions/FilterChips.tsx frontend/src/components/transactions/FilterChips.test.tsx
git commit -m "feat(frontend): FilterChips dropdown multi-select component"
```

---

## Task 3: Wire `FilterChips` into the Transactions screen

**Files:**
- Modify: `frontend/src/screens/Transactions.tsx`
- Test: `frontend/src/screens/Transactions.test.tsx`

- [ ] **Step 1: Write the failing test**

Add these tests inside the `describe("Transactions", …)` block in `frontend/src/screens/Transactions.test.tsx` (after the existing `client-filters by search text` test). They rely on the existing `all` fixture (SPINNEYS = needs_review/debit/no-category; NETFLIX = confirmed/debit/want/category 2):

```tsx
  it("filters by bucket via the chip picker", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /^bucket/i }));
    fireEvent.click(screen.getByLabelText("Wants"));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
  });

  it("ANDs a bucket chip with a direction chip", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /^bucket/i }));
    fireEvent.click(screen.getByLabelText("Wants"));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /^direction/i }));
    fireEvent.click(screen.getByLabelText("Income")); // credit — NETFLIX is debit
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.queryByText("NETFLIX")).not.toBeInTheDocument();
    expect(await screen.findByText(/no transactions/i)).toBeInTheDocument();
  });

  it("Clear restores all rows", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /^bucket/i }));
    fireEvent.click(screen.getByLabelText("Wants"));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: FAIL — no `Bucket` chip button exists yet (`Unable to find role="button" name /^bucket/i`).

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/screens/Transactions.tsx`:

1. Add the import alongside the other component imports:

```tsx
import { FilterChips } from "../components/transactions/FilterChips";
```

2. Extend the lib import (currently `import { txnTotals } from "../lib/transactions";`) to:

```tsx
import { txnTotals, applyTxnFilters, EMPTY_FILTERS, type TxnFilters } from "../lib/transactions";
```

3. Add filter state next to the existing `search` state (after the `const [search, setSearch] = useState("");` line):

```tsx
  const [filters, setFilters] = useState<TxnFilters>(EMPTY_FILTERS);
```

4. Replace the existing `rows` memo:

```tsx
  const rows = useMemo(() => {
    const data = q.data ?? [];
    const term = search.trim().toLowerCase();
    return term ? data.filter((t) => (t.MerchantRaw || "").toLowerCase().includes(term)) : data;
  }, [q.data, search]);
```

with:

```tsx
  const rows = useMemo(() => {
    let data = applyTxnFilters(q.data ?? [], filters);
    const term = search.trim().toLowerCase();
    if (term) data = data.filter((t) => (t.MerchantRaw || "").toLowerCase().includes(term));
    return data;
  }, [q.data, search, filters]);
```

5. Render `FilterChips` directly after the search `</div>` (the block that closes the `relative` search wrapper), before the `{q.isError ? …}` block:

```tsx
      <FilterChips filters={filters} categories={cats.data ?? []} txns={q.data ?? []} onChange={setFilters} />
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: PASS (original 4 tests + 3 new = 7).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/Transactions.tsx frontend/src/screens/Transactions.test.tsx
git commit -m "feat(frontend): wire FilterChips into Transactions screen"
```

---

## Task 4: Full verification + rebuild embedded bundle

**Files:**
- Modify: `internal/web/dist/` (rebuilt artifact)

- [ ] **Step 1: Run the full frontend test suite**

Run: `cd frontend && bun run test`
Expected: PASS — all files green, including the new `transactions.test.ts`, `FilterChips.test.tsx`, and updated `Transactions.test.tsx`.

- [ ] **Step 2: Typecheck / build the frontend**

Run: `cd frontend && bun run build`
Expected: build succeeds with no TypeScript errors; assets emitted to `internal/web/dist/`.

(Per CLAUDE.md, `internal/web/dist/` is a committed build artifact and parallel sessions run on `main`, so the embedded bundle must match source before finishing.)

- [ ] **Step 3: Build the Go binary to confirm the embed still compiles**

Run: `cd /root/Coding/ledger && CGO_ENABLED=0 go build -o ledger ./cmd/ledger`
Expected: builds with no errors.

- [ ] **Step 4: Commit the rebuilt bundle**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for transaction filter chips"
```

---

## Self-Review Notes

- **Spec coverage:** bucket/category/direction/source chips (Task 2), OR-within / AND-across + null-category (Task 1), Dialog picker reuse (Task 2), status SegmentedControl untouched (Task 3 only adds below search), client-side compose with search (Task 3), per-dimension + global Clear (Task 2), derived sources with friendly labels (Tasks 1–2). All covered.
- **Type consistency:** `TxnFilters` shape (`buckets`/`categoryIds`/`directions`/`sources`) is identical across `lib/transactions.ts`, `FilterChips.tsx`, and `Transactions.tsx`. `applyTxnFilters`, `filtersActive`, `sourceLabel`, `EMPTY_FILTERS` names match between definition (Task 1) and use (Tasks 2–3).
- **No placeholders:** every code/test step contains complete code and an exact run command.
