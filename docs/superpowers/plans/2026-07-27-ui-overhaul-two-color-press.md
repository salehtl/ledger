# UI Overhaul: Two-Color Press — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Material-derived visual language with a two-ink press identity — paper + black + one vermilion spot, Geist typography, hairlines instead of elevation, and dither density rather than hue for the 50/30/20 buckets.

**Architecture:** Token values change first so the whole app re-skins in one commit without touching 81 files' class names. Structural changes (elevation, radius, chrome) follow. The density signature lands last, as a per-segment bias on `DitherFill`'s existing Bayer threshold.

**Tech Stack:** React 19, TypeScript, Tailwind v4 (CSS-first `@theme`), Vite, vitest + Testing Library, canvas 2D.

**Spec:** `docs/superpowers/specs/2026-07-27-ui-overhaul-design.md`

## Global Constraints

- **Keep token names, change values.** `--color-bg`, `--color-fg`, `--color-muted`, `--color-border`, `--color-accent`, `--color-accent-fg` keep their names. `text-muted` alone appears 122 times across 81 files; renaming buys nothing.
- **Light palette:** paper `#f2f1ef`, ink `#16161a`, ink-muted `#5e5e63`, rule `#d6d5d1`, track `#e3e2de`, spot `#d8452c`, spot-fg `#ffffff`.
- **Dark palette (D1):** paper `#141416`, ink `#ecebe8`, ink-muted `#8b8b8f`, rule `#2b2b2f`, track `#232326`, spot `#d8452c`, spot-fg `#ffffff`.
- **In dark, `#d8452c` is a fill only — never text.** It is ~4.1:1 on `#141416`, under AA. The one place red text is allowed in dark is `.money-neg`, which uses the lifted tint `--color-bad: #f0866f` (~7.4:1). Any other red label in dark is a bug, and the lifted tint must never be used as a fill.
- **Red is rationed.** Primary action, create plate, active-tab marker, review badge. Nowhere else.
- **Radius:** `--radius-card` → `3px`. `--radius-sheet` stays `12px`.
- **One shadow in the app**, used by `Dialog` only.
- **Unchanged:** `.press`, 44px targets (and the sanctioned 36px exceptions), 16px inputs, haptics via `lib/feedback`, `.tnum`, Dialog-only overlays, swipe geometry, all component APIs except `Pill`'s `Tone` union.
- Every task must leave `bun run test` and `tsc -b` green. Run from `frontend/`.
- `frontend/src/components/README.md` is the UI catalog. Update it in the same commit as any shared-component change.

---

### Task 1: Geist typography

**Files:**
- Modify: `frontend/package.json` (deps)
- Modify: `frontend/src/main.tsx:1-2`
- Modify: `frontend/src/styles/app.css:33-38` (font tokens), `:37` (`--font-rounded`)
- Modify: `frontend/src/components/swipe/SwipeDeck.tsx:278`, `frontend/src/components/swipe/SwipeCard.tsx:187`

**Interfaces:**
- Produces: `--font-sans` = Geist Variable, `--font-mono` = Geist Mono Variable. `--font-rounded` no longer exists.

- [ ] **Step 1: Swap the font packages**

```bash
cd frontend
bun remove @fontsource-variable/inter @fontsource-variable/roboto-mono
bun add @fontsource-variable/geist @fontsource-variable/geist-mono
```

- [ ] **Step 2: Update the imports**

In `frontend/src/main.tsx`, replace lines 1–2 with:

```ts
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
```

- [ ] **Step 3: Update the font tokens**

In `frontend/src/styles/app.css`, replace the `--font-sans`, `--font-rounded` and `--font-mono` declarations with:

```css
  --font-sans: "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  /* Monospaced figures — money, counts, percentages, labels, dates (via .tnum
     and directly). Geist Mono does far more than figures in this design: every
     non-prose string is mono. */
  --font-mono: "Geist Mono Variable", ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
```

Delete the `--font-rounded` line and its two-line comment entirely.

- [ ] **Step 4: Retire the rounded face at its two call sites**

`frontend/src/components/swipe/SwipeDeck.tsx:278` — replace `font-rounded` with `tnum`:

```tsx
          <p className="tnum font-bold text-fg leading-none" style={{ fontSize: '2rem' }}>{remaining}</p>
```

`frontend/src/components/swipe/SwipeCard.tsx:187` — replace `font-rounded` with `tnum` and drop the now-redundant `tabular-nums` (`.tnum` already sets `font-variant-numeric: tabular-nums`):

```tsx
            className="tnum font-bold leading-none"
```

- [ ] **Step 5: Verify nothing still references the removed token**

Run: `cd frontend && grep -rn "font-rounded\|roboto-mono\|fontsource-variable/inter" src/ package.json`
Expected: no output.

- [ ] **Step 6: Run the suite**

