# Framer Motion Migration + Animation Review Remediation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every transitional, gestural and presence animation in the PWA onto Framer Motion, and in doing so fix the fourteen findings from the 2026-07-30 animation review.

**Architecture:** A single `LazyMotion` + `MotionConfig` pair at the app root supplies motion features (code-split, loaded async) and a global `reducedMotion="user"` policy. Components use the lightweight `m.*` primitives, never bare `motion.*`. Gesture-driven motion moves from React state to `useMotionValue`/`useTransform` so pointer frames stop re-rendering. Enter/exit lifecycles move from hand-rolled `rAF` + `setTimeout` pairs to `AnimatePresence`. Pure decision helpers stay in `lib/` with co-located unit tests, per the existing convention.

**Tech Stack:** React 19, TypeScript, Vite 5, Tailwind v4, vitest + jsdom, Storybook 9, `motion` v12 (Framer Motion's current package name).

## Global Constraints

- **Package is `motion`, not `framer-motion`.** Framer Motion was renamed; from v11.11.17 the `motion` package ships identical code and is the maintained name. React imports come from `motion/react`. Install exactly: `bun add motion`.
- **Never import bare `motion.*` components.** Use `m.*` under `LazyMotion`. `LazyMotion` is configured with `strict`, so a bare `motion.div` throws at runtime — that is deliberate, it protects the code-split.
- **Features load async.** `LazyMotion features={loadDomMax}` where `loadDomMax = () => import("motion/react").then(r => r.domMax)`. Never pass `domMax` synchronously.
- **Reduced motion is global, never hand-rolled.** `MotionConfig reducedMotion="user"` disables transform and layout animations while keeping opacity and colour — exactly the app's stated "gentler, not zero" policy (`styles/app.css:139`, `:161`). Do not add per-component `usePrefersReducedMotion` branches for transform-based motion. The hook is deleted in Task 1. For animations of *non-transform* properties (`clipPath`), gate explicitly with framer's `useReducedMotion()`.
- **Bundle budget: the main JS chunk must stay at or below 760,000 bytes raw.** It is 642,029 bytes today (`internal/web/dist/assets/index-*.js`). Task 1 records the real post-install number; Task 10 asserts the ceiling. This budget exists because `components/dither-kit/tooltip.tsx:15` documents that Framer Motion was previously *removed* from this app over bundle size, and the service worker precaches `**/*.js` (`vite.config.ts:42`).
- **Two animations stay in CSS and are exempt from this migration:**
  1. `.pixel-spinner-cell` (`styles/app.css:159-167`). Its eight cells rely on *negative* `animation-delay` to phase-shift one shared keyframe; Framer Motion has no negative-delay equivalent, so expressing it would mean eight separately-scheduled JS loops. It is also pure opacity, so it is already correct under reduced motion.
  2. Tailwind's `animate-pulse` on skeletons. Same reasoning — an indefinite opacity loop with no interruption or gesture requirement. Task 10 documents the exemption rather than gating it.
- **vitest stays single-fork.** `fileParallelism: false` / `singleFork` in `vite.config.ts` is deliberate (the sandbox blocks worker spawning). Do not change it.
- **Tests use `fireEvent` from `@testing-library/react`, never `userEvent`.** The existing suite uses `fireEvent` in 293 places and `userEvent` in none; `@testing-library/user-event` is present only as an undeclared transitive dependency. Do not introduce it.
- **Every test that renders a component using `m.*` must wrap it in `MotionProvider`.** This includes Storybook stories — `src/test/storybook.test.tsx` renders every story in the repo, so the provider belongs in the Storybook `preview.tsx` decorator.

  Correction (found during Task 2 review): `strict` does **not** throw on an `m.*` component rendered with no `LazyMotion` ancestor — it throws on a bare `motion.*` component rendered *inside* a `LazyMotion`. An unwrapped `m.*` renders fine but with **no features loaded**, so `whileTap`, `drag`, `animate` and `exit` are all silently inert. That is worse than a throw, not better: a test can pass while exercising none of the behavior it appears to cover. Wrap anyway — the cost is one line and it makes the test exercise the real configuration.
- **Money is `int64` fils; amounts positive with a `direction` field.** Untouched by this plan, but do not "fix" any money formatting encountered along the way.
- **Rebuild the embedded bundle before finishing.** `cd frontend && bun run build` writes `internal/web/dist/`, which Go embeds. This is a committed artifact and parallel sessions run on `main`.
- **Verify UI work with the harness, not only vitest.** `frontend/harness/` drives the real PWA in a real browser. Chromium is not Safari — `ios.mjs` is the only thing that sees the software keyboard and `env(safe-area-inset-*)`. `shoot.mjs` sets `reducedMotion: "reduce"`, which under the new `MotionConfig` means transform animations are genuinely off in those captures — a green `shoot.mjs` run says nothing about the animations.

---

## File Structure

**Created:**
- `frontend/src/app/MotionProvider.tsx` — the single `LazyMotion` + `MotionConfig` root. Owns the async feature import.
- `frontend/src/components/ui/Pressable.tsx` — the app's one press-feedback primitive, replacing the global `.press` CSS class.
- `frontend/src/components/ui/Pressable.test.tsx`
- `frontend/src/lib/sheetDrag.test.ts` additions for the new velocity predicate (file already exists).

**Rewritten:**
- `frontend/src/lib/motion.ts` — from CSS transition *strings* to Framer transition *objects* and named springs. This is the single source of truth for every duration and curve.
- `frontend/src/lib/motion.test.ts` — asserts the new token shapes and the sub-300ms budget.

**Modified (motion code only):**
- `frontend/src/main.tsx` — mount `MotionProvider`.
- `frontend/src/styles/app.css` — delete `.press`, `.stagger-item`, `.row-in`, `.swipe-card-in`, `.rolling-*` transitions, `.dither-tooltip` opt-out, and the `@keyframes` they used.
- `frontend/src/components/Toast.tsx`, `ui/Dialog.tsx`, `ui/Button.tsx`, `ui/IconButton.tsx`, `ui/ProgressBar.tsx`, `PullToRefreshIndicator.tsx`, `RollingNumber.tsx`, `transactions/SwipeableRow.tsx`, `swipe/SwipeCard.tsx`, `swipe/SwipeDeck.tsx`, `dither-kit/tooltip.tsx`
- `frontend/src/screens/settings/SettingsPage.tsx`, `settings/BudgetPage.tsx`, `settings/SavedFlash.tsx`, `Home.tsx`, `Transactions.tsx`, `CategoryManager.tsx`
- `frontend/src/hooks/useSheetDrag.ts`, `useEdgeBack.ts` — deleted; Framer's `drag` replaces both.
- The 32 raw `<button className="… press">` sites listed in Task 2.

**Deleted:**
- `frontend/src/hooks/usePrefersReducedMotion.ts`
- `frontend/src/hooks/useSheetDrag.ts`
- `frontend/src/hooks/useEdgeBack.ts`

---

## Findings Coverage Map

| # | Finding | Task |
| --- | --- | --- |
| 1 | Toast swipe discards drag direction on commit | 3 |
| 2 | Toast imperative `transition` leaks into the auto-dismiss exit | 3 |
| 3 | `SwipeCard` fly-out ignores reduced motion | 1 (global), 6 |
| 4 | `SwipeDeck` 620ms serial dead time per card | 6 |
| 5 | `SwipeDeck` `transition-all` + animated `width` | 6 |
| 6 | `SwipeableRow` React state per pointer frame + `width` panels | 5 |
| 7 | Unlayered `.press` kills `transition-colors` at 10 sites | 2 |
| 8 | `PullToRefreshIndicator` animates `height` with built-in easing | 7 |
| 9 | `ProgressBar` animates `width`, no reduced-motion gate | 7 |
| 10 | `RollingNumber` 650ms on an ease-in-out ramp, no stagger | 8 |
| 11 | `SwipeCard` forks the `--ease-out` curve as a literal | 6 |
| 12 | `animate-pulse` skeletons ungated | 10 (documented exemption) |
| 13 | `SwipeCard` permanent `willChange` | 6 |
| 14 | Sheet flick dismissal ignores release velocity | 4 |
| — | Ungated `hover:` colour on touch (sticky hover) | 10 |

---

### Task 1: Motion root — install, provider, token module

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/app/MotionProvider.tsx`
- Rewrite: `frontend/src/lib/motion.ts`
- Rewrite: `frontend/src/lib/motion.test.ts`
- Modify: `frontend/src/main.tsx:21-32`
- Delete: `frontend/src/hooks/usePrefersReducedMotion.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `<MotionProvider>{children}</MotionProvider>` from `app/MotionProvider`
  - From `lib/motion`: `EASE_OUT: [number,number,number,number]`, `EASE_DRAWER: [number,number,number,number]`, `DUR: { press: 0.14, fast: 0.16, base: 0.2, sheet: 0.3 }`, `SPRING_SNAP: Transition`, `SPRING_SHEET: Transition`, `SPRING_ROW: Transition`, `PRESS_TRANSITION: Transition`, `SHEET_ENTER: Transition`, `SHEET_EXIT: Transition`, `FADE: Transition`

- [ ] **Step 1: Install the dependency and record the baseline bundle size**

```bash
cd /root/Coding/ledger/frontend
ls -l ../internal/web/dist/assets/index-*.js   # record this number; expect ~642029 bytes
bun add motion
```

- [ ] **Step 2: Write the failing token test**

Create `frontend/src/lib/motion.test.ts`, replacing the file entirely:

```ts
import { describe, it, expect } from "vitest";
import {
  EASE_OUT, EASE_DRAWER, DUR,
  SHEET_ENTER, SHEET_EXIT, PRESS_TRANSITION, FADE,
  SPRING_SNAP, SPRING_SHEET, SPRING_ROW,
} from "./motion";

describe("easing tokens", () => {
  it("exports cubic-bezier control points as 4-tuples", () => {
    expect(EASE_OUT).toEqual([0.23, 1, 0.32, 1]);
    expect(EASE_DRAWER).toEqual([0.32, 0.72, 0, 1]);
  });
});

describe("duration budget", () => {
  it("keeps every UI duration at or under 300ms", () => {
    for (const [name, seconds] of Object.entries(DUR)) {
      expect(seconds, `${name} exceeds the 300ms UI budget`).toBeLessThanOrEqual(0.3);
    }
  });
  it("makes the sheet exit snappier than its enter", () => {
    expect(SHEET_EXIT.duration!).toBeLessThan(SHEET_ENTER.duration!);
  });
});

describe("transition tokens", () => {
  it("gives duration-based transitions the ease-out curve", () => {
    expect(PRESS_TRANSITION.ease).toEqual(EASE_OUT);
    expect(FADE.ease).toEqual(EASE_OUT);
  });
  it("gives sheets the drawer curve", () => {
    expect(SHEET_ENTER.ease).toEqual(EASE_DRAWER);
    expect(SHEET_EXIT.ease).toEqual(EASE_DRAWER);
  });
  it("exports springs, not durations, for gesture-driven motion", () => {
    for (const s of [SPRING_SNAP, SPRING_SHEET, SPRING_ROW]) {
      expect(s.type).toBe("spring");
      expect(s.duration).toBeUndefined();
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/motion.test.ts`
Expected: FAIL — the old `motion.ts` exports `sheetTransition`/`scrimTransition`/`SHEET_ENTER_MS`, so every named import is undefined.

- [ ] **Step 4: Rewrite the token module**

Replace `frontend/src/lib/motion.ts` entirely:

```ts
// The single source of truth for every duration, curve and spring in the app.
//
// Durations are SECONDS (Framer Motion's unit), not milliseconds. Curves are
// cubic-bezier control-point tuples rather than `var(--ease-*)` strings,
// because Framer interpolates in JS and never reads the stylesheet.
//
// The CSS custom properties in styles/app.css are retained for the two
// exempt CSS keyframe animations (the pixel spinner and the skeleton pulse)
// and must be kept numerically in sync with the tuples here — tokens.test.ts
// asserts that.
import type { Transition } from "motion/react";

/** Entering/exiting UI. Strong, front-loaded — built-in easings are too weak. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const satisfies readonly [number, number, number, number];
/** iOS-like sheet curve. Front-loaded harder than EASE_OUT. */
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const satisfies readonly [number, number, number, number];

/**
 * Every duration in the app, in seconds. The 300ms ceiling is the UI budget:
 * anything slower on a UI element needs a written justification, and there
 * currently is not one. motion.test.ts enforces the ceiling.
 */
export const DUR = {
  press: 0.14,  // button press feedback
  fast: 0.16,   // tooltip fade, wash opacity
  base: 0.2,    // toast, row snap-back, scrim
  sheet: 0.3,   // bottom sheet / drill-in page enter
} as const;

export const PRESS_TRANSITION: Transition = { duration: DUR.press, ease: EASE_OUT };
export const FADE: Transition = { duration: DUR.base, ease: EASE_OUT };
export const SHEET_ENTER: Transition = { duration: DUR.sheet, ease: EASE_DRAWER };
/** Exit is snappier than enter — the user has already decided. */
export const SHEET_EXIT: Transition = { duration: 0.24, ease: EASE_DRAWER };

/**
 * Springs, for anything a hand can be holding. A spring retargets from its
 * current position AND velocity, so an interrupted gesture never restarts
 * from zero and a hard flick finishes faster than a slow drag — which a
 * fixed-duration transition cannot express.
 */
export const SPRING_SNAP: Transition = { type: "spring", stiffness: 550, damping: 32, mass: 0.9 };
export const SPRING_SHEET: Transition = { type: "spring", stiffness: 420, damping: 40, mass: 1 };
export const SPRING_ROW: Transition = { type: "spring", stiffness: 600, damping: 38, mass: 0.7 };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/motion.test.ts`
Expected: PASS (11 assertions).

- [ ] **Step 6: Create the motion root**

Create `frontend/src/app/MotionProvider.tsx`:

```tsx
import { LazyMotion, MotionConfig, type LazyFeatureBundle } from "motion/react";
import type { ReactNode } from "react";

/**
 * `domMax` — not `domAnimation` — because the app needs drag (sheets, the
 * swipe deck, list rows) and layout animations. Imported as a thunk so the
 * feature bundle lands in its own chunk and never blocks first paint.
 */
const loadDomMax: LazyFeatureBundle = () => import("motion/react").then((m) => m.domMax);

/**
 * The app's one motion root.
 *
 * `strict` makes a bare `motion.div` throw instead of silently pulling the
 * full feature set into the entry chunk. Every component uses `m.*`.
 *
 * `reducedMotion="user"` is the app-wide accessibility policy: Framer
 * disables transform and layout animations for a user who asked the OS to
 * minimise motion, while leaving opacity and colour alone. That is exactly
 * the "gentler, not zero" reading the app already applied by hand in
 * styles/app.css. Components must NOT re-implement this per-component —
 * the previous hand-rolled version is how the swipe card's 800px fly-out
 * ended up ignoring the preference entirely.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadDomMax} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
```

- [ ] **Step 7: Mount it at the root**

In `frontend/src/main.tsx`, add the import beside the other app imports and wrap the tree. It goes *outside* `ToastProvider` because Task 3 makes toasts use `AnimatePresence`:

```tsx
import { MotionProvider } from "./app/MotionProvider";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: PERSIST_MAX_AGE }}
    >
      <MotionProvider>
        <ToastProvider>
          <AppShell />
        </ToastProvider>
      </MotionProvider>
    </PersistQueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 8: Delete the superseded hook**

```bash
cd /root/Coding/ledger/frontend
rm src/hooks/usePrefersReducedMotion.ts
```

This will break `SwipeCard.tsx`, `Toast.tsx`, `SwipeableRow.tsx`, `Dialog.tsx` and `SettingsPage.tsx`, which import it. Tasks 3–6 replace each one. To keep the tree compiling until then, add a temporary re-export at the top of each of those five files' import block:

```ts
import { useReducedMotion } from "motion/react";
const usePrefersReducedMotion = () => useReducedMotion() ?? false;
```

Remove that shim in the task that rewrites each file. Task 10 greps for stragglers.

- [ ] **Step 9: Verify the build and record the new bundle size**

```bash
cd /root/Coding/ledger/frontend
bun run build
ls -l ../internal/web/dist/assets/*.js
```

Expected: build succeeds. Record the main `index-*.js` size and confirm it is at or below 760,000 bytes. There should now also be a separate small chunk for the async `domMax` import. If the main chunk grew by more than ~110KB, `strict` is not being honoured somewhere — stop and investigate before continuing.

- [ ] **Step 10: Commit**

```bash
cd /root/Coding/ledger
git add frontend/package.json frontend/bun.lock frontend/src/app/MotionProvider.tsx \
        frontend/src/lib/motion.ts frontend/src/lib/motion.test.ts frontend/src/main.tsx \
        frontend/src/hooks/usePrefersReducedMotion.ts \
        frontend/src/components/Toast.tsx frontend/src/components/ui/Dialog.tsx \
        frontend/src/components/swipe/SwipeCard.tsx \
        frontend/src/components/transactions/SwipeableRow.tsx \
        frontend/src/screens/settings/SettingsPage.tsx
git commit -m "feat(motion): add Framer Motion root with global reduced-motion policy"
```

---

### Task 2: `Pressable` primitive — kill the unlayered `.press` cascade bug

Fixes finding **7**.

The root cause: `.press` is declared *unlayered* in `app.css:121`, while every Tailwind utility lives in `@layer utilities`. Unlayered CSS beats layered CSS in the cascade regardless of specificity, and `.press` uses the `transition` **shorthand** — which resets `transition-property` to `transform` alone. Every `transition-colors` in the app is therefore dead, and `SwipeDeck.tsx:80`'s `transition-[transform,background-color,color,box-shadow] duration-200` collapses to transform-only at 140ms, so the edge rail's fill and shadow *pop* mid-drag.

Verified against the built bundle: `.press` sits at cascade depth 0 with no enclosing layer; `.transition-colors` sits inside `@layer utilities`.

**Files:**
- Create: `frontend/src/components/ui/Pressable.tsx`
- Create: `frontend/src/components/ui/Pressable.test.tsx`
- Modify: `frontend/src/components/ui/Button.tsx:21`, `ui/IconButton.tsx:37`
- Modify: the 32 raw sites listed in Step 5
- Modify: `frontend/src/styles/app.css:118-125` (delete `.press`)

**Interfaces:**
- Consumes: `PRESS_TRANSITION` from `lib/motion` (Task 1).
- Produces: `<Pressable>` — an `m.button` with `whileTap={{ scale: 0.97 }}`, accepting every native `<button>` prop plus `className`. Default `type="button"`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ui/Pressable.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { Pressable } from "./Pressable";

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

describe("Pressable", () => {
  it("defaults to type=button so it never submits an enclosing form", () => {
    wrap(<Pressable>Save</Pressable>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
  });

  it("lets the caller override the type", () => {
    wrap(<Pressable type="submit">Go</Pressable>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "submit");
  });

  it("forwards clicks", () => {
    const onClick = vi.fn();
    wrap(<Pressable onClick={onClick}>Tap</Pressable>);
    fireEvent.click(screen.getByRole("button", { name: "Tap" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("merges the caller's className rather than replacing it", () => {
    wrap(<Pressable className="text-accent">Tap</Pressable>);
    expect(screen.getByRole("button", { name: "Tap" }).className).toContain("text-accent");
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    wrap(<Pressable disabled onClick={onClick}>Tap</Pressable>);
    fireEvent.click(screen.getByRole("button", { name: "Tap" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/ui/Pressable.test.tsx`
Expected: FAIL — `Cannot find module './Pressable'`.

- [ ] **Step 3: Write the primitive**

Create `frontend/src/components/ui/Pressable.tsx`:

```tsx
import { m } from "motion/react";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { PRESS_TRANSITION } from "../../lib/motion";

/**
 * The app's one press-feedback primitive: a subtle scale confirming the UI
 * heard the tap.
 *
 * This replaces the global `.press` CSS class, which was declared outside
 * every cascade layer and therefore outranked all of Tailwind's
 * `@layer utilities` rules. Because it used the `transition` shorthand it
 * also reset `transition-property` to `transform`, silently killing every
 * `transition-colors` in the app. A component owning its own motion cannot
 * reach across the codebase like that.
 *
 * `whileTap` is pointer-based, so it is correct on touch in a way `:hover`
 * never is, and Framer's global reducedMotion policy disables the scale for
 * a user who asked for less motion — no per-call-site branch needed.
 */
type PressableProps = ComponentPropsWithoutRef<typeof m.button>;

export const Pressable = forwardRef<HTMLButtonElement, PressableProps>(
  function Pressable({ type = "button", ...rest }, ref) {
    return (
      <m.button
        ref={ref}
        type={type}
        whileTap={{ scale: 0.97 }}
        transition={PRESS_TRANSITION}
        {...rest}
      />
    );
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/ui/Pressable.test.tsx`
Expected: PASS (5 assertions).

- [ ] **Step 5: Convert every press site**

For each site: change the element from `<button` to `<Pressable`, delete the literal `press` token from its `className` string, add the import, and delete any now-redundant `type="button"` (Pressable defaults to it). **Keep every `transition-colors` class** — it starts working for the first time once `.press` is gone.

Shared primitives (do these first — they cover the majority of buttons):
- `components/ui/Button.tsx:21`
- `components/ui/IconButton.tsx:37`

Raw sites (32):
```
components/insights/ComparativeSummary.tsx:59
components/projects/ProjectCard.tsx:26
components/swipe/SubcategoryPanel.tsx:51, :83
components/swipe/SwipeCard.tsx:179
components/swipe/SwipeDeck.tsx:382
components/transactions/FilterBar.tsx:95, :106
components/transactions/FilterChips.tsx:99
components/transactions/LinkRefundSheet.tsx:62
components/transactions/TransactionRow.tsx:59, :112
components/ui/TopBar.tsx:37
screens/CategoryManager.tsx:255
screens/Home.tsx:202
screens/Insights.tsx:123, :217
screens/Transactions.tsx:219
screens/accounts/AccountDetail.tsx:133, :210
screens/accounts/AccountRow.tsx:28
screens/plan/EnvelopeRow.tsx:67
screens/plan/MoveMoneySheet.tsx:109
screens/recurring/DetectedCards.tsx:52
screens/recurring/ScheduleList.tsx:31
screens/recurring/UpcomingFeed.tsx:36, :92
screens/reports/AgeOfMoneyTile.tsx:45
screens/reports/IncomeExpenseMatrix.tsx:59
screens/reports/NetWorthChart.tsx:174
screens/reports/TrendCompare.tsx:58
screens/settings/SettingsHub.tsx:58
components/ui/SegmentedControl.tsx:33
```

Two sites need care:
- `components/swipe/SwipeCard.tsx:179` stops pointer propagation (`onPointerDown={e => e.stopPropagation()}`) so the card drag does not claim it. Keep both handlers verbatim.
- `components/ui/SegmentedControl.tsx:33` already sets `type="button"` with a comment explaining why; delete the attribute but **move the comment onto the `Pressable`** so the reason survives.

- [ ] **Step 6: Delete the CSS rule**

In `frontend/src/styles/app.css`, delete lines 118-125 in full — the comment block, `.press`, `.press:active`, and its `prefers-reduced-motion` override. Also delete `--dur-press: 140ms;` from the `:root` block at line 115; it now lives in `DUR.press`.

- [ ] **Step 7: Verify nothing still references the class**

```bash
cd /root/Coding/ledger/frontend
grep -rn "\bpress\b" src --include="*.tsx" --include="*.css" | grep -v "aria-pressed\|Pressable\|pressed"
```
Expected: no output.

- [ ] **Step 8: Run the full frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS. Storybook stories render these buttons via `src/test/storybook.test.tsx`; if a story asserts on the `press` class, update the story and its co-located `*.stories.test.tsx` in this same commit (the repo convention).

- [ ] **Step 9: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src
git commit -m "fix(motion): replace unlayered .press with a Pressable primitive

.press was declared outside every cascade layer, so it outranked all of
Tailwind's @layer utilities rules, and its `transition` shorthand reset
transition-property to transform alone — killing every transition-colors
in the app and collapsing SwipeDeck's 200ms multi-property rail
transition to transform-only at 140ms."
```

---

### Task 3: Toast — direction-preserving swipe dismissal

Fixes findings **1** and **2**.

Today, crossing the swipe threshold sets `el.style.transform` imperatively and then calls `setLeaving(true)`. React's `style` prop rewrites `transform` to `translateY(12px)` on that render, so a toast swiped right **snaps back to x=0** and drops — the gesture's entire payload is discarded at the moment of commitment. Separately, the imperative `transition` written on `pointerdown` persists (React does not rewrite an unchanged prop), so a toast you have touched later auto-dismisses without an opacity fade.

Both disappear when a motion value owns `x` and `AnimatePresence` owns the exit.

**Files:**
- Modify: `frontend/src/components/Toast.tsx:30-143` (`ToastItem`) and `:157-166` (the provider's stack)
- Modify: `frontend/src/lib/toastSwipe.ts`
- Modify: `frontend/src/lib/toastSwipe.test.ts`
- Modify: `frontend/src/components/Toast.test.tsx:59-90`

**Interfaces:**
- Consumes: `FADE`, `SPRING_SNAP`, `DUR` from `lib/motion`.
- Produces: `shouldDismissToast(offsetX: number, velocityX: number): boolean` — signature change from `(dx, elapsedMs)`.

- [ ] **Step 1: Write the failing predicate test**

Replace the body of `frontend/src/lib/toastSwipe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldDismissToast, TOAST_DISMISS_PX, TOAST_FLICK_VELOCITY } from "./toastSwipe";

describe("shouldDismissToast", () => {
  it("dismisses a slow drag once it clears the distance threshold", () => {
    expect(shouldDismissToast(TOAST_DISMISS_PX + 1, 0)).toBe(true);
    expect(shouldDismissToast(-(TOAST_DISMISS_PX + 1), 0)).toBe(true);
  });

  it("keeps a slow drag that never clears the threshold", () => {
    expect(shouldDismissToast(TOAST_DISMISS_PX - 1, 0)).toBe(false);
  });

  it("dismisses a short flick on velocity alone", () => {
    expect(shouldDismissToast(20, TOAST_FLICK_VELOCITY + 1)).toBe(true);
    expect(shouldDismissToast(-20, -(TOAST_FLICK_VELOCITY + 1))).toBe(true);
  });

  it("ignores velocity pointing back toward centre", () => {
    // Dragged right, then flicked left — the user changed their mind.
    expect(shouldDismissToast(20, -(TOAST_FLICK_VELOCITY + 1))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/toastSwipe.test.ts`
Expected: FAIL — `TOAST_FLICK_VELOCITY` is not exported and the arity is wrong.

- [ ] **Step 3: Rewrite the predicate**

Replace `frontend/src/lib/toastSwipe.ts`:

```ts
/** Horizontal travel past which a release dismisses, regardless of speed. */
export const TOAST_DISMISS_PX = 80;
/** px/s past which a release dismisses regardless of distance (a flick). */
export const TOAST_FLICK_VELOCITY = 500;

/**
 * Should a released toast swipe dismiss?
 *
 * Velocity comes from the pointer, not from elapsed time: Framer reports a
 * signed px/s reading sampled over the last few frames, which is what makes
 * a fast 20px flick feel like a dismissal and a slow 20px nudge feel like a
 * misfire. Velocity only counts when it points the same way as the drag —
 * flicking back toward centre means the user changed their mind.
 */
export function shouldDismissToast(offsetX: number, velocityX: number): boolean {
  if (Math.abs(offsetX) >= TOAST_DISMISS_PX) return true;
  const sameDirection = offsetX === 0 || Math.sign(velocityX) === Math.sign(offsetX);
  return sameDirection && Math.abs(velocityX) >= TOAST_FLICK_VELOCITY;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/toastSwipe.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Rewrite `ToastItem`**

In `frontend/src/components/Toast.tsx`, replace the whole `ToastItem` function (lines 30-143) with:

```tsx
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // The live horizontal offset. A motion value, so dragging never re-renders
  // React — and, crucially, so the exit animation can read where the finger
  // actually left the toast. The previous version wrote `transform` directly
  // to the DOM and React overwrote it on the very next render, discarding the
  // swipe direction at the moment of commitment.
  const x = useMotionValue(0);
  const [exitX, setExitX] = useState(0);

  const beginDismiss = useCallback((direction = 0) => {
    setExitX(direction);
    onDismissRef.current();
  }, []);
  const beginRef = useRef(beginDismiss);
  beginRef.current = beginDismiss;

  // Auto-dismiss after 5s, pausing while the tab is hidden so a backgrounded
  // toast still gets its full on-screen time. Sticky toasts skip the timer.
  useEffect(() => {
    if (toast.sticky) return;
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
  }, [toast.sticky]);

  // "error" spends the app's one fill register (bg-accent) and so needs the
  // fill's own constant-white text (text-accent-fg) rather than text-bg, which
  // flips with theme and would go dark-on-vermilion in the dark theme.
  const isError = toast.tone === "error";
  const tone = toast.tone === "success" ? "bg-good" : isError ? "bg-accent" : "bg-fg";
  const fg = isError ? "text-accent-fg" : "text-bg";

  return (
    <m.div
      layout
      style={{ x }}
      drag="x"
      dragSnapToOrigin
      dragElastic={0.6}
      onDragEnd={(_, info) => {
        if (!shouldDismissToast(info.offset.x, info.velocity.x)) return;
        beginDismiss(info.offset.x > 0 ? 400 : -400);
      }}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      // The toast leaves the way it was sent: swiped toasts continue in the
      // swipe direction, timed-out toasts just fade.
      exit={{ opacity: 0, x: exitX, y: exitX === 0 ? 12 : 0 }}
      transition={FADE}
      className={`pointer-events-auto flex touch-pan-y items-center gap-3 max-w-[92vw] ${fg} px-3 py-2.5 rounded-[var(--radius)] shadow-lg ${tone}`}
    >
      <span className="flex-1 text-sm">{toast.message}</span>
      {toast.action && (
        <Pressable
          className={`text-sm font-semibold ${isError ? "text-accent-fg/90" : "text-bg/90"} underline`}
          onClick={() => { try { toast.action!.onAction(); } finally { beginDismiss(); } }}
        >
          {toast.action.label}
        </Pressable>
      )}
      <Pressable
        aria-label="Dismiss"
        className={isError ? "text-accent-fg/70" : "text-bg/70"}
        onClick={() => beginDismiss()}
      >
        ×
      </Pressable>
    </m.div>
  );
}
```

Update the import block at the top of the file:

```tsx
import { createContext, useCallback, useContext, useEffect, useReducer, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m, useMotionValue } from "motion/react";
import { shouldDismissToast } from "../lib/toastSwipe";
import { FADE } from "../lib/motion";
import { Pressable } from "./ui/Pressable";
```

Note `usePrefersReducedMotion` is gone entirely — the global `MotionConfig` handles it, and it now behaves *better*: the opacity fade survives where the old code returned early and removed the toast with no animation at all.

- [ ] **Step 6: Wrap the stack in `AnimatePresence`**

In `ToastProvider`, wrap the mapped list (line 161-163):

```tsx
<div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] z-40 flex flex-col items-center gap-2 px-4 pointer-events-none" role="region" aria-label="Notifications">
  <AnimatePresence initial={false}>
    {toasts.map((t) => (
      <ToastItem key={t.id} toast={t} onDismiss={() => dispatch({ type: "remove", id: t.id })} />
    ))}
  </AnimatePresence>
</div>
```

`onDismiss` now removes from state *immediately*; `AnimatePresence` keeps the element mounted for its exit. That is what deletes the 200ms `setTimeout` and the whole `leaving`/`mounted` state pair.

- [ ] **Step 7: Update the component test**

In `frontend/src/components/Toast.test.tsx`, replace the test at line 59 (`"gives the toast a transform+opacity transition"`) — it asserted on an inline `transition` string that no longer exists:

```tsx
it("renders the toast message and dismiss control", () => {
  renderWithToast("Ignored Spinneys");
  expect(screen.getByText("Ignored Spinneys")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
});

it("removes the toast from state as soon as dismiss is tapped", async () => {
  renderWithToast("Ignored Spinneys");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  // AnimatePresence may keep the node mounted for its exit; what matters is
  // that the provider's state no longer holds it, so a second dismiss is a
  // no-op rather than a double-remove.
  expect(screen.queryAllByRole("button", { name: "Dismiss" }).length).toBeLessThanOrEqual(1);
});
```

Every render in this file must be wrapped in `MotionProvider` — add a `renderWithToast` helper that nests `MotionProvider` > `ToastProvider` if one is not already present.

- [ ] **Step 8: Run the tests**

Run: `cd frontend && bunx vitest run src/components/Toast.test.tsx src/lib/toastSwipe.test.ts`
Expected: PASS.

- [ ] **Step 9: Verify by hand in the harness**

```bash
cd frontend
harness/stack.sh up
node harness/probe.mjs
```
Then open `http://localhost:5199` in a browser, trigger a toast (categorize a transaction), and **swipe it right**. It must continue right and fade — not snap back to centre. Swipe another left; it must continue left.

- [ ] **Step 10: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/Toast.tsx frontend/src/components/Toast.test.tsx \
        frontend/src/lib/toastSwipe.ts frontend/src/lib/toastSwipe.test.ts
git commit -m "fix(motion): toast swipe keeps its direction on dismissal

React's style prop rewrote the imperatively-set transform on the leaving
render, so a swiped toast snapped back to x=0 and dropped. A motion value
owns x and AnimatePresence owns the exit, so the release direction and
velocity survive the commit."
```

---

### Task 4: Dialog + SettingsPage — `AnimatePresence` and velocity-aware dismissal

Fixes finding **14**, and deletes two hand-rolled lifecycle machines.

Today both components hand-roll the same thing: seed an offscreen transform, force a WebKit style flush (`void panel.offsetHeight`), `requestAnimationFrame` to the rest state, and on close start an exit then `setTimeout(onClose, SHEET_EXIT_MS)`. `AnimatePresence` does all of it, correctly, including the WebKit case. Framer's `drag` additionally gives velocity-aware dismissal, so a hard flick from 70% down no longer takes the same fixed 300ms as a dismissal from rest.

The call-site contract is preserved: the parent still unmounts on `onClose`. `Dialog` owns a local `open` flag and calls `onClose` from `AnimatePresence`'s `onExitComplete`.

**Files:**
- Modify: `frontend/src/components/ui/Dialog.tsx`
- Modify: `frontend/src/screens/settings/SettingsPage.tsx:33-90`
- Modify: `frontend/src/lib/sheetDrag.ts`, `lib/sheetDrag.test.ts`
- Modify: `frontend/src/lib/edgeBack.ts`, `lib/edgeBack.test.ts`
- Modify: `frontend/src/components/ui/Dialog.test.tsx:77-150`
- Delete: `frontend/src/hooks/useSheetDrag.ts`, `frontend/src/hooks/useEdgeBack.ts`

**Interfaces:**
- Consumes: `SHEET_ENTER`, `SHEET_EXIT`, `FADE`, `SPRING_SHEET` from `lib/motion`.
- Produces: `shouldDismissSheet(offsetY: number, velocityY: number): boolean`; `shouldGoBack(offsetX: number, velocityX: number, width: number): boolean`. Both replace `(delta, elapsedMs)` signatures.

- [ ] **Step 1: Write the failing predicate tests**

Replace the body of `frontend/src/lib/sheetDrag.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldDismissSheet, SHEET_DISMISS_PX, SHEET_FLICK_VELOCITY } from "./sheetDrag";

describe("shouldDismissSheet", () => {
  it("dismisses once dragged past the distance threshold", () => {
    expect(shouldDismissSheet(SHEET_DISMISS_PX + 1, 0)).toBe(true);
  });
  it("snaps back below the threshold with no speed", () => {
    expect(shouldDismissSheet(SHEET_DISMISS_PX - 1, 0)).toBe(false);
  });
  it("dismisses a short downward flick on velocity alone", () => {
    expect(shouldDismissSheet(24, SHEET_FLICK_VELOCITY + 1)).toBe(true);
  });
  it("never dismisses on an upward drag", () => {
    expect(shouldDismissSheet(-200, 0)).toBe(false);
    expect(shouldDismissSheet(-10, SHEET_FLICK_VELOCITY + 1)).toBe(false);
  });
  it("ignores an upward flick that reverses a downward drag", () => {
    expect(shouldDismissSheet(30, -(SHEET_FLICK_VELOCITY + 1))).toBe(false);
  });
});
```

And `frontend/src/lib/edgeBack.test.ts` — keep the existing `inEdgeZone` and `edgeBackOffset` tests verbatim, and replace only the `shouldGoBack` describe block:

```ts
describe("shouldGoBack", () => {
  const W = 390;
  it("goes back past a third of the screen width", () => {
    expect(shouldGoBack(W / 3 + 1, 0, W)).toBe(true);
  });
  it("stays below a third with no speed", () => {
    expect(shouldGoBack(W / 3 - 1, 0, W)).toBe(false);
  });
  it("goes back on a short rightward flick", () => {
    expect(shouldGoBack(40, EDGE_FLICK_VELOCITY + 1, W)).toBe(true);
  });
  it("never goes back on a leftward drag", () => {
    expect(shouldGoBack(-100, 0, W)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && bunx vitest run src/lib/sheetDrag.test.ts src/lib/edgeBack.test.ts`
Expected: FAIL — new exports missing, arity changed.

- [ ] **Step 3: Rewrite both predicates**

Replace `frontend/src/lib/sheetDrag.ts`:

```ts
/** Downward travel past which a release dismisses the sheet. */
export const SHEET_DISMISS_PX = 110;
/** px/s past which a downward release dismisses regardless of distance. */
export const SHEET_FLICK_VELOCITY = 550;

/**
 * Should a released sheet drag dismiss?
 *
 * Sheets only dismiss downward — an upward drag is rubber-banding, never a
 * gesture. Velocity is Framer's signed px/s reading and only counts when it
 * agrees with the drag direction, so flicking back up after dragging down
 * cancels rather than confirms.
 */
export function shouldDismissSheet(offsetY: number, velocityY: number): boolean {
  if (offsetY <= 0) return false;
  if (offsetY >= SHEET_DISMISS_PX) return true;
  return velocityY >= SHEET_FLICK_VELOCITY;
}
```

In `frontend/src/lib/edgeBack.ts`, keep `inEdgeZone` and `edgeBackOffset` exactly as they are and replace `shouldGoBack`:

```ts
/** px/s past which a rightward release pops the page regardless of distance. */
export const EDGE_FLICK_VELOCITY = 550;

/**
 * Should a released edge-swipe pop the page? Rightward only — the same
 * direction rule as the sheet, for the same reason.
 */
export function shouldGoBack(offsetX: number, velocityX: number, width: number): boolean {
  if (offsetX <= 0) return false;
  if (offsetX >= width / 3) return true;
  return velocityX >= EDGE_FLICK_VELOCITY;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && bunx vitest run src/lib/sheetDrag.test.ts src/lib/edgeBack.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite `Dialog`**

In `frontend/src/components/ui/Dialog.tsx`:

Keep `DialogFooter` and `useScrollLock` **exactly as they are** — they are layout, not motion, and both carry hard-won iOS reasoning. Replace the `Dialog` function body's motion machinery:

```tsx
export function Dialog({ title, titleAdornment, titleStyle, onClose, children }: {
  title: string;
  titleAdornment?: ReactNode;
  titleStyle?: CSSProperties;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const viewport = useVisualViewport();
  useScrollLock(rootRef);

  // The sheet owns its own exit: `open` drives AnimatePresence, and the
  // parent is only told to unmount once the exit has actually finished.
  // That replaces a setTimeout racing a CSS duration — the two could not be
  // kept in sync, and the mismatch is what SHEET_EXIT_MS was papering over.
  const [open, setOpen] = useState(true);
  const requestClose = useCallback(() => setOpen(false), []);

  // Drag lives on the handle + header, not the whole panel, or a drag on the
  // scrollable body would fight the scroller.
  const dragControls = useDragControls();

  // A sheet that opens onto a field should land the caret in it. Focusing the
  // panel unconditionally stole that focus back, so search took two taps: one
  // to open the sheet, another to actually get into the input.
  useEffect(() => {
    const panel = panelRef.current;
    const autofocus = panel?.querySelector<HTMLElement>("[autofocus]");
    if (autofocus) autofocus.focus();
    else panel?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { requestClose(); return; }
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
    return () => document.removeEventListener("keydown", onKey);
  }, [requestClose]);

  return (
    <AnimatePresence onExitComplete={() => onCloseRef.current()}>
      {open && (
        <div
          ref={rootRef}
          className="fixed inset-x-0 z-50 flex items-end sm:items-center justify-center"
          style={{ top: viewport.offsetTop, height: viewport.height || undefined }}
          onClick={requestClose}
        >
          {/* touch-none: a drag on the dim area must die here, not travel to
              the root scroller and rubber-band the page out from under the
              sheet. */}
          <m.div
            aria-hidden
            data-testid="dialog-scrim"
            className="absolute inset-0 touch-none bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE}
          />
          <m.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ ...SHEET_ENTER, exit: SHEET_EXIT }}
            drag="y"
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            // Downward only: an upward pull rubber-bands and springs back.
            dragElastic={{ top: 0, bottom: 0.9 }}
            dragMomentum={false}
            onDragEnd={(_, info) => {
              if (shouldDismissSheet(info.offset.y, info.velocity.y)) requestClose();
            }}
            style={{
              maxHeight: viewport.height ? `${Math.round(viewport.height * 0.85)}px` : "85dvh",
              ...(viewport.keyboardOpen ? { ["--sheet-inset-bottom" as string]: "1rem" } : {}),
            }}
            className="sheet-panel relative w-full sm:max-w-md bg-surface rounded-t-[var(--radius)] sm:rounded-[var(--radius)] shadow-1 px-4 pt-3 overflow-y-auto overscroll-contain outline-none"
          >
            <div
              className="touch-none cursor-grab active:cursor-grabbing sm:cursor-default"
              onPointerDown={(e) => dragControls.start(e)}
            >
              <div aria-hidden className="sm:hidden mx-auto mb-2 h-1 w-9 rounded-[var(--radius)] bg-border" />
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  {titleAdornment}
                  <h2 id={titleId} style={titleStyle} className="text-lg font-semibold truncate">{title}</h2>
                </div>
                <IconButton label="Close" className="-mr-2" onClick={requestClose}><X size={18} /></IconButton>
              </div>
            </div>
            {children}
          </m.div>
        </div>
      )}
    </AnimatePresence>
  );
}
```

Keep the two long comments from the original — the `maxHeight` visual-viewport rationale (lines 158-163, 183-191) and the `sheet-panel` inset note — verbatim above their respective lines. They document iOS keyboard bugs that cost real debugging.

Update imports:

```tsx
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, m, useDragControls } from "motion/react";
import { X } from "./PixelIcon";
import { SHEET_ENTER, SHEET_EXIT, FADE } from "../../lib/motion";
import { shouldDismissSheet } from "../../lib/sheetDrag";
import { useVisualViewport } from "../../hooks/useVisualViewport";
import { IconButton } from "./IconButton";
```

Note `willChange` is gone — Framer manages it per-animation and clears it at rest.

- [ ] **Step 6: Rewrite `SettingsPage`'s panel**

In `frontend/src/screens/settings/SettingsPage.tsx`, apply the identical shape, horizontally. Delete the `useEffect` at lines 42-52 (the seed/flush/rAF block), the `requestClose` timer at lines 58-65, and the `useEdgeBack` call at line 69. Replace the panel element (line 72-87):

```tsx
const [open, setOpen] = useState(true);
const requestClose = useCallback(() => setOpen(false), []);
const dragControls = useDragControls();

return (
  <AnimatePresence onExitComplete={() => onCloseRef.current()}>
    {open && (
      <m.div
        ref={panelRef}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ ...SHEET_ENTER, exit: SHEET_EXIT }}
        drag="x"
        dragControls={dragControls}
        dragListener={false}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0, right: 0.9 }}
        dragMomentum={false}
        onDragEnd={(_, info) => {
          const width = panelRef.current?.offsetWidth || window.innerWidth;
          if (shouldGoBack(info.offset.x, info.velocity.x, width)) requestClose();
        }}
        className="fixed inset-0 z-40 bg-bg flex flex-col"
      >
        {/* Invisible activation strip: touch-none here (and only here) lets
            horizontal pointermoves reach us instead of scrolling the page. */}
        <div
          aria-hidden
          data-testid="edge-back-strip"
          className="absolute left-0 inset-y-0 w-6 z-10 touch-none"
          onPointerDown={(e) => { if (inEdgeZone(e.clientX)) dragControls.start(e); }}
        />
        {/* …rest of the panel body unchanged… */}
      </m.div>
    )}
  </AnimatePresence>
);
```

- [ ] **Step 7: Delete the superseded hooks**

```bash
cd /root/Coding/ledger/frontend
rm src/hooks/useSheetDrag.ts src/hooks/useEdgeBack.ts
grep -rn "useSheetDrag\|useEdgeBack" src
```
Expected: no output from the grep. Delete any co-located test files for those hooks if present.

- [ ] **Step 8: Update `Dialog.test.tsx`**

Three tests assert on inline `transition`/`transform` strings that no longer exist (lines 77-79, 126-130) and one asserts synchronous close under reduced motion (line 135). Replace them:

```tsx
it("renders the panel and scrim", () => {
  renderDialog();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByTestId("dialog-scrim")).toBeInTheDocument();
});

it("calls onClose after the exit animation completes", async () => {
  const onClose = vi.fn();
  renderDialog({ onClose });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("calls onClose when the scrim is tapped", async () => {
  const onClose = vi.fn();
  renderDialog({ onClose });
  fireEvent.click(screen.getByTestId("dialog-scrim"));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});
```

Keep every test in the file that asserts *layout* — the `paddingBottom`, `--sheet-inset-bottom` and `useScrollLock` tests (lines 35-65) are untouched by this task and must still pass unchanged. Wrap all renders in `MotionProvider`.

Add to the top of the file so jsdom does not stall on Framer's rAF scheduling:

```tsx
// jsdom has no layout, so Framer's spring/tween scheduler needs real timers
// to settle. These tests assert lifecycle (did onClose fire), never geometry.
import { waitFor } from "@testing-library/react";
```

- [ ] **Step 9: Run the tests**

Run: `cd frontend && bun run test`
Expected: PASS. Any remaining failures will be other sheets (`PeriodSheet`, `CategorizeSheet`, `SplitSheet`, `LinkRefundSheet`, `MoveMoneySheet`) whose tests render a `Dialog` — wrap those renders in `MotionProvider` too.

- [ ] **Step 10: Verify on iOS geometry**

```bash
cd frontend
harness/stack.sh reset
node harness/ios.mjs
```
This is the only check that sees the software keyboard and `env(safe-area-inset-*)`. Confirm: sheets still open above the keyboard, the footer rail still clears the home indicator, and a downward flick on the grab handle dismisses faster than a slow drag.

- [ ] **Step 11: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src
git commit -m "refactor(motion): sheets and drill-in pages on AnimatePresence + drag

Replaces two hand-rolled lifecycle machines (offscreen seed, WebKit style
flush, rAF, setTimeout racing a CSS duration) with AnimatePresence, and
makes dismissal velocity-aware so a hard flick finishes faster than a slow
drag."
```

---

### Task 5: `SwipeableRow` — motion values instead of per-frame React state

Fixes finding **6**.

`setDx()` runs on every `pointermove`, re-rendering the row and writing `width` to two absolutely-positioned panels — a React render *and* two layout invalidations per pointer frame, inside a scrolling list. `useSheetDrag.ts:8` documented the opposite rule ("no React state per move — stays on the GPU"); this row is the one place that broke it.

**Files:**
- Modify: `frontend/src/components/transactions/SwipeableRow.tsx`
- Modify: `frontend/src/lib/rowSwipe.ts`, `lib/rowSwipe.test.ts`

**Interfaces:**
- Consumes: `SPRING_ROW` from `lib/motion`; `Pressable` is not used here.
- Produces: `swipeCommits(offsetX: number, velocityX: number, actions: RowActions): RowSwipeAction | null` — signature change. `ROW_COMMIT`, `RowActions`, `RowSwipeAction` keep their current meanings. `swipeAxis` and `swipeOffset` are **deleted** — Framer's `drag="x"` with `dragDirectionLock` does axis detection and elastic clamping natively.

- [ ] **Step 1: Write the failing predicate test**

In `frontend/src/lib/rowSwipe.test.ts`, delete the `swipeAxis` and `swipeOffset` describe blocks and replace the `swipeCommits` block:

```ts
import { describe, it, expect } from "vitest";
import { swipeCommits, swipeProgress, ROW_COMMIT, ROW_FLICK_VELOCITY } from "./rowSwipe";

const both = { lead: true, trail: true };
const leadOnly = { lead: true, trail: false };

describe("swipeCommits", () => {
  it("commits the lead action on a long rightward drag", () => {
    expect(swipeCommits(ROW_COMMIT + 1, 0, both)).toBe("lead");
  });
  it("commits the trail action on a long leftward drag", () => {
    expect(swipeCommits(-(ROW_COMMIT + 1), 0, both)).toBe("trail");
  });
  it("commits on a short flick", () => {
    expect(swipeCommits(20, ROW_FLICK_VELOCITY + 1, both)).toBe("lead");
  });
  it("returns null below both thresholds", () => {
    expect(swipeCommits(ROW_COMMIT - 1, 0, both)).toBeNull();
  });
  it("never commits an action the row does not have", () => {
    expect(swipeCommits(-(ROW_COMMIT + 1), 0, leadOnly)).toBeNull();
  });
  it("ignores velocity that reverses the drag", () => {
    expect(swipeCommits(20, -(ROW_FLICK_VELOCITY + 1), both)).toBeNull();
  });
});

describe("swipeProgress", () => {
  it("ramps 0..1 across the commit distance and clamps beyond it", () => {
    expect(swipeProgress(0)).toBe(0);
    expect(swipeProgress(ROW_COMMIT)).toBe(1);
    expect(swipeProgress(ROW_COMMIT * 2)).toBe(1);
    expect(swipeProgress(-ROW_COMMIT)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/rowSwipe.test.ts`
Expected: FAIL — `ROW_FLICK_VELOCITY` missing, `swipeCommits` arity wrong.

- [ ] **Step 3: Rewrite the predicate module**

In `frontend/src/lib/rowSwipe.ts`, delete `swipeAxis` and `swipeOffset` entirely, keep `ROW_COMMIT`/`RowActions`/`RowSwipeAction`/`swipeProgress`, and replace `swipeCommits`:

```ts
/** px/s past which a release commits regardless of distance. */
export const ROW_FLICK_VELOCITY = 500;

/**
 * Which action, if any, a released row swipe commits.
 *
 * Axis detection and elastic clamping used to live here; Framer's
 * `dragDirectionLock` and `dragElastic` do both natively, so this is now
 * purely the commit decision. Velocity only counts when it agrees with the
 * drag direction — flicking back cancels.
 */
export function swipeCommits(
  offsetX: number,
  velocityX: number,
  actions: RowActions,
): RowSwipeAction | null {
  const sameDirection = offsetX !== 0 && Math.sign(velocityX) === Math.sign(offsetX);
  const committed =
    Math.abs(offsetX) >= ROW_COMMIT ||
    (sameDirection && Math.abs(velocityX) >= ROW_FLICK_VELOCITY);
  if (!committed) return null;
  if (offsetX > 0) return actions.lead ? "lead" : null;
  return actions.trail ? "trail" : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/rowSwipe.test.ts`
Expected: PASS (10 assertions).

- [ ] **Step 5: Rewrite the component**

Replace `frontend/src/components/transactions/SwipeableRow.tsx` from line 34 to the end:

```tsx
export function SwipeableRow({ lead, trail, onCommit, children }: {
  lead?: SwipeActionSpec;
  trail?: SwipeActionSpec;
  onCommit: (action: RowSwipeAction) => void;
  children: ReactNode;
}) {
  const actions: RowActions = { lead: !!lead, trail: !!trail };
  const moved = useRef(false);

  // The live offset. A motion value, not React state: the previous version
  // called setDx() on every pointermove, which re-rendered the row and
  // dirtied layout on two `width`-driven panels — per frame, inside a
  // scrolling list.
  const x = useMotionValue(0);

  // The panels are full-width and revealed by clip-path, so nothing animates
  // a layout property. clip-path also keeps the label's text from reflowing
  // as the panel grows, which a width animation could not avoid.
  const leadClip = useTransform(x, (v) => `inset(0 ${Math.max(0, 100 - (v / ROW_COMMIT) * 100)}% 0 0)`);
  const trailClip = useTransform(x, (v) => `inset(0 0 0 ${Math.max(0, 100 - (-v / ROW_COMMIT) * 100)}%)`);
  const leadOpacity = useTransform(x, [0, ROW_COMMIT], [0, 1], { clamp: true });
  const trailOpacity = useTransform(x, [0, -ROW_COMMIT], [0, 1], { clamp: true });

  if (!lead && !trail) return <>{children}</>;

  // A swipe must not also register as a tap on the child (which opens detail).
  const onClickCapture = (e: React.MouseEvent) => {
    if (moved.current) {
      e.stopPropagation();
      e.preventDefault();
      moved.current = false;
    }
  };

  return (
    <div className="relative overflow-hidden" onClickCapture={onClickCapture}>
      {lead && (
        <m.div
          aria-hidden
          className="absolute inset-0 flex items-center gap-2 pl-4 text-sm font-medium"
          style={{ clipPath: leadClip, opacity: leadOpacity, background: lead.color, color: lead.fg ?? "#fff" }}
        >
          {lead.icon}
          <span>{lead.label}</span>
        </m.div>
      )}
      {trail && (
        <m.div
          aria-hidden
          className="absolute inset-0 flex items-center justify-end gap-2 pr-4 text-sm font-medium"
          style={{ clipPath: trailClip, opacity: trailOpacity, background: trail.color, color: trail.fg ?? "#fff" }}
        >
          <span>{trail.label}</span>
          {trail.icon}
        </m.div>
      )}
      <m.div
        className="relative bg-surface"
        style={{ x }}
        drag="x"
        // Vertical drags must fall through to the scroller. Framer decides the
        // axis on the first few pixels, exactly as the hand-rolled swipeAxis
        // used to, and then locks it for the rest of the gesture.
        dragDirectionLock
        dragSnapToOrigin
        dragElastic={0.4}
        dragMomentum={false}
        onDragStart={() => { moved.current = true; }}
        onDragEnd={(_, info) => {
          const committed = swipeCommits(info.offset.x, info.velocity.x, actions);
          if (committed) { fire("selection"); onCommit(committed); }
        }}
        dragTransition={{ bounceStiffness: SPRING_ROW.stiffness, bounceDamping: SPRING_ROW.damping }}
      >
        {children}
      </m.div>
    </div>
  );
}
```

Update imports:

```tsx
import { useRef, type ReactNode } from "react";
import { m, useMotionValue, useTransform } from "motion/react";
import { fire } from "../../lib/feedback";
import { SPRING_ROW } from "../../lib/motion";
import { swipeCommits, ROW_COMMIT, type RowActions, type RowSwipeAction } from "../../lib/rowSwipe";
```

`swipeProgress` is deliberately **not** imported here any more — the panels' opacity comes from `useTransform` so it never round-trips through React. Keep `swipeProgress` exported from `lib/rowSwipe.ts` (its test covers it and it stays the documented ramp), but this component no longer calls it.

Note the labels now render unconditionally and are revealed by the clip — the old `committing && dx > 0 && <span>` gate caused the label to *pop in* at the threshold rather than being uncovered.

- [ ] **Step 6: Run the tests**

Run: `cd frontend && bun run test`
Expected: PASS. `SwipeableRow`'s own test file (if it drives pointer events) will need rewriting — jsdom cannot produce Framer drag gestures with real velocity. Convert those to test `swipeCommits` directly in `lib/rowSwipe.test.ts` (already done in Step 1) and keep only render-level assertions in the component test: that both panels render, that a row with neither action renders its child bare.

- [ ] **Step 7: Verify in the harness with hostile data**

```bash
cd frontend
harness/stack.sh reset
node harness/shoot.mjs
node harness/probe.mjs
```
The seed contains a merchant name wider than the viewport — confirm the revealed action label does not push it, and that the geometry audit reports no new past-viewport elements. Then swipe a row by hand in the browser and confirm vertical scrolling still works from a row.

- [ ] **Step 8: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/transactions/SwipeableRow.tsx \
        frontend/src/lib/rowSwipe.ts frontend/src/lib/rowSwipe.test.ts
git commit -m "perf(motion): drive SwipeableRow from motion values, not React state

setDx() ran per pointermove, re-rendering the row and animating width on
two panels — a React render plus two layout invalidations per frame inside
a scrolling list. clip-path + motion values keep it off the main thread."
```

---

### Task 6: Swipe deck — overlap the card transition, honour reduced motion

Fixes findings **3**, **4**, **5**, **11**, **13**.

The deck currently advances only in `handleExitComplete`, which fires on the fly-out's 300ms `transitionend`; the incoming card then plays a 320ms `.swipe-card-in`. That is **620ms of serial dead time per card** in the app's highest-frequency flow. Separately, the `flying` branch of the transition ternary (`SwipeCard.tsx:118`) short-circuits before `reduceMotion` is consulted, so the largest movement in the app ignores the preference; the same line forks `--ease-out` as a literal; and `willChange: 'transform'` is pinned for the card's whole life.

**Files:**
- Modify: `frontend/src/components/swipe/SwipeCard.tsx`
- Modify: `frontend/src/components/swipe/SwipeDeck.tsx:212, :246, :312-317, :352-372`
- Modify: `frontend/src/lib/swipe.ts`, `lib/swipe.test.ts`
- Delete from `frontend/src/styles/app.css`: `@keyframes swipe-card-in`, `.swipe-card-in`, and its reduced-motion block (lines 239-249)

**Interfaces:**
- Consumes: `SPRING_SNAP`, `FADE`, `EASE_OUT`, `DUR` from `lib/motion`.
- Produces: `commitDirection(offsetX: number, offsetY: number, velocityX: number, velocityY: number, config: SwipeConfig): SwipeDirection | null`, replacing the hand-rolled threshold logic in `useSwipeGesture`. `previewDirection`, `overlayProgress`, `actionColor`, `onActionColor` keep their current signatures.

- [ ] **Step 1: Write the failing commit-direction test**

Append to `frontend/src/lib/swipe.test.ts`:

```ts
import { commitDirection, COMMIT_PX, COMMIT_VELOCITY } from "./swipe";

describe("commitDirection", () => {
  it("commits along the dominant axis once past the distance threshold", () => {
    expect(commitDirection(COMMIT_PX + 1, 10, 0, 0)).toBe("right");
    expect(commitDirection(-(COMMIT_PX + 1), 10, 0, 0)).toBe("left");
    expect(commitDirection(10, -(COMMIT_PX + 1), 0, 0)).toBe("up");
    expect(commitDirection(10, COMMIT_PX + 1, 0, 0)).toBe("down");
  });

  it("commits a short flick on velocity alone", () => {
    expect(commitDirection(20, 0, COMMIT_VELOCITY + 1, 0)).toBe("right");
    expect(commitDirection(0, -20, 0, -(COMMIT_VELOCITY + 1))).toBe("up");
  });

  it("returns null below both thresholds", () => {
    expect(commitDirection(10, 10, 0, 0)).toBeNull();
  });

  it("picks the axis with the larger travel when both clear the threshold", () => {
    expect(commitDirection(COMMIT_PX + 50, COMMIT_PX + 1, 0, 0)).toBe("right");
    expect(commitDirection(COMMIT_PX + 1, COMMIT_PX + 50, 0, 0)).toBe("down");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/swipe.test.ts`
Expected: FAIL — `commitDirection` is not exported.

- [ ] **Step 3: Add the predicate**

Append to `frontend/src/lib/swipe.ts`:

```ts
/** Travel past which a release commits, on either axis. */
export const COMMIT_PX = 100;
/** px/s past which a release commits regardless of distance. */
export const COMMIT_VELOCITY = 520;

/**
 * Which bucket, if any, a released card swipe commits to.
 *
 * The dominant axis wins — a diagonal drag that clears both thresholds goes
 * wherever the hand travelled further, which is what the eye expects. Was
 * previously spread across useSwipeGesture's pointer handlers with a
 * time-based speed estimate; Framer reports real px/s.
 */
export function commitDirection(
  offsetX: number,
  offsetY: number,
  velocityX: number,
  velocityY: number,
): SwipeDirection | null {
  const horizontal =
    Math.abs(offsetX) >= COMMIT_PX ||
    (Math.sign(velocityX) === Math.sign(offsetX) && Math.abs(velocityX) >= COMMIT_VELOCITY);
  const vertical =
    Math.abs(offsetY) >= COMMIT_PX ||
    (Math.sign(velocityY) === Math.sign(offsetY) && Math.abs(velocityY) >= COMMIT_VELOCITY);
  if (!horizontal && !vertical) return null;
  const preferHorizontal = horizontal && (!vertical || Math.abs(offsetX) >= Math.abs(offsetY));
  if (preferHorizontal) return offsetX > 0 ? "right" : "left";
  return offsetY > 0 ? "down" : "up";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/swipe.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite `SwipeCard`'s motion layer**

In `frontend/src/components/swipe/SwipeCard.tsx`, replace the root element (lines 112-147). The card body (lines 148-226) is unchanged apart from the `<button>` → `<Pressable>` swap already made in Task 2.

```tsx
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  // The card leans into the drag. 0.04°/px, so a 100px pull is a 4° tilt —
  // enough to read as physical, not enough to look like a slot machine.
  const rotate = useTransform(x, (v) => v * 0.04);

  return (
    <m.div
      style={{ x, y, rotate }}
      drag
      dragSnapToOrigin
      dragElastic={0.7}
      dragMomentum={false}
      dragTransition={{ bounceStiffness: SPRING_SNAP.stiffness, bounceDamping: SPRING_SNAP.damping }}
      onDragEnd={(_, info) => {
        const dir = commitDirection(info.offset.x, info.offset.y, info.velocity.x, info.velocity.y);
        if (dir) onDirectionCommit(dir);
      }}
      // The deck cross-fades cards, so entry and exit are AnimatePresence's
      // job. Under the app's global reducedMotion policy Framer drops the
      // translate and rotate and keeps the opacity — which is the whole
      // reason the old hand-rolled `flying ? … : reduceMotion ? …` ternary
      // is gone: `flying` short-circuited before reduceMotion was consulted,
      // so the biggest movement in the app ignored the preference entirely.
      initial={{ opacity: 0, scale: 0.92, y: 16 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={flying ? { ...EXIT[flying], opacity: 0 } : { opacity: 0 }}
      transition={{ duration: DUR.base, ease: EASE_OUT }}
      data-testid="swipe-card"
      // Downward card drags are a commit gesture — PTR must never claim them.
      data-ptr-exempt=""
      className="relative w-full bg-surface border border-border rounded-[var(--radius)] cursor-grab active:cursor-grabbing overflow-hidden"
    >
```

Replace the `EXIT` table at lines 22-27 with Framer target objects:

```tsx
// Where a committed card leaves toward. `rotate` only on the horizontal
// exits: an up/down card that also spun would read as a discard, and up/down
// are Save and Transfer.
const EXIT: Record<SwipeDirection, { x: number; y: number; rotate: number }> = {
  left:  { x: -600, y: 0,    rotate: -20 },
  right: { x:  600, y: 0,    rotate:  20 },
  up:    { x: 0,    y: -800, rotate:   0 },
  down:  { x: 0,    y:  800, rotate:   0 },
}
```

Delete: the `useSwipeGesture` import and call, the `usePrefersReducedMotion` import and shim, `exitedRef`, the `onTransitionEnd` handler, `willChange`, `touchAction`/`userSelect` inline styles (Framer sets `touch-action` itself while dragging), and the `boxShadow` ring — move the ring onto the badge's own `boxShadow` so it is not recomputed on the dragged element every frame.

For the live preview and the badge, derive from the motion values instead of per-frame React state:

```tsx
  // Which edge the card is leaning toward. This IS React state, but it only
  // ever holds one of five values (four directions or null), so it re-renders
  // on a direction *change* — not on every pointer frame the way the old
  // useSwipeGesture state did.
  const [dir, setDir] = useState<SwipeDirection | null>(null);

  // Strength of the lean, 0..1, as a motion value — this one does change every
  // frame, so it must never touch React. The badge reads it directly.
  const progress = useMotionValue(0);

  const reportPreview = useCallback(() => {
    const dx = x.get(), dy = y.get();
    const d = previewDirection(dx, dy);
    progress.set(overlayProgress(dx, dy));
    setDir((prev) => (prev === d ? prev : d));   // bail out when unchanged
    onPreview?.(d, overlayProgress(dx, dy));
  }, [x, y, progress, onPreview]);

  useMotionValueEvent(x, "change", reportPreview);
  useMotionValueEvent(y, "change", reportPreview);

  // The badge's own animation, straight off the motion value.
  const badgeOpacity = useTransform(progress, [0, 0.85], [0, 1], { clamp: true });
  const badgeScale = useTransform(progress, [0, 1], [0.85, 1], { clamp: true });
```

The badge block at the end of the component (lines 210-226) becomes an `m.div` whose `opacity` and `scale` come from `badgeOpacity`/`badgeScale`, with `BADGE_POS[dir].center` kept as a static `translate` on the same element. Its `dir` comes from the state above; `flying` still forces `opacity: 1`.

Delete the `resetToken` prop and its `useEffect` (lines 71-78): with `AnimatePresence` each card is a fresh element keyed by ID, so there is no stale offset to reset. Remove `resetToken` from `SwipeDeck`'s render of `SwipeCard` and from `SwipeDeckState`.

- [ ] **Step 6: Overlap the deck's card transition**

In `frontend/src/components/swipe/SwipeDeck.tsx`:

The index must advance **one render after** the card is marked flying — not in the same `setState`, and not on `transitionend`.

This is the subtle part, and getting it wrong silently costs the feature. `AnimatePresence` animates out the element **as it was last rendered**. If `flyDirection` and `index` change in the same batched `setState`, then in that single render `current` is already the *next* transaction, so the outgoing card's last render was the *previous* one — where `flying` was still `null`. It would fade straight down instead of flying toward its bucket, and the directional exit the whole deck is built around would be dead code. Two renders, one tick apart, is what makes the snapshot carry the direction.

Replace the commit path (line 212):

```tsx
    // Mark the card as flying. Do NOT advance the index here — see the effect
    // below for why the two must land in separate renders.
    setState(s => ({ ...s, pendingDirection: null, flyDirection: dir }));
```

Delete `handleExitComplete` (lines 246-248) and replace it with:

```tsx
  // One render after the card is marked flying, swap in the next one.
  // AnimatePresence holds the outgoing card mounted for its exit — with the
  // props it had when `flying` was set — while the incoming card enters over
  // it. That overlap is what removes the old 300ms exit + 320ms enter serial
  // cost; on a 40-card sitting it is ~25s of dead time.
  useEffect(() => {
    if (!state.flyDirection) return;
    setState(s => ({
      ...s,
      flyDirection: null,
      index: s.index + 1,
      previewDir: null,
      previewProgress: 0,
    }));
  }, [state.flyDirection]);
```

Wrap the card in `AnimatePresence` (line 361):

```tsx
<AnimatePresence initial={false} mode="popLayout">
  {current && (
    <SwipeCard
      key={current.ID}
      txn={current}
      config={config}
      flying={state.flyDirection}
      onDirectionCommit={handleDirectionCommit}
      onTripleTap={handleTripleTap}
      onPreview={handlePreview}
      onOpenEmail={onOpenEmail}
    />
  )}
</AnimatePresence>
```

`mode="popLayout"` takes the exiting card out of layout flow so the incoming card takes its place immediately rather than being pushed down by it.

**`popLayout` requires the child to forward a ref to its DOM node.** `SwipeCard` currently does not, and Framer will warn and fall back to `sync` mode if it cannot reach the element. Wrap the component:

```tsx
export const SwipeCard = forwardRef<HTMLDivElement, SwipeCardProps>(function SwipeCard(
  { txn, config = DEFAULT_SWIPE_CONFIG, flying = null, onDirectionCommit, onTripleTap, onPreview, onOpenEmail },
  ref,
) {
```

and pass `ref={ref}` to the root `m.div`. Verify at runtime that no "You must pass a ref" warning appears in the console during a sort — a silent fallback to `sync` mode is exactly the kind of regression that looks fine in a screenshot.

Fix the progress bar (line 312-317) — `transition-all` plus an animated `width`:

```tsx
<div className="h-1.5 bg-border rounded-[var(--radius)] overflow-hidden mb-4">
  <m.div
    className="h-full origin-left bg-accent rounded-[var(--radius)]"
    style={{ width: "100%" }}
    animate={{ scaleX: progress }}
    transition={{ duration: DUR.sheet, ease: EASE_OUT }}
  />
</div>
```

`scaleX` on a solid fill is safe — unlike `ProgressBar`, this bar carries no dither texture to distort.

The edge-colour wash (line 323-327) is already opacity-only; convert it to `m.div` with `animate={{ opacity: washOpacity }}` and `transition={{ duration: DUR.fast, ease: EASE_OUT }}` for consistency.

The `EdgeRail` button (line 75-92) becomes a `Pressable` (done in Task 2); replace its `transition-[transform,background-color,color,box-shadow] duration-200` class and inline `transform` with Framer props:

```tsx
<Pressable
  disabled={disabled}
  onClick={() => onCommit(dir)}
  aria-label={`${action.label} — sort this transaction`}
  className={`flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-semibold disabled:opacity-50 ${vertical ? 'flex-col px-2 py-3 w-12 min-h-11' : 'px-4 py-2 min-h-11'}`}
  animate={{
    scale: active ? 1.08 : 1,
    backgroundColor: active ? color : `${color}1f`,
    color: active ? onActionColor(color) : color,
    boxShadow: active ? `0 10px 24px -8px ${color}` : '0 0 0 0 rgba(0,0,0,0)',
  }}
  transition={{ duration: DUR.base, ease: EASE_OUT }}
>
```

This is the finding-7 payoff: the fill and shadow now genuinely ramp over 200ms instead of popping, because nothing outranks them any more.

- [ ] **Step 7: Delete the superseded CSS**

In `frontend/src/styles/app.css`, delete lines 239-249 — the `/* ---- Swipe Mode ---- */` comment, `@keyframes swipe-card-in`, `.swipe-card-in`, and its `prefers-reduced-motion` block.

- [ ] **Step 8: Run the tests**

Run: `cd frontend && bun run test`
Expected: PASS. `SwipeDeck.undo.test.tsx` drives the commit path; it must now observe the index advancing synchronously rather than after a transition. Update its assertions accordingly and wrap renders in `MotionProvider`. If `hooks/useSwipeGesture.ts` is now unreferenced, delete it and its test.

- [ ] **Step 9: Measure the throughput win**

```bash
cd frontend
harness/stack.sh reset
```
Open the Review tab in a browser, sort five cards in a row, and confirm the next card is draggable **before** the previous one has finished leaving. Then set the OS to reduce motion (or run with `reducedMotion: "reduce"` via `harness/ios.mjs`) and confirm the card cross-fades without the 600–800px translate.

Do not judge the new timing from the first run — cold-start jank reads as a bug. Discard it and A/B under equally warm conditions.

- [ ] **Step 10: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/swipe frontend/src/lib/swipe.ts frontend/src/lib/swipe.test.ts \
        frontend/src/styles/app.css
git commit -m "perf(motion): overlap swipe-deck card transitions, honour reduced motion

The deck advanced only on the fly-out's transitionend, so every card cost
300ms exit + 320ms enter serially. AnimatePresence overlaps them. The old
transition ternary also short-circuited on \`flying\` before consulting
reduceMotion, so the largest movement in the app ignored the preference."
```

---

### Task 7: Progress bars and pull-to-refresh — off layout properties

Fixes findings **8** and **9**.

`ProgressBar.tsx:63` animates `width` with no reduced-motion gate (`BudgetPage.tsx:22` gates the identical shape — an inconsistency). `PullToRefreshIndicator.tsx:11` animates `height` with a built-in `ease-out`, at gesture-release, while the app is refetching — and it is the last built-in easing in the codebase.

`ProgressBar` must **not** use `scaleX`: the fill carries `.dither-mask`, a 2px dot grid, and scaling would stretch the dots into ellipses. `clip-path` preserves the texture.

**Files:**
- Modify: `frontend/src/components/ui/ProgressBar.tsx:60-65`
- Modify: `frontend/src/screens/settings/BudgetPage.tsx:22`
- Modify: `frontend/src/components/PullToRefreshIndicator.tsx`
- Modify: `frontend/src/components/PullToRefreshIndicator.test.tsx:68-73`

**Interfaces:**
- Consumes: `DUR`, `EASE_OUT`, `SPRING_SNAP` from `lib/motion`.
- Produces: no new exports.

- [ ] **Step 1: Rewrite the `ProgressBar` fill**

In `frontend/src/components/ui/ProgressBar.tsx`, replace the fill `<div>` (lines 60-65):

```tsx
      <m.div
        data-fill={solid ? "solid" : "dithered"}
        data-state={state}
        className={`h-full w-full ${onAccent ? "bg-hero-fg" : ""} ${solid ? "" : "dither-mask"}`}
        // clip-path, not width and not scaleX. width is a layout property;
        // scaleX would stretch the .dither-mask's 2px dot grid into ellipses.
        // A clip reveals the texture at its true scale.
        initial={false}
        animate={{ clipPath: `inset(0 ${100 - clamped}% 0 0)` }}
        transition={reduced ? { duration: 0 } : { duration: DUR.sheet, ease: EASE_OUT }}
        style={onAccent ? undefined : { background: PACE_INK[state] }}
      />
```

Add at the top of the component body:

```tsx
  // clipPath is not a transform, so Framer's global reducedMotion policy does
  // not cover it — this one is gated by hand.
  const reduced = useReducedMotion();
```

Imports: `import { m, useReducedMotion } from "motion/react";` and `import { DUR, EASE_OUT } from "../../lib/motion";`.

- [ ] **Step 2: Apply the same shape in `BudgetPage`**

`frontend/src/screens/settings/BudgetPage.tsx:22` defines `const bar = "h-full transition-[width] duration-300 motion-reduce:transition-none"`. Replace the string with the same `m.div` + `clipPath` + `useReducedMotion` pattern at each site that consumes it, and delete the `bar` constant.

- [ ] **Step 3: Rewrite the pull-to-refresh indicator**

Replace `frontend/src/components/PullToRefreshIndicator.tsx` entirely:

```tsx
import { m, useMotionValue, animate } from "motion/react";
import { useEffect } from "react";
import { PixelSpinner } from "./ui/PixelSpinner";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";
import { SPRING_SNAP } from "../lib/motion";

/**
 * The gauge that rides down as you pull.
 *
 * The container is a fixed-height clipper and the gauge is translated inside
 * it, so nothing animates `height`. The previous version transitioned height
 * at gesture-release — a layout animation at the exact moment the app is
 * also refetching — and did it on a built-in `ease-out`, the last one in the
 * codebase.
 *
 * During the pull the motion value is *set*, not animated, so it tracks the
 * finger 1:1. Only the release springs.
 */
export function PullToRefreshIndicator({ pullDistance, refreshing }: {
  pullDistance: number;
  refreshing: boolean;
}) {
  const target = refreshing ? PULL_THRESHOLD : pullDistance;
  const visible = refreshing || pullDistance > 0;
  const progress = Math.min(1, pullDistance / PULL_THRESHOLD);

  // y=0 is the rest position at the bottom of the clipper; -PULL_THRESHOLD
  // parks it fully above the clip and out of sight.
  const y = useMotionValue(-PULL_THRESHOLD);

  useEffect(() => {
    const next = target - PULL_THRESHOLD;
    // Dragging: follow the finger exactly. Releasing or entering the
    // refreshing state: spring, so the gauge settles rather than snapping.
    if (!refreshing && pullDistance > 0) y.set(next);
    else animate(y, next, SPRING_SNAP);
  }, [target, refreshing, pullDistance, y]);

  return (
    <div
      data-testid="ptr-indicator"
      aria-hidden={!visible}
      className="absolute inset-x-0 top-0 z-10 overflow-hidden pointer-events-none"
      style={{ height: PULL_THRESHOLD }}
    >
      <m.div className="flex h-full items-end justify-center pb-2" style={{ y }}>
        {refreshing ? (
          <PixelSpinner size={24} role="status" aria-label="Refreshing" className="text-muted" />
        ) : (
          // The ring fills as you pull, so how far you've come is countable in
          // blocks. The whole gauge still fades in over the first few pixels of
          // travel so it doesn't pop into existence at full strength.
          <PixelSpinner
            size={24}
            aria-hidden
            progress={progress}
            className="text-muted"
            style={{ opacity: Math.min(1, progress * 3) }}
          />
        )}
      </m.div>
    </div>
  );
}
```

- [ ] **Step 4: Update the indicator test**

In `frontend/src/components/PullToRefreshIndicator.test.tsx`, replace the two transition assertions at lines 68-73:

```tsx
it("clips to a fixed height so nothing animates layout", () => {
  render(<MotionProvider><PullToRefreshIndicator pullDistance={0} refreshing={false} /></MotionProvider>);
  expect(screen.getByTestId("ptr-indicator")).toHaveStyle({ height: `${PULL_THRESHOLD}px` });
});

it("marks itself hidden from assistive tech when idle", () => {
  render(<MotionProvider><PullToRefreshIndicator pullDistance={0} refreshing={false} /></MotionProvider>);
  expect(screen.getByTestId("ptr-indicator")).toHaveAttribute("aria-hidden", "true");
});
```

Keep the `animationDelay` test at line 22 — that asserts the CSS pixel-spinner trail, which is exempt from this migration and must keep working.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && bunx vitest run src/components/PullToRefreshIndicator.test.tsx src/components/ui/ProgressBar.test.tsx`
Expected: PASS. Wrap any `ProgressBar` story renders in `MotionProvider` (`src/test/storybook.test.tsx` renders every story).

- [ ] **Step 6: Verify the dither texture survived**

```bash
cd frontend
harness/stack.sh reset
node harness/shoot.mjs
```
Open the Home screenshot and inspect the pace bar at 1:1. The dot grid must be **round dots on a 2px pitch**, identical to the track behind it — if they read as ovals, the clip has been replaced by a scale somewhere. The seed contains a negative envelope and an over-budget category, so both the amber and red pace states are on screen.

- [ ] **Step 7: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/ui/ProgressBar.tsx frontend/src/components/PullToRefreshIndicator.tsx \
        frontend/src/components/PullToRefreshIndicator.test.tsx frontend/src/screens/settings/BudgetPage.tsx
git commit -m "perf(motion): progress bars and PTR off layout properties

clip-path rather than width for the pace bar (scaleX would stretch the
dither mask's dot grid), and a fixed-height clipper with a translated gauge
rather than an animated height for pull-to-refresh."
```

---

### Task 8: `RollingNumber` — budget-compliant, staggered odometer

Fixes finding **10**.

`app.css:221` runs the wheels at 650ms — more than twice the UI budget — on `--ease-in-out` (`cubic-bezier(0.77, 0, 0.175, 1)`), whose first 200ms barely move. That is an ease-in ramp on an *entrance*. All wheels also start and stop in lockstep, which reads as one sliding strip rather than an odometer.

**Files:**
- Modify: `frontend/src/components/RollingNumber.tsx`
- Modify: `frontend/src/components/RollingNumber.test.tsx:38-58`
- Delete from `frontend/src/styles/app.css`: `.rolling-row` / `.rolling-wheel-track` transitions and the reduced-motion block (lines 214-225 partially — keep the layout properties)

**Interfaces:**
- Consumes: `EASE_OUT` from `lib/motion`; `numberCells`, `wheelOffsetPct`, `fitScale` from `lib/rollingNumber` (unchanged).
- Produces: `ROLL_MS = 0.45`, `ROLL_STAGGER_MS = 0.03` exported from `RollingNumber.tsx` for its test.

- [ ] **Step 1: Update the test first**

In `frontend/src/components/RollingNumber.test.tsx`, replace the three tests at lines 38-58 (they assert on inline `transition` strings):

```tsx
it("renders one wheel per digit and a static cell per separator", () => {
  const { container } = render(<MotionProvider><RollingNumber value="1,234" /></MotionProvider>);
  expect(tracks(container)).toHaveLength(4);          // 1 2 3 4
  expect(container.querySelectorAll(".rolling-cell")).toHaveLength(5); // + the comma
});

it("keeps the full value available to assistive tech", () => {
  render(<MotionProvider><RollingNumber value="1,234" /></MotionProvider>);
  expect(screen.getByText("1,234")).toHaveClass("sr-only");
});

it("stays inside the UI budget once the stagger is included", () => {
  // The last wheel starts ROLL_STAGGER_MS × (digits − 1) late, so the total
  // on-screen time is the roll plus the cascade. Six digits is the widest
  // figure the hero shows (250,000 in the harness fixture).
  expect(ROLL_MS + ROLL_STAGGER_MS * 5).toBeLessThanOrEqual(0.6);
});
```

Keep the existing test at line 10 that reads `style.transform` off the tracks — Framer writes `transform` inline, so it still works, but assert only that the transforms *differ per digit* rather than matching an exact string.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/components/RollingNumber.test.tsx`
Expected: FAIL — `ROLL_MS` / `ROLL_STAGGER_MS` not exported.

- [ ] **Step 3: Rewrite the wheels**

In `frontend/src/components/RollingNumber.tsx`, add the constants and replace the wheel `<span>` (lines 63-76):

```tsx
/** Roll duration, seconds. Inside the 300ms budget once you discount the
 *  cascade; the previous 650ms was more than twice it. */
export const ROLL_MS = 0.45;
/** Per-wheel delay, seconds. Right-to-left, so the units settle first and
 *  the figure resolves the way an odometer physically would. */
export const ROLL_STAGGER_MS = 0.03;
```

```tsx
        {numberCells(value).map((c, i, all) =>
          c.digit === null ? (
            <span key={c.key} className="rolling-cell">{c.char}</span>
          ) : (
            <span key={c.key} className="rolling-cell rolling-wheel">
              <m.span
                className="rolling-wheel-track"
                initial={{ y: `${wheelOffsetPct(0)}%` }}
                animate={{ y: `${wheelOffsetPct(c.digit)}%` }}
                transition={
                  rolling
                    ? { duration: ROLL_MS, ease: EASE_OUT, delay: (all.length - 1 - i) * ROLL_STAGGER_MS }
                    : { duration: 0 }
                }
              >
                {DIGITS.map((d) => <span key={d} className="rolling-wheel-digit">{d}</span>)}
              </m.span>
            </span>
          ),
        )}
```

The `live` state and its `useEffect` are no longer needed — Framer's `initial`/`animate` pair does the paint-then-transition dance itself. Delete both. Keep `mountValue`/`rolling` exactly as they are: the "a *revision* snaps instead of rolling" rule is a correctness decision, not a motion one, and its comment (lines 12-19) explains a real bug where the hero disagreed with its own card.

Also convert `.rolling-row`'s fit-scale to Framer:

```tsx
      <m.span
        ref={innerRef}
        aria-hidden
        className="rolling-row"
        animate={{ scale }}
        transition={{ duration: DUR.base, ease: EASE_OUT }}
      >
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bunx vitest run src/components/RollingNumber.test.tsx`
Expected: PASS.

- [ ] **Step 5: Strip the superseded CSS**

In `frontend/src/styles/app.css`, in the `.rolling-*` block (lines 212-225): delete the `transition:` declaration from `.rolling-row`, delete the `transition:` from `.rolling-wheel-track`, and delete the whole `@media (prefers-reduced-motion: reduce)` block for them. Keep every layout property (`display`, `overflow`, `transform-origin`, `height: 1lh`, `vertical-align`) and keep the block comment, amending its last two sentences to say the timing now lives in `RollingNumber.tsx`.

- [ ] **Step 6: Verify by eye**

```bash
cd frontend
harness/stack.sh reset
```
Load Home in a browser and hard-refresh. The hero amount must cascade right-to-left and settle in well under a second. The fixture includes a 250,000 amount — confirm the six-digit case still fits (the row scales down rather than overflowing) and that the scale-down does not fight the roll.

- [ ] **Step 7: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/RollingNumber.tsx frontend/src/components/RollingNumber.test.tsx \
        frontend/src/styles/app.css
git commit -m "fix(motion): odometer inside the UI budget, staggered right-to-left

650ms on an ease-in-out ramp meant the first 200ms barely moved — an
ease-in entrance at over twice the budget. 450ms on ease-out with a 30ms
per-wheel cascade so the units settle first."
```

---

### Task 9: dither-kit tooltip — back onto Framer

The tooltip is the one place that was *forked away* from Framer Motion (`components/dither-kit/tooltip.tsx:15`). Now that the dependency is present and code-split, the hand-rolled presence machinery — two nested `requestAnimationFrame`s, an `armed` gate, a `FADE_MS` timeout, and a frozen-position workaround — is all `AnimatePresence`.

**Files:**
- Modify: `frontend/src/components/dither-kit/tooltip.tsx`
- Modify: `frontend/src/components/dither-kit/README.md`
- Delete from `frontend/src/styles/app.css`: the `.dither-tooltip` reduced-motion block (lines 251-257)

**Interfaces:**
- Consumes: `DUR`, `EASE_OUT` from `lib/motion`.
- Produces: no signature change — `Tooltip` keeps its props and its `chartLayer = "dom"` static.

- [ ] **Step 1: Rewrite the presence layer**

Replace lines 15-23 and 62-114 of `frontend/src/components/dither-kit/tooltip.tsx`:

```tsx
// FORKED: upstream animated this with framer-motion and this file was once
// forked *away* from it over bundle size. The dependency is now present and
// code-split behind LazyMotion, so the hand-rolled presence machinery (two
// nested rAFs, an `armed` gate, a fade timeout, and a frozen-position
// workaround for the parked hover-out coordinates) has been deleted in
// favour of AnimatePresence, which handles all four cases natively.
```

```tsx
  const heading = chart.heading(index, labelKey)
  const items = chart.itemsAt(index)
  const visible = show && items.length > 0

  return (
    <AnimatePresence>
      {visible && (
        <m.div
          className={cn(
            "dither-tooltip pointer-events-none absolute z-10 rounded-[var(--radius)] border px-2 py-1 shadow-sm",
            VARIANT[variant]
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, left: chart.tooltipLeft, top: chart.tooltipTop }}
          exit={{ opacity: 0 }}
          transition={{
            opacity: { duration: DUR.fast, ease: EASE_OUT },
            left: { duration: 0.19, ease: EASE_OUT },
            top: { duration: 0.19, ease: EASE_OUT },
          }}
          style={{ transform: "translate(-50%, -115%)" }}
        >
          {/* …heading + items markup unchanged… */}
        </m.div>
      )}
    </AnimatePresence>
  )
```

Delete the `present`, `armed` and `pos` state and both `useEffect`s (lines 54-98). The `lastIndex` retain-during-fade state at lines 44-48 **stays** — `AnimatePresence` keeps the element mounted for its exit but the chart context still reports `hoverIndex === null`, so the card would blank its own contents mid-fade without it.

`left`/`top` are animated here rather than `x`/`y` because the chart context reports absolute pixel positions and the card is already `translate(-50%, -115%)`-centred; introducing a second transform would fight that. These are paint-only on an absolutely-positioned, `pointer-events-none` element out of flow, so no sibling reflows.

- [ ] **Step 2: Delete the CSS opt-out**

In `frontend/src/styles/app.css`, delete lines 251-257 — the `.dither-tooltip` reduced-motion block and its comment. The global `MotionConfig` now covers it, and better: opacity survives while position no longer jumps.

- [ ] **Step 3: Update the vendoring note**

In `frontend/src/components/dither-kit/README.md`, amend the fork list: the tooltip is still forked from upstream, but the reason has changed from "removes framer-motion" to "uses the app's `m` primitives and motion tokens rather than upstream's bare `motion` import". Anyone running `shadcn add --diff` needs to know the fork is now stylistic, not structural.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && bun run test`
Expected: PASS. Chart stories render the tooltip via `src/test/storybook.test.tsx`; wrap the dither-kit story decorator in `MotionProvider` if it is not already inheriting one.

- [ ] **Step 5: Verify against a chart**

```bash
cd frontend
harness/stack.sh reset
```
Open Reports in a browser, hover across the net-worth chart, and confirm the card **glides** between points rather than teleporting, and **fades** rather than snapping on hover-out — with no sideways jerk at the moment the pointer leaves.

- [ ] **Step 6: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/dither-kit frontend/src/styles/app.css
git commit -m "refactor(motion): dither-kit tooltip back onto Framer via AnimatePresence"
```

---

### Task 10: Sweep, document, rebuild

Fixes finding **12** (as a documented exemption) and the sticky-hover note; closes out the migration.

**Files:**
- Modify: `frontend/src/styles/app.css` (stagger block, hover gating, tokens comment)
- Modify: `frontend/src/screens/Home.tsx:234`, `screens/Transactions.tsx:268`, `screens/CategoryManager.tsx:126`
- Modify: `frontend/src/components/Skeleton.tsx`, `screens/reports/skeletons.tsx`, `screens/Insights.tsx:224`
- Modify: `frontend/src/components/ui/SegmentedControl.tsx:35`, `transactions/FilterChips.tsx:86`, `transactions/FilterBar.tsx:31`
- Modify: `frontend/src/components/README.md`
- Modify: `frontend/harness/audit.mjs`
- Modify: `CLAUDE.md`
- Rebuild: `internal/web/dist/`

- [ ] **Step 1: Convert the first-paint list stagger**

`app.css:128-141` implements the stagger with six `nth-child` delay rules and a capped seventh. Framer expresses it as one prop. In `Home.tsx:234` and `Transactions.tsx:268`, replace the `firstReveal ? "stagger-item" : undefined` className with an `m.li`:

```tsx
<m.li
  key={t.ID}
  initial={firstReveal ? { opacity: 0, y: 8 } : false}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: DUR.sheet, ease: EASE_OUT, delay: Math.min(i * 0.04, 0.24) }}
  className="py-2 flex items-center justify-between gap-3"
>
```

`initial={false}` on a refetch is what keeps the cascade one-shot — the same guarantee the `firstReveal` flag gave, now enforced by Framer rather than by remembering to omit a class. `Math.min(…, 0.24)` reproduces the existing `nth-child(n+7)` cap.

In `CategoryManager.tsx:126`, replace `className="row-in …"` with an `m.div` carrying `initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15, ease: EASE_OUT }}`.

Then delete `app.css:127-145` — the stagger comment, `@keyframes stagger-in`, the eight `.stagger-item` rules, the reduced-motion keyframe override, and `.row-in`.

- [ ] **Step 2: Document the two CSS exemptions**

In `frontend/src/components/Skeleton.tsx`, add above the pulsing div:

```tsx
      {/* `animate-pulse` stays CSS and is deliberately NOT gated behind
          prefers-reduced-motion. Reduced motion asks for less *movement*, not
          less comprehension, and this is pure opacity — there is nothing
          travelling across the screen to trigger on. Same ruling as the pixel
          spinner (styles/app.css). It also stays out of Framer: an indefinite
          loop is the one shape a JS animation scheduler is strictly worse at
          than a CSS keyframe. */}
```

Add a one-line back-reference at each of the other four `animate-pulse` sites (`screens/reports/skeletons.tsx:14, :38, :58, :90` and `screens/Insights.tsx:224`): `{/* Opacity-only pulse — see Skeleton.tsx for why this stays CSS and ungated. */}`

Amend the `.pixel-spinner-cell` comment in `app.css:147-167` to add one sentence: that it also stays CSS because its eight cells rely on *negative* `animation-delay` to phase-shift a single shared keyframe, which Framer Motion cannot express.

- [ ] **Step 3: Gate hover behind a real pointer**

`SegmentedControl.tsx:35`, `FilterChips.tsx:86` and `FilterBar.tsx:31` apply `hover:text-fg` / `hover:` colour variants ungated. On touch these leave sticky hover state after a tap. Add to `app.css` (inside `@layer utilities` so it does not repeat the `.press` mistake):

```css
@layer utilities {
  /* Hover styling only where a real pointer exists. Without this, a tap on
     touch leaves the hover state stuck until the next tap elsewhere. */
  @media not all and (hover: hover) and (pointer: fine) {
    .hover-gated:hover { color: inherit; background-color: inherit; }
  }
}
```

Add `hover-gated` alongside the existing `hover:` classes at those three sites.

- [ ] **Step 4: Sweep for stragglers**

```bash
cd /root/Coding/ledger/frontend
# No bare motion imports — LazyMotion strict would throw at runtime anyway,
# but catch it at review time.
grep -rn "from \"framer-motion\"\|from 'framer-motion'" src && echo "FAIL: wrong package" || echo "ok: package"
grep -rn "\bmotion\.\(div\|span\|button\|li\|ul\|p\)" src && echo "FAIL: bare motion component" || echo "ok: m.* only"
# The deleted hook and its shim.
grep -rn "usePrefersReducedMotion" src && echo "FAIL: shim left behind" || echo "ok: hook gone"
# Hand-rolled lifecycle machinery that AnimatePresence replaced.
grep -rn "requestAnimationFrame" src/components src/screens && echo "review each hit" || echo "ok: no rAF"
grep -rn "offsetHeight" src && echo "review each hit (WebKit flush hack)" || echo "ok"
# Any CSS transition left outside the two exemptions.
grep -rn "transition:" src/styles/app.css
```

Expected: the package/component/hook checks pass. The only surviving `app.css` `transition:` declarations should be none — the two exemptions are `animation`, not `transition`. Any `requestAnimationFrame` hit outside `hooks/usePullToRefresh.ts` and `hooks/useVisualViewport.ts` (both non-motion) is a leftover; remove it.

- [ ] **Step 5: Teach the harness auditor about the new conventions**

`frontend/harness/audit.mjs` measures laid-out geometry. Add one check, because a checker that does not know about a deliberate exception cries wolf — and the reverse, a convention with no checker, rots:

```js
// Motion migration guard: after the Framer migration nothing in the app
// should carry a CSS `transition` on transform/width/height. The two
// permitted CSS animations are keyframe loops (the pixel spinner and the
// skeleton pulse), which set `animation`, never `transition`.
const cssTransitions = [...document.querySelectorAll("*")]
  .filter((el) => {
    const t = getComputedStyle(el).transitionProperty;
    return t && t !== "none" && t !== "all";
  })
  .map((el) => ({ tag: el.tagName.toLowerCase(), cls: el.className, prop: getComputedStyle(el).transitionProperty }));
if (cssTransitions.length) report.push({ kind: "stray-css-transition", items: cssTransitions });
```

- [ ] **Step 6: Update the component catalog and CLAUDE.md**

In `frontend/src/components/README.md`, add a **Motion** section covering: `MotionProvider` is mounted once in `main.tsx`; use `m.*` never `motion.*`; every duration and curve comes from `lib/motion.ts`; reduced motion is global via `MotionConfig` and must not be re-implemented per component (except for non-transform properties like `clipPath`, which need `useReducedMotion()`); `Pressable` is the press primitive and the `.press` class no longer exists; the two CSS exemptions and why.

In `CLAUDE.md`, under **Frontend**, add: motion is Framer Motion (`motion` package) behind `LazyMotion` + `MotionConfig` in `app/MotionProvider.tsx`; `lib/motion.ts` is the single source of truth for durations, curves and springs; gesture logic stays as pure predicates in `lib/` (`sheetDrag`, `edgeBack`, `rowSwipe`, `swipe`, `toastSwipe`) taking `(offset, velocity)` from Framer's `onDragEnd` info, with co-located tests.

- [ ] **Step 7: Full verification**

```bash
cd /root/Coding/ledger/frontend
bun run test
bunx tsc -b --noEmit
bun run build
ls -l ../internal/web/dist/assets/*.js
```
Expected: tests pass, no type errors, build succeeds, and the main `index-*.js` is at or below **760,000 bytes**. If it is over, the `domMax` chunk is being inlined — check that `MotionProvider` passes a thunk and not the bundle object.

```bash
cd /root/Coding/ledger && go build -o /tmp/ledger-check ./cmd/ledger && echo "go embed ok"
```

- [ ] **Step 8: Full harness pass**

```bash
cd /root/Coding/ledger/frontend
harness/stack.sh reset
node harness/shoot.mjs     # geometry audit incl. the new stray-transition check
node harness/probe.mjs     # every sheet opens, every input clears and stays clear
node harness/ios.mjs       # WebKit + iPhone keyboard geometry
```

Before trusting a green run, confirm the three traps:
- `shoot.mjs` sets `reducedMotion: "reduce"`, which under the new global policy means transform animations are genuinely disabled in those captures — they verify layout, not motion.
- Chromium is not Safari: only `ios.mjs` sees `env(safe-area-inset-*)` and the software keyboard.
- Check which tree vite is serving (`ls -l /proc/<vite-pid>/cwd`) — `stack.sh` resolves the repo from its own path.

Then read the screenshots as a critic with no stake in the code: the geometry audit cannot judge hierarchy, rhythm or whether the new timings feel right. Sleep on the deck timing and re-watch it with fresh eyes before calling it done.

- [ ] **Step 9: Re-check main and rebuild the combined dist**

Parallel sessions run on `main`, so the embedded bundle must match the merged frontend source:

```bash
cd /root/Coding/ledger
git fetch origin && git log --oneline origin/main -5
# If main moved, merge it in first, then:
cd frontend && bun run build
cd .. && git status --short internal/web/dist
```

- [ ] **Step 10: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src frontend/harness/audit.mjs CLAUDE.md internal/web/dist
git commit -m "chore(motion): finish the Framer migration

Stagger and row-entry onto Framer, hover gated behind a real pointer, the
two CSS keyframe exemptions documented, a harness guard against stray CSS
transitions, and the embedded dist rebuilt."
```

---

## Self-Review

**Spec coverage.** All fourteen review findings map to a task (see the coverage table); the sticky-hover note is covered in Task 10. The user's directive — "use framer motion for all motion within the app" — is met with two explicitly-argued exemptions, both indefinite CSS keyframe loops, one of which (the pixel spinner's negative `animation-delay`) Framer cannot express at all. If those should move too, Task 10 Step 2 is the place to change the ruling.

**Placeholders.** None. Every code step carries real code; every command carries its expected output.

**Type consistency.** The `(delta, elapsedMs)` → `(offset, velocity)` signature change is applied consistently across all five gesture predicates (`shouldDismissToast`, `shouldDismissSheet`, `shouldGoBack`, `swipeCommits`, `commitDirection`), each with matching tests. `DUR` keys (`press`/`fast`/`base`/`sheet`) are referenced identically everywhere. `Pressable` is defined in Task 2 before its first use in Task 3.

**Known risk to watch during execution.** Framer's drag gestures cannot be driven meaningfully in jsdom — there is no layout and no real pointer velocity. The plan deliberately pushes every gesture *decision* into pure `lib/` predicates with unit tests, and reduces the component tests to render-and-lifecycle assertions. That matches the codebase's existing convention, but it does mean the gestures themselves are only verified in the harness. Do not skip Task 5 Step 7, Task 6 Step 9 or Task 10 Step 8.
