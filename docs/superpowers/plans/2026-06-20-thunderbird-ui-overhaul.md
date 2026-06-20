# Thunderbird-Flavored UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the ledger PWA so it reads as a member of the Thunderbird Android family — Material 3 ("Material You") surfaces, deep Thunderbird blue, tonal elevation instead of hairline borders, stadium buttons, a floating action button, the Inter type face, and a full automatic dark theme.

**Architecture:** The app already funnels essentially all color/radius/border styling through Tailwind v4 `@theme` CSS-variable tokens in `frontend/src/styles/app.css`, consumed as semantic utilities (`bg-surface`, `text-muted`, `bg-accent`, `border-border`, `text-good|warn|bad`, `--color-need|want|save`). We **keep every existing semantic token name** and only change its *value*, then add a `@media (prefers-color-scheme: dark)` block that overrides the same CSS variables — so dark mode needs zero `dark:` variants sprinkled across components. New Material concepts (a second surface tone, a branded hero surface, an elevation shadow) are added as a few extra `@theme` tokens. The shared primitives in `components/ui/` are then reshaped to Material 3 geometry, which cascades to every screen.

**Tech Stack:** React 18 + TypeScript + Vite, Tailwind CSS v4 (CSS-first `@theme`), TanStack Query, recharts, lucide-react, vite-plugin-pwa, vitest + Testing Library, bun.

---

## Design System (the brief, pinned)

The brief pins the direction: **make it like the Thunderbird Android email client**. Thunderbird Android's words win, so this is a faithful port of its design language rather than a free-choice exploration. The tokens below are derived directly from Thunderbird Android's `theme2/thunderbird` Compose theme (`ThemeColors.kt`, `DefaultThemeShapes.kt`, `DefaultThemeSpacings.kt`).

**Color** (named hex, light → dark):

| Role | Token | Light | Dark |
|---|---|---|---|
| App background (warm off-white / near-black) | `--color-bg` | `#FCF8F8` | `#131314` |
| Card surface (1 step up from bg) | `--color-surface` | `#FFFFFF` | `#201F20` |
| Inset / secondary surface (segmented track, chips) | `--color-surface-2` | `#F1EDEC` | `#2A2A2B` |
| Hairline outline (used sparingly) | `--color-border` | `#C5C6CA` | `#44474C` |
| Primary text (onSurface) | `--color-fg` | `#1C1B1B` | `#E5E2E3` |
| Secondary text (onSurfaceVariant) | `--color-muted` | `#45474A` | `#C5C6CC` |
| Brand primary (icons, active nav, links) | `--color-accent` | `#004F9B` | `#BEE6FF` |
| On-accent text | `--color-accent-fg` | `#FFFFFF` | `#003549` |
| Hero panel fill (branded blue moment) | `--color-hero` | `#004F9B` | `#00344A` |
| On-hero text | `--color-hero-fg` | `#FFFFFF` | `#BEE6FF` |
| Success ("on track") | `--color-good` | `#194E2C` | `#8EE7AA` |
| Warning ("over pace") | `--color-warn` | `#713F12` | `#FEE78A` |
| Error ("over budget", debits) | `--color-bad` | `#7F1D1D` | `#FCA5A5` |
| Bucket: Needs | `--color-need` | `#1373D9` | `#96CDFF` |
| Bucket: Wants (TB tertiary purple) | `--color-want` | `#7B35B8` | `#C7A6E8` |
| Bucket: Savings | `--color-save` | `#2E7D52` | `#8EE7AA` |

**Type** — three roles:
- **Display/data face:** **Inter Variable** (self-hosted, `@fontsource-variable/inter`). Roboto-adjacent geometric sans → the Material feel, deterministic offline. Used everywhere as the base.
- **Body/UI:** Inter at 400/500/600.
- **Rounded numeric (kept):** the existing `--font-rounded` (SF Pro Rounded fallback) stays *only* on the swipe-deck big amount — a deliberate playful note in categorize mode. Untouched.

**Layout / shape** (Material 3): 8-pt spacing grid (already followed). Corner radii — cards `16px` (`--radius-card`, unchanged value), bottom sheets `28px` (`--radius-sheet`, new), buttons & chips **fully rounded** (stadium), segmented control fully rounded track + thumb. Borders are mostly replaced by **tonal elevation**: a card is `surface` sitting on `bg` with a soft `--shadow-1`, not a 1px outline.