Run: `cd frontend && bun run test && bunx tsc -b`
Expected: PASS. Snapshot/class assertions naming `font-rounded` will fail here — update them to `tnum`.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/bun.lock frontend/src/main.tsx frontend/src/styles/app.css frontend/src/components/swipe/
git commit -m "style(type): Geist + Geist Mono, retire the rounded face"
```

---

### Task 2: Token values

The single highest-leverage commit: every `bg-surface`, `text-muted`, `bg-accent` in the app re-skins at once because only the values change.

**Files:**
- Modify: `frontend/src/styles/app.css` (the `@theme` block and the `prefers-color-scheme: dark` block)

**Interfaces:**
- Produces: the light and dark palettes above, bound to the existing token names.

- [ ] **Step 1: Rewrite the light `@theme` colour block**

Replace the colour declarations in `@theme` (leave fonts and radii for now) with:

```css
  /* Two-color press: paper, ink, one vermilion spot. Named roles are kept from
     the previous Material palette so no utility class has to change; only the
     values are new. See docs/superpowers/specs/2026-07-27-ui-overhaul-design.md */
  --color-bg: #f2f1ef;          /* paper */
  --color-surface: #f2f1ef;     /* same paper — the tonal ladder is gone */
  --color-surface-2: #e3e2de;   /* track: progress/dither backing only */
  --color-border: #d6d5d1;      /* hairline rule */
  --color-fg: #16161a;          /* ink */
  --color-muted: #5e5e63;       /* ink, low emphasis */

  --color-accent: #d8452c;      /* the one spot ink */
  --color-accent-fg: #ffffff;

  --color-hero: #16161a;        /* hero panel prints in ink, not in spot */
  --color-hero-fg: #f2f1ef;

  /* Bucket hues are retired — buckets are encoded by dither density (Task 9).
     These resolve to ink so any un-migrated call site degrades to legible
     monochrome rather than to an undefined colour. */
  --color-need: #16161a;
  --color-want: #16161a;
  --color-save: #16161a;

  /* Semantic colours are retired — over-budget is a texture change. `bad` keeps
     a red because negative money still reads as red in .money-neg, and that is
     the one semantic use that survives. */
  --color-good: #16161a;
  --color-warn: #5e5e63;
  --color-bad: #d8452c;

  /* shadcn token names, aliased onto our palette — dither-kit's vendored chrome
     (tooltip, axes, grid) is written against these. */
  --color-foreground: #16161a;
  --color-muted-foreground: #5e5e63;
  --color-popover: #f2f1ef;
  --color-popover-foreground: #16161a;
```

- [ ] **Step 2: Rewrite the dark override block**

Replace the body of `@media (prefers-color-scheme: dark) { :root { … } }` with:

```css
    --color-bg: #141416;
    --color-surface: #141416;
    --color-surface-2: #232326;
    --color-border: #2b2b2f;
    --color-fg: #ecebe8;
    --color-muted: #8b8b8f;

    /* Spot stays #d8452c in dark. It is ~4.1:1 on this ground — legal as a fill
       behind white, under AA as text. Never use it for a label in dark. */
    --color-accent: #d8452c;
    --color-accent-fg: #ffffff;

    --color-hero: #ecebe8;
    --color-hero-fg: #141416;

    --color-need: #ecebe8;
    --color-want: #ecebe8;
    --color-save: #ecebe8;

    --color-good: #ecebe8;
    --color-warn: #8b8b8f;
    /* The spot ink has two values in dark, the way a press runs a tint of the
       same plate: #d8452c is the FILL (behind white), #f0866f is the TEXT tint.
       .money-neg paints negative amounts with this token, and #d8452c would be
       ~4.1:1 here — under AA. #f0866f is ~7.4:1. Never widen this to fills. */
    --color-bad: #f0866f;

    --color-foreground: #ecebe8;
    --color-muted-foreground: #8b8b8f;
    --color-popover: #141416;
    --color-popover-foreground: #ecebe8;
```

- [ ] **Step 3: Realign the dither seeds to the new palette**

In `frontend/src/components/dither-kit/palette.ts`, replace both tables. The seven `DitherColor` keys and the `Seed` shape stay intact per the fork's contract; only the RGB values change. Buckets now differ by density, not hue, so they share the ink seed.

```ts
/** Light theme — values are the `@theme` tokens in styles/app.css. */
export const PALETTE_LIGHT: Record<DitherColor, Seed> = {
  blue: light([22, 22, 26]),      // --color-need   ink
  purple: light([22, 22, 26]),    // --color-want   ink
  green: light([22, 22, 26]),     // --color-save   ink
  red: light([216, 69, 44]),      // --color-bad    #d8452c
  orange: light([94, 94, 99]),    // --color-warn   #5e5e63
  pink: light([216, 69, 44]),     // --color-accent #d8452c
  grey: light([94, 94, 99]),      // --color-muted  #5e5e63
};

