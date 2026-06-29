# Motion Polish Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add subtle, performant motion across the ledger PWA — chiefly making every bottom sheet slide in/out smoothly and feel droppable — applying Emil Kowalski's animation craft bar where it earns its place, and exercising deliberate restraint where it doesn't.

**Architecture:** The app has **no motion library** (no framer-motion/vaul/sonner) — just React 18, Tailwind v4, recharts, and hand-rolled pointer-gesture hooks. We keep that. Motion is **CSS-first** (custom-property easing tokens + transitions, which run off the main thread per Emil's performance rules) with JS only for interruptible gestures (drag-to-dismiss, swipe). The keystone is the shared `Dialog` component: it powers 5 sheets but currently appears/disappears instantly. We bake enter/exit + drag-to-dismiss into `Dialog` once, and every sheet inherits it with **zero changes to callers**. The existing `SubcategoryPanel` (already animated with the iOS drawer curve) is our reference; we promote its pattern into shared tokens.

**Tech Stack:** React 18 + TypeScript, Tailwind v4 (`@import "tailwindcss"`, CSS-first `@theme`), Vite, recharts, vitest + @testing-library/react (jsdom), pure helpers in `frontend/src/lib/*` with co-located `*.test.ts`.

## Global Constraints

- **Money is integer minor units** elsewhere in the app, but this plan touches **no money math** — purely presentation. Do not alter any `fils`/`AmountFils` handling.
- **Only animate `transform` and `opacity`.** Never animate `width`/`height`/`top`/`left`/`margin`/`padding` for motion (they trigger layout + paint). (Emil performance rule.)
- **UI animations stay under 300ms.** Sheets/drawers 200–300ms; press feedback 100–160ms; toasts ~200ms. (Emil duration table.)
- **Never `ease-in` on UI; never `scale(0)` entry.** Use the custom curves defined in Task 1. Start entries from `scale(0.95)`/`translateY` + `opacity:0`. (Emil.)
- **Respect `prefers-reduced-motion`.** Reduced motion = keep opacity/color transitions that aid comprehension, drop transform-based movement — *not* zero animation. Use the existing `usePrefersReducedMotion()` hook (`frontend/src/hooks/usePrefersReducedMotion.ts`).
- **Restraint on frequently-seen and financial elements.** No count-up on money. No tab-switch transition (bottom nav is used tens of times/day). No chart entrance flourish (functional financial graphs). These are deliberate non-goals — see the audit below.
- **Frontend test convention:** pure decision logic lives in `frontend/src/lib/*.ts` with a co-located `*.test.ts`; components stay thin. Tests run via `cd frontend && bunx vitest run <path>`. `matchMedia` is already mocked in `src/test/setup.ts` (returns `matches: false`, i.e. motion **allowed** in tests).
- **Embedded bundle:** `internal/web/dist/` is a committed build artifact. Rebuild it (Task 9) before finishing.

---

## Motion Philosophy For This App (read before starting)

The personality is a **professional financial dashboard**: crisp and fast, not playful or bouncy. Per Emil's "should it animate?" frequency table, every candidate was triaged:

| Element | Frequency | Verdict |
| --- | --- | --- |
| Bottom sheets (Categorize, Add, Period, DrillDown, Search) | Occasional | **Animate** — slide + fade + drag-to-dismiss (Tasks 3–4) |
| Toasts | Occasional | **Animate** — slide + interruptible transitions + swipe-dismiss (Tasks 5–6) |
| Pressable buttons / FAB / icon buttons | Every interaction | **Press feedback only** — `scale(0.97)` on `:active` (Task 2) |
| Bottom-nav tab switch | Tens/day | **No transition** — animation would make navigation feel slow. Keep press feedback only. |
| Money figures (hero, rows) | Constant | **No motion** — "a functional graph in a banking app: no animation is better." |
| Charts (TrendBars, DonutChart) | Re-renders on every period/lens switch | **Disable re-animation** (Task 7) — the recharts default re-grows bars on each switch; that's frequent motion on a functional graph. |
| First paint of a long list | First-time per screen mount | **Subtle stagger** (Task 8) — decorative, ≤80ms steps, first-mount only, never on refetch. |
| Swipe deck / SubcategoryPanel (Review) | — | **Already well-animated. Leave as-is** (our reference). Only adopt the shared easing token if trivially clean. |

---

## Page-by-Page Motion Audit

This is the "where does motion go" map. Each screen lists its components, the verdict, and the task that implements it.

### Home (`src/screens/Home.tsx`)
- **Hero card / Budget-pace bars** (`ProgressBar`): bar fill already transitions `width` (300ms). It animates rarely (data load) on a 3px bar — **acceptable as-is**; not worth a transform rewrite that would distort the pill caps. No change.
- **6-month trend** (`TrendBars`): **disable recharts re-animation** (Task 7).
- **Recent list**: **first-mount stagger** (Task 8).
- Pull-to-refresh indicator: already animated (`PullToRefreshIndicator`). No change.

### Transactions (`src/screens/Transactions.tsx`)
- **FAB** (`Fab`): **press feedback** via shared `.press` (Task 2).
- **Transaction list**: **first-mount stagger** (Task 8).
- **CategorizeSheet / AddTransactionSheet** (both built on `Dialog`): inherit **slide + drag-to-dismiss** (Tasks 3–4).
- **Toasts** ("Transaction added"): **animate** (Tasks 5–6).
- SegmentedControl / search input / FilterChips: color transitions are fine. No change.

### Review (`src/screens/Review.tsx`)
- **SwipeDeck / SwipeCard / SubcategoryPanel**: **already richly animated** (edge rails, color wash, spring return, drawer-curve panel slide). **Leave as-is** — this is the reference implementation. (Optional: `SubcategoryPanel`'s hardcoded `cubic-bezier(0.32, 0.72, 0, 1)` may be swapped for `var(--ease-drawer)` in Task 1's step, but only as a no-op cleanup.)
- Loading spinner / empty state: fine. No change.

### Insights (`src/screens/Insights.tsx`)
- **DrillDownSheet / SearchSheet** (built on `Dialog`, and they nest `CategorizeSheet`): inherit **slide + drag-to-dismiss** (Tasks 3–4).
- **TrendBars / DonutChart**: **disable re-animation** (Task 7).
- **Lens SegmentedControl** swaps `LensBreakdown` content on every tap (frequent): **no crossfade** — deliberate restraint. No change.
- ComparativeSummary / TopMovers / LensBreakdown rows: static. No change.

### Settings (`src/screens/Settings.tsx`) & Category Manager (`src/screens/CategoryManager.tsx`)
- Form screens. Buttons use the shared `Button` primitive → **press feedback inherited** (Task 2). Any modal/sheet they render via `Dialog` inherits Tasks 3–4. **Implementer note:** if these screens contain bespoke `<button>`s not using the `Button` component, add the `press` class to them in Task 2.

### Shell (`src/app/AppShell.tsx`, `BottomNav`, `TopBar`)
- **Tab switch**: **no content transition** (used tens/day). Keep instant.
- **BottomNav** buttons: **press feedback** (Task 2). Active-indicator pill keeps its existing `transition-colors`. No layout/shared-element animation — deliberate restraint.
- **TopBar** month chevrons / period button: **press feedback** (Task 2). The `PeriodSheet` it opens inherits Tasks 3–4.

---

## File Structure

**New files:**
- `frontend/src/lib/motion.ts` — pure motion helpers + duration constants (single source for JS-side timing; curves live as CSS vars). Test: `frontend/src/lib/motion.test.ts`.
- `frontend/src/lib/sheetDrag.ts` — pure drag-to-dismiss geometry (damping + velocity/distance rule). Test: `frontend/src/lib/sheetDrag.test.ts`.
- `frontend/src/lib/toastSwipe.ts` — pure horizontal swipe-dismiss rule for toasts. Test: `frontend/src/lib/toastSwipe.test.ts`.
- `frontend/src/hooks/useSheetDrag.ts` — pointer-gesture hook wiring `sheetDrag` math to a sheet panel.
- `frontend/src/hooks/useFirstMount.ts` — returns `true` only during a component's first render. Test: `frontend/src/hooks/useFirstMount.test.ts`.
- `frontend/src/components/ui/Dialog.test.tsx` — new test for the animated Dialog.

**Modified files:**
- `frontend/src/styles/app.css` — easing/duration custom-property tokens + `.press` and `.stagger-item` utilities.
- `frontend/src/components/ui/Button.tsx`, `ui/Fab.tsx`, `ui/BottomNav.tsx` — add `press` class.
- `frontend/src/components/ui/Dialog.tsx` — enter/exit slide + drag-to-dismiss.
- `frontend/src/components/Toast.tsx` — enter/exit + interruptible transitions + pause-on-hidden + swipe-dismiss.
- `frontend/src/components/charts/TrendBars.tsx`, `charts/DonutChart.tsx` — `isAnimationActive={false}`.
- `frontend/src/screens/Home.tsx`, `screens/Transactions.tsx` — apply first-mount stagger to lists.
- Existing sheet tests that assert synchronous close (updated in Task 3): `ui/PeriodSheet.test.tsx`, `ui/TopBar.test.tsx`, `transactions/AddTransactionSheet.test.tsx`, `transactions/CategorizeSheet.test.tsx`, `insights/DrillDownSheet.test.tsx`, `insights/SearchSheet.test.tsx`.
- `internal/web/dist/**` — rebuilt embedded bundle (Task 9).

---

## Task 1: Motion foundation (easing tokens + timing helpers)

Establishes the shared motion vocabulary: custom easing curves as CSS custom properties (usable both in CSS and in JS inline-style strings via `var(--ease-*)`), plus a tiny pure module for the few timing numbers JS needs to coordinate exit-then-unmount.

**Files:**
- Modify: `frontend/src/styles/app.css` (insert a `:root` motion-token block after the `@theme {…}` block, before the `html, body` rules at line 37)
- Create: `frontend/src/lib/motion.ts`
- Test: `frontend/src/lib/motion.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3, 5): `SHEET_ENTER_MS = 300`, `SHEET_EXIT_MS = 240` (numbers); `sheetTransition(reduced: boolean): string`; `scrimTransition(): string`.
- Produces (CSS, consumed by Tasks 2, 3, 8): custom properties `--ease-out`, `--ease-in-out`, `--ease-drawer`, `--dur-press`.

- [ ] **Step 1: Write the failing test** — `frontend/src/lib/motion.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { sheetTransition, scrimTransition, SHEET_ENTER_MS, SHEET_EXIT_MS } from "./motion";

describe("sheetTransition", () => {
  it("uses the drawer curve and enter duration when motion is allowed", () => {
    expect(sheetTransition(false)).toBe(`transform ${SHEET_ENTER_MS}ms var(--ease-drawer)`);
  });
  it("drops the transform transition under reduced motion", () => {
    expect(sheetTransition(true)).toBe("none");
  });
});

describe("scrimTransition", () => {
  it("animates opacity with the ease-out curve (kept even under reduced motion)", () => {
    expect(scrimTransition()).toContain("opacity");
    expect(scrimTransition()).toContain("var(--ease-out)");
  });
});

describe("timing constants", () => {
  it("stay within the UI budget (<300ms exit, <=300ms enter)", () => {
    expect(SHEET_EXIT_MS).toBeLessThan(300);
    expect(SHEET_ENTER_MS).toBeLessThanOrEqual(300);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/motion.test.ts`
Expected: FAIL — `Failed to resolve import "./motion"` (file does not exist yet).

- [ ] **Step 3: Create `frontend/src/lib/motion.ts`**

```ts
// Pure motion helpers. The easing CURVES live in styles/app.css as CSS custom
// properties (`var(--ease-*)`), referenced directly inside inline-style strings
// so there's one source of truth for them. These numbers exist only for JS that
// must coordinate timing — e.g. play an exit transition, then unmount.

/** Bottom-sheet slide-in duration (ms). Matches the drawer feel; <=300ms. */
export const SHEET_ENTER_MS = 300;
/** Bottom-sheet slide-out duration (ms). Exit is snappier than enter. */
export const SHEET_EXIT_MS = 240;

/**
 * Transition for a bottom sheet's `transform`. Under reduced motion we drop the
 * transform transition entirely (the sheet appears/leaves without sliding);
 * opacity/scrim still fade via scrimTransition() to aid comprehension.
 */
export function sheetTransition(reduced: boolean): string {
  return reduced ? "none" : `transform ${SHEET_ENTER_MS}ms var(--ease-drawer)`;
}

/** Transition for the backdrop scrim's opacity. Kept under reduced motion. */
export function scrimTransition(): string {
  return "opacity 200ms var(--ease-out)";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/motion.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the CSS easing/duration tokens** — in `frontend/src/styles/app.css`, insert immediately after the closing `}` of the `@theme { … }` block (currently line 35) and before `html, body, #root { height: 100%; }`:

```css
/* Motion tokens — strong custom easings (Emil Kowalski's craft bar). Built-in
   CSS easings are too weak; these give entrances/exits intentional punch.
   Usable in CSS rules and in JS inline styles via var(--ease-*). */
:root {
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);      /* entering/exiting UI */
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);  /* on-screen movement   */
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);   /* iOS-like sheet curve  */
  --dur-press: 140ms;                               /* button press feedback */
}
```

- [ ] **Step 6: (Optional no-op cleanup) point the existing drawer curve at the token** — in `frontend/src/styles/app.css`, the `.swipe-card-in` keyframe at line 56 uses the literal `cubic-bezier(0.32, 0.72, 0, 1)`. Replace it with `var(--ease-drawer)` so there's one definition:

```css
.swipe-card-in { animation: swipe-card-in 0.32s var(--ease-drawer) both; }
```

(`SubcategoryPanel.tsx` line 55 has the same literal in an inline style — leave it for now; Task 4 does not touch that file and changing it risks an untested visual regression. The token is the canonical source going forward.)

- [ ] **Step 7: Verify the full suite still passes**

Run: `cd frontend && bunx vitest run`
Expected: PASS (all existing tests + the 4 new ones). CSS changes are inert to jsdom.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/motion.ts frontend/src/lib/motion.test.ts frontend/src/styles/app.css
git commit -m "feat(motion): add easing/duration tokens and sheet timing helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Pressable feedback pass (`.press` → buttons, FAB, nav)

Every pressable element should confirm it heard the tap with a subtle `scale(0.97)`. One CSS utility, applied across the shared primitives. Reduced motion drops the scale.

**Files:**
- Modify: `frontend/src/styles/app.css` (add `.press` utility after the motion-token block)
- Modify: `frontend/src/components/ui/Button.tsx:15`
- Modify: `frontend/src/components/ui/Fab.tsx:10`
- Modify: `frontend/src/components/ui/BottomNav.tsx:17`
- Test: `frontend/src/components/ui/Button.test.tsx` (file exists)

**Interfaces:**
- Produces: a `.press` class (CSS only). No JS API.

- [ ] **Step 1: Add a failing assertion to the existing Button test** — append to `frontend/src/components/ui/Button.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { Button } from "./Button";

it("applies press-feedback class for tactile :active scaling", () => {
  render(<Button>Save</Button>);
  expect(screen.getByRole("button", { name: "Save" }).className).toContain("press");
});
```

(If `Button.test.tsx` has no React imports yet, add the `render`/`screen` import line at the top instead of re-importing.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/components/ui/Button.test.tsx`
Expected: FAIL — `expect(...).toContain("press")` (class not present yet).

- [ ] **Step 3: Add the `.press` utility** — in `frontend/src/styles/app.css`, after the `:root { --ease-* }` block from Task 1:

```css
/* Press feedback — subtle scale confirms the UI heard the tap. Applies to any
   pressable element. Disabled under reduced motion (movement removed, not the
   element). Scale on :active is correct on touch too (unlike hover). */
.press { transition: transform var(--dur-press) var(--ease-out); }
.press:active { transform: scale(0.97); }
@media (prefers-reduced-motion: reduce) {
  .press:active { transform: none; }
}
```

- [ ] **Step 4: Apply `press` to `Button`** — `frontend/src/components/ui/Button.tsx`, line 15, add `press` into the className template (keep `transition-colors` for the color hover):

```tsx
      className={`min-h-11 px-5 rounded-lg text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors press disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
```

- [ ] **Step 5: Apply `press` to `Fab`** — `frontend/src/components/ui/Fab.tsx`, line 10, replace the ad-hoc `active:scale-95 transition` with the shared utility (and keep `hover:opacity-90`):

```tsx
      className="fixed right-4 z-30 flex items-center justify-center w-14 h-14 rounded-lg bg-accent text-accent-fg shadow-1 hover:opacity-90 press bottom-[calc(env(safe-area-inset-bottom)+4.5rem)]"
```

- [ ] **Step 6: Apply `press` to bottom-nav buttons** — `frontend/src/components/ui/BottomNav.tsx`, line 17, add `press` to the tab `<button>` className:

```tsx
            className={`min-h-14 flex flex-col items-center justify-center gap-1 text-xs press ${isActive ? "text-accent font-medium" : "text-muted"}`}
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd frontend && bunx vitest run src/components/ui/Button.test.tsx src/components/ui/Fab.test.tsx src/components/ui/BottomNav.test.tsx`
Expected: PASS (new assertion green; existing Fab/BottomNav tests unaffected).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/styles/app.css frontend/src/components/ui/Button.tsx frontend/src/components/ui/Fab.tsx frontend/src/components/ui/BottomNav.tsx frontend/src/components/ui/Button.test.tsx
git commit -m "feat(motion): add press-feedback scale to buttons, FAB, and nav

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Animate the shared Dialog (slide enter + exit)

The keystone. `Dialog` powers PeriodSheet, CategorizeSheet, AddTransactionSheet, DrillDownSheet, and SearchSheet, but currently mounts/unmounts instantly. We give it a backdrop fade + bottom-sheet slide on enter, and — critically — an **exit animation**: closing now plays the slide-down first, then calls the parent's `onClose` (which unmounts it). Callers are unchanged.

**Files:**
- Modify (rewrite): `frontend/src/components/ui/Dialog.tsx`
- Create: `frontend/src/components/ui/Dialog.test.tsx`
- Modify (fix delayed-close expectations): `ui/PeriodSheet.test.tsx`, `ui/TopBar.test.tsx`, `transactions/AddTransactionSheet.test.tsx`, `transactions/CategorizeSheet.test.tsx`, `insights/DrillDownSheet.test.tsx`, `insights/SearchSheet.test.tsx`

**Interfaces:**
- Consumes (from Task 1): `sheetTransition`, `scrimTransition`, `SHEET_EXIT_MS` from `../../lib/motion`; `usePrefersReducedMotion` from `../../hooks/usePrefersReducedMotion`.
- Produces: unchanged public props `{ title: string; onClose: () => void; children: ReactNode }`. New behavior: `onClose` fires **after** `SHEET_EXIT_MS` (or synchronously under reduced motion).

- [ ] **Step 1: Write the failing test** — `frontend/src/components/ui/Dialog.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dialog } from "./Dialog";
import { SHEET_EXIT_MS } from "../../lib/motion";

describe("Dialog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders the title and children", () => {
    render(<Dialog title="Choose period" onClose={vi.fn()}>body</Dialog>);
    expect(screen.getByRole("dialog", { name: "Choose period" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("gives the panel a transform transition for the slide", () => {
    render(<Dialog title="T" onClose={vi.fn()}>x</Dialog>);
    expect(screen.getByRole("dialog").style.transition).toContain("transform");
  });

  it("plays the exit before calling onClose", () => {
    const onClose = vi.fn();
    render(<Dialog title="T" onClose={onClose}>x</Dialog>);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).not.toHaveBeenCalled();          // exit in flight
    vi.advanceTimersByTime(SHEET_EXIT_MS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire onClose when closed twice quickly", () => {
    const onClose = vi.fn();
    render(<Dialog title="T" onClose={onClose}>x</Dialog>);
    fireEvent.click(screen.getByLabelText("Close"));
    fireEvent.keyDown(document, { key: "Escape" });
    vi.advanceTimersByTime(SHEET_EXIT_MS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/components/ui/Dialog.test.tsx`
Expected: FAIL — the "plays the exit before calling onClose" case fails because the current Dialog calls `onClose` synchronously (and there is no transform transition style).

- [ ] **Step 3: Rewrite `frontend/src/components/ui/Dialog.tsx`**

```tsx
// frontend/src/components/ui/Dialog.tsx
import { useEffect, useId, useRef, type ReactNode } from "react";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { sheetTransition, scrimTransition, SHEET_EXIT_MS } from "../../lib/motion";

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const reduced = usePrefersReducedMotion();
  const titleId = useId();
  const closingRef = useRef(false);     // guards against double-close
  const timerRef = useRef<number | null>(null);

  // Slide the sheet up and fade the scrim in on mount. Double rAF lets the
  // browser paint the offscreen start state before transitioning to rest.
  useEffect(() => {
    const panel = panelRef.current, scrim = scrimRef.current;
    panel?.focus();
    if (reduced || !panel || !scrim) return;
    panel.style.transform = "translateY(100%)";
    scrim.style.opacity = "0";
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        panel.style.transform = "translateY(0)";
        scrim.style.opacity = "1";
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [reduced]);

  // Play the exit, then ask the parent to unmount us. Under reduced motion,
  // close immediately (no slide).
  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reduced) { onCloseRef.current(); return; }
    const panel = panelRef.current, scrim = scrimRef.current;
    if (panel) panel.style.transform = "translateY(100%)";
    if (scrim) scrim.style.opacity = "0";
    timerRef.current = window.setTimeout(() => onCloseRef.current(), SHEET_EXIT_MS);
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { requestCloseRef.current(); return; }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []); // mount-only; refs hold the latest callbacks

  return (
    <div
      className="fixed inset-x-0 top-0 h-[100dvh] z-50 flex items-end sm:items-center justify-center"
      onClick={requestClose}
    >
      <div ref={scrimRef} aria-hidden className="absolute inset-0 bg-black/40" style={{ transition: scrimTransition() }} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{ transition: sheetTransition(reduced), willChange: "transform" }}
        className="relative w-full sm:max-w-md bg-surface rounded-t-[var(--radius-sheet)] sm:rounded-[var(--radius-sheet)] px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[85dvh] overflow-y-auto overscroll-contain outline-none"
      >
        <div aria-hidden className="sm:hidden mx-auto mb-2 h-1 w-9 rounded-full bg-border" />
        <div className="flex items-center justify-between mb-3">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button aria-label="Close" className="-mr-2 p-2 rounded-lg text-muted hover:bg-surface-2 text-xl leading-none press" onClick={requestClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

Notes: the scrim is now a separate `aria-hidden` element (was the root's `bg-black/40`) so it can fade independently. The panel gets `relative` so it stacks above the absolute scrim.

- [ ] **Step 4: Run the new Dialog test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/ui/Dialog.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite to surface the delayed-close fallout**

Run: `cd frontend && bunx vitest run`
Expected: FAIL in some existing sheet tests. Reason: tests that click Close / the backdrop / press Escape and then assert `onClose`/`onCancel`/`onApply` was called **synchronously** now see it fire after `SHEET_EXIT_MS`. Inspect each failure.

- [ ] **Step 6: Fix the affected existing tests** — for each test that asserts a *close* callback fired right after a close interaction (clicking the `×`, clicking the backdrop, or pressing Escape), wrap with fake timers and advance. Apply this pattern (example for `frontend/src/components/transactions/CategorizeSheet.test.tsx` — adapt the import/handle to each file):

```tsx
import { vi, beforeEach, afterEach } from "vitest";
import { SHEET_EXIT_MS } from "../../lib/motion";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ...inside a test that closes the sheet:
fireEvent.click(screen.getByLabelText("Close"));
vi.advanceTimersByTime(SHEET_EXIT_MS);
expect(onClose).toHaveBeenCalled();
```

Important distinctions while editing:
- Callbacks that fire on a **primary action, not a close** — `PeriodSheet`'s "Show"/preset buttons call `onApply` directly, `CategorizeSheet`'s "Save" calls `onSubmit` directly, `AddTransactionSheet`'s "Add" calls `onSubmit` directly. These are **not** routed through `requestClose` and remain synchronous — do **not** add timer advances to those assertions.
- Only the `×` button, backdrop click, and Escape now defer. Update just those assertions.
- Files to review (close-path assertions): `ui/PeriodSheet.test.tsx`, `ui/TopBar.test.tsx`, `transactions/AddTransactionSheet.test.tsx`, `transactions/CategorizeSheet.test.tsx`, `insights/DrillDownSheet.test.tsx`, `insights/SearchSheet.test.tsx`. (Some may have no close-path assertion and need no change.)

- [ ] **Step 7: Run the full suite again to verify green**

Run: `cd frontend && bunx vitest run`
Expected: PASS (all tests).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ui/Dialog.tsx frontend/src/components/ui/Dialog.test.tsx frontend/src/components/ui/PeriodSheet.test.tsx frontend/src/components/ui/TopBar.test.tsx frontend/src/components/transactions/AddTransactionSheet.test.tsx frontend/src/components/transactions/CategorizeSheet.test.tsx frontend/src/components/insights/DrillDownSheet.test.tsx frontend/src/components/insights/SearchSheet.test.tsx
git commit -m "feat(motion): slide bottom sheets in and out via shared Dialog

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Drag-to-dismiss for the Dialog sheet

Make the sheet feel droppable: drag the grab-handle/header down to dismiss, with rubber-band resistance when pushed up past rest, and velocity-based dismissal (a flick is enough — no need to cross a big distance). Pure geometry lives in `lib/`; the pointer wiring is a small hook.

**Files:**
- Create: `frontend/src/lib/sheetDrag.ts`
- Test: `frontend/src/lib/sheetDrag.test.ts`
- Create: `frontend/src/hooks/useSheetDrag.ts`
- Modify: `frontend/src/components/ui/Dialog.tsx` (wire the hook to the handle/header region)
- Modify: `frontend/src/components/ui/Dialog.test.tsx` (add a drag-dismiss test)

**Interfaces:**
- `sheetDrag.ts` produces: `SHEET_DISMISS_DISTANCE = 120`, `SHEET_DISMISS_VELOCITY = 0.11`; `sheetOffset(dy: number): number`; `shouldDismiss(dy: number, elapsedMs: number): boolean`.
- `useSheetDrag.ts` produces: `useSheetDrag(panelRef: RefObject<HTMLDivElement>, onDismiss: () => void, reduced: boolean) => { onPointerDown; onPointerMove; onPointerUp }` (React pointer handlers to spread onto the drag region).
- Consumes (in Dialog): `requestClose` from Task 3 becomes the `onDismiss` target; `sheetTransition` to snap back.

- [ ] **Step 1: Write the failing test** — `frontend/src/lib/sheetDrag.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { sheetOffset, shouldDismiss, SHEET_DISMISS_DISTANCE } from "./sheetDrag";

describe("sheetOffset", () => {
  it("moves 1:1 when dragged down", () => {
    expect(sheetOffset(50)).toBe(50);
    expect(sheetOffset(0)).toBe(0);
  });
  it("applies damped resistance when dragged up past rest", () => {
    const up = sheetOffset(-100);
    expect(up).toBeLessThan(0);          // still moves up a little
    expect(up).toBeGreaterThan(-100);    // but far less than the raw drag
  });
});

describe("shouldDismiss", () => {
  it("dismisses on a long slow drag down", () => {
    expect(shouldDismiss(SHEET_DISMISS_DISTANCE + 1, 1000)).toBe(true);
  });
  it("dismisses on a quick flick even if short", () => {
    expect(shouldDismiss(40, 100)).toBe(true);   // 0.4 px/ms > 0.11
  });
  it("snaps back on a short slow drag", () => {
    expect(shouldDismiss(40, 1000)).toBe(false); // 0.04 px/ms, under both bars
  });
  it("never dismisses on an upward drag", () => {
    expect(shouldDismiss(-200, 100)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/sheetDrag.test.ts`
Expected: FAIL — cannot resolve `./sheetDrag`.

- [ ] **Step 3: Create `frontend/src/lib/sheetDrag.ts`**

```ts
// Pure drag-to-dismiss geometry for a bottom sheet. Framework-free so the
// damping curve and the dismissal rule are unit-tested without rendering.

/** Drag-down distance (px) that dismisses on release. */
export const SHEET_DISMISS_DISTANCE = 120;
/** Flick velocity (px/ms) that dismisses regardless of distance. */
export const SHEET_DISMISS_VELOCITY = 0.11;

/**
 * Resolve raw vertical drag into the sheet's visible offset. Downward (dy > 0)
 * moves 1:1. Dragging up past rest gets rubber-band damping — the further you
 * push, the less it moves — instead of an invisible wall.
 */
export function sheetOffset(dy: number): number {
  if (dy >= 0) return dy;
  return -Math.sqrt(-dy) * 6;
}

/** Should the sheet dismiss on release? A long drag down OR a quick flick down. */
export function shouldDismiss(dy: number, elapsedMs: number): boolean {
  if (dy <= 0) return false;
  const velocity = dy / Math.max(1, elapsedMs);
  return dy >= SHEET_DISMISS_DISTANCE || velocity >= SHEET_DISMISS_VELOCITY;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/sheetDrag.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Create the gesture hook `frontend/src/hooks/useSheetDrag.ts`**

```ts
import { useCallback, useRef, type PointerEvent, type RefObject } from "react";
import { sheetOffset, shouldDismiss } from "../lib/sheetDrag";
import { sheetTransition } from "../lib/motion";

/**
 * Pointer drag-to-dismiss for a bottom sheet. Spread the returned handlers onto
 * the drag region (grab handle + header). Drives the panel's transform directly
 * (no React state per move — avoids re-render churn and stays on the GPU).
 */
export function useSheetDrag(
  panelRef: RefObject<HTMLDivElement>,
  onDismiss: () => void,
  reduced: boolean,
) {
  const startY = useRef<number | null>(null);
  const startT = useRef(0);
  const dy = useRef(0);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (reduced || dragging.current) return;          // multi-touch guard
    dragging.current = true;
    startY.current = e.clientY;
    startT.current = Date.now();
    dy.current = 0;
    e.currentTarget.setPointerCapture?.(e.pointerId);  // keep events if pointer leaves
    const panel = panelRef.current;
    if (panel) panel.style.transition = "none";        // 1:1 follow while dragging
  }, [reduced, panelRef]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current || startY.current === null) return;
    dy.current = e.clientY - startY.current;
    const panel = panelRef.current;
    if (panel) panel.style.transform = `translateY(${sheetOffset(dy.current)}px)`;
  }, [panelRef]);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    const elapsed = Date.now() - startT.current;
    const panel = panelRef.current;
    if (shouldDismiss(dy.current, elapsed)) {
      onDismiss();                                     // Dialog plays the rest of the slide-out
      return;
    }
    if (panel) {                                       // snap back to rest
      panel.style.transition = sheetTransition(reduced);
      panel.style.transform = "translateY(0)";
    }
    startY.current = null;
  }, [panelRef, onDismiss, reduced]);

  return { onPointerDown, onPointerMove, onPointerUp };
}
```

- [ ] **Step 6: Wire the hook into `frontend/src/components/ui/Dialog.tsx`** — import it, instantiate it pointing at `requestClose`, and spread the handlers onto a drag region wrapping the grab handle + header. Add this import near the top:

```tsx
import { useSheetDrag } from "../../hooks/useSheetDrag";
```

Inside the component, after `requestCloseRef.current = requestClose;`:

```tsx
  const drag = useSheetDrag(panelRef, () => requestCloseRef.current(), reduced);
```

Then wrap the handle + header in a drag region with `touch-action: none` so the browser doesn't scroll while dragging. Replace the existing handle `<div>` and header `<div className="flex items-center justify-between mb-3">` with a single wrapper (mobile-only drag; desktop modal keeps pointer events inert because there's no handle shown there):

```tsx
        <div
          className="touch-none cursor-grab active:cursor-grabbing"
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
        >
          <div aria-hidden className="sm:hidden mx-auto mb-2 h-1 w-9 rounded-full bg-border" />
          <div className="flex items-center justify-between mb-3">
            <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
            <button aria-label="Close" className="-mr-2 p-2 rounded-lg text-muted hover:bg-surface-2 text-xl leading-none press" onClick={requestClose}>×</button>
          </div>
        </div>
```

(Dragging is gated by `reduced` inside the hook, so reduced-motion users simply tap to close.)

- [ ] **Step 7: Add a drag-dismiss test** — append to `frontend/src/components/ui/Dialog.test.tsx`:

```tsx
it("dismisses when the handle is flicked down", () => {
  const onClose = vi.fn();
  render(<Dialog title="T" onClose={onClose}>x</Dialog>);
  const handle = screen.getByText("T").closest("div")!; // the drag region wrapping the header
  fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: 60, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientY: 60, pointerId: 1 });
  vi.advanceTimersByTime(SHEET_EXIT_MS);
  expect(onClose).toHaveBeenCalled();
});
```

Note: jsdom pointer events carry `clientY`; `setPointerCapture` is called with optional chaining so its absence is harmless. The down→move(60) happens within the same tick, so velocity (60px / ~1ms) clears the flick bar.

- [ ] **Step 8: Run Dialog + sheetDrag tests, then the full suite**

Run: `cd frontend && bunx vitest run src/components/ui/Dialog.test.tsx src/lib/sheetDrag.test.ts`
Expected: PASS.
Run: `cd frontend && bunx vitest run`
Expected: PASS (all tests).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/sheetDrag.ts frontend/src/lib/sheetDrag.test.ts frontend/src/hooks/useSheetDrag.ts frontend/src/components/ui/Dialog.tsx frontend/src/components/ui/Dialog.test.tsx
git commit -m "feat(motion): drag-to-dismiss bottom sheets with velocity flick

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Toast enter/exit + interruptible transitions + pause-on-hidden

Apply the Sonner principles to the existing toast system: slide up from below on enter, fade/slide out on dismiss (transitions, not keyframes, so rapid toasts retarget smoothly), and pause the auto-dismiss timer while the tab is hidden so a backgrounded toast isn't already gone when the user returns.

**Files:**
- Modify: `frontend/src/components/Toast.tsx` (the `ToastItem` component)
- Modify: `frontend/src/components/Toast.test.tsx` (add enter/exit + pause coverage)

**Interfaces:**
- Consumes (from earlier): `usePrefersReducedMotion` from `../hooks/usePrefersReducedMotion`.
- Public API of `Toast.tsx` (`ToastProvider`, `useToast`, `toastReducer`, `Toast`/`ToastAction` types) is unchanged.

- [ ] **Step 1: Write the failing test** — append to `frontend/src/components/Toast.test.tsx`:

```tsx
import { usePrefersReducedMotion as _unused } from "../hooks/usePrefersReducedMotion"; // ensure module resolves
import { render as renderItem } from "@testing-library/react";

describe("ToastItem motion", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("enters with a transform+opacity transition and delays removal on dismiss", () => {
    const onDismiss = vi.fn();
    render(
      <ToastProvider>
        <></>
      </ToastProvider>,
    );
    // Render a toast via the provider and grab its element.
    // (Use the existing Trigger pattern: click "go", then dismiss with ×.)
  });
});
```

Replace the placeholder above with a concrete test driven through the provider, mirroring the existing `Trigger` helper at the top of the file. Add this self-contained test instead:

```tsx
describe("toast enter/exit motion", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the toast mounted briefly after × is clicked (exit animation)", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    const toast = screen.getByText("Ignored Spinneys");
    expect(toast).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    // Still present immediately after click — exit is animating.
    expect(screen.queryByText("Ignored Spinneys")).toBeInTheDocument();
    vi.advanceTimersByTime(200);
    expect(screen.queryByText("Ignored Spinneys")).toBeNull();
  });

  it("gives the toast a transform+opacity transition", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    const el = screen.getByText("Ignored Spinneys").closest("[style]") as HTMLElement;
    expect(el.style.transition).toContain("opacity");
  });
});
```

(The existing `Trigger` already renders a toast with an action; the `×` button has `aria-label="Dismiss"`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/components/Toast.test.tsx`
Expected: FAIL — clicking `×` currently removes the toast synchronously (no delay), and there's no transition style on the element.

- [ ] **Step 3: Rewrite the `ToastItem` component** in `frontend/src/components/Toast.tsx`. Add the import at the top of the file:

```tsx
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
```

Replace the existing `ToastItem` (lines 24–47) with:

```tsx
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const reduced = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Slide/fade out, then ask the provider to drop it from state.
  const beginDismiss = useCallback(() => {
    if (reduced) { onDismissRef.current(); return; }
    setLeaving(true);
    window.setTimeout(() => onDismissRef.current(), 200);
  }, [reduced]);
  const beginRef = useRef(beginDismiss);
  beginRef.current = beginDismiss;

  // Trigger the enter transition one frame after mount.
  useEffect(() => {
    const r = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Auto-dismiss after 5s, pausing while the tab is hidden so a backgrounded
  // toast still gets its full on-screen time when the user returns.
  useEffect(() => {
    let remaining = 5000;
    let startedAt = Date.now();
    let id = window.setTimeout(() => beginRef.current(), remaining);
    const onVis = () => {
      if (document.hidden) {
        clearTimeout(id);
        remaining -= Date.now() - startedAt;
      } else {
        startedAt = Date.now();
        id = window.setTimeout(() => beginRef.current(), Math.max(0, remaining));
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(id); document.removeEventListener("visibilitychange", onVis); };
  }, []); // mount-only; beginRef holds the latest callback

  const tone = toast.tone === "success" ? "bg-good" : toast.tone === "error" ? "bg-bad" : "bg-fg";
  const hidden = !mounted || leaving;
  return (
    <div
      style={{
        transition: reduced
          ? "opacity 150ms var(--ease-out)"
          : "transform 200ms var(--ease-out), opacity 200ms var(--ease-out)",
        transform: reduced ? undefined : hidden ? "translateY(12px)" : "translateY(0)",
        opacity: hidden ? 0 : 1,
        willChange: "transform",
      }}
      className={`pointer-events-auto flex items-center gap-3 max-w-[92vw] text-bg px-3 py-2.5 rounded-lg shadow-lg ${tone}`}
    >
      <span className="flex-1 text-sm">{toast.message}</span>
      {toast.action && (
        <button
          className="text-sm font-semibold text-bg/90 underline press"
          onClick={() => { try { toast.action!.onAction(); } finally { beginDismiss(); } }}
        >
          {toast.action.label}
        </button>
      )}
      <button aria-label="Dismiss" className="text-bg/70 press" onClick={beginDismiss}>×</button>
    </div>
  );
}
```

Update the imports on line 1 to include `useState` (already imports `useCallback, useEffect, useReducer, useMemo, useRef`):

```tsx
import { createContext, useCallback, useContext, useEffect, useReducer, useMemo, useRef, useState, type ReactNode } from "react";
```

- [ ] **Step 4: Run the Toast tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/Toast.test.tsx`
Expected: PASS — including the original "shows a toast and fires its action" test (the action still calls `onAction`; it now calls `beginDismiss` instead of `onDismiss`, which fires `onDismiss` after 200ms — the original test doesn't assert removal timing, so it stays green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Toast.tsx frontend/src/components/Toast.test.tsx
git commit -m "feat(motion): animate toasts in/out with interruptible transitions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Swipe-to-dismiss for toasts

Spatial consistency: toasts live at the bottom and can be flicked away horizontally. Pure rule in `lib/`, wired into `ToastItem` with the same pointer pattern as the sheet.

**Files:**
- Create: `frontend/src/lib/toastSwipe.ts`
- Test: `frontend/src/lib/toastSwipe.test.ts`
- Modify: `frontend/src/components/Toast.tsx` (`ToastItem` pointer handlers)

**Interfaces:**
- `toastSwipe.ts` produces: `TOAST_DISMISS_DISTANCE = 80`; `shouldDismissToast(dx: number, elapsedMs: number): boolean` (reuses the 0.11 px/ms flick bar via import from `./sheetDrag`).

- [ ] **Step 1: Write the failing test** — `frontend/src/lib/toastSwipe.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { shouldDismissToast, TOAST_DISMISS_DISTANCE } from "./toastSwipe";

describe("shouldDismissToast", () => {
  it("dismisses on a long horizontal drag either direction", () => {
    expect(shouldDismissToast(TOAST_DISMISS_DISTANCE + 1, 1000)).toBe(true);
    expect(shouldDismissToast(-(TOAST_DISMISS_DISTANCE + 1), 1000)).toBe(true);
  });
  it("dismisses on a quick flick", () => {
    expect(shouldDismissToast(30, 100)).toBe(true); // 0.3 px/ms > 0.11
  });
  it("snaps back on a small slow drag", () => {
    expect(shouldDismissToast(20, 1000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/toastSwipe.test.ts`
Expected: FAIL — cannot resolve `./toastSwipe`.

- [ ] **Step 3: Create `frontend/src/lib/toastSwipe.ts`**

```ts
import { SHEET_DISMISS_VELOCITY } from "./sheetDrag";

/** Horizontal drag distance (px) that dismisses a toast on release. */
export const TOAST_DISMISS_DISTANCE = 80;

/** Dismiss on a long horizontal drag (either direction) or a quick flick. */
export function shouldDismissToast(dx: number, elapsedMs: number): boolean {
  const dist = Math.abs(dx);
  const velocity = dist / Math.max(1, elapsedMs);
  return dist >= TOAST_DISMISS_DISTANCE || velocity >= SHEET_DISMISS_VELOCITY;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/toastSwipe.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire horizontal swipe into `ToastItem`** in `frontend/src/components/Toast.tsx`. Add the import:

```tsx
import { shouldDismissToast } from "../lib/toastSwipe";
```

Inside `ToastItem`, add drag refs and handlers (place after the `beginDismiss` definition). Drive the element transform directly via a ref:

```tsx
  const elRef = useRef<HTMLDivElement>(null);
  const dragX = useRef<{ start: number; t: number; dx: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (reduced) return;
    dragX.current = { start: e.clientX, t: Date.now(), dx: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (elRef.current) elRef.current.style.transition = "none";
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragX.current) return;
    dragX.current.dx = e.clientX - dragX.current.start;
    if (elRef.current) elRef.current.style.transform = `translateX(${dragX.current.dx}px)`;
  };
  const onPointerUp = () => {
    const d = dragX.current;
    dragX.current = null;
    if (!d) return;
    if (shouldDismissToast(d.dx, Date.now() - d.t)) { beginDismiss(); return; }
    if (elRef.current) {                       // snap back
      elRef.current.style.transition = "transform 200ms var(--ease-out)";
      elRef.current.style.transform = "translateX(0)";
    }
  };
```

Attach `ref={elRef}` and the three handlers to the toast's outer `<div>` (the one carrying the `style`/`className`), and add `touchAction: "pan-y"` to its style object so vertical scrolling still works but horizontal drag is ours:

```tsx
    <div
      ref={elRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        transition: reduced
          ? "opacity 150ms var(--ease-out)"
          : "transform 200ms var(--ease-out), opacity 200ms var(--ease-out)",
        transform: reduced ? undefined : hidden ? "translateY(12px)" : "translateY(0)",
        opacity: hidden ? 0 : 1,
        willChange: "transform",
        touchAction: "pan-y",
      }}
      className={`pointer-events-auto flex items-center gap-3 max-w-[92vw] text-bg px-3 py-2.5 rounded-lg shadow-lg ${tone}`}
    >
```

Note: while dragging we overwrite `transform` with `translateX`, replacing the `translateY` enter offset — acceptable because dragging only starts after the toast has settled at rest. The action/dismiss buttons keep their own `onClick`; pointer drag on them is harmless (a click without movement leaves `dx≈0`, snapping back).

- [ ] **Step 6: Run Toast + toastSwipe tests and the full suite**

Run: `cd frontend && bunx vitest run src/components/Toast.test.tsx src/lib/toastSwipe.test.ts`
Expected: PASS.
Run: `cd frontend && bunx vitest run`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/toastSwipe.ts frontend/src/lib/toastSwipe.test.ts frontend/src/components/Toast.tsx
git commit -m "feat(motion): swipe-to-dismiss toasts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Chart re-animation restraint

`TrendBars` and `DonutChart` re-render on every period/lens switch (frequent), and recharts' default re-grows the bars/arcs each time. On a functional financial graph that reads as noise. Disable recharts' built-in animation; the data should just be there.

**Files:**
- Modify: `frontend/src/components/charts/TrendBars.tsx:10`
- Modify: `frontend/src/components/charts/DonutChart.tsx:15`
- Test: `frontend/src/components/charts/DonutChart.test.tsx` (exists; add a synchronous-render assertion)

**Interfaces:** none (prop-only change).

- [ ] **Step 1: Add a failing assertion** — append to `frontend/src/components/charts/DonutChart.test.tsx` a test that the legend renders its values immediately (with recharts animation off, there is no async grow to wait on):

```tsx
it("renders slice labels immediately (no entrance animation)", () => {
  render(
    <DonutChart
      slices={[{ name: "Dining", value: 100, color: "#000" }]}
      centerLabel="Total"
      centerValue={100}
    />,
  );
  expect(screen.getByText("Dining")).toBeInTheDocument();
});
```

(If `DonutChart.test.tsx` already imports `render`/`screen`/`DonutChart`, reuse those imports.)

- [ ] **Step 2: Run to verify it passes or fails as expected**

Run: `cd frontend && bunx vitest run src/components/charts/DonutChart.test.tsx`
Expected: This particular assertion likely PASSES already (the legend is our own `<ul>`, rendered synchronously regardless of the pie animation). That's fine — it documents intent and guards against regressions. The substantive change is the prop in Step 3. Proceed.

- [ ] **Step 3: Disable animation on `DonutChart`** — `frontend/src/components/charts/DonutChart.tsx`, line 15, add `isAnimationActive={false}` to the `<Pie>`:

```tsx
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="100%"
                 stroke="var(--color-surface)" strokeWidth={2} paddingAngle={1.5} isAnimationActive={false}>
```

- [ ] **Step 4: Disable animation on `TrendBars`** — `frontend/src/components/charts/TrendBars.tsx`, line 10, add `isAnimationActive={false}` to the `<Bar>`:

```tsx
          <Bar dataKey="spent" radius={[4, 4, 0, 0]} isAnimationActive={false}>
```

- [ ] **Step 5: Run the chart tests and full suite**

Run: `cd frontend && bunx vitest run src/components/charts/`
Expected: PASS.
Run: `cd frontend && bunx vitest run`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/charts/TrendBars.tsx frontend/src/components/charts/DonutChart.tsx frontend/src/components/charts/DonutChart.test.tsx
git commit -m "feat(motion): stop charts re-animating on every period switch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: First-mount list stagger

A gentle cascade the first time a screen's long list paints — decorative, short (≤80ms steps), and **first-mount only** so it never replays on refetch, filter, or period change. Implemented with a one-shot CSS animation (acceptable here: it plays once and isn't interrupted) gated by a `useFirstMount` flag, with reduced motion keeping only the fade.

**Files:**
- Create: `frontend/src/hooks/useFirstMount.ts`
- Test: `frontend/src/hooks/useFirstMount.test.ts`
- Modify: `frontend/src/styles/app.css` (add `.stagger-item` utility)
- Modify: `frontend/src/screens/Home.tsx` (Recent list), `frontend/src/screens/Transactions.tsx` (transaction list)

**Interfaces:**
- `useFirstMount.ts` produces: `useFirstMount(): boolean` — `true` only during the component's first render, `false` thereafter.

- [ ] **Step 1: Write the failing test** — `frontend/src/hooks/useFirstMount.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFirstMount } from "./useFirstMount";

describe("useFirstMount", () => {
  it("is true on first render and false after a re-render", () => {
    const { result, rerender } = renderHook(() => useFirstMount());
    expect(result.current).toBe(true);
    rerender();
    expect(result.current).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/hooks/useFirstMount.test.ts`
Expected: FAIL — cannot resolve `./useFirstMount`.

- [ ] **Step 3: Create `frontend/src/hooks/useFirstMount.ts`**

```ts
import { useEffect, useRef } from "react";

/** True only during the component's first render; false on every render after.
 *  Use to play a one-shot entrance once per mount without replaying on updates. */
export function useFirstMount(): boolean {
  const first = useRef(true);
  useEffect(() => { first.current = false; }, []);
  return first.current;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bunx vitest run src/hooks/useFirstMount.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `.stagger-item` utility** — in `frontend/src/styles/app.css`, after the `.press` rules:

```css
/* First-paint list stagger — a one-shot cascade (decorative). Apply only on a
   list's first mount; never on refetch. Steps are short (<=80ms). Reduced
   motion keeps the fade, drops the upward movement. */
@keyframes stagger-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.stagger-item { opacity: 0; animation: stagger-in 300ms var(--ease-out) forwards; }
.stagger-item:nth-child(1) { animation-delay: 0ms; }
.stagger-item:nth-child(2) { animation-delay: 40ms; }
.stagger-item:nth-child(3) { animation-delay: 80ms; }
.stagger-item:nth-child(4) { animation-delay: 120ms; }
.stagger-item:nth-child(5) { animation-delay: 160ms; }
.stagger-item:nth-child(6) { animation-delay: 200ms; }
.stagger-item:nth-child(n+7) { animation-delay: 240ms; } /* cap the cascade */
@media (prefers-reduced-motion: reduce) {
  @keyframes stagger-in { from { opacity: 0; } to { opacity: 1; } }
}
```

- [ ] **Step 6: Apply to the Transactions list** — `frontend/src/screens/Transactions.tsx`. Import the hook and tag the list items on first mount only. Add near the other imports:

```tsx
import { useFirstMount } from "../hooks/useFirstMount";
```

Inside the component body (top, with the other hooks):

```tsx
  const firstMount = useFirstMount();
```

Then in the list (around line 103), add the class conditionally:

```tsx
              {rows.map((t) => (
                <li key={t.ID} className={firstMount ? "stagger-item" : undefined}><TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} onArchive={archiveTxn} onRestore={restoreTxn} /></li>
              ))}
```

- [ ] **Step 7: Apply to the Home Recent list** — `frontend/src/screens/Home.tsx`. Add the import and hook the same way:

```tsx
import { useFirstMount } from "../hooks/useFirstMount";
```

In the component body (top):

```tsx
  const firstMount = useFirstMount();
```

In the Recent list (around line 124):

```tsx
              {s.recent.map((t) => (
                <li key={t.ID} className={`py-2 flex items-center justify-between gap-3${firstMount ? " stagger-item" : ""}`}>
```

- [ ] **Step 8: Run the relevant tests and the full suite**

Run: `cd frontend && bunx vitest run src/hooks/useFirstMount.test.ts`
Expected: PASS.
Run: `cd frontend && bunx vitest run`
Expected: PASS (all tests — `AppShell.test.tsx` and any screen tests should be unaffected; the class is additive and jsdom doesn't run CSS animations).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/hooks/useFirstMount.ts frontend/src/hooks/useFirstMount.test.ts frontend/src/styles/app.css frontend/src/screens/Transactions.tsx frontend/src/screens/Home.tsx
git commit -m "feat(motion): gentle first-paint stagger on long lists

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Verification, reduced-motion audit, and embedded-bundle rebuild

Confirm the whole suite is green, manually validate the motion feels right (Emil: review with fresh eyes, test gestures on a real device), and rebuild the committed embedded bundle so the Go binary serves the new frontend.

**Files:**
- Modify (rebuilt artifact): `internal/web/dist/**`

- [ ] **Step 1: Full frontend test suite**

Run: `cd frontend && bunx vitest run`
Expected: PASS — all tests, including the new `motion`, `sheetDrag`, `toastSwipe`, `useFirstMount`, `Dialog` suites and the updated sheet tests.

- [ ] **Step 2: Typecheck / build the frontend**

Run: `cd frontend && bun run build`
Expected: Build succeeds with no TypeScript errors. Output lands in the embedded `dist` location (`internal/web/dist/` per CLAUDE.md).

- [ ] **Step 3: Go build sanity (no Go changed, but confirm the binary still builds with the new embed)**

Run: `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`
Expected: Builds cleanly. (Optionally `go test ./...` — should be unaffected.)

- [ ] **Step 4: Manual reduced-motion audit** — set the OS to "Reduce motion" (or toggle via DevTools: Rendering → Emulate CSS `prefers-reduced-motion: reduce`) and confirm:
  - Bottom sheets open/close without sliding but **with** the scrim fade (comprehension preserved), and tapping a handle simply closes (no drag).
  - Toasts fade in/out without the vertical slide; no swipe.
  - Buttons show no `scale` on press.
  - Lists fade in without the upward step.
  - Nothing is *missing* or broken — reduced motion means gentler, not absent.

- [ ] **Step 5: Manual full-motion pass (fresh eyes / slow-motion)** — with motion enabled, in the running app (`./ledger` then open over Tailscale, or `cd frontend && bun run dev`):
  - Open each sheet (Period from TopBar, Categorize from a transaction, Add via FAB, DrillDown + Search from Insights) — each slides up on the `--ease-drawer` curve and slides down on close.
  - Drag a sheet handle down slowly → it follows; release past ~120px or flick → it dismisses; small drag → snaps back; drag up → rubber-bands.
  - Trigger a toast ("Add transaction") → slides up; flick it sideways → dismisses; click × → slides out.
  - Switch periods on Home/Insights → charts do **not** re-grow.
  - First visit to Transactions/Home → list cascades once; change filter → no replay.
  - (Emil) bump a transition duration 3× temporarily if any motion feels off, watch in slow-mo, then restore. Test sheet/toast **gestures on a real phone** over Tailscale, not just the desktop pointer.

- [ ] **Step 6: Rebuild the embedded bundle and stage it** — ensure `internal/web/dist/` reflects the latest `bun run build` (it was produced in Step 2). Per CLAUDE.md and the parallel-agents note, the committed `dist` must match source before finishing.

```bash
git add internal/web/dist
git status   # confirm only intended files staged
```

- [ ] **Step 7: Commit the rebuilt bundle**

```bash
git commit -m "chore(web): rebuild embedded bundle for motion polish pass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 8: (Recommended) run the animation review** — invoke the `review-animations` skill (or `superpowers:requesting-code-review`) over the diff to check the work against the craft bar before merging: easing curves, durations <300ms, no `ease-in` on UI, no `scale(0)`, reduced-motion handling, transform/opacity-only.

---

## Self-Review

**Spec coverage** (request: "page-by-page … review and specify if animations enhance UX … apply the Emil skill so bottom sheets animate smoothly and performantly … subtle motion where relevant"):
- Page-by-page review with explicit animate/reduce/none verdicts and rationale → **Page-by-Page Motion Audit** section. ✓
- Bottom sheets animate smoothly + performantly → Tasks 3 (slide enter/exit via shared Dialog) + 4 (drag-to-dismiss), CSS-transition/transform-based for off-main-thread performance. ✓
- Subtle motion where relevant; restraint where not → press feedback (T2), toasts (T5–6), list stagger (T8); explicit non-goals: tab transitions, money count-up, chart re-animation (T7), with Emil-cited reasoning. ✓
- Emil skill applied → tokens from his easing/duration tables (T1), `scale(0.97)` press (T2), `translateY(100%)` sheets + `@`-style mount (T3), velocity/damping gestures (T4), Sonner toast principles + interruptible transitions (T5–6), reduced-motion + transform/opacity-only throughout. ✓
- Sub-agent development → execution handoff below selects subagent-driven. ✓

**Placeholder scan:** The Task 5 Step 1 contains a deliberately-labeled placeholder block immediately replaced by a concrete test in the same step ("Add this self-contained test instead"). No `TODO`/`TBD`/"handle edge cases" left as real instructions. Every code step shows complete code.

**Type/name consistency:** `sheetTransition`/`scrimTransition`/`SHEET_ENTER_MS`/`SHEET_EXIT_MS` defined in T1, consumed unchanged in T3/T4/T5. `SHEET_DISMISS_DISTANCE`/`SHEET_DISMISS_VELOCITY`/`sheetOffset`/`shouldDismiss` defined in T4, reused in T6 (`shouldDismissToast` imports `SHEET_DISMISS_VELOCITY`). `useSheetDrag(panelRef, onDismiss, reduced)` signature matches its call site in T4 Step 6. `useFirstMount()` defined and consumed in T8. `.press` defined T2, reused in T3/T5/T6. `var(--ease-drawer)`/`var(--ease-out)` defined T1, referenced everywhere after.

**Known integration caveat (called out, not hidden):** T3 changes `onClose` from synchronous to deferred (`SHEET_EXIT_MS`), which breaks existing close-path test assertions; T3 Step 5–6 detect and fix exactly those, distinguishing close callbacks (deferred) from primary-action callbacks (still synchronous).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-29-motion-polish-pass.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. (You asked for sub-agent development.)

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