**Signature element:** the **Home hero** becomes a filled **Thunderbird-blue panel** (`--color-hero`) with the month's spend set large in Inter and a translucent-white budget meter — the one bold, branded moment. Everything around it (bucket pace, trend, recent) stays quiet on neutral `surface` cards. The floating action button is Material's standard interaction vocabulary (Thunderbird's compose button → here "Add transaction"), not a second decorative flourish.

**Why this isn't the generic default:** the three current AI-design clichés are cream+serif+terracotta, near-black+acid-accent, and broadsheet hairlines. This is none of them: it is a specific, documented product's Material 3 system — warm-neutral (not cream) surfaces, a deep institutional blue (not an acid accent), tonal-elevation cards (the opposite of hairline broadsheet), and a sans (not a serif) display. The palette and radii are copied verbatim from Thunderbird Android, which is exactly what the brief asked for.

---

## Global Constraints

- **Keep all existing semantic token names.** Never rename `--color-bg|surface|border|fg|muted|accent|accent-fg|need|want|save|good|warn|bad` or the utilities built on them; only change values and add new tokens. Tests assert on these class names (`bg-bad`, `text-warn`, `bg-bg`).
- **Money stays integer fils.** No styling task touches money math, `lib/money.ts`, or amount signs.
- **No runtime Node.** The Inter font ships as a bundled `woff2` inside `internal/web/dist` via the normal Vite build; the Go server never runs Node. `workbox.globPatterns` already includes `woff2`.
- **Dark mode is automatic** via `@media (prefers-color-scheme: dark)` and dual `theme-color` metas. No JS theme store, no toggle, no `localStorage`.
- **Accessibility floor:** visible keyboard focus preserved, `prefers-reduced-motion` respected (already honored in `app.css`), tap targets stay ≥44px.
- **Verify after every task:** `cd frontend && bunx vitest run <changed file>` green; the *full* suite green at the end (`cd frontend && bun run test`).
- **Rebuild the embedded bundle before finishing** (`cd frontend && bun run build`) so `internal/web/dist/` matches source — parallel sessions run on `main`.
- Match the surrounding code style: Tailwind utility classes inline, semantic tokens, comments only where intent is non-obvious.

---

### Task 1: Self-host Inter and set it as the base face

**Files:**
- Modify: `frontend/package.json` (add dependency)
- Modify: `frontend/src/main.tsx` (import font CSS)
- Modify: `frontend/src/styles/app.css:22` (`--font-sans` value)

**Interfaces:**
- Produces: the global `font-family` resolves to `Inter Variable` with a system fallback. No exported symbols.

- [ ] **Step 1: Add the font package**

Run:
```bash
cd frontend && bun add @fontsource-variable/inter
```
Expected: `package.json` gains `"@fontsource-variable/inter"` under `dependencies`; `bun.lockb` updates.

- [ ] **Step 2: Import the font at the app entry**

In `frontend/src/main.tsx`, add this import at the very top of the import block (before the CSS/app imports so the `@font-face` rules load first):

```ts
import "@fontsource-variable/inter";
```

- [ ] **Step 3: Point `--font-sans` at Inter**

In `frontend/src/styles/app.css`, replace the `--font-sans` line (currently line 22):

```css
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
```

with:

```css
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
```

- [ ] **Step 4: Verify the build resolves the font and bundles a woff2**

Run:
```bash
cd frontend && bun run build && ls -1 ../internal/web/dist/assets | grep -i 'inter.*\.woff2' | head
```
Expected: build succeeds; at least one `inter-*-.woff2` asset is emitted into `dist/assets` (it gets embedded and PWA-cached via the existing `woff2` glob).

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/bun.lockb frontend/src/main.tsx frontend/src/styles/app.css
git commit -m "feat(web): self-host Inter Variable as the base type face

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Re-base the light palette and add Material tokens

**Files:**
- Modify: `frontend/src/styles/app.css:5-27` (the `@theme` block)

**Interfaces:**
- Produces: new utilities generated by Tailwind from the new tokens — `bg-surface-2`, `bg-hero`, `text-hero-fg`, `shadow-1` (via a CSS class, see below). All existing token names keep working with new values. Later tasks consume `bg-surface-2`, `bg-hero`, `text-hero-fg`, `.shadow-1`, `--radius-sheet`.

- [ ] **Step 1: Replace the `@theme` block with the Thunderbird light palette**

In `frontend/src/styles/app.css`, replace the entire `@theme { ... }` block (lines 5–27) with:

```css
/* Design tokens (Tailwind v4 CSS-first config).
   Light values = Thunderbird Android "theme2/thunderbird" Compose theme.
   Dark overrides live below in a prefers-color-scheme media block; every
   utility resolves the same CSS var, so dark mode needs no `dark:` variants. */
@theme {
  --color-bg: #fcf8f8;          /* warm off-white surface */
  --color-surface: #ffffff;     /* card, one tonal step up from bg */
  --color-surface-2: #f1edec;   /* inset surfaces: segmented track, chips */
  --color-border: #c5c6ca;      /* outlineVariant — hairlines, used sparingly */
  --color-fg: #1c1b1b;          /* onSurface */
  --color-muted: #45474a;       /* onSurfaceVariant */

  --color-accent: #004f9b;      /* Thunderbird primary blue */
  --color-accent-fg: #ffffff;

  --color-hero: #004f9b;        /* branded hero panel fill */
  --color-hero-fg: #ffffff;

  --color-need: #1373d9;        /* blue */
  --color-want: #7b35b8;        /* tertiary purple */
  --color-save: #2e7d52;        /* green */

  --color-good: #194e2c;        /* success */
  --color-warn: #713f12;        /* warning */
  --color-bad: #7f1d1d;         /* error */

  --font-sans: "Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  /* Rounded numeric face — kept only for the swipe-deck amount. */
  --font-rounded: ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", system-ui, sans-serif;

  --radius-card: 16px;          /* Material "large" */
  --radius-sheet: 28px;         /* Material "extra-large" — bottom sheets */
}
```

> Note: Step 1 of Task 1 already set `--font-sans` to Inter; this block keeps that value. If executing tasks out of order, the Inter value above is authoritative.

- [ ] **Step 2: Add the Material elevation utility**

In `frontend/src/styles/app.css`, immediately after the `body { ... }` rule (around line 31), add:

```css
/* Material tonal elevation. On light it's a soft drop shadow; on dark the
   shadow is near-invisible and the lighter surface tone provides separation. */
.shadow-1 {
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.10);
}
```

- [ ] **Step 3: Verify the existing suite still passes (token rename guard)**

Run:
```bash
cd frontend && bunx vitest run src/components/ui/Pill.test.tsx src/components/ui/ProgressBar.test.tsx
```
Expected: PASS — these assert on `text-warn` / `bg-bad` class names, which are unchanged (only values changed).

- [ ] **Step 4: Verify the build compiles the new tokens**

Run:
```bash
cd frontend && bun run build
```
Expected: build succeeds (Tailwind generates `bg-surface-2`, `bg-hero`, `text-hero-fg` etc.).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles/app.css
git commit -m "feat(web): re-base palette to Thunderbird light tokens + elevation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Add the automatic dark theme + theme-color metas

**Files:**
- Modify: `frontend/src/styles/app.css` (append a dark media block)
- Modify: `frontend/index.html:6` (theme-color metas)
- Modify: `frontend/vite.config.ts` (manifest `theme_color` / `background_color`)

**Interfaces:**
- Consumes: the token names defined in Task 2.
- Produces: every `--color-*` flips under `prefers-color-scheme: dark`; the browser/PWA chrome color matches each scheme.

- [ ] **Step 1: Append the dark-theme override block**

At the end of `frontend/src/styles/app.css`, append:

```css
/* ---- Dark theme (automatic, follows the OS) ----
   Overrides the same CSS vars the light @theme set; utilities pick these up
   with no markup changes. Values = Thunderbird Android dark color scheme. */
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #131314;
    --color-surface: #201f20;
    --color-surface-2: #2a2a2b;
    --color-border: #44474c;
    --color-fg: #e5e2e3;
    --color-muted: #c5c6cc;

    --color-accent: #bee6ff;
    --color-accent-fg: #003549;

    --color-hero: #00344a;
    --color-hero-fg: #bee6ff;

    --color-need: #96cdff;
    --color-want: #c7a6e8;
    --color-save: #8ee7aa;

    --color-good: #8ee7aa;
    --color-warn: #fee78a;
    --color-bad: #fca5a5;
  }
}
```

- [ ] **Step 2: Swap the single theme-color meta for a scheme-aware pair**

In `frontend/index.html`, replace line 6:

```html
    <meta name="theme-color" content="#0058E6" />
```

with:

```html
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fcf8f8" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#131314" />
```

- [ ] **Step 3: Update the PWA manifest colors**

In `frontend/vite.config.ts`, inside the `manifest: { ... }` object, change:

```ts
        theme_color: "#0058E6",
        background_color: "#245EDC",
```

to:

```ts
        theme_color: "#fcf8f8",
        background_color: "#fcf8f8",
```

- [ ] **Step 4: Verify build + suite**

Run:
```bash
cd frontend && bun run build && bunx vitest run src/app/AppShell.test.tsx
```
Expected: build succeeds; AppShell test PASS. (Dark tokens are CSS-only; jsdom doesn't evaluate the media query, so there's nothing to unit-test here — dark mode is verified visually in Task 14.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles/app.css frontend/index.html frontend/vite.config.ts
git commit -m "feat(web): automatic dark theme via prefers-color-scheme + theme-color metas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Card → elevated Material surface

**Files:**
- Modify: `frontend/src/components/ui/Card.tsx`

**Interfaces:**
- Consumes: `.shadow-1` (Task 2), `--radius-card`.
- Produces: `Card` keeps the same props (`className?: string; children: ReactNode`). Visual change only: no border, soft elevation.

- [ ] **Step 1: Drop the border, add elevation**

Replace the body of `frontend/src/components/ui/Card.tsx` with:

```tsx
import type { ReactNode } from "react";
export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`bg-surface rounded-[var(--radius-card)] shadow-1 p-4 ${className}`}>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Verify no test asserted the old border**

Run:
```bash
cd frontend && grep -rn "border-border" src/screens src/components --include=*.test.tsx | grep -i card
```
Expected: no output (Card has no dedicated test, and no screen test pins its border).

- [ ] **Step 3: Verify screens that use Card still render**

Run:
```bash
cd frontend && bunx vitest run src/screens/Home.test.tsx src/screens/Insights.test.tsx
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ui/Card.tsx
git commit -m "feat(web): Card uses Material tonal elevation instead of a border

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Button → Material stadium variants

**Files:**
- Modify: `frontend/src/components/ui/Button.tsx`

**Interfaces:**
- Consumes: `bg-accent`, `bg-surface-2`, `text-accent`, `bg-bad`.
- Produces: `Button` keeps the same API — `variant?: "primary" | "secondary" | "ghost" | "danger"`, plus all native button attrs. `secondary` becomes a Material **tonal** button (filled `surface-2`, no border); `primary`/`danger` stay filled; `ghost` stays text-only. Buttons become fully rounded (stadium).

- [ ] **Step 1: Restyle the variants and radius**

Replace `frontend/src/components/ui/Button.tsx` with:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";
type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "bg-surface-2 text-fg hover:opacity-80",   // Material tonal
  ghost: "bg-transparent text-accent hover:bg-surface-2",
  danger: "bg-bad text-white hover:opacity-90",
};
export function Button(
  { variant = "secondary", className = "", children, ...rest }:
  { variant?: Variant; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>,
) {
  return (
    <button
      className={`min-h-11 px-5 rounded-full text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Find tests/usages asserting the old `border` secondary or `rounded-xl`**

Run:
```bash
cd frontend && grep -rn "rounded-xl\|border border-border" src --include=*.test.tsx
```
Expected: review any hits. If a test asserts a Button has `rounded-xl` or a border, update that assertion to `rounded-full` / remove the border check in that test file. (Most Button styling is unverified by tests.)

- [ ] **Step 3: Verify the Settings/CategoryManager suites (heavy Button users) pass**

Run:
```bash
cd frontend && bunx vitest run src/screens/Settings.test.tsx src/screens/CategoryManager.test.tsx
```
Expected: PASS. If a class assertion fails, update it to match the new variant classes and re-run.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ui/Button.tsx
git commit -m "feat(web): Material stadium buttons with a tonal secondary variant

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Pill (chip) and SegmentedControl → Material

**Files:**
- Modify: `frontend/src/components/ui/Pill.tsx`
- Modify: `frontend/src/components/ui/SegmentedControl.tsx`

**Interfaces:**
- Consumes: `bg-surface-2`, `bg-surface`, semantic tone tokens.
- Produces: `Pill` keeps `tone?: "good" | "warn" | "bad" | "muted" | "neutral"` and its `Tone` export. `SegmentedControl` keeps its generic `<T extends string>` API (`value`, `onChange`, `options`). Both become fully rounded with a Material thumb.

- [ ] **Step 1: Keep Pill tones (tests pin `text-warn`), refine geometry**

Replace `frontend/src/components/ui/Pill.tsx` with:

```tsx
import type { ReactNode } from "react";
export type Tone = "good" | "warn" | "bad" | "muted" | "neutral";
const TONES: Record<Tone, string> = {
  good: "text-good bg-good/10",
  warn: "text-warn bg-warn/10",
  bad: "text-bad bg-bad/10",
  muted: "text-muted bg-muted/10",
  neutral: "text-accent bg-accent/10",
};
export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}
```

> The tone class strings are unchanged on purpose — `Pill.test.tsx` asserts `text-warn`. Only padding changed.

- [ ] **Step 2: SegmentedControl → fully-rounded Material track + thumb**

Replace `frontend/src/components/ui/SegmentedControl.tsx` with:

```tsx
export function SegmentedControl<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex p-1 bg-surface-2 rounded-full gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
            value === o.value ? "bg-surface text-fg shadow-1" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Verify Pill and SegmentedControl tests**

Run:
```bash
cd frontend && bunx vitest run src/components/ui/Pill.test.tsx src/components/ui/SegmentedControl.test.tsx
```
Expected: PASS. If `SegmentedControl.test.tsx` asserted the old `border`/`rounded-xl`/`shadow-sm`, update those strings to the new classes (`rounded-full`, `bg-surface-2`, `shadow-1`) and re-run.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ui/Pill.tsx frontend/src/components/ui/SegmentedControl.tsx
git commit -m "feat(web): Material chips and fully-rounded segmented control

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: ProgressBar → Material track + on-accent mode

**Files:**
- Modify: `frontend/src/components/ui/ProgressBar.tsx`

**Interfaces:**
- Consumes: `bg-surface-2` (track), tone tokens, `--color-hero-fg`.
- Produces: `ProgressBar` gains one optional prop. New signature:
  `ProgressBar({ pct, label, pace, tone, onAccent }: { pct: number; label?: string; pace?: number; tone?: "good"|"warn"|"bad"; onAccent?: boolean })`.
  `onAccent` (default `false`) switches the track to translucent white and the pace marker to white, for use on the blue hero panel (Task 12). Behavior and the `bg-good|warn|bad` fill class names are otherwise unchanged.

- [ ] **Step 1: Update the test first (add the on-accent expectation)**

In `frontend/src/components/ui/ProgressBar.test.tsx`, add this test (place it after the existing tone tests):

```tsx
it("uses a translucent track on accent surfaces", () => {
  const { getByRole } = render(<ProgressBar pct={0.5} onAccent />);
  expect((getByRole("progressbar") as HTMLElement).className).toContain("bg-white/25");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd frontend && bunx vitest run src/components/ui/ProgressBar.test.tsx -t "translucent track"
```
Expected: FAIL — the component still hardcodes `bg-border` for the track.

- [ ] **Step 3: Implement `onAccent` and switch the default track to `surface-2`**

Replace `frontend/src/components/ui/ProgressBar.tsx` with:

```tsx
type Tone = "good" | "warn" | "bad";
const TONE_BG: Record<Tone, string> = { good: "bg-good", warn: "bg-warn", bad: "bg-bad" };

/**
 * pct is a fraction (0..1+). Tone defaults to green <0.8, amber <1.0, red >=1.0,
 * but a `tone` prop can override it (e.g. to colour by projection, not spend).
 * An optional `pace` fraction draws a vertical "today" marker on the track.
 * `onAccent` styles the track for placement on a filled brand surface (the hero).
 */
export function ProgressBar({ pct, label, pace, tone, onAccent = false }: {
  pct: number; label?: string; pace?: number; tone?: Tone; onAccent?: boolean;
}) {
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const auto: Tone = pct >= 1.0 ? "bad" : pct >= 0.8 ? "warn" : "good";
  const track = onAccent ? "bg-white/25" : "bg-surface-2";
  const marker = onAccent ? "bg-white" : "bg-fg/70";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`relative h-3 w-full rounded-full overflow-hidden ${track}`}
    >
      <div className={`h-full rounded-full transition-[width] duration-300 ${onAccent ? "bg-white" : TONE_BG[tone ?? auto]}`} style={{ width: `${clamped}%` }} />
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

- [ ] **Step 4: Run the full ProgressBar test file**

Run:
```bash
cd frontend && bunx vitest run src/components/ui/ProgressBar.test.tsx
```
Expected: PASS — including the existing `bg-bad`/`bg-warn` fill assertions (the default path still uses `TONE_BG`) and the new on-accent test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/ProgressBar.tsx frontend/src/components/ui/ProgressBar.test.tsx
git commit -m "feat(web): ProgressBar Material track + on-accent variant for the hero

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Top app bar + bottom nav → Material

**Files:**
- Modify: `frontend/src/components/ui/TopBar.tsx`
- Modify: `frontend/src/components/ui/BottomNav.tsx`

**Interfaces:**
- Consumes: `bg-surface`, `bg-surface-2`, `text-accent`, `bg-bad`, `bg-accent/10`.
- Produces: both keep their existing prop APIs (`TopBar`: `title, scope, onScopeChange, showScope`; `BottomNav`: `active, reviewCount, onNavigate`). Visual: the top bar loses its bottom border and sits flat on `bg`; the scope buttons become tonal chips. The bottom nav loses its top border and the active tab gets a Material **pill indicator** behind the icon.

- [ ] **Step 1: TopBar — flat Material top app bar with tonal scope chips**

In `frontend/src/components/ui/TopBar.tsx`, replace the `<header>` opening tag (line 16):

```tsx
    <header className="shrink-0 bg-surface border-b border-border pt-[env(safe-area-inset-top)]">
```

with (flat on bg, no border):

```tsx
    <header className="shrink-0 bg-bg pt-[env(safe-area-inset-top)]">
```

Then change the title size to Material `titleLarge` weight/scale — replace line 18:

```tsx
        <h1 className="text-base font-semibold truncate">{title}</h1>
```

with:

```tsx
        <h1 className="text-xl font-semibold truncate">{title}</h1>
```

Then make the month nav buttons and the scope button tonal. Replace the prev-month button `className` (line 26) `"p-1.5 rounded-lg text-muted hover:bg-bg"` and the next-month button `className` (line 43) — both occurrences — with `"p-2 rounded-full text-muted hover:bg-surface-2"`:

```bash
cd frontend && sed -i 's#p-1.5 rounded-lg text-muted hover:bg-bg#p-2 rounded-full text-muted hover:bg-surface-2#g' src/components/ui/TopBar.tsx
```

Then replace the scope label button `className` (line 34):

```tsx
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-bg text-fg tnum truncate"
```

with:

```tsx
              className="px-3 py-1.5 rounded-full text-sm font-medium bg-surface-2 text-fg tnum truncate"
```

- [ ] **Step 2: BottomNav — flat bar with a pill active-indicator**

Replace `frontend/src/components/ui/BottomNav.tsx` with:

```tsx
import { TABS, type TabId } from "../../app/nav";

export function BottomNav({
  active, reviewCount, onNavigate,
}: { active: TabId; reviewCount: number; onNavigate: (id: TabId) => void }) {
  return (
    <nav className="shrink-0 bg-surface grid grid-cols-5 pb-[env(safe-area-inset-bottom)]">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            aria-label={t.id === "review" && reviewCount > 0 ? `Review, ${reviewCount} need review` : t.label}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onNavigate(t.id)}
            className={`min-h-14 flex flex-col items-center justify-center gap-1 text-xs ${isActive ? "text-accent font-medium" : "text-muted"}`}
          >
            <span className="relative">
              {/* Material active-indicator pill behind the icon */}
              <span className={`flex items-center justify-center w-14 h-8 rounded-full transition-colors ${isActive ? "bg-accent/10" : ""}`}>
                <Icon size={22} aria-hidden />
              </span>
              {t.id === "review" && reviewCount > 0 && (
                <span className="absolute -top-0.5 right-1.5 min-w-4 h-4 px-1 rounded-full bg-bad text-white text-[10px] leading-4 text-center">
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

- [ ] **Step 3: Verify TopBar and BottomNav tests**

Run:
```bash
cd frontend && bunx vitest run src/components/ui/TopBar.test.tsx src/components/ui/BottomNav.test.tsx
```
Expected: PASS. The `aria-label`/`aria-current`/badge-count behavior is unchanged; if a test pinned the old `border-t`/`border-b` or icon-wrapping structure, update it to the new classes and re-run.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ui/TopBar.tsx frontend/src/components/ui/BottomNav.tsx
git commit -m "feat(web): Material top app bar + bottom nav with active-indicator pill

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Dialog / bottom sheet → Material radius + drag handle

**Files:**
- Modify: `frontend/src/components/ui/Dialog.tsx`

**Interfaces:**
- Consumes: `--radius-sheet`, `bg-surface`, `bg-border`.
- Produces: `Dialog` keeps its API (`title, onClose, children`). The mobile bottom sheet gets the 28px Material radius and a drag handle; the close affordance becomes a rounded icon hit-area.

- [ ] **Step 1: Apply the sheet radius and add a drag handle**

In `frontend/src/components/ui/Dialog.tsx`, replace the inner panel's `className` (line 35):

```tsx
        className="w-full sm:max-w-md bg-surface rounded-t-2xl sm:rounded-2xl px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[85dvh] overflow-y-auto overscroll-contain outline-none"
```

with:

```tsx
        className="w-full sm:max-w-md bg-surface rounded-t-[var(--radius-sheet)] sm:rounded-[var(--radius-sheet)] px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[85dvh] overflow-y-auto overscroll-contain outline-none"
```

Then, immediately after that opening `<div ... >` tag and before the header `<div className="flex items-center justify-between mb-3">`, insert a drag handle (visible only as a bottom sheet on mobile):

```tsx
        <div aria-hidden className="sm:hidden mx-auto mb-2 h-1 w-9 rounded-full bg-border" />
```

Then refine the close button — replace line 39:

```tsx
          <button aria-label="Close" className="text-muted text-xl" onClick={onClose}>×</button>
```

with:

```tsx
          <button aria-label="Close" className="-mr-2 p-2 rounded-full text-muted hover:bg-surface-2 text-xl leading-none" onClick={onClose}>×</button>
```

- [ ] **Step 2: Verify dialog-driven suites still pass**

Run:
```bash
cd frontend && bunx vitest run src/components/transactions/AddTransactionSheet.test.tsx src/components/ui/PeriodSheet.test.tsx
```
Expected: PASS — focus trap, `aria-label="Close"`, and Escape handling are unchanged.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ui/Dialog.tsx
git commit -m "feat(web): Material bottom sheet — 28px radius, drag handle, round close

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Floating action button + wire to Add transaction

**Files:**
- Create: `frontend/src/components/ui/Fab.tsx`
- Create: `frontend/src/components/ui/Fab.test.tsx`
- Modify: `frontend/src/screens/Transactions.tsx` (replace the toolbar add button with the FAB)

**Interfaces:**
- Consumes: `bg-accent`, `text-accent-fg`, `.shadow-1`, `lucide-react`.
- Produces: `Fab({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void })` — a fixed bottom-right Material FAB that clears the bottom nav and the safe-area inset. Consumed by `Transactions.tsx`.

- [ ] **Step 1: Write the failing FAB test**

Create `frontend/src/components/ui/Fab.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { Plus } from "lucide-react";
import { Fab } from "./Fab";

it("renders an accessible labelled button and fires onClick", () => {
  const onClick = vi.fn();
  render(<Fab icon={Plus} label="Add transaction" onClick={onClick} />);
  const btn = screen.getByRole("button", { name: "Add transaction" });
  fireEvent.click(btn);
  expect(onClick).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd frontend && bunx vitest run src/components/ui/Fab.test.tsx
```
Expected: FAIL — `Cannot find module './Fab'`.

- [ ] **Step 3: Implement the FAB**

Create `frontend/src/components/ui/Fab.tsx`:

```tsx
import type { LucideIcon } from "lucide-react";

/** Material floating action button, fixed above the bottom nav. */
export function Fab({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="fixed right-4 z-30 flex items-center justify-center w-14 h-14 rounded-2xl bg-accent text-accent-fg shadow-1 hover:opacity-90 active:scale-95 transition bottom-[calc(env(safe-area-inset-bottom)+4.5rem)]"
    >
      <Icon size={24} aria-hidden />
    </button>
  );
}
```

> `LucideIcon` is exported by `lucide-react` (the same type the `nav.ts` tab icons use). The `bottom-[calc(...+4.5rem)]` clears the 56px (`min-h-14`) nav bar plus the safe-area inset.

- [ ] **Step 4: Run the test to confirm it passes**

Run:
```bash
cd frontend && bunx vitest run src/components/ui/Fab.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Wire the FAB into Transactions, remove the toolbar add button**

In `frontend/src/screens/Transactions.tsx`:

First add the import (alongside the other `components/ui` imports near line 12):

```tsx
import { Fab } from "../components/ui/Fab";
```

Remove the inline toolbar add button at line 126:

```tsx
          <button onClick={() => setAddOpen(true)} aria-label="Add transaction" className="flex items-center justify-center p-2 rounded-lg bg-accent text-accent-fg hover:opacity-90 transition-opacity"><Plus size={16} /></button>
```

Then render the FAB. Locate the line that renders the add sheet (around line 177):

```tsx
        <AddTransactionSheet categories={cats.data ?? []} onSubmit={createTxn} onClose={() => setAddOpen(false)} />
```

Immediately **before** it, add:

```tsx
      <Fab icon={Plus} label="Add transaction" onClick={() => setAddOpen(true)} />
```

(`Plus` is already imported in `Transactions.tsx` per its existing import line.)

- [ ] **Step 6: Verify the Transactions suite**

Run:
```bash
cd frontend && bunx vitest run src/screens/Transactions.test.tsx
```
Expected: PASS. The add affordance still exposes `aria-label="Add transaction"`; if the test queried the old toolbar button by a more specific selector, point it at the FAB's accessible name and re-run.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ui/Fab.tsx frontend/src/components/ui/Fab.test.tsx frontend/src/screens/Transactions.tsx
git commit -m "feat(web): floating action button for Add transaction

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Re-tune chart + category palette for both themes

**Files:**
- Modify: `frontend/src/lib/insights.ts:36` (`CATEGORY_PALETTE`)
- Modify: `frontend/src/lib/insights.test.ts:?` (the palette assertion)
- Modify: `frontend/src/components/charts/TrendBars.tsx`
- Modify: `frontend/src/components/charts/DonutChart.tsx`

**Interfaces:**
- Consumes: `--color-surface` (donut stroke), `--color-accent`, `--color-surface-2`.
- Produces: `CATEGORY_PALETTE` stays a `string[]` of 6 hex colors; `donutSlices` / `bucketColor` signatures unchanged. Chart colors read theme vars where they touch chrome so they flip in dark mode.

- [ ] **Step 1: Replace the category palette with Thunderbird-aligned hues**

In `frontend/src/lib/insights.ts`, replace line 36:

```ts
export const CATEGORY_PALETTE = ["#4f46e5", "#0891b2", "#d97706", "#db2777", "#16a34a", "#7c3aed"];
```

with a palette built around the Thunderbird blue/purple/green family (mid-saturation hues that read on both the warm-light and near-black surfaces):

```ts
export const CATEGORY_PALETTE = ["#1373d9", "#7b35b8", "#2e7d52", "#0e7490", "#b45309", "#be185d"];
```

- [ ] **Step 2: Update the palette assertion in the test**

In `frontend/src/lib/insights.test.ts`, find the assertion that pins the first palette color (it currently expects `"#4f46e5"`, around line referencing `rent.color`) and change the expected value to `"#1373d9"`:

```ts
    expect(rent.color).toBe("#1373d9");
```

(If the test references other specific palette hexes by index, update each to the new array above, in order.)

- [ ] **Step 3: TrendBars — brand the active bar, theme the axis**

In `frontend/src/components/charts/TrendBars.tsx`, the inactive bar currently uses `var(--color-border)`. Replace the `<Cell .../>` fill expression (line 12):

```tsx
              <Cell key={i} fill={p.period === activePeriod ? "var(--color-accent)" : "var(--color-border)"} />
```

with a slightly stronger inactive tone so bars stay visible on both themes:

```tsx
              <Cell key={i} fill={p.period === activePeriod ? "var(--color-accent)" : "var(--color-surface-2)"} />
```

(The axis already reads `var(--color-muted)`, which now flips automatically — no change needed there.)

- [ ] **Step 4: DonutChart — confirm the slice stroke uses the surface var**

Open `frontend/src/components/charts/DonutChart.tsx` and confirm line 15 already sets `stroke="var(--color-surface)"`. It does — no change needed; it now flips with the theme. (No edit; this step is a verification.)

- [ ] **Step 5: Run the affected tests**

Run:
```bash
cd frontend && bunx vitest run src/lib/insights.test.ts src/components/charts/DonutChart.test.tsx
```
Expected: PASS — including the updated palette assertion.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/insights.ts frontend/src/lib/insights.test.ts frontend/src/components/charts/TrendBars.tsx
git commit -m "feat(web): Thunderbird-aligned chart palette that reads in both themes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Home hero — the signature branded panel

**Files:**
- Modify: `frontend/src/screens/Home.tsx:53-68` (the first `<Card>` → hero)

**Interfaces:**
- Consumes: `bg-hero`, `text-hero-fg`, `Money`, `ProgressBar` with `onAccent` (Task 7).
- Produces: the Home hero renders as a filled Thunderbird-blue panel with the spend figure in the Inter display scale. The remaining Home cards are untouched (kept quiet on `surface`).

- [ ] **Step 1: Replace the hero Card with the branded panel**

In `frontend/src/screens/Home.tsx`, replace the first card block (lines 53–68, the `{/* hero: ... */}` `<Card>` and its contents) with:

```tsx
      {/* hero: spent vs budget, with today's pace + projection — the one bold,
          branded surface; everything below stays quiet on neutral cards. */}
      <div className="rounded-[var(--radius-card)] bg-hero text-hero-fg shadow-1 p-5">
        <p className="text-sm opacity-80">{heroLabel}</p>
        <p className="mt-1 text-[2.75rem] leading-none font-semibold tracking-tight tnum"><Money fils={spent} /></p>
        <p className="text-sm opacity-80 mt-2">of <span className="tnum"><Money fils={budget} /></span> budget</p>
        <div className="mt-4"><ProgressBar pct={pct} pace={pace} onAccent label="Total budget used" /></div>
        <div className="flex items-center justify-between mt-2 text-sm">
          <span className="tnum opacity-80">{remainingLabel(budget - spent)}</span>
          {isCurrent && <span className="font-medium">{VERDICT[heroStatus]}</span>}
        </div>
        {isCurrent && (
          <p className="text-xs opacity-70 mt-1">
            Projected <span className="tnum"><Money fils={projection} /></span> · {Math.round(s.month_progress * 100)}% of month gone
          </p>
        )}
      </div>
```

> The hero now uses `onAccent` on the ProgressBar (white meter on a translucent track) and drops the per-tone text color in favor of `text-hero-fg` with opacity — semantic tone color would clash on the blue fill. `heroTone`/`TONE_TEXT` may now be unused in this file; if the TypeScript build flags an unused binding, remove the now-dead `heroTone` line and the `TONE_TEXT` import/const **only if** they're not used by the bucket section below (they are used there via `tone`, so keep `paceTone`/`TONE_TEXT` — only remove `heroTone` if unused).

- [ ] **Step 2: Resolve any unused-variable TS errors**

Run:
```bash
cd frontend && bun run build
```
Expected: build succeeds. If it fails with "`heroTone` is declared but never read", delete the `const heroTone = paceTone(heroStatus);` line (line ~48) and rebuild. Do **not** remove `TONE_TEXT` or `paceTone` — the bucket-pace section still uses them.

- [ ] **Step 3: Verify the Home suite**

Run:
```bash
cd frontend && bunx vitest run src/screens/Home.test.tsx
```
Expected: PASS — the hero still renders the spent figure, budget, verdict text, and progressbar; assertions on those texts/roles are unaffected. If a test asserted the hero sat inside a `Card`-specific class, retarget it to the visible text/role and re-run.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/screens/Home.tsx
git commit -m "feat(web): branded Thunderbird-blue Home hero — the signature surface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: Screen + odds-and-ends polish pass

**Files:**
- Modify: `frontend/src/components/Toast.tsx`
- Modify: `frontend/src/components/EmptyState.tsx`
- Modify: `frontend/src/components/Skeleton.tsx`
- Modify: `frontend/src/components/transactions/FilterChips.tsx`
- Modify: `frontend/src/components/insights/DeltaBadge.tsx`
- Modify: `frontend/src/screens/Transactions.tsx`, `Settings.tsx`, `Review.tsx`, `CategoryManager.tsx` (border/radius sweep)

**Interfaces:**
- Consumes: the tokens and reshaped primitives from Tasks 2–12. No API changes.
- Produces: stray hairline borders, `rounded-lg`/`rounded-xl` ad-hoc radii, and `bg-bg` inset surfaces across screens are aligned to the Material system (`bg-surface-2` insets, `rounded-full` chips/controls, elevation over borders).

- [ ] **Step 1: Sweep ad-hoc borders → tonal surfaces in screens**

Replace inset panels that used `bg-bg` + `border border-border` with `bg-surface-2` (no border). Run a survey first:

```bash
cd frontend && grep -rnE "border border-border|bg-bg\b" src/screens src/components --include=*.tsx | grep -v "\.test\."
```

For each hit that is a **container/inset panel** (not a real divider), change `bg-bg` → `bg-surface-2` and remove the `border border-border`. Leave genuine dividers (`divide-y divide-border`, `border-t`/`border-b` separators inside lists) as-is — hairline dividers are valid Material list separators. Update `CategoryManager.test.tsx:64` expectation (`toContain("bg-bg")`) to `toContain("bg-surface-2")` if you changed that overlay; if you leave that specific overlay on `bg-bg`, leave the test.

- [ ] **Step 2: FilterChips → Material filter chips**

In `frontend/src/components/transactions/FilterChips.tsx`, ensure each chip is fully rounded with a tonal selected state. Replace the per-chip class string so unselected chips read `bg-surface-2 text-muted` and selected chips read `bg-accent/10 text-accent`, both `rounded-full px-3 py-1 text-sm`. (Open the file, match the existing chip `className`, and substitute these classes; keep the existing `aria-pressed`/selected logic.)

- [ ] **Step 3: Toast → Material radius**

In `frontend/src/components/Toast.tsx`, change the toast container radius (line 34) from `rounded-xl` to `rounded-2xl` and keep `shadow-lg`. (Toasts are transient overlays; `shadow-lg` is appropriate there.)

- [ ] **Step 4: EmptyState + Skeleton — tonal neutrals**

In `frontend/src/components/Skeleton.tsx`, ensure the shimmer blocks use `bg-surface-2` (not `bg-border`) so they read as quiet placeholders on both themes — substitute if needed. In `frontend/src/components/EmptyState.tsx`, ensure any icon circle/background uses `bg-surface-2 text-muted` and the container has no hairline border.

- [ ] **Step 5: DeltaBadge — confirm it rides the semantic tones**

Open `frontend/src/components/insights/DeltaBadge.tsx` and confirm it uses `text-good|warn|bad|muted` tokens (it should). If it hardcodes any hex, replace with the matching semantic token. No structural change otherwise.

- [ ] **Step 6: Run the suites touched by this pass**

Run:
```bash
cd frontend && bunx vitest run src/screens/CategoryManager.test.tsx src/screens/Settings.test.tsx src/screens/Review.test.tsx src/components/transactions/FilterChips.test.tsx src/components/Toast.test.tsx
```
Expected: PASS. Update any assertion that pinned an old class string (`bg-bg`, `border-border`, `rounded-xl`, `rounded-lg`) to the new value where you changed it, then re-run until green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(web): align screens and small components to the Material system

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 14: Full verification + rebuild the embedded bundle

**Files:**
- Modify (build artifact): `internal/web/dist/**`

**Interfaces:** none — this task ships the work.

- [ ] **Step 1: Typecheck + full frontend test suite**

Run:
```bash
cd frontend && bun run test
```
Expected: all test files PASS (single non-parallel fork per `vite.config.ts`).

- [ ] **Step 2: Visual check — light and dark, on a real device**

Run:
```bash
cd frontend && bun run build
cd /root/Coding/ledger && CGO_ENABLED=0 go build -o ledger ./cmd/ledger && ./ledger -config config.toml
```
Then open the app over Tailscale and verify, in this order:
- **Home hero** is a filled Thunderbird-blue panel with a white spend figure and a white meter; the bucket/trend/recent cards below are quiet neutral surfaces with soft elevation and no borders.
- **Bottom nav** active tab shows the pill indicator behind the icon; the review badge still counts.
- **FAB** floats bottom-right on Transactions, clears the nav bar, opens the Add sheet.
- **Buttons** are stadium-shaped; secondary buttons are tonal (filled `surface-2`, no border).
- **Bottom sheets** have the 28px radius and a drag handle.
- Toggle OS dark mode: surfaces flip to near-black `#131314`, text stays legible, accent becomes light blue, the hero becomes the dark-blue variant, charts/donut/trend remain readable, and the browser chrome (`theme-color`) matches.
- Keyboard focus rings are visible; reduced-motion users see no swipe-card animation.

Stop the server (Ctrl-C) when done.

- [ ] **Step 3: Confirm the embedded bundle is rebuilt and staged**

Run:
```bash
cd /root/Coding/ledger && git status --short internal/web/dist | head
```
Expected: `internal/web/dist/` shows modified/new assets (the fresh build including the Inter `woff2`).

- [ ] **Step 4: Go build sanity (the embed compiles)**

Run:
```bash
cd /root/Coding/ledger && CGO_ENABLED=0 go build -o /tmp/ledger-check ./cmd/ledger && echo OK
```
Expected: `OK`.

- [ ] **Step 5: Commit the rebuilt bundle**

```bash
cd /root/Coding/ledger && git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for Thunderbird UI overhaul

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** (against the Design System brief):
- Thunderbird color palette (light + dark) → Tasks 2, 3 ✓
- Inter type face, offline-safe, embedded → Task 1 ✓
- Tonal elevation instead of borders (cards, nav, top bar) → Tasks 2, 4, 8 ✓
- Stadium buttons / Material chips / segmented → Tasks 5, 6 ✓
- Bottom sheets at 28px + drag handle → Task 9 ✓
- FAB (Material interaction signature) → Task 10 ✓
- Branded hero (the one aesthetic risk) → Task 12 ✓
- Charts/donut/palette themed for both modes → Task 11 ✓
- Automatic dark mode + chrome theme-color → Task 3 ✓
- Screen-level cleanup so nothing is left in the old style → Task 13 ✓
- Embedded bundle rebuilt (Global Constraint) → Task 14 ✓

**Placeholder scan:** no "TBD"/"add error handling"/"write tests for the above" — every code step shows the code; restyle steps that touch existing files give exact class substitutions. Task 13 is a guided sweep with a survey command rather than blind edits, by design (the ad-hoc classes vary per file); each sub-step names the exact target classes.

**Type consistency:** `ProgressBar`'s new `onAccent?: boolean` is defined in Task 7 and consumed in Task 12 with the same name. `Fab`'s signature (`icon: LucideIcon, label, onClick`) is defined in Task 10 and consumed there. New tokens `--color-surface-2`, `--color-hero`, `--color-hero-fg`, `--radius-sheet`, `.shadow-1` are defined in Task 2 and consumed by name in Tasks 4–12. `CATEGORY_PALETTE` stays `string[]` (Task 11). No renamed semantic tokens.