/** Dark theme — values are the prefers-color-scheme: dark overrides. */
export const PALETTE_DARK: Record<DitherColor, Seed> = {
  blue: dark([236, 235, 232]),    // --color-need   ink
  purple: dark([236, 235, 232]),  // --color-want   ink
  green: dark([236, 235, 232]),   // --color-save   ink
  red: dark([216, 69, 44]),       // --color-bad    #d8452c
  orange: dark([139, 139, 143]),  // --color-warn   #8b8b8f
  pink: dark([216, 69, 44]),      // --color-accent #d8452c
  grey: dark([139, 139, 143]),    // --color-muted  #8b8b8f
};
```

- [ ] **Step 4: Run the suite**

Run: `cd frontend && bun run test && bunx tsc -b`
Expected: PASS. `dither-kit/palette.test.ts` asserts against seed values — update its expectations to the values above.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles/app.css frontend/src/components/dither-kit/palette.ts frontend/src/components/dither-kit/palette.test.ts
git commit -m "style(tokens): two-color press palette, light and dark"
```

---

### Task 3: Kill elevation, tighten radius

**Files:**
- Modify: `frontend/src/styles/app.css` (`.shadow-1`, `--radius-card`)
- Modify: every file using `shadow-1` (8 occurrences) except `Dialog.tsx`

**Interfaces:**
- Produces: `.shadow-1` exists but is used only by `Dialog`. `--radius-card` is `3px`.

- [ ] **Step 1: Find every elevation user**

Run: `cd frontend && grep -rn "shadow-1" src/`
Record the list. `Dialog.tsx` is the only one that keeps it.

- [ ] **Step 2: Retighten the radius token**

In `app.css`:

```css
  --radius-card: 3px;           /* print-tight; was 8px Material "large" */
  --radius-sheet: 12px;         /* sheets stay iOS-round for drag-to-dismiss */
```

- [ ] **Step 3: Rewrite the shadow rule as Dialog-only**

```css
/* The one shadow in the app. A sheet must read as above the page; nothing else
   is elevated — separation everywhere else is a 1px --color-border hairline. */
.shadow-1 {
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.10);
}
```

- [ ] **Step 4: Strip `shadow-1` from every non-Dialog call site**

For each file from Step 1 except `Dialog.tsx`, remove the `shadow-1` class. Where it was the only thing separating a surface from the page, add `border border-border` in its place. `Card.tsx` is the main one — it becomes paper bounded by a rule:

```tsx
className={`bg-surface rounded-[var(--radius-card)] border border-border p-4 ${className}`}
```

- [ ] **Step 5: Verify only Dialog is elevated**

Run: `cd frontend && grep -rn "shadow-1" src/`
Expected: matches in `styles/app.css` and `components/ui/Dialog.tsx` only.

- [ ] **Step 6: Run the suite and commit**

```bash
cd frontend && bun run test && bunx tsc -b
git add frontend/src/
git commit -m "style(surfaces): hairlines replace elevation, radius 8px to 3px"
```

---

### Task 4: ProgressBar tone becomes density

**Files:**
- Modify: `frontend/src/components/ui/ProgressBar.tsx`
- Test: `frontend/src/components/ui/ProgressBar.test.tsx` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `ProgressBar` keeps its full prop signature `{ pct, label, pace, tone, onAccent }`. `Tone` stays `"good" | "warn" | "bad"` so no call site changes; the tones now select *fill treatment*, not colour.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar";

test("a bucket under budget renders a dithered fill", () => {
  render(<ProgressBar pct={0.5} label="Needs" />);
  const fill = screen.getByRole("progressbar").querySelector("[data-fill]");
  expect(fill).toHaveAttribute("data-fill", "dithered");
});

test("a bucket at or over budget fills solid — over is a texture change, not a colour change", () => {
  render(<ProgressBar pct={1.12} label="Wants" />);
  const fill = screen.getByRole("progressbar").querySelector("[data-fill]");
  expect(fill).toHaveAttribute("data-fill", "solid");
});

