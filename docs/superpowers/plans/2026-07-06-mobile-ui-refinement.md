# Mobile UI Refinement & Component Standardization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Worktree/cwd note:** subagents start in `/root/Coding/ledger` even when the session runs in a worktree. Every dispatched task must `cd` to the correct checkout and verify the branch before touching files.

**Goal:** Close the app's remaining mobile-ergonomics gaps (iOS zoom-on-focus, sub-44px touch targets, missing keyboard hints, one hand-rolled sheet) and standardize UI component usage app-wide behind documented shared primitives, recorded in a component documentation file.

**Architecture:** Three new `components/ui/` primitives (`Input`/`Select` in `Field.tsx`, `IconButton.tsx`, `SectionLabel.tsx`) plus a small `Dialog` extension absorb every ad-hoc pattern found in the audit: copy-pasted `field` className constants, hand-rolled 32px icon buttons, three competing eyebrow-label styles, and `SubcategoryPanel`'s duplicate bottom-sheet. Screens then migrate mechanically onto the primitives. A new `frontend/src/components/README.md` documents every shared component's purpose and when (not) to use it, and `CLAUDE.md` points at it so future work keeps it current.

**Tech Stack:** React 18 + TypeScript, Tailwind v4 (CSS-first tokens in `styles/app.css`), vitest + Testing Library (jsdom), lucide-react icons, bun.

## Global Constraints

- Frontend vitest is pinned to a **single, non-parallel fork** (`fileParallelism: false`, `singleFork`) in `vite.config.ts` — do not change that.
- `internal/web/dist/` is a committed build artifact; **rebuild the combined dist before finishing the branch** (`cd frontend && bun run build`, then commit `internal/web/dist`).
- Parallel sessions run on `main`. **Known overlap:** the unmerged `worktree-refund-linking` branch also modifies `TransactionRow.tsx`, `CategorizeSheet.tsx`, `Transactions.tsx`, and `SwipeDeck.tsx` and adds `LinkRefundSheet.tsx`. Before merging this work, check whether that branch landed and reconcile (its changes are additive: a `RefundOfID` subtitle tag, extra sheet props, a deck button).
- Design tokens live in `frontend/src/styles/app.css` (`--color-*`, `--radius-card` 8px, `--radius-sheet` 12px, `--ease-*`, `.press`, `.tnum`, `.shadow-1`). New primitives must use these, never raw hex or ad-hoc radii.
- The `!` important-utility prefix is the established way to override a primitive's base class (`<Card className="!p-0">` in `Transactions.tsx:112` is the precedent). Never rely on Tailwind class order for conflicting utilities.
- Haptics convention: interactive primitives fire `fire("selection")` from `lib/feedback` on click (see `Button.tsx`). Tests spy on `lib/haptics` (`vi.spyOn(haptics, "fire")`), matching `Button.test.tsx` — `lib/feedback` re-exports through, so spying `feedback` directly does not intercept.
- Do not touch `Dialog`'s focus-trap, drag-to-dismiss, or enter/exit animation internals — only the header markup and props specified in Task 4.
- All tests must go through `cd frontend && bunx vitest run <file>`; full suite via `bun run test`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Design decisions (locked in)

