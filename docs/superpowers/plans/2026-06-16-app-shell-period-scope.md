# App Shell + Global Period Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the PWA into a fixed top-bar + scrollable-middle + fixed bottom-tab shell sized with `svh`, and replace the per-screen month controls with one global period scope (single month, month range, or all time) chosen from a mobile-friendly bottom sheet.

**Architecture:** `AppShell` owns a `Scope` state and renders a shared `TopBar` (page title + period control) above a scrollable `<main>` above the (now-unfixed) `BottomNav`, all inside a `h-[100svh]` flex column. The period control opens a `PeriodSheet` (built on the existing `Dialog`). Pure scope math lives in `lib/scope.ts`. Screens become presentational: Home/Insights take a `period` (anchor month) prop; Transactions takes `from`/`to` bounds props. Each screen drops its own `<h1>` and selector.

**Tech Stack:** React 18 + TypeScript, TanStack Query, Tailwind v4 (CSS-first tokens in `frontend/src/styles/app.css`), lucide-react, vitest + Testing Library.

---

## Design rationale (frontend-design)

Harmonize within the established system; spend boldness on one signature.

**Color / Type** — reuse existing tokens (`--color-accent #4f46e5`, `--color-surface`, `--color-bg`, `--color-border`, `--color-muted`, bucket colors) and `--font-sans`. The page title drops from `text-xl` to `text-base font-semibold` to keep the top bar's vertical footprint small; money/numbers keep `.tnum`.

**Layout** — a three-zone flex shell:

```
┌──────────────────────────────────────┐  ← TopBar (shrink-0, ~48px, border-b)
│ Transactions          ‹ Jun 2026 ›    │     title left · period control right
├──────────────────────────────────────┤
│                                        │  ← main (flex-1, min-h-0,
│   …scrollable screen content…          │     overflow-y-auto, overscroll-contain)
│                                        │
├──────────────────────────────────────┤  ← BottomNav (shrink-0, border-t,
│  Home   Transactions  Insights  ⚙     │     safe-area pb)
└──────────────────────────────────────┘
   whole shell = h-[100svh] overflow-hidden
```

`svh` (small viewport height) means the shell is sized to the viewport **with** browser chrome visible, so the bottom tabs never hide behind a mobile URL bar. `min-h-0` on `<main>` is required for a flex child to actually scroll.

**Signature** — the **PeriodSheet**: presets + year stepper + 12-month grid where tapping two months forms a range. It's the one memorable, tactile element; the top bar around it stays quiet (just chevrons + a label).

**Why not the obvious default** — the template answer is a native `<input type="month">` (what Transactions has today) or a plain `<select>` (what Home has today). Both are single-month only and feel like form controls, not a budgeting instrument. The grid-with-range sheet is specific to this brief's "let users specify a range/all."

**Copy** — the control reads as the current period (`June 2026`, `Mar–Jun 2026`, `All time`); the sheet's commit button says **Show** (it shows that period); presets use plain labels (This month, Last 3 months, Year to date, All time).

---

## File structure

**Create:**
- `frontend/src/lib/scope.ts` — `Scope` type + pure helpers (`addMonth`, `normalizeRange`, `scopeBounds`, `scopeAnchor`, `scopeLabel`, `DEFAULT_SCOPE`).
- `frontend/src/lib/scope.test.ts`
- `frontend/src/components/ui/PeriodSheet.tsx` — the period picker (presets + year stepper + month grid + range).
- `frontend/src/components/ui/PeriodSheet.test.tsx`
- `frontend/src/components/ui/TopBar.tsx` — title + period control; opens PeriodSheet.
- `frontend/src/components/ui/TopBar.test.tsx`

**Modify:**
- `frontend/src/app/AppShell.tsx` — shell layout + `Scope` state + wiring.
- `frontend/src/app/AppShell.test.tsx` — keep green; add a period-scope smoke test.
- `frontend/src/components/ui/BottomNav.tsx` — unfix (flex child).
- `frontend/src/screens/Home.tsx` (+ test stays green) — `period` prop; drop `<h1>` + `<select>`.
- `frontend/src/screens/Insights.tsx` (+ test stays green) — `period` prop; drop `<h1>`.
- `frontend/src/screens/Transactions.tsx` (+ test rewrite) — `from`/`to` props; drop month input, "This month/All time" toggle, `<h1>`; simplify the summary bar.
- `frontend/src/screens/Settings.tsx` — drop `<h1>` (TopBar provides the title).

Existing pure helpers in `lib/insights.ts` (`currentPeriod`, `monthLabel`) and `lib/transactions.ts` (`monthRange`, `txnTotals`) are reused, not duplicated.