test("an explicit tone still overrides the automatic one", () => {
  render(<ProgressBar pct={0.2} label="Saving" tone="bad" />);
  const fill = screen.getByRole("progressbar").querySelector("[data-fill]");
  expect(fill).toHaveAttribute("data-fill", "solid");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && bunx vitest run src/components/ui/ProgressBar.test.tsx`
Expected: FAIL — no `data-fill` attribute.

- [ ] **Step 3: Implement**

Replace the body of `ProgressBar.tsx` with:

```tsx
type Tone = "good" | "warn" | "bad";

/**
 * pct is a fraction (0..1+). Over budget is a *texture* change, not a colour
 * change: under budget the fill is dithered, at or over it fills to solid ink.
 * The `tone` prop still overrides the automatic reading (e.g. to mark by
 * projection rather than spend); "bad" means solid. An optional `pace` fraction
 * draws a vertical "today" marker. `onAccent` styles the track for the hero.
 */
export function ProgressBar({ pct, label, pace, tone, onAccent = false }: {
  pct: number; label?: string; pace?: number; tone?: Tone; onAccent?: boolean;
}) {
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const auto: Tone = pct >= 1.0 ? "bad" : pct >= 0.8 ? "warn" : "good";
  const solid = (tone ?? auto) === "bad";
  const track = onAccent ? "bg-white/25" : "bg-surface-2";
  const marker = onAccent ? "bg-white" : "bg-fg/70";
  const ink = onAccent ? "bg-white" : "bg-fg";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`relative h-3 w-full overflow-hidden rounded-[var(--radius-card)] ${track}`}
    >
      <div
        data-fill={solid ? "solid" : "dithered"}
        className={`h-full transition-[width] duration-300 ${ink} ${solid ? "" : "dither-mask"}`}
        style={{ width: `${clamped}%` }}
      />
      {pace !== undefined && (
        <div
          data-pace
          aria-hidden
          className={`absolute top-0 bottom-0 w-0.5 ${marker}`}
          style={{ left: `${Math.min(100, Math.max(0, pace * 100))}%` }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the CSS dither mask**

The bar is a DOM element, not a canvas, so the texture is a mask. Append to `app.css`:

```css
/* A CSS stand-in for the canvas dither, for DOM fills (ProgressBar). Two
   alpha tiers on a 2px grid, matching dither-paint's OFF_TIER relationship —
   a family resemblance to the canvas, not a pixel match. */
.dither-mask {
  -webkit-mask-image: radial-gradient(circle at 50% 50%, #000 0.6px, rgb(0 0 0 / 0.4) 0.7px);
  mask-image: radial-gradient(circle at 50% 50%, #000 0.6px, rgb(0 0 0 / 0.4) 0.7px);
  -webkit-mask-size: 2px 2px;
  mask-size: 2px 2px;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && bunx vitest run src/components/ui/ProgressBar.test.tsx && bun run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ui/ProgressBar.tsx frontend/src/components/ui/ProgressBar.test.tsx frontend/src/styles/app.css
git commit -m "feat(ui): ProgressBar signals over-budget by texture, not colour"
```

---

### Task 5: Pill tones collapse

**Files:**
- Modify: `frontend/src/components/ui/Pill.tsx`
- Modify: `frontend/src/components/ui/Pill.test.tsx`
- Modify: every `Pill` call site passing `good` / `warn` / `neutral`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type Tone = "default" | "muted" | "attention"`. This is the one breaking API change in the plan.

- [ ] **Step 1: Find the call sites**

Run: `cd frontend && grep -rn "<Pill" src/`
Record each `tone` value in use.

- [ ] **Step 2: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { Pill } from "./Pill";

test("attention is the only tone that spends the spot ink", () => {
  render(<Pill tone="attention">Needs review</Pill>);
  expect(screen.getByText("Needs review").className).toContain("bg-accent");
});

test("default and muted print in ink only", () => {
  render(<><Pill>Cleared</Pill><Pill tone="muted">Archived</Pill></>);
  expect(screen.getByText("Cleared").className).not.toContain("accent");
  expect(screen.getByText("Archived").className).toContain("text-muted");
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd frontend && bunx vitest run src/components/ui/Pill.test.tsx`
Expected: FAIL — `"attention"` is not assignable to the current `Tone`.

- [ ] **Step 4: Implement**

```tsx
import type { ReactNode } from "react";

/**
 * Small inline status badge. Colour no longer carries status — the label does.
 * Only `attention` spends the spot ink, and red is rationed app-wide, so use it
 * for the one status that should pull the eye (needs review), never for routine
 * states.
 */
export type Tone = "default" | "muted" | "attention";

const TONES: Record<Tone, string> = {
  default: "text-fg border border-border",
  muted: "text-muted border border-border",
  attention: "bg-accent text-accent-fg",
};

export function Pill({ tone = "default", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-[var(--radius-card)] px-2.5 py-1 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}
```

- [ ] **Step 5: Migrate the call sites**

Map old → new: `bad` → `attention`; `warn` → `attention`; `good` → `default`; `neutral` → `default`; `muted` → `muted`. Where two adjacent pills would both become `attention`, keep only the more urgent one as `attention` and demote the other to `default` — red is rationed.

- [ ] **Step 6: Run the suite**

Run: `cd frontend && bun run test && bunx tsc -b`
Expected: PASS. `tsc` is the safety net here — it flags every unmigrated `tone` value.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/
git commit -m "feat(ui): Pill tones collapse to ink, muted and one attention"
```

---

### Task 6: FAB becomes a squared plate

**Files:**
- Modify: `frontend/src/components/ui/Fab.tsx`
- Modify: `frontend/src/components/ui/Fab.test.tsx`

**Interfaces:**
- Produces: `Fab` keeps its exact props `{ icon, label, onClick }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { Fab } from "./Fab";

test("the plate is square, shadowless and flush to the content margin", () => {
  render(<Fab icon={Plus} label="Add transaction" onClick={() => {}} />);
  const el = screen.getByLabelText("Add transaction");
  expect(el.className).not.toContain("shadow-1");
  expect(el.className).not.toContain("rounded-lg");
  expect(el.className).toContain("rounded-[var(--radius-card)]");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && bunx vitest run src/components/ui/Fab.test.tsx`
Expected: FAIL — still `rounded-lg shadow-1`.

- [ ] **Step 3: Implement**

```tsx
import type { LucideIcon } from "lucide-react";
import { fire } from "../../lib/feedback";

/**
 * The screen's single creation action: a square vermilion plate above the bottom
 * nav, flush to the 16px content margin. Deliberately not elevated — nothing in
 * this design floats. If it needs separating from content beneath it, that is a
 * layout problem, not an elevation problem.
 */
export function Fab({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => { fire("selection"); onClick(); }}
      className="press fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-[var(--radius-card)] bg-accent text-accent-fg hover:opacity-90 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)]"
    >
      <Icon size={24} aria-hidden />
    </button>
  );
}
```

- [ ] **Step 4: Run and commit**

```bash
cd frontend && bunx vitest run src/components/ui/Fab.test.tsx && bun run test
git add frontend/src/components/ui/Fab.tsx frontend/src/components/ui/Fab.test.tsx
git commit -m "feat(ui): FAB becomes a squared, shadowless plate"
```

---

### Task 7: BottomNav hairline and tick marker

**Files:**
- Modify: `frontend/src/components/ui/BottomNav.tsx`
- Modify: `frontend/src/components/ui/BottomNav.test.tsx`

**Interfaces:**
- Produces: `BottomNav` keeps its props and its five tabs.

The current component marks the active tab with a literal *"Material active-indicator pill"* (`bg-accent/10` behind the icon) and `text-accent` on the label. Both go: `text-accent` in dark is sub-AA, and the pill is the Material tell.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { TABS } from "../../app/nav";
import { BottomNav } from "./BottomNav";

test("the active tab is marked by a spot tick, not a filled pill", () => {
  render(<BottomNav active={TABS[0].id} reviewCount={0} onNavigate={() => {}} />);
  const active = screen.getByRole("button", { current: "page" });
  expect(active.querySelector("[data-active-tick]")).not.toBeNull();
  expect(active.innerHTML).not.toContain("bg-accent/10");
  expect(active.className).not.toContain("text-accent");
});

test("the review badge spends the spot ink", () => {
  render(<BottomNav active={TABS[0].id} reviewCount={3} onNavigate={() => {}} />);
  expect(screen.getByText("3").className).toContain("bg-accent");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && bunx vitest run src/components/ui/BottomNav.test.tsx`
Expected: FAIL — no `data-active-tick`, and the active label still carries `text-accent`.

- [ ] **Step 3: Implement**

Replace the `<nav>` and its button with:

```tsx
    <nav className="shrink-0 grid grid-cols-5 bg-bg border-t border-border pb-[env(safe-area-inset-bottom)]">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            aria-label={t.id === "review" && reviewCount > 0 ? `Review, ${reviewCount} need review` : t.label}
            aria-current={isActive ? "page" : undefined}
            onClick={() => { fire("navigation"); onNavigate(t.id); }}
            className={`relative min-h-14 flex flex-col items-center justify-center gap-1 press font-mono text-[8px] uppercase tracking-[0.1em] ${isActive ? "text-fg font-medium" : "text-muted"}`}
          >
            {/* The active mark: a 2px spot tick on the top rule. */}
            {isActive && (
              <span data-active-tick aria-hidden className="absolute top-0 left-1/2 h-0.5 w-6 -translate-x-1/2 bg-accent" />
            )}
            <span className="relative">
              <span className="flex items-center justify-center w-14 h-8">
                <Icon size={22} aria-hidden />
              </span>
              {t.id === "review" && reviewCount > 0 && (
                <span className="absolute -top-0.5 right-1.5 min-w-4 h-4 px-1 rounded-[2px] bg-accent text-accent-fg text-[10px] leading-4 text-center">
                  {reviewCount}
                </span>
              )}
            </span>
            {t.label}
          </button>
        );
      })}
    </nav>
```

- [ ] **Step 4: Run and commit**

```bash
cd frontend && bun run test && bunx tsc -b
git add frontend/src/components/ui/BottomNav.tsx frontend/src/components/ui/BottomNav.test.tsx
git commit -m "feat(ui): BottomNav loses elevation, gains a spot tick marker"
```

---

### Task 8: Per-segment dither density

The signature mechanism. `DitherFill`'s threshold is currently `t > BAYER[y % 4][x % 4]` where `t` is purely positional. A per-segment bias on that comparison is the whole change.

**Files:**
- Modify: `frontend/src/components/charts/DitherFill.tsx`
- Modify: `frontend/src/components/charts/DitherFill.test.tsx`

**Interfaces:**
- Consumes: `segmentBounds` from `lib/ditherFill.ts`, `BAYER`/`OFF_TIER`/`backingSize`/`bloomLayerStyle` from `dither-kit/dither-paint`.
- Produces: `export type Density = "dense" | "medium" | "sparse" | "solid"` and `export type DitherSegment = { value: number; color: DitherColor; density?: Density }`. `density` defaults to `"medium"`, so every existing call site keeps working unchanged.

- [ ] **Step 1: Write the failing test**

```tsx
import { DENSITY_BIAS } from "./DitherFill";

test("density bias is ordered dense > medium > sparse, and solid is unconditional", () => {
  expect(DENSITY_BIAS.dense).toBeGreaterThan(DENSITY_BIAS.medium);
  expect(DENSITY_BIAS.medium).toBeGreaterThan(DENSITY_BIAS.sparse);
  // A bias >= 1 lights every cell regardless of the Bayer threshold, because
  // the ramp t is in [0,1] and thresholds are < 1.
  expect(DENSITY_BIAS.solid).toBeGreaterThanOrEqual(1);
});

test("medium is the default, so existing call sites are unchanged", () => {
  expect(DENSITY_BIAS.medium).toBe(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && bunx vitest run src/components/charts/DitherFill.test.tsx`
Expected: FAIL — `DENSITY_BIAS` is not exported.

- [ ] **Step 3: Implement**

In `DitherFill.tsx`, add above the component:

```tsx
/**
 * How the 50/30/20 buckets are told apart now that they share one ink: the
 * threshold the Bayer matrix is compared against is biased per segment. Positive
 * bias lights more cells (denser), negative lights fewer (sparser), and a bias
 * of 1 clears every threshold so the fill goes solid — which is how over-budget
 * reads, matching ProgressBar.
 */
export type Density = "dense" | "medium" | "sparse" | "solid";

export const DENSITY_BIAS: Record<Density, number> = {
  dense: 0.22,
  medium: 0,
  sparse: -0.22,
  solid: 1,
};
```

Widen the segment type:

```tsx
export type DitherSegment = { value: number; color: DitherColor; density?: Density };
```

Include density in the repaint signature so a density change actually repaints:

```tsx
  const sig = segments.map((s) => `${s.color}:${s.value}:${s.density ?? "medium"}`).join("|");
```

And bias the threshold in the paint loop:

```tsx
      segments.forEach((seg, i) => {
        const seed = seedOfColor(seg.color);
        const bias = DENSITY_BIAS[seg.density ?? "medium"];
        const [x0, x1] = bounds[i];
        for (let x = x0; x < x1; x++) {
          for (let y = 0; y < rows; y++) {
            // Ramp density from the bottom up, matching the charts' gradient
            // fill, then threshold it through the shared Bayer matrix — offset
            // by this segment's density bias.
            const t = rows > 1 ? y / (rows - 1) : 1;
            const on = t + bias > BAYER[y % 4][x % 4];
            c.fillStyle = rgb(seed.fill, 1, on ? 1 : OFF_TIER);
            c.fillRect(x, y, 1, 1);
          }
        }
      });
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && bunx vitest run src/components/charts/DitherFill.test.tsx && bun run test`
Expected: PASS, including the existing `DitherFill` tests — `density` is optional and `medium` is a zero bias, so current behaviour is byte-identical.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/charts/DitherFill.tsx frontend/src/components/charts/DitherFill.test.tsx
git commit -m "feat(charts): DitherFill encodes magnitude class by dither density"
```

---

### Task 9: Buckets adopt density

**Files:**
- Modify: every `DitherFill` call site that passes a bucket colour
- Modify: `frontend/src/components/README.md`

**Interfaces:**
- Consumes: `Density` and `DitherSegment` from Task 8.

- [ ] **Step 1: Find the call sites**

Run: `cd frontend && grep -rn "DitherFill\|DitherSegment" src/ --include=*.tsx | grep -v "charts/DitherFill"`

- [ ] **Step 2: Map buckets to densities**

Needs → `"dense"`, wants → `"medium"`, saving → `"sparse"`. A bucket at or over budget → `"solid"`, matching `ProgressBar`. Keep the `color` field on every segment — it still selects the ink seed, which is now the same ink for all three buckets but still differs for `red` (negative money) and `grey` (muted).

- [ ] **Step 3: Confirm the label is still present at every call site**

Density is never the sole encoding. For each call site, verify a visible text label names the bucket. If one does not, add it — this is an accessibility requirement from the spec, not a nicety.

- [ ] **Step 4: Update the catalog**

In `frontend/src/components/README.md`: update the Conventions section (tokens, elevation, radius are all now different), `ProgressBar`, `Pill`, `Fab`, `BottomNav`, and add a short entry describing the density encoding and the red-rationing rule.

- [ ] **Step 5: Run the suite and commit**

```bash
cd frontend && bun run test && bunx tsc -b
git add frontend/src/
git commit -m "feat(budget): buckets read by dither density, not by hue"
```

---

### Task 10: Rebuild the embedded bundle

> **Execution order:** run this task **last**, after Task 11. It is numbered 10 because it belongs with the structural work, but it must follow the final code change or the embedded bundle will not match the source.

`internal/web/dist/` is a committed build artifact that Go embeds. Per CLAUDE.md it must match the frontend source before the branch is finished.

- [ ] **Step 1: Re-check main has not moved**

```bash
git fetch --all -q
git log --oneline -3 main
```
If main advanced, merge it before rebuilding — parallel sessions run in this repo.

- [ ] **Step 2: Build**

```bash
cd frontend && bun install && bun run build
```

- [ ] **Step 3: Verify the binary still builds**

```bash
cd /root/Coding/ledger && CGO_ENABLED=0 go build -o /tmp/ledger-build-check ./cmd/ledger && rm /tmp/ledger-build-check
```

- [ ] **Step 4: Commit**

```bash
git add internal/web/dist
git commit -m "build(web): rebuild embedded PWA bundle for the two-color press"
```

---

### Task 11: The type scale and the mono division of labour

Task 1 swapped the faces; this applies the scale. It lands last because it touches many screens and is easiest to judge once the palette and chrome are already in place.

**Files:**
- Modify: `frontend/src/components/ui/SectionLabel.tsx`
- Modify: `frontend/src/components/ui/TopBar.tsx`
- Modify: `frontend/src/components/RollingNumber.tsx` call sites (the Home hero)
- Modify: `frontend/src/components/transactions/TransactionRow.tsx`
- Modify: `frontend/src/components/README.md`

**Interfaces:**
- Produces: no API changes. This is presentation only.

**The rule:** Geist Sans takes prose, merchant names and screen titles. Geist Mono takes *everything else* — every figure, date, category label, count, eyebrow, chart axis and nav label. Geist alone is a neutral grotesk and will read as Inter by another name; pushing Mono well past a "figures" role is what produces the technical register.

| Role | Face | Size | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Hero amount | Mono | 32px | 500 | -0.02em |
| Screen title | Sans | 16px | 600 | -0.015em |
| Row primary | Sans | 14px | 500 | -0.01em |
| Row meta | Mono | 10px | 400 | 0.04em |
| Eyebrow / label | Mono | 10px | 500 | 0.14em, uppercase |
| Nav label | Mono | 8px | 500 | 0.10em, uppercase |
| Button | Sans | 13px | 500 | normal |

- [ ] **Step 1: Write the failing test for SectionLabel**

```tsx
import { render, screen } from "@testing-library/react";
import { SectionLabel } from "./SectionLabel";

test("eyebrows are mono micro-caps at the spec's tracking", () => {
  render(<SectionLabel>This month</SectionLabel>);
  const el = screen.getByText("This month");
  expect(el.className).toContain("font-mono");
  expect(el.className).toContain("uppercase");
  expect(el.className).toContain("tracking-[0.14em]");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && bunx vitest run src/components/ui/SectionLabel.test.tsx`
Expected: FAIL — the current eyebrow is sans at `0.08em`.

- [ ] **Step 3: Apply the scale to SectionLabel**

Change its classes to `font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted`. Keep the `as` prop and everything else. The swipe deck's wider-set display eyebrows (`0.18em`) stay as they are — the catalog already records them as a deliberate exception.

- [ ] **Step 4: Apply the scale to TopBar**

Screen title becomes `text-base font-semibold tracking-[-0.015em]` in sans. TopBar's *actions* become mono micro-caps: `font-mono text-[10px] font-medium uppercase tracking-[0.12em]`. Actions that were `text-accent` become `text-fg` unless they are the screen's single primary action — red is rationed, and in dark it is sub-AA.

- [ ] **Step 5: Apply the scale to rows and the hero**

`TransactionRow`: merchant stays sans at `text-sm font-medium tracking-[-0.01em]`; the `category · date` meta line becomes `font-mono text-[10px] tracking-[0.04em] text-muted`. The Home hero's `RollingNumber` wrapper takes `tracking-[-0.02em]` — it already renders through `.tnum`, which is now Geist Mono.

- [ ] **Step 6: Sweep for prose still set in mono, and figures still in sans**

Run: `cd frontend && grep -rn "tabular-nums" src/ --include=*.tsx`
Any element showing a figure should reach mono via `.tnum` rather than a bare `tabular-nums`. Fix the ones that don't.

- [ ] **Step 7: Update the catalog and commit**

Record the scale table in `frontend/src/components/README.md` under Conventions, and note the Sans/Mono division of labour as a rule.

```bash
cd frontend && bun run test && bunx tsc -b
git add frontend/src/
git commit -m "style(type): apply the scale and the sans/mono division of labour"
```

---

## Device verification (not automatable)

These are the spec's three risks. They need a real phone over Tailscale, not a test:

1. **Moiré** — dither at bucket-bar and pill sizes on a high-DPI screen can shimmer. If it does, raise `CELL` for `DitherFill` only, or widen the density spread.
2. **Overspend legibility** — does solid fill read as "over" at a glance, without a legend?
3. **Night legibility** — D1 is the high-contrast dark ground. If it is harsh in a dark room, the fallback is lifting `--color-bg` toward a warmer graphite (`#1e1d1c`) with ink `#e6e3de`.

---

### Task 12: Accessible spot ink

Added mid-execution. A contrast audit of the shipped palette found two sub-AA pairings that the design's own rules require fixing. Run this **after Task 11 and before Task 10**.

**Files:**
- Modify: `frontend/src/styles/app.css` (light `@theme` and dark override)
- Modify: `frontend/src/components/dither-kit/palette.ts` (the `pink` and `red` seeds in both tables)

**The measurements** (WCAG 2.1 relative luminance, computed, not estimated):

| Pairing | Before | After |
| --- | --- | --- |
| white on `--color-accent` (badge 10px, button labels 13px) | `#d8452c` → **4.37:1** ❌ | `#c93d26` → **5.03:1** ✅ |
| `--color-bad` as text on light paper `#f2f1ef` (`.money-neg`) | `#d8452c` → **3.87:1** ❌ | `#b8331d` → **5.27:1** ✅ |
| `--color-bad` as text on dark ground `#141416` (`.money-neg`) | `#f0866f` → 7.31:1 ✅ | unchanged |

**The resulting rule — the spot ink has three registers**, which is ordinary two-colour press practice (one plate, different tints for different jobs):

- **Fill:** `#c93d26`, always with `--color-accent-fg: #ffffff` on it.
- **Text on light paper:** `#b8331d`.
- **Text on dark ground:** `#f0866f`.

Never use a text register as a fill or a fill register as text.

- [ ] **Step 1: Update the light `@theme`**

```css
  --color-accent: #c93d26;      /* the one spot ink, as a FILL. 5.03:1 with white. */
  --color-accent-fg: #ffffff;
```

and

```css
  /* Negative money prints in the spot ink's TEXT register, not its fill. On
     light paper #c93d26 is only 4.45:1; #b8331d is 5.27:1. Never use this as
     a fill — --color-accent is the fill. */
  --color-bad: #b8331d;
```

- [ ] **Step 2: Update the dark override**

```css
    --color-accent: #c93d26;
    --color-accent-fg: #ffffff;
```

`--color-bad` in dark stays `#f0866f` — already 7.31:1 and already documented as the dark text register. Do not change it.

- [ ] **Step 3: Realign the two affected dither seeds**

In `palette.ts`, `pink` mirrors `--color-accent` and `red` mirrors `--color-bad`. Update both tables:

```ts
// PALETTE_LIGHT
  red: light([184, 51, 29]),      // --color-bad    #b8331d
  pink: light([201, 61, 38]),     // --color-accent #c93d26
// PALETTE_DARK
  red: dark([240, 134, 111]),     // --color-bad    #f0866f  (unchanged)
  pink: dark([201, 61, 38]),      // --color-accent #c93d26
```

Update `frontend/src/components/dither-kit/palette.test.ts` expectations to match.

- [ ] **Step 4: Record the rule in the catalog**

Add the three-register rule to the Conventions section of `frontend/src/components/README.md`, with the measured ratios.

- [ ] **Step 5: Verify, then commit**

```bash
cd frontend && bun run test && bunx tsc -b
git add frontend/src/styles/app.css frontend/src/components/dither-kit/ frontend/src/components/README.md
git commit -m "fix(a11y): spot ink gets separate fill and text registers for AA"
```

#### Task 12 — additional scope, added after the Task 11 review

Run these **before** the Step 5 commit above; one commit covers the whole task.

- [ ] **Step 6: Close the last three `text-accent`-as-text violations**

Task 11's review confirmed these still render vermilion as *text* on a non-primary action. That breaks the rationing rule (four sanctioned contexts only) and is sub-AA on the dark ground, where red must be a fill.

| File | Line | What it is |
| --- | --- | --- |
| `frontend/src/components/insights/DrillDownSheet.tsx` | 58 | "Back" |
| `frontend/src/screens/Home.tsx` | 172 | "All ›" |
| `frontend/src/components/swipe/SwipeDeck.tsx` | 344 | refund link |

All three are secondary navigation, not a screen's single primary action. Change `text-accent` to `text-fg` at each. Verify with `grep -rn "text-accent" frontend/src/` — the only survivors should be genuine primary actions (e.g. `Button`'s primary variant, which uses `bg-accent text-accent-fg`, not `text-accent`). Report every remaining match and why it is legitimate.

- [ ] **Step 7: Correct the hero row in the catalog**

`frontend/src/components/README.md` documents the hero amount as 32px/500, but `frontend/src/screens/Home.tsx:286` renders `text-[2.75rem]` (44px) at `font-semibold` (600). **The code is right — a hero number should be the largest thing on the screen; the table's 32px came from a mockup rendered at mockup scale.** Update the table row to 44px/600 and mark it explicitly as the hero's own size rather than a general scale step.

While there, add TopBar's chrome-specific `0.12em` stepper tracking as a noted variant of the 0.14em eyebrow row, so a reader working from the table alone can derive the real value.