- **16px inputs.** iOS Safari zooms the viewport onto any focused control with font-size < 16px. Every text control moves to `text-base` via the shared `Input`/`Select`; a CSS backstop rule covers future unstyled controls. This is the single highest-impact fix.
- **Touch targets.** Default `IconButton` is 44×44px (`min-w-11 min-h-11`, Apple HIG). A `size="sm"` (36×36px) exists **only** for dense stacked rows (`TransactionRow` shows up to 4 stacked actions; 4×44px = 176px would dominate the row). Filter chips go from ~28px to ~36px tall; segmented controls from ~32px to ~36px.
- **One sheet implementation.** `SubcategoryPanel` reimplements the bottom sheet by hand (no focus trap, no Escape, no drag-to-dismiss, wrong scrim/radius). It becomes a `Dialog` via two new optional Dialog props (`titleAdornment`, `titleStyle`) that preserve its colored bucket-dot header.
- **Input surface rule.** Default `Input`/`Select` background is `bg-surface`. Inside a `Dialog` (whose panel is already `bg-surface`) pass `inset` for `bg-surface-2` so the field remains visible. This resolves the existing `AddTransactionSheet` divergence in favor of a documented rule.
- **Eyebrow labels.** The `text-[11px] font-semibold uppercase tracking-[0.08em] text-muted` style (SettingsHub's) wins as `SectionLabel`. The swipe deck's wider-tracked `tracking-[0.18em]` eyebrows are a deliberate display-context exception and stay.
- **Loading rule.** `Skeleton` for list-shaped primary loads; a centered `Loader2` spinner only for non-list loads (the Review deck) and inline waits. `CategoryManager`'s spinner becomes a `Skeleton`.
- **Deliberate exceptions (document, don't churn):** BottomNav's tiny count badge (too small for `Pill`), `DeltaBadge` (domain arrows), the Insights search trigger (a button styled as a fake input), swipe-deck card radius `rounded-[12px]`.
- **Out of scope:** list virtualization (data volumes don't justify it yet — noted in docs), landscape left/right safe-area insets, pull-to-refresh minimum-duration floor, any visual redesign beyond target sizes.

## File map

| File | Change |
|---|---|
| `frontend/src/styles/app.css` | tap-highlight reset + 16px form-control backstop |
| `frontend/src/components/ui/Field.tsx` (new, +test) | `Input` + `Select` primitives |
| `frontend/src/components/ui/IconButton.tsx` (new, +test) | 44px icon button, tones, haptic |
| `frontend/src/components/ui/SectionLabel.tsx` (new, +test) | canonical eyebrow label |
| `frontend/src/components/ui/Dialog.tsx` (+test) | `titleAdornment`/`titleStyle` props; close × → IconButton |
| `frontend/src/screens/settings/{AccountsPage,BudgetPage,CurrenciesPage,SwipePage}.tsx` | Field adoption, inputMode/keyboard attrs, IconButton deletes |
| `frontend/src/components/transactions/{AddTransactionSheet,CategorizeSheet}.tsx` | Field adoption + keyboard attrs |
| `frontend/src/components/insights/SearchSheet.tsx` | Field with icon |
| `frontend/src/screens/Transactions.tsx` | search Input with icon; CSV link 44px |
| `frontend/src/components/transactions/TransactionRow.tsx` | row actions → IconButton sm |
| `frontend/src/components/transactions/FilterChips.tsx` | chip target bump; footer → Button |
| `frontend/src/components/ui/SegmentedControl.tsx` | target bump + press |
| `frontend/src/components/ui/PeriodSheet.tsx` | year nav → IconButton |
| `frontend/src/screens/Insights.tsx` | search trigger 44px; SectionLabel |
| `frontend/src/screens/{CategoryManager,RulesManager}.tsx` | SettingsPage shell; Button/Field/IconButton/Skeleton/Card |
| `frontend/src/screens/settings/SettingsPage.tsx` | back button → IconButton |
| `frontend/src/components/swipe/SubcategoryPanel.tsx` (+test) | rebuilt on Dialog |
| `frontend/src/screens/settings/{SettingsHub,CategorizationPage,IngestHealthPage}.tsx` | SectionLabel + Card adoption |
| `frontend/src/components/README.md` (new) | component documentation file |
| `CLAUDE.md` | pointer to the component docs |
| `internal/web/dist/` | rebuilt embedded bundle |

---

### Task 1: Global CSS — tap-highlight reset and 16px form-control backstop

**Files:**
- Modify: `frontend/src/styles/app.css` (insert after the `body { ... }` rule, currently lines 72–74)

**Interfaces:**
- Consumes: nothing.
- Produces: global CSS only; no exports. Every later task relies on the tap-highlight reset existing.

- [ ] **Step 1: Add the rules**

In `frontend/src/styles/app.css`, directly after the `body { ... }` rule (line 74), insert:

```css
/* iOS Safari paints a gray flash box on tapped links/buttons; our .press scale
   and haptics are the feedback channel, so kill the default highlight. */
html { -webkit-tap-highlight-color: transparent; }

/* Backstop against iOS zoom-on-focus: Safari zooms the viewport onto any
   focused control whose font-size is under 16px. Shared Input/Select set
   text-base explicitly; this element-level rule (which any utility class
   outranks) only catches future controls that forget. */
input, select, textarea { font-size: max(16px, 1rem); }
```

- [ ] **Step 2: Verify the build and suite still pass**

Run: `cd frontend && bun run build && bun run test`
Expected: build succeeds; all tests pass (CSS-only change).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles/app.css
git commit -m "fix(web): kill iOS tap-highlight flash and add 16px form-control backstop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `Input` / `Select` primitives (`ui/Field.tsx`)

**Files:**
- Create: `frontend/src/components/ui/Field.tsx`
- Create: `frontend/src/components/ui/Field.test.tsx`

**Interfaces:**
- Consumes: design tokens only.
- Produces (Tasks 5–8 import exactly these):
  - `Input({ inset?: boolean; icon?: LucideIcon; className?: string } & InputHTMLAttributes<HTMLInputElement>)`
  - `Select({ inset?: boolean; className?: string } & SelectHTMLAttributes<HTMLSelectElement>)`
  - With `icon`, `Input` renders its own `relative` wrapper + absolutely-positioned leading icon (replaces the hand-rolled search-input wrappers in `Transactions.tsx` / `SearchSheet.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ui/Field.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Search } from "lucide-react";
import { Input, Select } from "./Field";

it("renders a 16px control (text-base) so iOS Safari doesn't zoom on focus", () => {
  render(<Input aria-label="Name" />);
  const el = screen.getByLabelText("Name");
  expect(el.className).toContain("text-base");
  expect(el.className).not.toContain("text-sm");
});

it("defaults to the surface background and switches to the inset surface on demand", () => {
  render(<Input aria-label="A" />);
  expect(screen.getByLabelText("A").className).toContain("bg-surface");
  render(<Input aria-label="B" inset />);
  expect(screen.getByLabelText("B").className).toContain("bg-surface-2");
});

it("renders a leading icon and pads the text clear of it", () => {
  render(<Input aria-label="Search" icon={Search} />);
  expect(screen.getByLabelText("Search").className).toContain("pl-9");
});

it("spreads native props through (type, inputMode)", () => {
  render(<Input aria-label="Amount" type="number" inputMode="decimal" />);
  const el = screen.getByLabelText("Amount") as HTMLInputElement;
  expect(el.type).toBe("number");
  expect(el.inputMode).toBe("decimal");
});

it("Select keeps the 16px base and spreads props", () => {
  render(
    <Select aria-label="Kind" defaultValue="income">
      <option value="spending">spending</option>
      <option value="income">income</option>
    </Select>,
  );
  const el = screen.getByLabelText("Kind") as HTMLSelectElement;
  expect(el.className).toContain("text-base");
  expect(el.value).toBe("income");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/components/ui/Field.test.tsx`
Expected: FAIL — cannot resolve `./Field`.

- [ ] **Step 3: Implement**

Create `frontend/src/components/ui/Field.tsx`:

```tsx
// frontend/src/components/ui/Field.tsx
import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

// text-base (16px) is load-bearing: iOS Safari zooms the viewport onto any
// focused control whose font-size is below 16px. Never swap it for text-sm.
// `inset` (bg-surface-2) is for fields inside a Dialog, whose panel is
// already bg-surface; the default bg-surface is for fields on the page (bg-bg).
const BASE = "w-full min-h-11 py-2 pr-3 rounded-md border border-border text-base";
const bg = (inset: boolean) => (inset ? "bg-surface-2" : "bg-surface");

export function Input({ inset = false, icon: Icon, className = "", ...rest }:
  { inset?: boolean; icon?: LucideIcon; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const control = (
    <input className={`${BASE} ${Icon ? "pl-9" : "pl-3"} ${bg(inset)} ${className}`} {...rest} />
  );
  if (!Icon) return control;
  return (
    <div className="relative">
      <Icon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
      {control}
    </div>
  );
}

export function Select({ inset = false, className = "", children, ...rest }:
  { inset?: boolean; className?: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${BASE} pl-3 ${bg(inset)} ${className}`} {...rest}>
      {children}
    </select>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/ui/Field.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/Field.tsx frontend/src/components/ui/Field.test.tsx
git commit -m "feat(web): shared Input/Select primitives with 16px base and icon slot

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `IconButton` primitive

**Files:**
- Create: `frontend/src/components/ui/IconButton.tsx`
- Create: `frontend/src/components/ui/IconButton.test.tsx`

**Interfaces:**
- Consumes: `fire` from `lib/feedback` (same pattern as `Button.tsx`).
- Produces (Tasks 4, 5, 7, 8 import exactly this):
  - `IconButton({ label: string; size?: "md" | "sm"; tone?: "muted" | "accent" | "danger"; className?: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>)`
  - `label` becomes `aria-label` (required — icon-only buttons are invisible to screen readers otherwise). `md` = 44px, `sm` = 36px. Fires the `selection` haptic on click like `Button`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ui/IconButton.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Trash2 } from "lucide-react";
import { IconButton } from "./IconButton";
import * as haptics from "../../lib/haptics";

afterEach(() => vi.restoreAllMocks());

it("meets the 44px touch target by default and exposes its label", () => {
  render(<IconButton label="Delete"><Trash2 size={16} /></IconButton>);
  const btn = screen.getByRole("button", { name: "Delete" });
  expect(btn.className).toContain("min-w-11");
  expect(btn.className).toContain("min-h-11");
  expect(btn.className).toContain("press");
});

it("offers a 36px size for dense stacked rows only", () => {
  render(<IconButton label="Archive" size="sm"><Trash2 size={16} /></IconButton>);
  const btn = screen.getByRole("button", { name: "Archive" });
  expect(btn.className).toContain("w-9");
  expect(btn.className).toContain("h-9");
});

it("fires a selection haptic and still calls onClick when tapped", () => {
  const fire = vi.spyOn(haptics, "fire");
  const onClick = vi.fn();
  render(<IconButton label="Go" onClick={onClick}><Trash2 size={16} /></IconButton>);
  screen.getByRole("button", { name: "Go" }).click();
  expect(fire).toHaveBeenCalledWith("selection");
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("does not fire when disabled", () => {
  const fire = vi.spyOn(haptics, "fire");
  const onClick = vi.fn();
  render(<IconButton label="Nope" disabled onClick={onClick}><Trash2 size={16} /></IconButton>);
  screen.getByRole("button", { name: "Nope" }).click();
  expect(fire).not.toHaveBeenCalled();
  expect(onClick).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/components/ui/IconButton.test.tsx`
Expected: FAIL — cannot resolve `./IconButton`.

- [ ] **Step 3: Implement**

Create `frontend/src/components/ui/IconButton.tsx`:

```tsx
// frontend/src/components/ui/IconButton.tsx
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import { fire } from "../../lib/feedback";

type Size = "md" | "sm";
type Tone = "muted" | "accent" | "danger";

const SIZES: Record<Size, string> = {
  md: "min-w-11 min-h-11", // 44px — the default touch target (Apple HIG)
  sm: "w-9 h-9",           // 36px — ONLY inside dense stacked rows (TransactionRow)
};
const TONES: Record<Tone, string> = {
  muted: "text-muted hover:bg-surface-2",
  accent: "text-accent hover:bg-surface-2",
  danger: "text-muted hover:text-bad active:text-bad",
};

/** Icon-only button. `label` is required — it is the accessible name. */
export function IconButton(
  { label, size = "md", tone = "muted", className = "", children, onClick, ...rest }:
  { label: string; size?: Size; tone?: Tone; className?: string; children: ReactNode }
    & ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    fire("selection");
    onClick?.(e);
  };
  return (
    <button
      aria-label={label}
      className={`inline-flex items-center justify-center rounded-lg transition-colors press disabled:opacity-30 disabled:cursor-not-allowed ${SIZES[size]} ${TONES[tone]} ${className}`}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/ui/IconButton.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/IconButton.tsx frontend/src/components/ui/IconButton.test.tsx
git commit -m "feat(web): IconButton primitive — 44px targets, tones, press + haptic

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `SectionLabel` primitive + Dialog header extension

**Files:**
- Create: `frontend/src/components/ui/SectionLabel.tsx`
- Create: `frontend/src/components/ui/SectionLabel.test.tsx`
- Modify: `frontend/src/components/ui/Dialog.tsx` (props at line 7, header markup at lines 100–103)
- Modify: `frontend/src/components/ui/Dialog.test.tsx` (append)

**Interfaces:**
- Consumes: `IconButton` from Task 3.
- Produces (Tasks 9–10 rely on exactly these):
  - `SectionLabel({ as?: ElementType; className?: string; children: ReactNode })` — the one eyebrow style.
  - `Dialog` gains optional `titleAdornment?: ReactNode` (rendered before the h2) and `titleStyle?: CSSProperties` (applied to the h2). Existing callers are untouched (both optional).
  - Dialog's close control becomes `IconButton` (same `aria-label="Close"`).

- [ ] **Step 1: Write the failing SectionLabel test**

Create `frontend/src/components/ui/SectionLabel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SectionLabel } from "./SectionLabel";

it("renders the canonical eyebrow style", () => {
  render(<SectionLabel>Analyze by</SectionLabel>);
  const el = screen.getByText("Analyze by");
  expect(el.tagName).toBe("P");
  expect(el.className).toContain("uppercase");
  expect(el.className).toContain("tracking-[0.08em]");
});

it("can render as a heading or legend without losing the style", () => {
  render(<SectionLabel as="h2">Plan</SectionLabel>);
  expect(screen.getByRole("heading", { name: "Plan" }).className).toContain("uppercase");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && bunx vitest run src/components/ui/SectionLabel.test.tsx`
Expected: FAIL — cannot resolve `./SectionLabel`.

- [ ] **Step 3: Implement SectionLabel**

Create `frontend/src/components/ui/SectionLabel.tsx`:

```tsx
// frontend/src/components/ui/SectionLabel.tsx
import type { ElementType, ReactNode } from "react";

/** The one eyebrow/section-label style. `as` picks the element (p, h2, legend). */
export function SectionLabel({ as: Tag = "p" as ElementType, className = "", children }:
  { as?: ElementType; className?: string; children: ReactNode }) {
  return (
    <Tag className={`text-[11px] font-semibold uppercase tracking-[0.08em] text-muted ${className}`}>
      {children}
    </Tag>
  );
}
```

Run: `cd frontend && bunx vitest run src/components/ui/SectionLabel.test.tsx` — Expected: PASS.

- [ ] **Step 4: Write the failing Dialog tests**

Append to `frontend/src/components/ui/Dialog.test.tsx` (inside the file's existing describe/test structure, reusing its render helpers and imports; add any missing `screen` import):

```tsx
it("renders a title adornment and applies titleStyle to the heading", () => {
  render(
    <Dialog
      title="Wants"
      titleAdornment={<span data-testid="dot" />}
      titleStyle={{ color: "rgb(123, 53, 184)" }}
      onClose={() => {}}
    >
      body
    </Dialog>,
  );
  expect(screen.getByTestId("dot")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Wants" })).toHaveStyle({ color: "rgb(123, 53, 184)" });
});
```

Run: `cd frontend && bunx vitest run src/components/ui/Dialog.test.tsx`
Expected: the new test FAILS (unknown props render nothing); existing tests still pass.

- [ ] **Step 5: Implement the Dialog changes**

In `frontend/src/components/ui/Dialog.tsx`:

1. Extend the imports and signature (line 2 and 7):

```tsx
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";
```

```tsx
export function Dialog({ title, titleAdornment, titleStyle, onClose, children }: {
  title: string;
  titleAdornment?: ReactNode;
  titleStyle?: CSSProperties;
  onClose: () => void;
  children: ReactNode;
}) {
```

2. Replace the header block (currently lines 100–103):

```tsx
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2.5 min-w-0">
              {titleAdornment}
              <h2 id={titleId} style={titleStyle} className="text-lg font-semibold truncate">{title}</h2>
            </div>
            <IconButton label="Close" className="-mr-2" onClick={requestClose}><X size={18} /></IconButton>
          </div>
```

(The old `<button aria-label="Close" ...>×</button>` is deleted; the accessible name is unchanged.)

- [ ] **Step 6: Run the Dialog suite and every Dialog consumer's tests**

Run: `cd frontend && bunx vitest run src/components/ui/Dialog.test.tsx src/components/ui/PeriodSheet.test.tsx src/components/transactions/AddTransactionSheet.test.tsx src/components/transactions/CategorizeSheet.test.tsx src/components/transactions/FilterChips.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ui/SectionLabel.tsx frontend/src/components/ui/SectionLabel.test.tsx frontend/src/components/ui/Dialog.tsx frontend/src/components/ui/Dialog.test.tsx
git commit -m "feat(web): SectionLabel primitive; Dialog title adornment + IconButton close

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Settings pages — Field adoption, keyboard attributes, IconButton deletes

**Files:**
- Modify: `frontend/src/screens/settings/AccountsPage.tsx` (field const line 10, delete button 87–93, inputs 100–117)
- Modify: `frontend/src/screens/settings/BudgetPage.tsx` (field const line 12, inputs 81–88, 102–116)
- Modify: `frontend/src/screens/settings/CurrenciesPage.tsx` (field const line 11, delete button 97–103, inputs 88–96, 113–122, 131–148)
- Modify: `frontend/src/screens/settings/SwipePage.tsx` (field const line 13, select 56–66)
- Modify: `frontend/src/screens/settings/SettingsPage.tsx` (back button 23–29)

**Interfaces:**
- Consumes: `Input`, `Select` (Task 2); `IconButton` (Task 3).
- Produces: no new exports. Every `const field = "..."` constant is deleted. Money inputs gain `inputMode="decimal"`; integer inputs `inputMode="numeric"`.

- [ ] **Step 1: AccountsPage**

In `frontend/src/screens/settings/AccountsPage.tsx`:
- Delete line 10 (`const field = ...`). Add imports: `import { Input } from "../../components/ui/Field";` and `import { IconButton } from "../../components/ui/IconButton";`. Remove `Trash2` from the lucide import only if unused elsewhere (it is still used inside the IconButton — keep it).
- Replace the delete button (lines 87–93) with:

```tsx
                <IconButton label={`Delete ${a.name}`} tone="danger" className="-mr-2" onClick={() => remove(a.id)}>
                  <Trash2 size={16} />
                </IconButton>
```

- Replace the two inputs (lines 100–117) with:

```tsx
                <Input
                  type="text"
                  placeholder="Name"
                  aria-label="Account name"
                  autoCapitalize="words"
                  autoCorrect="off"
                  className="flex-1"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="Last 4"
                  aria-label="Last 4 digits"
                  className="!w-24"
                  value={last4}
                  onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))}
                />
```

(`!w-24` because `Input`'s base includes `w-full`; the `!` override is the codebase precedent.)

- [ ] **Step 2: BudgetPage**

In `frontend/src/screens/settings/BudgetPage.tsx`:
- Delete line 12 (`const field = ...`); add `import { Input } from "../../components/ui/Field";`.
- Income input (lines 81–88) becomes:

```tsx
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              className="mt-1"
              value={filsToDirhams(cfg.monthly_income)}
              onChange={(e) => patch({ monthly_income: dirhamsToFils(Number(e.target.value)) })}
            />
```

- The three percent inputs (lines 102–116) each become (shown for Need; Want/Saving identical apart from the field names):

```tsx
                <Input type="number" inputMode="numeric" min="0" max="100" className="mt-1"
                  value={fractionToPercent(cfg.need_pct)}
                  onChange={(e) => patch({ need_pct: percentToFraction(Number(e.target.value)) })} />
```

- [ ] **Step 3: CurrenciesPage**

In `frontend/src/screens/settings/CurrenciesPage.tsx`:
- Delete line 11 (`const field = ...`); add `import { Input } from "../../components/ui/Field";` and `import { IconButton } from "../../components/ui/IconButton";`.
- Each rate input (lines 88–96 and 113–122) becomes `<Input type="number" inputMode="decimal" step="0.0001" min="0" className="flex-1" ...>` keeping its existing `aria-label`/`value`/`onChange`/`onBlur` props verbatim.
- The delete button (lines 97–103) becomes:

```tsx
                <IconButton label={`Delete ${r.currency} rate`} tone="danger" className="-mr-2" onClick={() => removeRate(r.currency)}>
                  <Trash2 size={16} />
                </IconButton>
```

- The add-currency inputs (lines 131–148): code input becomes `<Input type="text" placeholder="USD" aria-label="New currency code" autoCapitalize="characters" autoCorrect="off" maxLength={3} className="!w-24" ...>`; rate input becomes `<Input type="number" inputMode="decimal" step="0.0001" min="0" placeholder="Rate" aria-label="New currency rate" className="flex-1" ...>` (existing value/onChange kept).

- [ ] **Step 4: SwipePage and SettingsPage**

In `frontend/src/screens/settings/SwipePage.tsx`: delete line 13 (`const field = ...`), add `import { Select } from "../../components/ui/Field";`, and change the select (lines 56–66) opening tag to `<Select value={value} aria-label={`${word} swipe action`} onChange={(e) => setSwipeDir(dir, e.target.value)} className="flex-1">` with matching `</Select>`.

In `frontend/src/screens/settings/SettingsPage.tsx`: add `import { IconButton } from "../../components/ui/IconButton";` and replace the back button (lines 23–29) with:

```tsx
        <IconButton label={`Back from ${title}`} className="-ml-2" onClick={onClose}>
          <ArrowLeft size={20} />
        </IconButton>
```

- [ ] **Step 5: Run the settings test files**

Run: `cd frontend && bunx vitest run src/screens/Settings.accounts.test.tsx src/screens/Settings.rates.test.tsx src/screens/Settings.test.tsx src/screens/Settings.categorization.test.tsx src/screens/settings/IngestHealthPage.test.tsx`
Expected: PASS (all aria-labels were preserved verbatim).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens/settings/AccountsPage.tsx frontend/src/screens/settings/BudgetPage.tsx frontend/src/screens/settings/CurrenciesPage.tsx frontend/src/screens/settings/SwipePage.tsx frontend/src/screens/settings/SettingsPage.tsx
git commit -m "refactor(web): settings pages on shared Input/Select/IconButton, mobile keypads

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Transaction & search inputs — Field adoption + keyboard attributes

**Files:**
- Modify: `frontend/src/components/transactions/AddTransactionSheet.tsx` (field const line 24, inputs 36–56)
- Modify: `frontend/src/components/transactions/CategorizeSheet.tsx` (search input 40–46)
- Modify: `frontend/src/components/insights/SearchSheet.tsx` (search block 27–36)
- Modify: `frontend/src/screens/Transactions.tsx` (search block 85–94)

**Interfaces:**
- Consumes: `Input`, `Select` from Task 2 (`icon` prop replaces the hand-rolled icon wrappers).
- Produces: no new exports. All four sheets/screens keep their existing behavior and aria-labels.

- [ ] **Step 1: AddTransactionSheet**

Delete line 24 (`const field = ...`), add `import { Input, Select } from "../ui/Field";`, and replace the five labeled controls (lines 36–56) with:

```tsx
        <label className="block text-sm">Merchant
          <Input inset autoCapitalize="words" autoCorrect="off" enterKeyHint="next" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Carrefour" />
        </label>
        <label className="block text-sm">Amount (AED)
          <Input inset type="number" inputMode="decimal" min="0" step="0.01" value={amountAed} onChange={(e) => setAmountAed(e.target.value)} />
        </label>
        <label className="block text-sm">Direction
          <Select inset value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="debit">Debit (money out)</option>
            <option value="credit">Credit (money in)</option>
          </Select>
        </label>
        <label className="block text-sm">Date
          <Input inset type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block text-sm">Category (optional)
          <Select inset value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Uncategorized — send to Needs review</option>
            {categories.map((c) => <option key={c.ID} value={c.ID}>{c.Name}</option>)}
          </Select>
        </label>
```

- [ ] **Step 2: CategorizeSheet search input**

Add `import { Input } from "../ui/Field";` and replace lines 40–46 with:

```tsx
      <Input
        inset
        type="search"
        enterKeyHint="search"
        autoCorrect="off"
        placeholder="Search categories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-3"
      />
```

- [ ] **Step 3: SearchSheet and Transactions search inputs**

`frontend/src/components/insights/SearchSheet.tsx`: add `import { Input } from "../ui/Field";`, replace the whole search block (lines 27–36, including the `relative` wrapper div and the absolute `<Search>` icon) with:

```tsx
      <div className="mb-3">
        <Input
          inset
          icon={Search}
          type="search"
          enterKeyHint="search"
          autoCorrect="off"
          placeholder="Search merchant…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>
```

`frontend/src/screens/Transactions.tsx`: add `import { Input } from "../components/ui/Field";`, replace the search block (lines 85–94, including the wrapper and absolute icon) with:

```tsx
      <Input
        icon={Search}
        type="search"
        enterKeyHint="search"
        autoCorrect="off"
        placeholder="Search merchant…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
```

(Keep the `Search` lucide import in both files — it now feeds the `icon` prop.)

- [ ] **Step 4: Run the affected test files**

Run: `cd frontend && bunx vitest run src/components/transactions/AddTransactionSheet.test.tsx src/components/transactions/CategorizeSheet.test.tsx src/screens/Transactions.test.tsx src/screens/Insights.test.tsx`
Expected: PASS (placeholders and behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/transactions/AddTransactionSheet.tsx frontend/src/components/transactions/CategorizeSheet.tsx frontend/src/components/insights/SearchSheet.tsx frontend/src/screens/Transactions.tsx
git commit -m "refactor(web): transaction forms and search on shared Input/Select with mobile keypads

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Touch-target pass — rows, chips, segments, links

**Files:**
- Modify: `frontend/src/components/transactions/TransactionRow.tsx` (action buttons 48–62)
- Modify: `frontend/src/components/transactions/FilterChips.tsx` (chips 81–101, footer 125–139, checkbox rows 112–118)
- Modify: `frontend/src/components/ui/SegmentedControl.tsx` (line 17)
- Modify: `frontend/src/components/ui/PeriodSheet.tsx` (year nav 61–63)
- Modify: `frontend/src/screens/Transactions.tsx` (CSV link 74–82)
- Modify: `frontend/src/screens/Insights.tsx` (search trigger 89–94)

**Interfaces:**
- Consumes: `IconButton` (Task 3), `Button` (existing).
- Produces: no new exports; all aria-labels preserved verbatim.

- [ ] **Step 1: TransactionRow — stacked actions become IconButton sm**

Add `import { IconButton } from "../ui/IconButton";` and replace the actions column (lines 48–62) with:

```tsx
      <div className="flex flex-col gap-1 self-center">
        {archived ? (
          <IconButton label="Restore" size="sm" tone="accent" onClick={() => onRestore(txn)}><ArchiveRestore size={16} /></IconButton>
        ) : (
          <>
            {needsReview && (
              <>
                <IconButton label="Categorize" size="sm" tone="accent" onClick={() => onOpen(txn)}><Tag size={16} /></IconButton>
                <IconButton label="Transfer" size="sm" onClick={() => onStatus(txn, "transfer")}><ArrowLeftRight size={16} /></IconButton>
                <IconButton label="Ignore" size="sm" onClick={() => onStatus(txn, "ignored")}><X size={16} /></IconButton>
              </>
            )}
            <IconButton label="Archive" size="sm" onClick={() => onArchive(txn)}><Archive size={16} /></IconButton>
          </>
        )}
      </div>
```

Run: `cd frontend && bunx vitest run src/components/transactions/TransactionRow.test.tsx` — Expected: PASS.

- [ ] **Step 2: FilterChips — bigger chips, Button footer, bigger checkboxes**

In `frontend/src/components/transactions/FilterChips.tsx`, add `import { Button } from "../ui/Button";` and:

1. Chip buttons (lines 81–92): change the className to

```tsx
            className={`flex items-center gap-1 px-3.5 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors press ${
              count > 0 ? "bg-accent/10 text-accent" : "bg-surface-2 text-muted"
            }`}
```

2. The Clear chip (lines 96–101): change its className to

```tsx
          className="flex items-center gap-1 px-3.5 py-2 rounded-md text-sm font-medium text-muted whitespace-nowrap press hover:text-fg"
```

3. Checkbox option rows (lines 112–118): change the label className to `"flex items-center gap-3 px-2 py-3 rounded-md hover:bg-surface-2 cursor-pointer"` and the checkbox className to `"h-5 w-5 accent-accent"`.

4. Replace the footer (lines 125–139) with:

```tsx
          <div className="flex justify-between items-center pt-3 mt-2 border-t border-border">
            <Button variant="ghost" onClick={() => current.onChange([])} disabled={current.selected.length === 0}>
              Clear
            </Button>
            <Button variant="primary" onClick={() => setOpen(null)}>Done</Button>
          </div>
```

Run: `cd frontend && bunx vitest run src/components/transactions/FilterChips.test.tsx` — Expected: PASS.

- [ ] **Step 3: SegmentedControl, PeriodSheet, CSV link, Insights trigger**

`SegmentedControl.tsx` line 17 — change the segment className's leading utilities from `px-4 py-1.5` to `px-4 py-2` and append `press`:

```tsx
          className={`px-4 py-2 rounded text-sm font-medium transition-colors press ${
            value === o.value ? "bg-surface text-fg shadow-1" : "text-muted hover:text-fg"
          }`}
```

`PeriodSheet.tsx` (lines 60–64) — add `import { IconButton } from "./IconButton";` and replace both year-nav buttons:

```tsx
      <div className="flex items-center justify-between mb-3">
        <IconButton label="Previous year" onClick={() => setYear((y) => y - 1)}><ChevronLeft size={18} /></IconButton>
        <span className="text-sm font-semibold tnum">{year}</span>
        <IconButton label="Next year" onClick={() => setYear((y) => y + 1)}><ChevronRight size={18} /></IconButton>
      </div>
```

`Transactions.tsx` CSV link (lines 74–82) — change its className to:

```tsx
          className="shrink-0 min-h-11 min-w-11 inline-flex items-center justify-center rounded-md border border-border bg-surface text-muted press"
```

`Insights.tsx` search trigger (lines 89–94) — change its className to:

```tsx
        className="w-full min-h-11 flex items-center gap-2 px-3 rounded-md border border-border bg-surface text-base text-muted press"
```

- [ ] **Step 4: Run the affected suites**

Run: `cd frontend && bunx vitest run src/components/ui/SegmentedControl.test.tsx src/components/ui/PeriodSheet.test.tsx src/screens/Transactions.test.tsx src/screens/Insights.test.tsx src/screens/settings/IngestHealthPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/transactions/TransactionRow.tsx frontend/src/components/transactions/FilterChips.tsx frontend/src/components/ui/SegmentedControl.tsx frontend/src/components/ui/PeriodSheet.tsx frontend/src/screens/Transactions.tsx frontend/src/screens/Insights.tsx
git commit -m "fix(web): raise touch targets to 36-44px and add press feedback across actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Manager screens onto the SettingsPage shell

**Files:**
- Modify: `frontend/src/screens/CategoryManager.tsx` (shell 40–48 + 93–95, add form 50–80, spinner 82–85, row 140–168)
- Modify: `frontend/src/screens/RulesManager.tsx` (shell 36–44 + 68–70, list card 53, delete 61–63)

**Interfaces:**
- Consumes: `SettingsPage` (existing shared shell — these two screens currently duplicate it by hand), `Button`, `Input`, `Select`, `IconButton`, `Skeleton`, `Card`.
- Produces: no signature changes; `onClose` prop behavior identical. Close-button aria-labels change to SettingsPage's `Back from <title>` pattern (no test queries the old labels).

- [ ] **Step 1: CategoryManager**

In `frontend/src/screens/CategoryManager.tsx`:

1. Imports — remove `ArrowLeft, Loader2` from the lucide import (keep `Trash2`); add:

```tsx
import { SettingsPage } from "./settings/SettingsPage";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Field";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/Skeleton";
```

2. Replace the shell — the outer `<div className="fixed inset-0 z-40 bg-bg flex flex-col">`, the `<header>...</header>` block, and the inner scroll `<div className="flex-1 overflow-y-auto ...">` (lines 41–49 and the matching closing tags at 93–95) — with `SettingsPage`:

```tsx
  return (
    <SettingsPage title="Categories" onClose={onClose}>
      {/* existing children of the scroll div go here, unchanged wrapper-to-wrapper */}
    </SettingsPage>
  );
```

(The `space-y-6` spacing and `max-w-screen-sm` centering come from SettingsPage's body.)

3. Add form: the name input (lines 52–58) becomes `<Input aria-label="New category name" autoCapitalize="words" autoCorrect="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />`; the two selects (60–77) become `<Select aria-label="New category kind" className="flex-1" ...>` / `<Select aria-label="New category bucket" className="flex-1" ...>` keeping options and handlers verbatim; the raw Add button (line 79) becomes:

```tsx
          <Button variant="primary" className="w-full" onClick={add}>Add</Button>
```

4. The `isPending` spinner (lines 82–85) becomes `<Skeleton rows={6} />`.

5. `CategoryRow` (lines 140–168): rename input becomes `<Input aria-label={`Rename ${cat.Name}`} className="min-w-0 flex-1" ...>` (keep value/onChange/onBlur); the bucket select becomes `<Select aria-label={`Bucket for ${cat.Name}`} className="!w-auto" ...>`; the bare delete button (159–166) becomes:

```tsx
      <IconButton
        label={inUse ? `${cat.Name} in use, can't delete` : `Delete ${cat.Name}`}
        size="sm"
        tone="danger"
        disabled={inUse}
        onClick={remove}
      >
        <Trash2 size={16} />
      </IconButton>
```

Run: `cd frontend && bunx vitest run src/screens/CategoryManager.test.tsx` — Expected: PASS. (The overlay-background regression test asserts `fixed` + `bg-bg` on the root, which SettingsPage provides; all queried aria-labels are preserved.)

- [ ] **Step 2: RulesManager**

In `frontend/src/screens/RulesManager.tsx`:

1. Imports — remove `ArrowLeft` (keep `Trash2`); add:

```tsx
import { SettingsPage } from "./settings/SettingsPage";
import { Card } from "../components/ui/Card";
import { IconButton } from "../components/ui/IconButton";
```

2. Replace the hand-rolled shell (outer div + header + scroll div, lines 37–45 and closers 68–70) with `<SettingsPage title="Rules" onClose={onClose}> ... </SettingsPage>`.

3. The list `<ul className="bg-surface rounded-[var(--radius-card)] shadow-1 divide-y divide-border">` (line 53) becomes:

```tsx
          <Card className="!p-0">
            <ul className="divide-y divide-border">
```

(with the matching `</ul></Card>` closer.)

4. The delete button (lines 61–63) becomes:

```tsx
                <IconButton label="Delete rule" tone="danger" className="-mr-2" onClick={() => deleteRule(r.ID)}>
                  <Trash2 size={16} />
                </IconButton>
```

- [ ] **Step 3: Run the full frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS (RulesManager has no dedicated test file; Settings.test.tsx exercises navigation into both managers).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/screens/CategoryManager.tsx frontend/src/screens/RulesManager.tsx
git commit -m "refactor(web): CategoryManager and RulesManager on the shared SettingsPage shell

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: SubcategoryPanel rebuilt on Dialog

**Files:**
- Modify: `frontend/src/components/swipe/SubcategoryPanel.tsx` (full rewrite)
- Modify: `frontend/src/components/swipe/SubcategoryPanel.test.tsx` (backdrop test)

**Interfaces:**
- Consumes: `Dialog` with `titleAdornment`/`titleStyle` (Task 4).
- Produces: identical props (`action, categories, makeRule, onMakeRuleChange, onSelect, onCancel`) — `SwipeDeck` needs no changes. The panel gains Dialog's focus trap, Escape handling, and drag-to-dismiss for free. The `subcategory-scrim` testid disappears (nothing references it).

- [ ] **Step 1: Update the backdrop test to survive the animated close**

In `frontend/src/components/swipe/SubcategoryPanel.test.tsx`, Dialog plays an exit transition before invoking `onClose`, so the backdrop assertion must wait. Replace the `'calls onCancel when backdrop is clicked'` test with:

```tsx
  it('calls onCancel when backdrop is clicked', async () => {
    const onCancel = vi.fn()
    render(
      <SubcategoryPanel
        action={DEFAULT_SWIPE_CONFIG.left}
        categories={CATS}
        makeRule={false}
        onMakeRuleChange={vi.fn()}
        onSelect={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByTestId('dialog-scrim'))
    await waitFor(() => expect(onCancel).toHaveBeenCalled())
  })
```

and extend the testing-library import to `import { render, screen, fireEvent, waitFor } from '@testing-library/react'`.

- [ ] **Step 2: Run to verify the suite fails against the old implementation**

Run: `cd frontend && bunx vitest run src/components/swipe/SubcategoryPanel.test.tsx`
Expected: the backdrop test FAILS (no `dialog-scrim` testid in the hand-rolled panel); the other three still pass.

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `frontend/src/components/swipe/SubcategoryPanel.tsx` with:

```tsx
import type { Category } from '../../api/types'
import { type SwipeAction, actionColor } from '../../lib/swipe'
import { Dialog } from '../ui/Dialog'

interface SubcategoryPanelProps {
  action: SwipeAction
  categories: Category[]
  makeRule: boolean
  onMakeRuleChange: (v: boolean) => void
  onSelect: (categoryId: number) => void
  onCancel: () => void
}

/** Bottom sheet for picking the category after an edge swipe. Built on the
 *  shared Dialog (focus trap, Escape, drag-to-dismiss); the bucket dot and
 *  tinted title tie the sheet to the direction just swiped. */
export function SubcategoryPanel({
  action,
  categories,
  makeRule,
  onMakeRuleChange,
  onSelect,
  onCancel,
}: SubcategoryPanelProps) {
  const color = actionColor(action)
  const visible = categories.filter(
    c => c.Kind === 'spending' && c.Bucket === action.bucket && c.IsActive,
  )

  return (
    <Dialog
      title={action.label}
      titleAdornment={<span aria-hidden className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />}
      titleStyle={{ color }}
      onClose={onCancel}
    >
      <div className="grid grid-cols-2 gap-2 mb-4">
        {visible.map(cat => (
          <button
            key={cat.ID}
            onClick={() => onSelect(cat.ID)}
            className="min-h-14 py-3 px-4 rounded-lg border border-border text-base font-medium text-fg hover:bg-surface-2 press text-left"
          >
            {cat.Name}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-3 py-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={makeRule}
          onChange={e => onMakeRuleChange(e.target.checked)}
          className="w-5 h-5 accent-accent"
        />
        <span className="text-sm text-muted">
          Always use this category for this merchant
        </span>
      </label>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run the swipe suites**

Run: `cd frontend && bunx vitest run src/components/swipe/`
Expected: PASS (SwipeDeck's tests exercise the panel through the same props).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/swipe/SubcategoryPanel.tsx frontend/src/components/swipe/SubcategoryPanel.test.tsx
git commit -m "refactor(web): SubcategoryPanel on shared Dialog — gains focus trap, Escape, drag-dismiss

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Idiom adoption — SectionLabel and Card across settings/insights

**Files:**
- Modify: `frontend/src/screens/settings/SettingsHub.tsx` (Group, lines 82–91)
- Modify: `frontend/src/screens/settings/CategorizationPage.tsx` (lines 108–110)
- Modify: `frontend/src/screens/settings/IngestHealthPage.tsx` (lines 52, 68)
- Modify: `frontend/src/screens/Insights.tsx` (line 99)
- Modify: `frontend/src/components/transactions/CategorizeSheet.tsx` (line 50)

**Interfaces:**
- Consumes: `SectionLabel` (Task 4), `Card` (existing).
- Produces: no new exports. The `tracking-wide text-xs` eyebrows converge on SectionLabel's `text-[11px] tracking-[0.08em]` — an intended visual unification.

- [ ] **Step 1: SettingsHub Group**

Add `import { SectionLabel } from "../../components/ui/SectionLabel";` and `import { Card } from "../../components/ui/Card";`, then replace the `Group` helper (lines 82–91) with:

```tsx
/** Eyebrow-labeled group of rows. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <SectionLabel as="h2" className="px-1">{label}</SectionLabel>
      <Card className="!p-0 divide-y divide-border overflow-hidden">
        {children}
      </Card>
    </section>
  );
}
```

- [ ] **Step 2: CategorizationPage and IngestHealthPage**

`CategorizationPage.tsx`: add the same two imports (path `"../../components/ui/..."`). Replace line 109's `<h2 className="px-1 text-[11px] ...">Run now</h2>` with `<SectionLabel as="h2" className="px-1">Run now</SectionLabel>`, and line 110's `<div className="bg-surface rounded-[var(--radius-card)] shadow-1 p-4">` with `<Card>` (matching `</Card>` closer).

`IngestHealthPage.tsx`: add `import { Card } from "../../components/ui/Card";`. Replace the section at line 52 with `<Card className="space-y-1">` (closer `</Card>`; drop the `<section>` wrapper) and the section at line 68 with `<Card className="!py-2 divide-y divide-border">` (closer `</Card>`).

- [ ] **Step 3: Insights and CategorizeSheet eyebrows**

`Insights.tsx` line 99: add `import { SectionLabel } from "../components/ui/SectionLabel";` and replace `<p className="text-xs uppercase tracking-wide text-muted mb-1.5">Analyze by</p>` with `<SectionLabel className="mb-1.5">Analyze by</SectionLabel>`.

`CategorizeSheet.tsx` line 50: add `import { SectionLabel } from "../ui/SectionLabel";` and replace `<legend className="text-xs uppercase tracking-wide text-muted mb-1">{...}</legend>` with `<SectionLabel as="legend" className="mb-1">{BUCKET_LABEL[bucket] ?? bucket}</SectionLabel>`.

- [ ] **Step 4: Run the affected suites**

Run: `cd frontend && bunx vitest run src/screens/Settings.test.tsx src/screens/Settings.categorization.test.tsx src/screens/settings/IngestHealthPage.test.tsx src/screens/Insights.test.tsx src/components/transactions/CategorizeSheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/settings/SettingsHub.tsx frontend/src/screens/settings/CategorizationPage.tsx frontend/src/screens/settings/IngestHealthPage.tsx frontend/src/screens/Insights.tsx frontend/src/components/transactions/CategorizeSheet.tsx
git commit -m "refactor(web): converge eyebrow labels on SectionLabel and card surfaces on Card

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Component documentation file + CLAUDE.md pointer

**Files:**
- Create: `frontend/src/components/README.md`
- Modify: `CLAUDE.md` (the "Frontend (`frontend/src/`)" section)

**Interfaces:**
- Consumes: everything above (documents the final state).
- Produces: the documentation file the whole plan exists to keep honest.

- [ ] **Step 1: Write the documentation file**

Create `frontend/src/components/README.md` with exactly this content:

```markdown
# UI Component Catalog

Every shared component: what it's for, when to use it, when not to. **Rule: before
hand-rolling any button, field, sheet, badge, label, or card, check this catalog.
If you add or meaningfully change a shared component, update this file in the same
commit.** Colocated `*.test.tsx` files are the behavioral spec.

## Conventions (apply to all UI work)

- **Tokens only.** Colors, radii, easings come from `src/styles/app.css`
  (`--color-*`, `--radius-card`, `--radius-sheet`, `--ease-*`). Never raw hex.
- **Touch targets.** Interactive elements are ≥44px (`min-h-11`) by default.
  36px (`IconButton size="sm"`) is allowed only inside dense stacked rows.
- **16px inputs.** Form controls use `Input`/`Select` (text-base). Anything
  smaller makes iOS Safari zoom on focus.
- **Press feedback.** Every tappable element carries `.press` (scale on
  `:active`) — hover-only affordances don't exist on touch.
- **Haptics.** `Button` and `IconButton` fire `fire("selection")` from
  `lib/feedback` themselves; don't add a second call in onClick handlers.
- **Money & counts** use `.tnum` (tabular mono figures) via `<Money>` or the
  class directly.
- **Overlays**: every sheet/modal is a `Dialog`. Full-screen drill-ins are a
  `SettingsPage`. No hand-rolled `fixed inset-0` overlays.
- **Loading**: `Skeleton` for list-shaped primary loads; a centered `Loader2`
  spinner only for non-list loads (Review deck) and inline waits.
- **Component logic** that grows beyond trivial goes into a pure `lib/`
  function with its own test (see CLAUDE.md).

## Primitives — `components/ui/`

### Button
- **Purpose:** any labeled tap action. Variants: `primary` (the screen's one
  main action), `secondary` (default, tonal), `ghost` (low-emphasis/cancel),
  `danger` (destructive).
- **Use when:** the action has a text label.
- **Don't use when:** icon-only (→ `IconButton`); navigation between screens
  (→ `BottomNav` / `HubRow`-style rows).

### IconButton
- **Purpose:** icon-only action with a required accessible `label`. 44px
  default; `size="sm"` (36px) only in dense stacked rows (TransactionRow).
  Tones: `muted` (default), `accent` (positive/primary row action),
  `danger` (delete).
- **Don't use when:** the action fits a text label (→ `Button`).

### Input / Select (`Field.tsx`)
- **Purpose:** the only text/select controls. 16px font (iOS zoom guard),
  44px min height. `icon` prop renders a leading icon (search fields).
- **Use `inset`** inside a `Dialog` (panel is already `bg-surface`); default
  `bg-surface` on pages (background `bg-bg`).
- **Don't:** copy a `className` string to make a one-off field; don't set
  `text-sm` on a control. Add `inputMode="decimal"` for money,
  `inputMode="numeric"` for integers, `enterKeyHint`/`autoCapitalize`/
  `autoCorrect` where the keyboard matters.

### Dialog
- **Purpose:** the one modal/bottom-sheet. Scrim, slide-up, focus trap,
  Escape, drag-to-dismiss, safe-area padding, `85dvh` scroll containment.
  `titleAdornment`/`titleStyle` decorate the header (see SubcategoryPanel).
- **Use when:** anything overlays the current screen but keeps context.
- **Don't use when:** the destination is a full screen task (→ `SettingsPage`).

### SettingsPage (`screens/settings/SettingsPage.tsx`)
- **Purpose:** full-screen drill-in shell — back arrow, title, optional
  `headerRight` (autosave flash), scrolling body. CategoryManager and
  RulesManager use it too.
- **Don't:** hand-roll a `fixed inset-0 z-40 bg-bg` overlay.

### Card
- **Purpose:** the elevated content surface (`bg-surface`, card radius,
  `shadow-1`, `p-4`). `className="!p-0"` + an inner `divide-y` list is the
  list-card idiom.
- **Don't:** inline `bg-surface rounded-[var(--radius-card)] shadow-1`.

### Pill
- **Purpose:** small inline status/label badge with a semantic `tone`
  (good/warn/bad/muted/neutral). Used for transaction status.
- **Don't use when:** the badge is a count overlay (BottomNav's tiny badge is
  a deliberate exception) or needs custom glyphs (→ `insights/DeltaBadge`).

### SectionLabel
- **Purpose:** the one eyebrow/section-heading style (11px, semibold,
  uppercase, 0.08em tracking, muted). `as` picks `p`/`h2`/`legend`.
- **Exception:** the swipe deck's display eyebrows (0.18em tracking) are
  intentionally wider-set; leave them.

### ProgressBar
- **Purpose:** budget progress with auto tone (green <80%, amber <100%,
  red ≥100%), optional pace marker, `onAccent` variant for the hero panel.

### SegmentedControl
- **Purpose:** exclusive choice between 2–6 short options (filters, day
  windows). Generic over the value type.
- **Don't use when:** options overflow — put long sets in a `Dialog` list.

### Switch
- **Purpose:** boolean toggle over a real checkbox (native semantics).
  Settings rows wrap it in a full-row `<label>`.

### Fab
- **Purpose:** the screen's single floating creation action, positioned above
  the bottom nav. One per screen, max.

### TopBar / BottomNav
- **Purpose:** app chrome. TopBar owns the page title + period scope stepper;
  BottomNav owns tab navigation (5 tabs, review badge). Screens never render
  their own h1 outside these.

### PeriodSheet
- **Purpose:** month/range picker built on Dialog. Reuse it anywhere a scope
  is chosen; don't build a second date picker.

## Shared components — `components/`

### Money
- **Purpose:** formats fils (int64 minor units) with sign/zero color coding
  and `.tnum`. All amounts render through it — never format currency inline.

### EmptyState
- **Purpose:** canonical empty/error state (icon chip + title + hint). Used
  for both "no data" and query-error states.

### Skeleton
- **Purpose:** pulse placeholder rows for list-shaped primary loads.

### Toast (`ToastProvider` / `useToast`)
- **Purpose:** transient outcome feedback (saved/failed), swipe-dismissable.
  Not for persistent states (→ `IngestHealthBanner` pattern).

### PullToRefreshIndicator / IngestHealthBanner
- **Purpose:** app-shell plumbing: PTR spinner; app-wide warning strip.

## Feature components

Domain components live beside their feature (`transactions/`, `swipe/`,
`insights/`, `charts/`) and compose the primitives above. Notable:
`TransactionRow` (the list row + stacked `IconButton size="sm"` actions),
`CategorizeSheet`/`AddTransactionSheet`/`SearchSheet`/`FilterChips` (Dialog
composition examples), `SubcategoryPanel` (Dialog with a decorated title).

## Known deliberate exceptions

- BottomNav's review-count badge: too small for `Pill`, stays bespoke.
- `insights/DeltaBadge`: direction arrows + domain colors, stays bespoke.
- Insights' search trigger: a `button` styled as a fake input (it opens
  `SearchSheet`), kept because a real input would summon the keyboard.
- Swipe deck cards use `rounded-[12px]` and wide-tracked eyebrows — display
  surface, intentionally denser than the card idiom.
- Transactions list is not virtualized; acceptable at current volumes.
  Revisit if months exceed ~500 rows.
```

- [ ] **Step 2: Add the CLAUDE.md pointer**

In `CLAUDE.md`, in the "### Frontend (`frontend/src/`)" section, append this paragraph after the existing `lib/` paragraph:

```markdown
`frontend/src/components/README.md` is the **UI component catalog**: every shared component's purpose plus when to use / not use it, and the mobile conventions (44px targets, 16px inputs, `.press` feedback, Dialog-only overlays). Check it before building UI; update it in the same commit whenever you add or change a shared component.
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/README.md CLAUDE.md
git commit -m "docs(web): UI component catalog with usage rules; CLAUDE.md pointer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Full verify, dist rebuild, final commit

**Files:**
- Modify: `internal/web/dist/` (committed build artifact)

**Interfaces:**
- Consumes: everything above.
- Produces: a deployable branch whose embedded bundle matches the frontend source.

- [ ] **Step 1: Re-check main for parallel-session drift**

Run `git log --oneline main..HEAD && git log --oneline HEAD..main` (if on a branch). If `main` moved — **especially if `worktree-refund-linking` merged** (it touches `TransactionRow`, `CategorizeSheet`, `Transactions`, `SwipeDeck` and adds `LinkRefundSheet`) — merge main first and re-apply the primitive adoptions to any newly-arrived raw buttons/inputs (e.g. `LinkRefundSheet`'s candidate list and any new sheet inputs) before building.

- [ ] **Step 2: Full test pass**

```bash
cd /root/Coding/ledger/frontend && bun run test
cd /root/Coding/ledger && go test ./...
```
Expected: all frontend tests PASS; Go tests PASS (known exception: `internal/config` `TestAIConfigEnabledRequiresAPIKey` fails when `LEDGER_AI_API_KEY` is set in the sandbox env — pre-existing, unrelated).

- [ ] **Step 3: Grep for stragglers**

```bash
cd /root/Coding/ledger/frontend/src
grep -rn "const field =" . && echo "FAIL: field constants remain" || echo "OK"
grep -rn 'className="[^"]*text-sm[^"]*"' --include="*.tsx" . | grep -E "<input|<select|Input |Select " | head
```
Expected: "OK" for the first; the second returns nothing input-related (labels wrapping fields at `text-sm` are fine — the control itself must be text-base).

- [ ] **Step 4: Rebuild the frontend and binary, smoke-test**

```bash
cd /root/Coding/ledger/frontend && bun install && bun run build
cd /root/Coding/ledger && CGO_ENABLED=0 go build -o ledger ./cmd/ledger
TMPD=$(mktemp -d) && printf '[server]\nlisten = "127.0.0.1:18099"\ndata_dir = "%s"\n' "$TMPD" > "$TMPD/config.toml"
./ledger -config "$TMPD/config.toml" & sleep 1.5
curl -s 127.0.0.1:18099/api/health
curl -s 127.0.0.1:18099/ | head -c 200   # SPA shell serves
kill %1 && rm -f ledger
```
Expected: `bun run build` succeeds (this is the TypeScript typecheck for all tasks); health returns `"status":"ok"`; the SPA HTML serves.

- [ ] **Step 5: Commit the dist**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded dist (mobile UI refinement)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** "refine mobile UI" → Tasks 1 (zoom/tap-highlight), 5–7 (16px fields, keypads, 36–44px targets, press feedback), 9 (accessible sheet). "Standardize component use by purpose" → Tasks 2–4 create the missing primitives, Tasks 5–10 migrate every audited bypass onto them. "Component documentation file with purpose / when / when-not" → Task 11 (`frontend/src/components/README.md` + CLAUDE.md pointer keeping it enforced).
- **Type consistency:** `Input`/`Select` props (`inset`, `icon`) match between Task 2's definition and Tasks 5–8's call sites; `IconButton` (`label`, `size`, `tone`) matches Tasks 4, 5, 7, 8; `SectionLabel` (`as`, `className`) matches Task 10; Dialog's `titleAdornment`/`titleStyle` match Task 9's usage.
- **Test-breakage audit done up front:** CategoryManager's overlay regression test (asserts `fixed` + `bg-bg`) survives the SettingsPage shell; all queried aria-labels preserved verbatim; the one intentional test change (SubcategoryPanel backdrop → `waitFor`) is specified in Task 9 Step 1.
- **Known judgment calls (documented, intended):** `TransactionRow` actions stay 36px (4 stacked 44px buttons would dominate the row); eyebrow styles visually converge on the 11px/0.08em variant; FilterChips' footer gains 44px Buttons inside the existing Dialog.