---

## Task 1: `lib/scope.ts` — scope model + pure helpers

**Files:**
- Create: `frontend/src/lib/scope.ts`
- Test: `frontend/src/lib/scope.test.ts`

- [ ] **Step 1: Write the failing test** — `frontend/src/lib/scope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addMonth, normalizeRange, scopeBounds, scopeAnchor, scopeLabel } from "./scope";
import { currentPeriod } from "./insights";

describe("addMonth", () => {
  it("steps within and across year boundaries", () => {
    expect(addMonth("2026-06", 1)).toBe("2026-07");
    expect(addMonth("2026-06", -1)).toBe("2026-05");
    expect(addMonth("2026-12", 1)).toBe("2027-01");
    expect(addMonth("2026-01", -1)).toBe("2025-12");
  });
});

describe("normalizeRange", () => {
  it("orders the two endpoints ascending", () => {
    expect(normalizeRange("2026-06", "2026-03")).toEqual({ from: "2026-03", to: "2026-06" });
    expect(normalizeRange("2026-03", "2026-06")).toEqual({ from: "2026-03", to: "2026-06" });
  });
});

describe("scopeBounds", () => {
  it("brackets a single month", () => {
    expect(scopeBounds({ kind: "month", period: "2026-06" })).toEqual({ from: "2026-06-01", to: "2026-06-32" });
  });
  it("brackets a range from first day to last-plus-one day", () => {
    expect(scopeBounds({ kind: "range", from: "2026-03", to: "2026-06" })).toEqual({ from: "2026-03-01", to: "2026-06-32" });
  });
  it("returns no bounds for all time", () => {
    expect(scopeBounds({ kind: "all" })).toEqual({});
  });
});

describe("scopeAnchor", () => {
  it("is the month itself, the range end, or the current month for all", () => {
    expect(scopeAnchor({ kind: "month", period: "2026-04" })).toBe("2026-04");
    expect(scopeAnchor({ kind: "range", from: "2026-03", to: "2026-06" })).toBe("2026-06");
    expect(scopeAnchor({ kind: "all" })).toBe(currentPeriod());
  });
});

describe("scopeLabel", () => {
  it("labels a single month", () => {
    expect(scopeLabel({ kind: "month", period: "2026-06" })).toBe("Jun 2026");
  });
  it("labels a same-year range compactly", () => {
    expect(scopeLabel({ kind: "range", from: "2026-03", to: "2026-06" })).toBe("Mar–Jun 2026");
  });
  it("labels a cross-year range with both years", () => {
    expect(scopeLabel({ kind: "range", from: "2025-12", to: "2026-02" })).toBe("Dec 2025 – Feb 2026");
  });
  it("labels all time", () => {
    expect(scopeLabel({ kind: "all" })).toBe("All time");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && bunx vitest run src/lib/scope.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `frontend/src/lib/scope.ts`:

```ts
import { currentPeriod, monthLabel } from "./insights";
import { monthRange } from "./transactions";

/** The app-wide time scope. Periods are "YYYY-MM". */
export type Scope =
  | { kind: "month"; period: string }
  | { kind: "range"; from: string; to: string } // from <= to
  | { kind: "all" };

export const DEFAULT_SCOPE: Scope = { kind: "month", period: currentPeriod() };

/** Add `delta` months to a "YYYY-MM" period (UTC-safe, wraps years). */
export function addMonth(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Order two periods ascending. */
export function normalizeRange(a: string, b: string): { from: string; to: string } {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/**
 * Inclusive query bounds for the transactions list. month/range reuse the
 * day-"32" upper bound (see monthRange) so timestamped posted_at on the last
 * day still matches; "all" returns no bounds.
 */
export function scopeBounds(scope: Scope): { from?: string; to?: string } {
  if (scope.kind === "all") return {};
  if (scope.kind === "month") return monthRange(scope.period);
  return { from: `${scope.from}-01`, to: `${scope.to}-32` };
}

/** The single month the monthly views (Home, Insights) should show. */
export function scopeAnchor(scope: Scope): string {
  if (scope.kind === "month") return scope.period;
  if (scope.kind === "range") return scope.to;
  return currentPeriod();
}

/** Human label: "Jun 2026" · "Mar–Jun 2026" · "Dec 2025 – Feb 2026" · "All time". */
export function scopeLabel(scope: Scope): string {
  if (scope.kind === "all") return "All time";
  if (scope.kind === "month") return `${monthLabel(scope.period)} ${scope.period.slice(0, 4)}`;
  const fy = scope.from.slice(0, 4), ty = scope.to.slice(0, 4);
  return fy === ty
    ? `${monthLabel(scope.from)}–${monthLabel(scope.to)} ${ty}`
    : `${monthLabel(scope.from)} ${fy} – ${monthLabel(scope.to)} ${ty}`;
}
```

- [ ] **Step 4: Run to verify it passes** — `cd frontend && bunx vitest run src/lib/scope.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/lib/scope.ts frontend/src/lib/scope.test.ts
git commit -m "feat(frontend): add global period scope model + helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `PeriodSheet` — mobile period picker

**Files:**
- Create: `frontend/src/components/ui/PeriodSheet.tsx`
- Test: `frontend/src/components/ui/PeriodSheet.test.tsx`

Depends on Task 1 and the existing `Dialog` (`frontend/src/components/ui/Dialog.tsx`) + `Button` (`frontend/src/components/ui/Button.tsx`).

- [ ] **Step 1: Write the failing test** — `frontend/src/components/ui/PeriodSheet.test.tsx`:

```ts
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PeriodSheet } from "./PeriodSheet";
import { currentPeriod } from "../../lib/insights";
import type { Scope } from "../../lib/scope";

function open(onApply: (s: Scope) => void) {
  render(<PeriodSheet scope={{ kind: "month", period: "2026-06" }} onApply={onApply} onClose={() => {}} />);
}

describe("PeriodSheet", () => {
  it("offers quick presets", () => {
    open(() => {});
    expect(screen.getByRole("button", { name: /this month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /last 3 months/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /year to date/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /all time/i })).toBeInTheDocument();
  });

  it("applies This month as a single-month scope", () => {
    const onApply = vi.fn();
    open(onApply);
    fireEvent.click(screen.getByRole("button", { name: /this month/i }));
    expect(onApply).toHaveBeenCalledWith({ kind: "month", period: currentPeriod() });
  });

  it("applies All time", () => {
    const onApply = vi.fn();
    open(onApply);
    fireEvent.click(screen.getByRole("button", { name: /all time/i }));
    expect(onApply).toHaveBeenCalledWith({ kind: "all" });
  });

  it("picks a single month from the grid", () => {
    const onApply = vi.fn();
    open(onApply); // seeded to year 2026
    fireEvent.click(screen.getByRole("button", { name: "Mar" }));
    fireEvent.click(screen.getByRole("button", { name: /^show$/i }));
    expect(onApply).toHaveBeenCalledWith({ kind: "month", period: "2026-03" });
  });

  it("forms a range from two grid taps", () => {
    const onApply = vi.fn();
    open(onApply);
    fireEvent.click(screen.getByRole("button", { name: "Mar" }));
    fireEvent.click(screen.getByRole("button", { name: "Jun" }));
    fireEvent.click(screen.getByRole("button", { name: /^show$/i }));
    expect(onApply).toHaveBeenCalledWith({ kind: "range", from: "2026-03", to: "2026-06" });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && bunx vitest run src/components/ui/PeriodSheet.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement** — `frontend/src/components/ui/PeriodSheet.tsx`:

```tsx
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { type Scope, addMonth, normalizeRange } from "../../lib/scope";
import { currentPeriod, monthLabel } from "../../lib/insights";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function PeriodSheet({ scope, onApply, onClose }: {
  scope: Scope;
  onApply: (s: Scope) => void;
  onClose: () => void;
}) {
  const seed = scope.kind === "month" ? scope.period : scope.kind === "range" ? scope.to : currentPeriod();
  const [year, setYear] = useState(Number(seed.slice(0, 4)));
  const [from, setFrom] = useState<string | null>(
    scope.kind === "month" ? scope.period : scope.kind === "range" ? scope.from : null,
  );
  const [to, setTo] = useState<string | null>(
    scope.kind === "month" ? scope.period : scope.kind === "range" ? scope.to : null,
  );

  // First tap starts a single selection; the next tap closes a range; a tap
  // after a complete range starts over.
  const pick = (period: string) => {
    if (from === null || to !== null) {
      setFrom(period);
      setTo(null);
    } else {
      const r = normalizeRange(from, period);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  const inSel = (period: string) => (from && to ? period >= from && period <= to : period === from);

  const show = () => {
    if (from && to) onApply(from === to ? { kind: "month", period: from } : { kind: "range", from, to });
    else if (from) onApply({ kind: "month", period: from });
  };

  const hint =
    from && to && from !== to
      ? `${monthLabel(from)}–${monthLabel(to)} selected`
      : from
        ? "Tap a second month for a range"
        : "Pick a month";

  return (
    <Dialog title="Choose period" onClose={onClose}>
      <div className="flex flex-wrap gap-2 mb-4">
        <Button variant="secondary" onClick={() => onApply({ kind: "month", period: currentPeriod() })}>This month</Button>
        <Button variant="secondary" onClick={() => onApply({ kind: "range", from: addMonth(currentPeriod(), -2), to: currentPeriod() })}>Last 3 months</Button>
        <Button variant="secondary" onClick={() => onApply({ kind: "range", from: `${currentPeriod().slice(0, 4)}-01`, to: currentPeriod() })}>Year to date</Button>
        <Button variant="secondary" onClick={() => onApply({ kind: "all" })}>All time</Button>
      </div>

      <div className="flex items-center justify-between mb-3">
        <button aria-label="Previous year" className="p-2 rounded-lg text-muted hover:bg-bg" onClick={() => setYear((y) => y - 1)}><ChevronLeft size={18} /></button>
        <span className="text-sm font-semibold tnum">{year}</span>
        <button aria-label="Next year" className="p-2 rounded-lg text-muted hover:bg-bg" onClick={() => setYear((y) => y + 1)}><ChevronRight size={18} /></button>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        {MONTHS.map((m, i) => {
          const period = `${year}-${String(i + 1).padStart(2, "0")}`;
          const selected = inSel(period);
          const isCurrent = period === currentPeriod();
          return (
            <button
              key={m}
              onClick={() => pick(period)}
              aria-pressed={selected}
              className={`min-h-11 rounded-xl text-sm font-medium transition-colors ${
                selected ? "bg-accent text-accent-fg" : isCurrent ? "bg-bg text-fg ring-1 ring-accent/40" : "bg-bg text-fg hover:bg-border/60"
              }`}
            >
              {m}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">{hint}</p>
        <Button variant="primary" disabled={!from} onClick={show}>Show</Button>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run to verify it passes** — `cd frontend && bunx vitest run src/components/ui/PeriodSheet.test.tsx` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/ui/PeriodSheet.tsx frontend/src/components/ui/PeriodSheet.test.tsx
git commit -m "feat(frontend): add PeriodSheet period picker (presets, year grid, range)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `TopBar` — title + period control

**Files:**
- Create: `frontend/src/components/ui/TopBar.tsx`
- Test: `frontend/src/components/ui/TopBar.test.tsx`

- [ ] **Step 1: Write the failing test** — `frontend/src/components/ui/TopBar.test.tsx`:

```ts
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "./TopBar";

describe("TopBar", () => {
  it("renders the page title", () => {
    render(<TopBar title="Transactions" scope={{ kind: "month", period: "2026-06" }} onScopeChange={() => {}} showScope />);
    expect(screen.getByRole("heading", { name: "Transactions" })).toBeInTheDocument();
  });

  it("shows the period label and steps months with the chevrons", () => {
    const onScopeChange = vi.fn();
    render(<TopBar title="Home" scope={{ kind: "month", period: "2026-06" }} onScopeChange={onScopeChange} showScope />);
    expect(screen.getByRole("button", { name: /jun 2026/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(onScopeChange).toHaveBeenCalledWith({ kind: "month", period: "2026-05" });
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(onScopeChange).toHaveBeenCalledWith({ kind: "month", period: "2026-07" });
  });

  it("hides the period control when showScope is false", () => {
    render(<TopBar title="Settings" scope={{ kind: "all" }} onScopeChange={() => {}} showScope={false} />);
    expect(screen.queryByRole("button", { name: /all time/i })).not.toBeInTheDocument();
  });

  it("opens the period sheet when the label is tapped", () => {
    render(<TopBar title="Home" scope={{ kind: "month", period: "2026-06" }} onScopeChange={() => {}} showScope />);
    fireEvent.click(screen.getByRole("button", { name: /jun 2026/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/choose period/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && bunx vitest run src/components/ui/TopBar.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement** — `frontend/src/components/ui/TopBar.tsx`:

```tsx
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type Scope, addMonth, scopeLabel } from "../../lib/scope";
import { PeriodSheet } from "./PeriodSheet";

export function TopBar({ title, scope, onScopeChange, showScope }: {
  title: string;
  scope: Scope;
  onScopeChange: (s: Scope) => void;
  showScope: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isMonth = scope.kind === "month";

  return (
    <header className="shrink-0 bg-surface border-b border-border pt-[env(safe-area-inset-top)]">
      <div className="min-h-[48px] px-4 flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold truncate">{title}</h1>
        {showScope && (
          <div className="flex items-center gap-0.5">
            {isMonth && (
              <button
                aria-label="Previous month"
                onClick={() => onScopeChange({ kind: "month", period: addMonth(scope.period, -1) })}
                className="p-1.5 rounded-lg text-muted hover:bg-bg"
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <button
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-bg text-fg tnum truncate"
            >
              {scopeLabel(scope)}
            </button>
            {isMonth && (
              <button
                aria-label="Next month"
                onClick={() => onScopeChange({ kind: "month", period: addMonth(scope.period, 1) })}
                className="p-1.5 rounded-lg text-muted hover:bg-bg"
              >
                <ChevronRight size={18} />
              </button>
            )}
          </div>
        )}
      </div>
      {open && (
        <PeriodSheet
          scope={scope}
          onApply={(s) => { onScopeChange(s); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </header>
  );
}
```

- [ ] **Step 4: Run to verify it passes** — `cd frontend && bunx vitest run src/components/ui/TopBar.test.tsx` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/ui/TopBar.tsx frontend/src/components/ui/TopBar.test.tsx
git commit -m "feat(frontend): add TopBar with title + global period control

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Restructure `AppShell` + unfix `BottomNav` + drop Settings `<h1>`

**Files:**
- Modify: `frontend/src/app/AppShell.tsx`
- Modify: `frontend/src/components/ui/BottomNav.tsx`
- Modify: `frontend/src/screens/Settings.tsx`
- Modify: `frontend/src/app/AppShell.test.tsx`

This task wires the shell but the screens still take their *old* prop shapes (Home/Insights ignore an extra `period`; Transactions ignores extra `from`/`to`). Tasks 5–7 make the screens consume them. To keep TypeScript happy in between, pass the new props now — the screens already accept extra props loosely? No: TS will error on unknown props. **Therefore Task 4 must land together with Tasks 5–7 before the build is green.** Implement Task 4's code, then immediately proceed through Tasks 5–7; run the full build at the end of Task 7. Within Task 4, only run the AppShell test file (which renders through the real screens) *after* Tasks 5–7 — see Task 7 Step. For now, after editing, run `bunx tsc` expecting the known prop errors that Tasks 5–7 resolve.

> Note for the executor: Tasks 4–7 are one coupled change (lifting state up). Do them back-to-back; the single green checkpoint is at the end of Task 7. Commit each task separately for history, but don't expect a green full build until Task 7.

- [ ] **Step 1: Unfix `BottomNav`** — in `frontend/src/components/ui/BottomNav.tsx`, change the `<nav>` className from:

```tsx
    <nav className="fixed bottom-0 inset-x-0 z-30 bg-surface border-t border-border grid grid-cols-4 pb-[env(safe-area-inset-bottom)]">
```

to:

```tsx
    <nav className="shrink-0 bg-surface border-t border-border grid grid-cols-4 pb-[env(safe-area-inset-bottom)]">
```

(It becomes a normal flex child of the shell instead of a fixed overlay. Everything else in the file is unchanged.)

- [ ] **Step 2: Drop the Settings page heading** — in `frontend/src/screens/Settings.tsx`, delete the line:

```tsx
      <h1 className="text-xl font-semibold">Settings</h1>
```

(The TopBar now renders the "Settings" title. Leave the rest, including the `<h2>Swipe Directions</h2>` subsection, untouched.)

- [ ] **Step 3: Rewrite `AppShell.tsx`** — replace the whole file with:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Txn } from "../api/types";
import { BottomNav } from "../components/ui/BottomNav";
import { TopBar } from "../components/ui/TopBar";
import { type TabId } from "./nav";
import { type Scope, DEFAULT_SCOPE, scopeBounds, scopeAnchor } from "../lib/scope";
import { useOnline } from "../hooks/useOnline";
import { useLiveEvents } from "../hooks/useLiveEvents";
import { Home } from "../screens/Home";
import { Transactions } from "../screens/Transactions";
import { Insights } from "../screens/Insights";
import { Settings } from "../screens/Settings";
import { ReviewSwipe } from "../screens/ReviewSwipe";

const TITLES: Record<TabId, string> = {
  home: "Home",
  transactions: "Transactions",
  insights: "Insights",
  settings: "Settings",
};

export function AppShell() {
  const [tab, setTab] = useState<TabId>("home");
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  const [inSwipeMode, setInSwipeMode] = useState(false);
  const online = useOnline();
  useLiveEvents();

  const review = useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") });
  const reviewCount = review.data?.length ?? 0;

  const bounds = scopeBounds(scope);
  const anchor = scopeAnchor(scope);

  return (
    <div className="flex flex-col h-[100svh] overflow-hidden">
      <TopBar title={TITLES[tab]} scope={scope} onScopeChange={setScope} showScope={tab !== "settings"} />
      {!online && (
        <div role="status" className="shrink-0 bg-warn/15 text-warn text-sm text-center py-1">Offline — showing last loaded data</div>
      )}
      <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="max-w-screen-sm w-full mx-auto px-4 py-4">
          {tab === "home" && <Home period={anchor} />}
          {tab === "transactions" && <Transactions from={bounds.from} to={bounds.to} onOpenSwipeMode={() => setInSwipeMode(true)} />}
          {tab === "insights" && <Insights period={anchor} />}
          {tab === "settings" && <Settings />}
        </div>
      </main>
      <BottomNav active={tab} reviewCount={reviewCount} onNavigate={setTab} />
      {inSwipeMode && <ReviewSwipe onClose={() => setInSwipeMode(false)} />}
    </div>
  );
}
```

- [ ] **Step 4: Add a period-scope smoke test** — in `frontend/src/app/AppShell.test.tsx`, add this test inside the `describe("AppShell", ...)` block (after the existing two):

```ts
  it("exposes the global period control and opens the picker", async () => {
    wrap();
    // The TopBar shows the current month as a tappable label; tapping opens the sheet.
    const label = screen.getByRole("button", { name: /\d{4}/ }); // e.g. "Jun 2026"
    fireEvent.click(label);
    expect(await screen.findByText(/choose period/i)).toBeInTheDocument();
  });
```

- [ ] **Step 5: Commit** (build not yet green — continue to Tasks 5–7)

```bash
cd /root/Coding/ledger
git add frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx frontend/src/components/ui/BottomNav.tsx frontend/src/screens/Settings.tsx
git commit -m "feat(frontend): three-zone svh shell with global TopBar period control

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Home — accept `period` prop, drop header + selector

**Files:**
- Modify: `frontend/src/screens/Home.tsx`

Home currently owns `const [period, setPeriod] = useState(currentPeriod())` and renders an `<h1>` + `<select>` period selector (around lines 33–63). The period now comes from the shell.

- [ ] **Step 1: Change the signature and remove local period state** — in `frontend/src/screens/Home.tsx`:

Replace the function signature:

```tsx
export function Home() {
  const [period, setPeriod] = useState(currentPeriod());
  const periods = trailingPeriods(period, 6);
```

with:

```tsx
export function Home({ period = currentPeriod() }: { period?: string }) {
```

(Removes local `period` state and the now-unused `periods`/`trailingPeriods`. The `period` default keeps the standalone unit test rendering the current month.)

- [ ] **Step 2: Delete the period-selector header block** — remove the entire header `<div>` that renders the `<h1>` + `<select>` (the block starting with the comment `{/* period selector */}` and ending at its closing `</div>`, i.e. the title row with the `<select aria-label="Period">`). The title now lives in the TopBar.

- [ ] **Step 3: Clean up imports** — remove `trailingPeriods` from the `../lib/insights` import (it's no longer used). Keep `monthLabel`, `currentPeriod`, `bucketColor`, etc. that remain referenced. Remove the `useState` import only if nothing else uses it (Home still uses `useState`? It does not after this change — verify and remove `import { useState } from "react"` if unused). Keep `useQuery`.

  Note: the `heroLabel` and `recent`-card logic that compare against `currentPeriod()` still work — `period` is now a prop.

- [ ] **Step 4: Verify the Home test still passes** — `cd frontend && bunx vitest run src/screens/Home.test.tsx` → PASS (the default `period = currentPeriod()` makes the "recent" card render, satisfying the SPINNEYS assertion).

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/screens/Home.tsx
git commit -m "refactor(frontend): Home takes period prop, drops its own header/selector

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Insights — accept `period` prop, drop header

**Files:**
- Modify: `frontend/src/screens/Insights.tsx`

Insights currently has `const [period] = useState(currentPeriod())` and an `<h1>Insights · {monthLabel(period)}</h1>`.

- [ ] **Step 1: Change the signature** — replace:

```tsx
export function Insights() {
  const [period] = useState(currentPeriod());
```

with:

```tsx
export function Insights({ period = currentPeriod() }: { period?: string }) {
```

- [ ] **Step 2: Remove the page heading** — delete the `<h1 className="text-xl font-semibold">Insights · {monthLabel(period)}</h1>` line (the TopBar shows "Insights" + the period). If `monthLabel` becomes unused after this, remove it from the import; keep `currentPeriod`, `trailingPeriods`, `donutSlices`, `trendSeries` as still used. Remove the now-unused `useState` import if nothing else uses it.

- [ ] **Step 3: Verify the Insights test still passes** — `cd frontend && bunx vitest run src/screens/Insights.test.tsx` → PASS (it asserts category text, not the heading; default `period` keeps the query shape).

- [ ] **Step 4: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/screens/Insights.tsx
git commit -m "refactor(frontend): Insights takes period prop, drops its own header

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Transactions — accept `from`/`to` props, drop month controls, simplify summary

**Files:**
- Modify: `frontend/src/screens/Transactions.tsx`
- Modify: `frontend/src/screens/Transactions.test.tsx`

Transactions currently owns `month` state, a `<h1>`, a "This month / All time" toggle, and an `<input type="month">`. All of that moves to the global TopBar. The screen now receives `from`/`to` bounds.

- [ ] **Step 1: Rewrite the test for prop-driven bounds** — replace the whole `frontend/src/screens/Transactions.test.tsx` with:

```ts
// frontend/src/screens/Transactions.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Transactions } from "./Transactions";
import type { Txn, Category } from "../api/types";

const all: Txn[] = [
  { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "" },
  { ID: 2, PostedAt: "2026-06-09", AmountFils: 2500, Currency: "AED", Direction: "debit", MerchantRaw: "NETFLIX", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 2, CategoryName: "Subscriptions", Bucket: "want" },
];
const cats: Category[] = [{ ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true }];

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

function wrap(props: { from?: string; to?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Transactions {...props} /></ToastProvider></QueryClientProvider>);
}

describe("Transactions", () => {
  it("renders rows with a result count", async () => {
    wrap();
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
    expect(screen.getByText(/2 transactions/i)).toBeInTheDocument();
  });

  it("filters to needs-review via the segmented control", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /needs review/i }));
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.queryByText("NETFLIX")).not.toBeInTheDocument();
  });

  it("client-filters by search text", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.change(screen.getByPlaceholderText(/search merchant/i), { target: { value: "spin" } });
    expect(screen.getByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.queryByText("NETFLIX")).not.toBeInTheDocument();
  });

  it("scopes to the from/to bounds it is given", async () => {
    wrap({ from: "2026-05-01", to: "2026-05-32" }); // May → no June rows
    expect(await screen.findByText(/no transactions/i)).toBeInTheDocument();
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, confirm the new bounds test fails** — `cd frontend && bunx vitest run src/screens/Transactions.test.tsx` → the first three pass against the *current* component, but `wrap({from,to})` won't filter yet (component ignores props), so "scopes to the from/to bounds" FAILS. (If the current component still renders the month input, that's fine — the assertions don't touch it.)

- [ ] **Step 3: Rewrite `Transactions.tsx`** — replace the whole file with:

```tsx
// frontend/src/screens/Transactions.tsx
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { TransactionRow } from "../components/transactions/TransactionRow";
import { CategorizeSheet } from "../components/transactions/CategorizeSheet";
import { useToast } from "../components/Toast";
import { txnTotals } from "../lib/transactions";
import { formatFils } from "../lib/money";
import { AlertTriangle, ListOrdered, Search, Zap } from "lucide-react";

type Filter = "all" | "needs_review" | "confirmed";
const FILTERS = [
  { value: "all" as const, label: "All" },
  { value: "needs_review" as const, label: "Needs review" },
  { value: "confirmed" as const, label: "Confirmed" },
];

export function Transactions({ from, to, onOpenSwipeMode }: { from?: string; to?: string; onOpenSwipeMode?: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<Txn | null>(null);

  const status = filter === "all" ? "" : filter;
  const q = useQuery({
    queryKey: ["transactions", status, from ?? "", to ?? ""],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return getJSON<Txn[]>(qs ? `/api/transactions?${qs}` : "/api/transactions");
    },
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const rows = useMemo(() => {
    const data = q.data ?? [];
    const term = search.trim().toLowerCase();
    return term ? data.filter((t) => (t.MerchantRaw || "").toLowerCase().includes(term)) : data;
  }, [q.data, search]);
  const totals = useMemo(() => txnTotals(rows), [rows]);

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
      show({ message: `${verb} ${name}`, action: { label: "Undo", onAction: () => { void postJSON(`/api/transactions/${t.ID}/status`, { status: "needs_review" }).then(invalidate).catch(() => show({ message: `Couldn’t undo`, tone: "error" })); } } });
    } catch { show({ message: `Couldn't update ${name}`, tone: "error" }); }
  };

  const categorize = async (t: Txn, body: { category_id: number; make_rule: boolean }) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/categorize`, { ...body, merchant_raw: t.MerchantRaw });
      setActive(null);
      invalidate();
      show({ message: `Categorized ${name}`, tone: "success" });
    } catch { show({ message: `Couldn't categorize ${name}`, tone: "error" }); }
  };

  return (
    <div className="space-y-4">
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

      {q.isError ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load transactions" hint="Check your connection and try again." />
      ) : q.isLoading ? (
        <Skeleton rows={8} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ListOrdered} title="No transactions" hint="Try a different period, filter, or search." />
      ) : (
        <>
          <div className="flex items-center justify-between px-1">
            <p className="text-sm text-muted">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>
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

      {active && cats.data && (
        <CategorizeSheet
          txn={active}
          categories={cats.data}
          onSubmit={(body) => categorize(active, body)}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
```

Changes from the prior version: props are `from`/`to` (no `month` state); the `<h1>`, the "This month / All time" toggle, and the `<input type="month">` are gone (the TopBar owns the period); the summary bar drops its month-label prefix (the TopBar shows the period) and now reads just `N transactions` + `X spent`; the empty-state hint mentions period.

- [ ] **Step 4: Run the full Transactions test** — `cd frontend && bunx vitest run src/screens/Transactions.test.tsx` → PASS (4 tests).

- [ ] **Step 5: Run the full type-check / build now that screens consume the lifted props** — `cd /root/Coding/ledger/frontend && bun run build` → compiles with **no TS errors** (this is the green checkpoint for the coupled Tasks 4–7). Do NOT commit `internal/web/dist/` here — Task 8 rebuilds it.

- [ ] **Step 6: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/screens/Transactions.tsx frontend/src/screens/Transactions.test.tsx
git commit -m "refactor(frontend): Transactions takes from/to bounds from global scope

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Full verification + rebuild embedded bundle

**Files:**
- Modify: `internal/web/dist/**` (regenerated build artifact)

- [ ] **Step 1: Full frontend suite** — `cd frontend && bun run test` → all suites PASS (incl. `scope`, `PeriodSheet`, `TopBar`, updated `AppShell`/`Transactions`, and unchanged `Home`/`Insights`/`Settings`).

- [ ] **Step 2: Go suite (sanity, nothing Go changed)** — `cd /root/Coding/ledger && go test ./...` → PASS.

- [ ] **Step 3: Rebuild the embedded PWA bundle** — `cd /root/Coding/ledger/frontend && bun install && bun run build` → writes to `internal/web/dist/`. If a stray empty `node_modules/` appears at the repo root, remove it (`rm -rf /root/Coding/ledger/node_modules`).

- [ ] **Step 4: Confirm the binary builds** — `cd /root/Coding/ledger && CGO_ENABLED=0 go build -o ledger ./cmd/ledger` → no errors.

- [ ] **Step 5: Commit the rebuilt bundle**

```bash
cd /root/Coding/ledger
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for app-shell period scope

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review checklist (run after building)

- **Spec coverage:** fixed top bar with title + global actions (Task 3/4); fixed bottom tab bar (Task 4 unfix); dynamic scrollable middle (Task 4 `flex-1 min-h-0 overflow-y-auto`); `svh` sizing (Task 4 `h-[100svh]`); small-footprint title (Task 3 `text-base`, `min-h-[48px]`); month selector refactored to a mobile-friendly sheet supporting single month / range / all (Tasks 1–3).
- **Type consistency:** `Scope` is the discriminated union from Task 1, used identically in `PeriodSheet`, `TopBar`, `AppShell`. `scopeBounds → {from?, to?}` feeds `Transactions` `from`/`to` props. `scopeAnchor → string` feeds Home/Insights `period`. `addMonth`/`normalizeRange`/`scopeLabel` signatures match across tasks. Home/Insights `period` is optional (default `currentPeriod()`) so their standalone tests need no prop.
- **Coupled change:** Tasks 4–7 lift state up together; the single green build checkpoint is Task 7 Step 5. Each task still commits separately for history.
- **No regressions:** existing Home/Insights/Settings tests pass without edits (defaults + TopBar-provided heading); AppShell's "switch to Settings" test passes because the TopBar renders the only "Settings" heading (Settings' own `<h1>` removed); Transactions' three original behaviors (count, status filter, search) preserved.
- **Quality floor:** Dialog provides focus trap + Esc + visible focus; month grid buttons are `min-h-11` (44px) touch targets; `overscroll-contain` prevents scroll chaining; safe-area insets on top and bottom bars.
