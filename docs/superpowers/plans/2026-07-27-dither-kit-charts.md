# Dither-kit Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's four hand-rolled CSS chart surfaces with dither-kit's ordered-dither canvas rendering, retuned to the app's design tokens.

**Architecture:** dither-kit is vendored source (shadcn registry), not an npm package — `core` + `bar-chart` land in `frontend/src/components/dither-kit/`. Its source requires React 19, so the app upgrades first. `palette.ts` is deliberately forked to carry the app's tokens in light and dark sets. The two vertical charts (`TrendBars`, `FlowBars`) become real dither `BarChart`s; the two horizontal bars get a local `DitherFill` built on dither-kit's own painting primitives, since dither-kit has no horizontal layout.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind v4, vitest + @testing-library/react, dither-kit 0.1.0 (vendored), motion, d3-scale, d3-shape.

**Spec:** `docs/superpowers/specs/2026-07-27-dither-kit-charts-design.md`

## Global Constraints

- All commands run from `frontend/` unless stated. Package manager is **bun**.
- Money is `int64` fils everywhere; never convert to float for display — use the existing `formatFils` / `compactFils` helpers.
- `frontend/src/lib/` holds **pure, framework-free** helpers with co-located `*.test.ts`. Extract decision logic there; keep components thin.
- vitest is pinned to a single non-parallel fork in `vite.config.ts` (`fileParallelism: false`, `singleFork`). **Do not change this.**
- `frontend/src/components/README.md` is the UI component catalog — update it in the same commit as any shared-component change.
- Every task must end with `bun run test` and `bunx tsc -b` green before its commit.
- Install only `core` + `bar-chart` from the dither-kit registry. Do **not** install area/line/pie/radar/sparkline, `dither-avatar` or `dither-button`.
- Scope is exactly four surfaces: `TrendBars`, `FlowBars`, `LensBreakdown`, `ComparativeSummary`. `components/ui/ProgressBar.tsx` and `screens/settings/BudgetPage.tsx` stay CSS — do not touch them.
- Registry URLs are pinned: `https://tripwire.sh/r/bar-chart.json` (pulls `https://tripwire.sh/r/core.json`), version `0.1.0`.

---

### Task 1: Upgrade to React 19

dither-kit's vendored source uses `use(Context)` and `<Context value=>`, both React 19 APIs. Nothing else in this plan can compile until this lands. The codebase was audited and is already free of everything React 19 removed — no `defaultProps` on function components, no `propTypes`, no `forwardRef`, no string refs, and `src/main.tsx` already uses `createRoot`.

**Files:**
- Modify: `frontend/package.json` (dependencies + devDependencies)

**Interfaces:**
- Consumes: nothing.
- Produces: React 19 runtime for every later task.

- [ ] **Step 1: Record the current green baseline**

```bash
cd frontend && bun run test 2>&1 | tail -20
```

Expected: all suites pass. Note the test-file and test counts — Task 1 must not change them.

- [ ] **Step 2: Upgrade the packages**

```bash
cd frontend
bun add react@^19 react-dom@^19
bun add -d @types/react@^19 @types/react-dom@^19
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && bunx tsc -b`
Expected: exit 0, no output.

If it fails, the errors will be in app code, not dependencies. Fix them in place — do not downgrade, and do not add `@ts-expect-error`. The most likely category is `@types/react` 19 no longer providing implicit `children` on `React.FC`; the fix is to type children explicitly.

- [ ] **Step 4: Run the full test suite**

Run: `cd frontend && bun run test`
Expected: PASS, with the same test count as Step 1.

- [ ] **Step 5: Verify the production build**

Run: `cd frontend && bun run build`
Expected: exit 0. This writes `../internal/web/dist/`; that is expected and will be rebuilt again in Task 6.

- [ ] **Step 6: Commit**

```bash
cd /root/Coding/ledger
git add frontend/package.json frontend/bun.lock internal/web/dist
git commit -m "chore(frontend): upgrade to React 19

dither-kit's vendored source uses use(Context) and <Context value=>, both
React 19 APIs. The codebase was already free of every removed API — no
defaultProps, propTypes, forwardRef or string refs, and main.tsx is on
createRoot — so this is a dependency bump with no source changes."
```

---

### Task 2: Vendor dither-kit and bridge it to the app's theme

Installs the registry files, wires the `@/` alias the shadcn CLI needs, defines the shadcn token names dither-kit's chrome references, forks `palette.ts` onto the app's tokens, and adds the jsdom stubs every later chart test depends on.

**Files:**
- Create: `frontend/components.json`
- Create: `frontend/src/components/dither-kit/**` (24 files, written by the CLI)
- Create: `frontend/src/components/dither-kit/README.md`
- Create: `frontend/src/components/dither-kit/palette.test.ts`
- Create: `frontend/src/hooks/useDitherTheme.ts`
- Modify: `frontend/src/components/dither-kit/palette.ts` (fork — rewritten by hand after the CLI writes it)
- Modify: `frontend/tsconfig.json` (add `baseUrl` + `paths`)
- Modify: `frontend/vite.config.ts` (add `resolve.alias`)
- Modify: `frontend/src/styles/app.css` (token aliases, light `@theme` + dark block)
- Modify: `frontend/src/test/setup.ts` (ResizeObserver + canvas stubs)

**Interfaces:**
- Consumes: React 19 (Task 1).
- Produces:
  - `components/dither-kit/bar-chart.tsx` → `BarChart<TData>(props: CartesianChartProps<TData>)`
  - `components/dither-kit/bar.tsx` → `Bar({ dataKey, variant, strokeVariant, isClickable })`
  - `components/dither-kit/x-axis.tsx` → `XAxis({ dataKey, tickFormatter, tickMargin, maxTicks })`
  - `components/dither-kit/tooltip.tsx` → `Tooltip({ labelKey, valueFormatter, variant })`
  - `components/dither-kit/palette.ts` → `type DitherColor`, `type Rgb = [number, number, number]`, `type Seed = { fill: Rgb; line: Rgb; star: Rgb }`, `seedOfColor(color: DitherColor): Seed`, `rgb(c: Rgb, k?: number, a?: number): string`, `mix(a: Rgb, b: Rgb, t: number): Rgb`, `isDarkTheme(): boolean`, `subscribeDitherTheme(cb: () => void): () => void`
  - `components/dither-kit/dither-paint.ts` → `BAYER`, `CELL`, `OFF_TIER`, `backingSize(w, h): { cols: number; rows: number }`, `bloomLayerStyle(bloom, active)`, `type BloomInput`
  - `hooks/useDitherTheme.ts` → `useDitherTheme(): boolean` (true when dark)

- [ ] **Step 1: Write `frontend/components.json`**

Do **not** run `shadcn init` — it injects shadcn's full token layer into `app.css` and collides with the existing `@theme` block.

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/app.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "utils": "@/lib/utils",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 2: Add the `@/` alias to tsconfig and vite**

In `frontend/tsconfig.json`, add to `compilerOptions` (keep every existing option):

```json
"baseUrl": ".",
"paths": { "@/*": ["./src/*"] }
```

In `frontend/vite.config.ts`, add a top-level `resolve` key to the `defineConfig` object, as a sibling of `plugins` / `build` / `test`:

```ts
resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
```

- [ ] **Step 3: Install the registry items**

```bash
cd frontend && bunx --bun shadcn@latest add https://tripwire.sh/r/bar-chart.json
```

`bar-chart.json` declares `registryDependencies: ["https://tripwire.sh/r/core.json"]`, so `core` is pulled automatically. Accept any prompt to install the npm dependencies (`motion`, `d3-scale`, `d3-shape`, `clsx`, `tailwind-merge`, `@types/d3-scale`, `@types/d3-shape`).

- [ ] **Step 4: Verify what landed**

```bash
cd frontend && ls src/components/dither-kit/ | sort
```

Expected: **24 files** — `bar-canvas.tsx`, `bar-chart.tsx`, `bar.tsx`, `block-legend.tsx`, `cartesian-root.tsx`, `chart-context.tsx`, `common-context.tsx`, `dither-paint.ts`, `dot.tsx`, `grid.tsx`, `legend.tsx`, `lib.ts`, `palette.ts`, `polar-context.tsx`, `polar-root.tsx`, `polar.ts`, `reference-line.tsx`, `scales.ts`, `series-context.tsx`, `tooltip.tsx`, `use-chart-dimensions.ts`, `x-axis.tsx`, `y-axis.tsx`, plus `cartesian-canvas.tsx` **only if** an area chart was pulled — if it is present, the wrong item was installed; delete it.

If the CLI placed files somewhere other than `src/components/dither-kit/` (for example at `components/dither-kit/`), move them to `src/components/dither-kit/` — the `target` fields in the registry are repo-root-relative and the alias resolution can differ.

Then confirm no file references an uninstalled sibling:

```bash
cd frontend && grep -rn "from \"\./\(area\|line\|pie\|radar\|sparkline\|cartesian-canvas\)" src/components/dither-kit/
```

Expected: no matches.

- [ ] **Step 5: Add the shadcn token aliases to `app.css`**

dither-kit's chrome uses shadcn token names the app never defined — `tooltip.tsx` uses `bg-popover`, `text-popover-foreground`, `text-muted-foreground`; `x-axis.tsx` uses `text-muted-foreground`; `grid.tsx` uses `stroke-border`. Under Tailwind v4 these utilities silently resolve to nothing without matching `--color-*` entries.

In `src/styles/app.css`, inside the existing `@theme { ... }` block, after the `--color-bad` line:

```css
  /* shadcn token names, aliased onto our palette — dither-kit's vendored
     chrome (tooltip, axes, grid) is written against these. Values mirror the
     tokens above; no new colors are introduced. */
  --color-foreground: #1c1b1b;            /* = --color-fg */
  --color-muted-foreground: #45474a;      /* = --color-muted */
  --color-popover: #ffffff;               /* = --color-surface */
  --color-popover-foreground: #1c1b1b;    /* = --color-fg */
```

And inside the existing `@media (prefers-color-scheme: dark) { :root { ... } }` block, after the `--color-bad` line:

```css
    --color-foreground: #e5e2e3;
    --color-muted-foreground: #c5c6cc;
    --color-popover: #201f20;
    --color-popover-foreground: #e5e2e3;
```

`--color-border` already exists in both blocks; do not duplicate it.

- [ ] **Step 6: Write the failing palette test**

Create `frontend/src/components/dither-kit/palette.test.ts`:

```ts
import { mix, seedOfColor, rgb, PALETTE_LIGHT, PALETTE_DARK } from "./palette";

describe("mix", () => {
  it("returns the first color at t=0 and the second at t=1", () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0)).toEqual([0, 0, 0]);
    expect(mix([0, 0, 0], [255, 255, 255], 1)).toEqual([255, 255, 255]);
  });

  it("interpolates and rounds at the midpoint", () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
  });
});

describe("palette seeds", () => {
  it("carries the app's light tokens as fills", () => {
    expect(PALETTE_LIGHT.blue.fill).toEqual([19, 115, 217]);    // --color-need
    expect(PALETTE_LIGHT.purple.fill).toEqual([123, 53, 184]);  // --color-want
    expect(PALETTE_LIGHT.green.fill).toEqual([46, 125, 82]);    // --color-save
  });

  it("carries the app's dark tokens as fills", () => {
    expect(PALETTE_DARK.blue.fill).toEqual([150, 205, 255]);
    expect(PALETTE_DARK.green.fill).toEqual([142, 231, 170]);
  });

  it("defines all seven keys in both themes", () => {
    const keys = ["green", "blue", "purple", "pink", "orange", "red", "grey"];
    for (const k of keys) {
      expect(PALETTE_LIGHT).toHaveProperty(k);
      expect(PALETTE_DARK).toHaveProperty(k);
    }
  });

  it("darkens the line tint on light and lightens it on dark", () => {
    // On the warm off-white surface a lighter line would wash out; on the dark
    // surface it must lift off the background.
    const lum = ([r, g, b]: [number, number, number]) => r + g + b;
    expect(lum(PALETTE_LIGHT.blue.line)).toBeLessThan(lum(PALETTE_LIGHT.blue.fill));
    expect(lum(PALETTE_DARK.blue.line)).toBeGreaterThan(lum(PALETTE_DARK.blue.fill));
  });

  it("resolves seeds through the active theme", () => {
    // jsdom reports no dark preference, so the light table is active.
    expect(seedOfColor("blue").fill).toEqual(PALETTE_LIGHT.blue.fill);
  });
});

describe("rgb", () => {
  it("formats an rgba string with scale and alpha", () => {
    expect(rgb([10, 20, 30])).toBe("rgba(10,20,30,1)");
    expect(rgb([10, 20, 30], 1, 0.4)).toBe("rgba(10,20,30,0.4)");
  });
});
```

- [ ] **Step 7: Run the palette test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/dither-kit/palette.test.ts`
Expected: FAIL — `mix`, `PALETTE_LIGHT`, `PALETTE_DARK` are not exported by the upstream file.

- [ ] **Step 8: Fork `palette.ts`**

Replace the whole file `frontend/src/components/dither-kit/palette.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// FORKED FROM UPSTREAM dither-kit 0.1.0.
// Upstream ships seven hardcoded RGB seeds tuned for dark surfaces. This app has
// its own token palette and both a light and a dark theme, so the seed *values*
// carry our tokens while the seven `DitherColor` keys and the `Seed` shape are
// kept intact — every dither-kit consumer keeps working unchanged.
// A future `shadcn add --diff` will show this file as divergent. That is
// intentional; re-apply the fork rather than accepting upstream.
// ─────────────────────────────────────────────────────────────────────────────

export type Rgb = [number, number, number];

export type DitherColor =
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "orange"
  | "red"
  | "grey";

export type Seed = { fill: Rgb; line: Rgb; star: Rgb };

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** Linear per-channel blend, rounded. `t` is how far from `a` toward `b`. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Upstream derives `line` and `star` as successively lighter tints of `fill`,
// which works on its dark canvas. On our warm off-white surface a lighter line
// washes out, so the light table tints toward black instead. Same relationship,
// mirrored for the background it sits on.
const light = (fill: Rgb): Seed => ({
  fill,
  line: mix(fill, BLACK, 0.25),
  star: mix(fill, BLACK, 0.4),
});
const dark = (fill: Rgb): Seed => ({
  fill,
  line: mix(fill, WHITE, 0.45),
  star: mix(fill, WHITE, 0.7),
});

/** Light theme — values are the `@theme` tokens in styles/app.css. */
export const PALETTE_LIGHT: Record<DitherColor, Seed> = {
  blue: light([19, 115, 217]),    // --color-need   #1373d9
  purple: light([123, 53, 184]),  // --color-want   #7b35b8
  green: light([46, 125, 82]),    // --color-save   #2e7d52
  red: light([220, 38, 38]),      // --color-bad    #dc2626
  orange: light([180, 83, 9]),    // --color-warn   #b45309
  pink: light([0, 79, 155]),      // --color-accent #004f9b
  grey: light([69, 71, 74]),      // --color-muted  #45474a
};

/** Dark theme — values are the prefers-color-scheme: dark overrides. */
export const PALETTE_DARK: Record<DitherColor, Seed> = {
  blue: dark([150, 205, 255]),    // --color-need   #96cdff
  purple: dark([199, 166, 232]),  // --color-want   #c7a6e8
  green: dark([142, 231, 170]),   // --color-save   #8ee7aa
  red: dark([252, 165, 165]),     // --color-bad    #fca5a5
  orange: dark([254, 231, 138]),  // --color-warn   #fee78a
  pink: dark([190, 230, 255]),    // --color-accent #bee6ff
  grey: dark([197, 198, 204]),    // --color-muted  #c5c6cc
};

// Theme tracking. The canvas paints raw RGB, so it cannot inherit a CSS var —
// the active table is resolved here and consumers re-render via useDitherTheme.
const QUERY = "(prefers-color-scheme: dark)";

function mql(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;
}

export function isDarkTheme(): boolean {
  return mql()?.matches ?? false;
}

/** Subscribe to OS theme flips. Returns an unsubscribe function. */
export function subscribeDitherTheme(cb: () => void): () => void {
  const m = mql();
  if (!m) return () => {};
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

export const rgb = ([r, g, b]: Rgb, k = 1, a = 1) =>
  `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`;

export const seedOfColor = (color: DitherColor): Seed =>
  (isDarkTheme() ? PALETTE_DARK : PALETTE_LIGHT)[color];

export const isDitherColor = (value: unknown): value is DitherColor =>
  typeof value === "string" && value in PALETTE_LIGHT;
```

- [ ] **Step 9: Run the palette test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/dither-kit/palette.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 10: Add the theme hook**

Create `frontend/src/hooks/useDitherTheme.ts`:

```ts
import { useSyncExternalStore } from "react";
import { isDarkTheme, subscribeDitherTheme } from "../components/dither-kit/palette";

/**
 * True when the OS is in dark mode. Dither canvases paint raw RGB rather than
 * CSS vars, so they cannot repaint on a theme flip by themselves — components
 * call this and feed the result into a `key` or `replayToken` to force a repaint.
 */
export function useDitherTheme(): boolean {
  return useSyncExternalStore(
    subscribeDitherTheme,
    isDarkTheme,
    () => false, // server / no matchMedia: assume light
  );
}
```

- [ ] **Step 11: Add the jsdom stubs**

jsdom ships neither `ResizeObserver` nor a canvas 2D context. Without both, `ctx.ready` never becomes true and every dither chart renders an empty div, so no later test can assert anything.

Append to `frontend/src/test/setup.ts`, following the existing `PointerEvent` polyfill pattern:

```ts
// jsdom has no ResizeObserver. dither-kit measures its container through one
// (use-chart-dimensions.ts) and stays unrendered at 0x0, so report a fixed
// phone-sized box and fire once on observe.
if (typeof window.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      Object.defineProperty(target, "clientWidth", { value: 320, configurable: true });
      Object.defineProperty(target, "clientHeight", { value: 144, configurable: true });
      this.cb([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom has no canvas 2D context. The dither engine calls into it every frame;
// a no-op stub keeps the RAF loop alive without pulling in the `canvas` package.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
    createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set globalAlpha(_v: number) {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
```

- [ ] **Step 12: Write the vendoring README**

Create `frontend/src/components/dither-kit/README.md`:

```markdown
# dither-kit (vendored)

Ordered-dither canvas charts, vendored from the [dither-kit](https://www.tripwire.sh/dither-kit)
shadcn registry. **Not an npm dependency** — these files are source we own.

- Version: `0.1.0`
- Installed: `bunx --bun shadcn@latest add https://tripwire.sh/r/bar-chart.json`
  (pulls `https://tripwire.sh/r/core.json` transitively)
- Only `core` + `bar-chart` are installed. Area, line, pie, radar, sparkline,
  `dither-avatar` and `dither-button` are deliberately not vendored — nothing
  uses them.

## Local changes

- **`palette.ts` is forked.** Upstream's seven seeds are dark-surface arcade
  hues; ours carry the app's design tokens in separate light and dark tables,
  plus `mix`, `isDarkTheme` and `subscribeDitherTheme`. See the header comment
  in that file.

Everything else is upstream-verbatim. To check for upstream changes:

```bash
cd frontend
bunx --bun shadcn@latest add https://tripwire.sh/r/bar-chart.json --dry-run
bunx --bun shadcn@latest add https://tripwire.sh/r/bar-chart.json --diff <file>
```

Never `--overwrite` without re-applying the `palette.ts` fork.

## Notes

- Bars are **vertical only**. Horizontal bars use `components/charts/DitherFill.tsx`,
  which is built on this package's painting primitives.
- The chrome components (`tooltip.tsx`, `x-axis.tsx`, `grid.tsx`) reference
  shadcn token names (`bg-popover`, `text-muted-foreground`, `stroke-border`).
  Those are aliased onto our palette in `src/styles/app.css`.
```

- [ ] **Step 13: Typecheck and run the full suite**

Run: `cd frontend && bunx tsc -b && bun run test`
Expected: both green. The vendored files must typecheck under `strict` with
`noUnusedLocals`/`noUnusedParameters`. If an upstream file trips those, fix it in
place with a minimal edit and add a line to the "Local changes" list in the
README — do not relax the tsconfig.

- [ ] **Step 14: Commit**

```bash
cd /root/Coding/ledger
git add frontend/components.json frontend/tsconfig.json frontend/vite.config.ts \
        frontend/package.json frontend/bun.lock frontend/src/components/dither-kit \
        frontend/src/hooks/useDitherTheme.ts frontend/src/styles/app.css \
        frontend/src/test/setup.ts
git commit -m "feat(charts): vendor dither-kit and bridge it to the app theme

Installs core + bar-chart from the dither-kit registry (24 files, no npm
runtime package). palette.ts is forked to carry our design tokens in
separate light and dark tables; app.css gains the four shadcn token
aliases the vendored chrome references. Test setup stubs ResizeObserver
and the canvas 2D context, without which every dither chart renders an
empty div under jsdom."
```

---

### Task 3: TrendBars → dither BarChart

**Files:**
- Modify: `frontend/src/components/charts/TrendBars.tsx`
- Modify: `frontend/src/components/charts/TrendBars.test.tsx`
- Modify: `frontend/src/lib/trendBars.ts`
- Modify: `frontend/src/lib/trendBars.test.ts`

**Interfaces:**
- Consumes: `BarChart`, `Bar`, `XAxis`, `Tooltip` from Task 2; `useDitherTheme()` from Task 2.
- Produces: `trendRows(points: TrendPoint[]): { period: string; label: string; spent: number }[]` and `activeIndex(points: TrendPoint[], activePeriod?: string): number | null` in `lib/trendBars.ts`. `barHeightPct` stays exported — `lib/flowBars.ts` still uses it.

- [ ] **Step 1: Write the failing lib tests**

Append to `frontend/src/lib/trendBars.test.ts`:

```ts
import { trendRows, activeIndex } from "./trendBars";
import type { TrendPoint } from "./insights";

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", spent: 5000, income: 0 },
  { period: "2026-06", label: "Jun", spent: 10000, income: 0 },
];

describe("trendRows", () => {
  it("projects points onto chart rows, dropping income", () => {
    expect(trendRows(points)).toEqual([
      { period: "2026-05", label: "May", spent: 5000 },
      { period: "2026-06", label: "Jun", spent: 10000 },
    ]);
  });

  it("returns an empty array for an empty series", () => {
    expect(trendRows([])).toEqual([]);
  });
});

describe("activeIndex", () => {
  it("finds the active period's position", () => {
    expect(activeIndex(points, "2026-06")).toBe(1);
  });

  it("returns null when the period is absent or unset", () => {
    expect(activeIndex(points, "2026-01")).toBeNull();
    expect(activeIndex(points, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the lib tests to verify they fail**

Run: `cd frontend && bunx vitest run src/lib/trendBars.test.ts`
Expected: FAIL — `trendRows` and `activeIndex` are not exported.

- [ ] **Step 3: Implement the lib helpers**

Append to `frontend/src/lib/trendBars.ts`:

```ts
import type { TrendPoint } from "./insights";

/** One row per month, in the shape the dither BarChart consumes. */
export function trendRows(points: TrendPoint[]): { period: string; label: string; spent: number }[] {
  return points.map((p) => ({ period: p.period, label: p.label, spent: p.spent }));
}

/** Position of the active month, or null when it isn't in the series. */
export function activeIndex(points: TrendPoint[], activePeriod?: string): number | null {
  if (!activePeriod) return null;
  const i = points.findIndex((p) => p.period === activePeriod);
  return i === -1 ? null : i;
}
```

- [ ] **Step 4: Run the lib tests to verify they pass**

Run: `cd frontend && bunx vitest run src/lib/trendBars.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite the component test**

The per-bar `data-testid` height assertions cannot survive — the bars are canvas
pixels now. Geometry is covered by the lib tests above. Replace the whole file
`frontend/src/components/charts/TrendBars.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { TrendBars } from "./TrendBars";
import type { TrendPoint } from "../../lib/insights";

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", spent: 5000, income: 0 },
  { period: "2026-06", label: "Jun", spent: 10000, income: 0 },
];

describe("TrendBars", () => {
  it("keeps the accessible chart role and label", () => {
    render(<TrendBars points={points} />);
    expect(screen.getByRole("img", { name: /Monthly spending trend/ })).toBeInTheDocument();
  });

  it("summarizes every month in the accessible label", () => {
    render(<TrendBars points={points} />);
    const chart = screen.getByRole("img", { name: /Monthly spending trend/ });
    expect(chart.getAttribute("aria-label")).toMatch(/May: 50\.00/);
    expect(chart.getAttribute("aria-label")).toMatch(/Jun: 100\.00/);
  });

  it("emphasizes only the active month's label", () => {
    render(<TrendBars points={points} activePeriod="2026-06" />);
    expect(screen.getByText("Jun").className).toContain("font-medium");
    expect(screen.getByText("May").className).not.toContain("font-medium");
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<TrendBars points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 6: Run the component test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/charts/TrendBars.test.tsx`
Expected: FAIL — the current component has no per-month summary in its label, no
bolded active label, and renders a bar row rather than nothing when empty.

- [ ] **Step 7: Rewrite the component**

Replace `frontend/src/components/charts/TrendBars.tsx`:

```tsx
import type { TrendPoint } from "../../lib/insights";
import { trendRows, activeIndex } from "../../lib/trendBars";
import { formatFils } from "../../lib/money";
import { BarChart } from "../dither-kit/bar-chart";
import { Bar } from "../dither-kit/bar";
import { Tooltip } from "../dither-kit/tooltip";
import { useDitherTheme } from "../../hooks/useDitherTheme";

/**
 * Monthly spending, as dithered bars. dither-kit colors per *series*, not per
 * *bar*, so the active month is marked with the chart's crosshair
 * (`markerIndex`) and a bolded label rather than a differently-colored bar.
 */
export function TrendBars({ points, activePeriod }: { points: TrendPoint[]; activePeriod?: string }) {
  const dark = useDitherTheme();
  const rows = trendRows(points);
  if (rows.length === 0) return null;

  const summary = rows.map((r) => `${r.label}: ${formatFils(r.spent)}`).join("; ");

  return (
    <div role="img" aria-label={`Monthly spending trend. ${summary}`}>
      {/* `key` on the theme forces a canvas repaint when the OS theme flips —
          the dither is painted in raw RGB and can't inherit a CSS var. */}
      <div className="h-32" key={dark ? "dark" : "light"}>
        <BarChart
          data={rows}
          config={{ spent: { label: "Spent", color: "grey" } }}
          bloom="aura"
          markerIndex={activeIndex(points, activePeriod)}
          margins={{ left: 8, right: 8, bottom: 4, top: 8 }}
        >
          <Bar dataKey="spent" variant="gradient" />
          <Tooltip labelKey="label" valueFormatter={(v) => formatFils(v)} />
        </BarChart>
      </div>

      {/* Month labels stay our own markup: dither-kit's <XAxis> can't carry the
          active-month emphasis, and this keeps the type scale consistent. */}
      <div className="mt-1 flex gap-1.5">
        {rows.map((r) => (
          <div
            key={r.period}
            className={`min-w-0 flex-1 truncate text-center text-[11px] ${
              r.period === activePeriod ? "font-medium text-fg" : "text-muted"
            }`}
          >
            {r.label}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run the component test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/charts/TrendBars.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `cd frontend && bunx tsc -b && bun run test`
Expected: both green. If `screens/Home.test.tsx` fails, it is asserting on the
old bar markup — retarget it to the label text or the chart's accessible name.

- [ ] **Step 10: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/charts/TrendBars.tsx \
        frontend/src/components/charts/TrendBars.test.tsx \
        frontend/src/lib/trendBars.ts frontend/src/lib/trendBars.test.ts \
        frontend/src/screens/Home.test.tsx
git commit -m "feat(charts): TrendBars renders as a dither BarChart

Bar geometry moves to the canvas, so the per-bar height assertions move
down to lib/trendBars.ts as trendRows/activeIndex. The active month is
now the chart crosshair plus a bolded label — dither-kit colors per
series, not per bar, so an accent-colored single bar isn't expressible."
```

---

### Task 4: FlowBars → dither BarChart with the net lane preserved

The diverging shape is native: `computeBands` with `stackType: "stacked"` runs d3's stack layout, which splits negative values below zero, and `bar-canvas.tsx` gives stacked series the full band width. Passing income positive and spending **negated** reproduces today's single column exactly — income above the zero axis, spending below. (`stackType: "default"` would place the two series side by side, which is wrong here.)

The net lane, net thread, net labels and the In/Out legend stay in our own markup — a dither `BarChart` cannot host a line series, and they are the chart's signature.

**Files:**
- Modify: `frontend/src/components/charts/FlowBars.tsx`
- Modify: `frontend/src/components/charts/FlowBars.test.tsx`
- Modify: `frontend/src/lib/flowBars.ts`
- Modify: `frontend/src/lib/flowBars.test.ts`

**Interfaces:**
- Consumes: `BarChart`, `Bar`, `Tooltip`, `useDitherTheme` (Task 2); `flowColumns`, `compactFils`, `FlowColumn`, `NetSign` (existing).
- Produces: `flowRows(cols: FlowColumn[]): { period: string; label: string; income: number; spent: number }[]` in `lib/flowBars.ts`, where `spent` is **negated**.

- [ ] **Step 1: Write the failing lib test**

Append to `frontend/src/lib/flowBars.test.ts`:

```ts
import { flowColumns, flowRows } from "./flowBars";
import type { TrendPoint } from "./insights";

const pts: TrendPoint[] = [
  { period: "2026-05", label: "May", income: 200000, spent: 100000 },
  { period: "2026-06", label: "Jun", income: 50000, spent: 100000 },
];

describe("flowRows", () => {
  it("negates spending so stacked bars diverge around zero", () => {
    expect(flowRows(flowColumns(pts))).toEqual([
      { period: "2026-05", label: "May", income: 200000, spent: -100000 },
      { period: "2026-06", label: "Jun", income: 50000, spent: -100000 },
    ]);
  });

  it("leaves a zero month at zero rather than negative zero", () => {
    const zero = flowRows(flowColumns([{ period: "2026-07", label: "Jul", income: 0, spent: 0 }]));
    expect(Object.is(zero[0].spent, -0)).toBe(false);
    expect(zero[0].spent).toBe(0);
  });

  it("returns an empty array for an empty series", () => {
    expect(flowRows([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the lib test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/flowBars.test.ts`
Expected: FAIL — `flowRows` is not exported.

- [ ] **Step 3: Implement `flowRows`**

Append to `frontend/src/lib/flowBars.ts`:

```ts
/**
 * Chart rows for the dithered bars. Spending is negated so a `stacked` bar
 * chart splits it below the zero axis — d3's stack layout puts negative values
 * under the baseline, which is exactly the in-above / out-below shape this
 * chart has always had. `|| 0` keeps a zero month off negative zero.
 */
export function flowRows(cols: FlowColumn[]): { period: string; label: string; income: number; spent: number }[] {
  return cols.map((c) => ({
    period: c.period,
    label: c.label,
    income: c.income,
    spent: -c.spent || 0,
  }));
}
```

- [ ] **Step 4: Run the lib test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/flowBars.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the component test**

The `flow-in-*` / `flow-out-*` height assertions go (canvas); everything else in
this file is our own markup and must keep passing. Replace the first `it` block
in `frontend/src/components/charts/FlowBars.test.tsx` — the one titled
`"scales income and spending against one shared max"` — with:

```tsx
  it("renders a dithered bar canvas for the series", () => {
    const { container } = render(<FlowBars points={points} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });
```

Leave the other five tests (`shows a signed net figure per month`,
`emphasizes only the active month's label`, `exposes an accessible summary of
every month`, `renders a net-lane dot per month`, `renders nothing for an empty
series`) **exactly as they are** — the net lane, labels and legend are unchanged
markup and are the regression net for this task.

- [ ] **Step 6: Run the component test to verify the canvas assertion fails**

Run: `cd frontend && bunx vitest run src/components/charts/FlowBars.test.tsx`
Expected: FAIL on `renders a dithered bar canvas for the series` — the current
component renders divs. The other five must still PASS.

- [ ] **Step 7: Swap the bar block for a BarChart**

In `frontend/src/components/charts/FlowBars.tsx`:

Add to the imports:

```tsx
import { flowColumns, flowRows, compactFils, type NetSign } from "../../lib/flowBars";
import { BarChart } from "../dither-kit/bar-chart";
import { Bar } from "../dither-kit/bar";
import { Tooltip } from "../dither-kit/tooltip";
import { useDitherTheme } from "../../hooks/useDitherTheme";
```

Inside the component, after `const cols = useMemo(...)`:

```tsx
  const dark = useDitherTheme();
  const rows = useMemo(() => flowRows(cols), [cols]);
```

Then replace the whole `<div className="relative h-36" role="img" ...>` block —
the bars, the per-column `flow-in-*`/`flow-out-*` divs and the zero axis — with:

```tsx
      <div
        className="relative h-36"
        role="img"
        aria-label={`Money in vs out over ${n} months. ${summary}`}
      >
        {/* `key` on the theme forces a canvas repaint when the OS theme flips. */}
        <div className="absolute inset-0" key={dark ? "dark" : "light"}>
          <BarChart
            data={rows}
            stackType="stacked"
            config={{
              income: { label: "In", color: "green" },
              spent: { label: "Out", color: "grey" },
            }}
            bloom="aura"
            margins={{ left: 8, right: 8, top: 4, bottom: 4 }}
          >
            <Bar dataKey="income" variant="gradient" />
            <Bar dataKey="spent" variant="gradient" />
            <Tooltip labelKey="label" valueFormatter={(v) => formatFils(Math.abs(v))} />
          </BarChart>
        </div>
      </div>
```

Everything below — the net lane, the SVG thread, the dots, the net labels, the
month labels and the legend above — is unchanged. `cx`/`cy` and `threadPts` stay
as they are; they are the net lane's own coordinate box, not the bars'.

Delete the now-unused `NET_DOT`/`NET_TEXT` entries only if they became unused —
they are still used by the net lane, so keep both.

- [ ] **Step 8: Run the component test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/charts/FlowBars.test.tsx`
Expected: PASS, 6 tests. In particular `exposes an accessible summary of every
month` must still pass: dither-kit hardcodes `role="img" aria-label="Chart"` on
its inner SVG, but descendants of a `role="img"` are presentational to assistive
technology, so `getByRole("img")` still resolves to our labelled wrapper. If it
instead finds two elements, add `aria-hidden` to the wrapper div holding the
BarChart and re-run.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `cd frontend && bunx tsc -b && bun run test`
Expected: both green. Fix `screens/Insights.test.tsx` the same way as Task 3 if
it asserted on the old bar markup.

- [ ] **Step 10: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/charts/FlowBars.tsx \
        frontend/src/components/charts/FlowBars.test.tsx \
        frontend/src/lib/flowBars.ts frontend/src/lib/flowBars.test.ts \
        frontend/src/screens/Insights.test.tsx
git commit -m "feat(charts): FlowBars bars render as a stacked dither BarChart

Spending is negated so d3's stack layout splits it below the zero axis,
reproducing the in-above/out-below column exactly. The net lane, net
thread, net labels and In/Out legend stay in our own markup — a dither
BarChart can't host a line series, and they're this chart's signature."
```

---

### Task 5: DitherFill and the two breakdown bars

dither-kit has no horizontal bar layout, so this builds one on its own painting
primitives — same Bayer matrix, same cell size, same off-tier alpha, same bloom
helper — so the texture is pixel-identical to the charts.

**Files:**
- Create: `frontend/src/components/charts/DitherFill.tsx`
- Create: `frontend/src/components/charts/DitherFill.test.tsx`
- Create: `frontend/src/lib/ditherColor.ts`
- Create: `frontend/src/lib/ditherColor.test.ts`
- Modify: `frontend/src/lib/lens.ts` (add `ditherColor` to `BreakdownRow`)
- Modify: `frontend/src/components/insights/LensBreakdown.tsx`
- Modify: `frontend/src/components/insights/ComparativeSummary.tsx`

**Interfaces:**
- Consumes: `BAYER`, `CELL`, `OFF_TIER`, `backingSize`, `bloomLayerStyle`, `BloomInput` from `components/dither-kit/dither-paint`; `rgb`, `seedOfColor`, `DitherColor` from `components/dither-kit/palette`; `useDitherTheme` (Task 2).
- Produces:
  - `DitherFill({ segments, max, height?, bloom?, className? })` where `segments: { value: number; color: DitherColor }[]`
  - `lib/ditherColor.ts` → `bucketDither(bucket: string): DitherColor`, `CATEGORY_DITHER: DitherColor[]`, `categoryDither(i: number): DitherColor`
  - `BreakdownRow.ditherColor: DitherColor` on every row from `bucketRows`, `categoryRows`, `merchantRows`

- [ ] **Step 1: Write the failing color-mapping test**

Create `frontend/src/lib/ditherColor.test.ts`:

```ts
import { bucketDither, categoryDither, CATEGORY_DITHER } from "./ditherColor";
import { CATEGORY_PALETTE } from "./insights";

describe("bucketDither", () => {
  it("maps each budget bucket to its token's dither seed", () => {
    expect(bucketDither("need")).toBe("blue");
    expect(bucketDither("want")).toBe("purple");
    expect(bucketDither("saving")).toBe("green");
  });

  it("falls back to grey for anything else", () => {
    expect(bucketDither("mystery")).toBe("grey");
  });
});

describe("categoryDither", () => {
  it("has one dither seed per CATEGORY_PALETTE entry", () => {
    expect(CATEGORY_DITHER).toHaveLength(CATEGORY_PALETTE.length);
  });

  it("assigns distinct seeds so adjacent ranks stay distinguishable", () => {
    expect(new Set(CATEGORY_DITHER).size).toBe(CATEGORY_DITHER.length);
  });

  it("wraps around past the end of the palette", () => {
    expect(categoryDither(0)).toBe(CATEGORY_DITHER[0]);
    expect(categoryDither(CATEGORY_DITHER.length)).toBe(CATEGORY_DITHER[0]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/ditherColor.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the color mapping**

Create `frontend/src/lib/ditherColor.ts`:

```ts
import type { DitherColor } from "../components/dither-kit/palette";

/**
 * Bridges the app's CSS-var colors to dither-kit's seven seed names. The canvas
 * paints raw RGB and can't read a CSS var, so anything dithered picks its seed
 * here. Keep this in step with `bucketColor` and `CATEGORY_PALETTE` in insights.ts.
 */
export function bucketDither(bucket: string): DitherColor {
  switch (bucket) {
    case "need": return "blue";
    case "want": return "purple";
    case "saving": return "green";
    default: return "grey";
  }
}

/** One seed per CATEGORY_PALETTE entry, in the same rank order. */
export const CATEGORY_DITHER: DitherColor[] = ["blue", "purple", "green", "red", "orange", "pink"];

/** Seed for the category at spend-rank `i`, wrapping past the palette's end. */
export function categoryDither(i: number): DitherColor {
  return CATEGORY_DITHER[i % CATEGORY_DITHER.length];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/ditherColor.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing DitherFill test**

Create `frontend/src/components/charts/DitherFill.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { DitherFill } from "./DitherFill";

describe("DitherFill", () => {
  it("renders a canvas", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "blue" }]} max={100} />,
    );
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("is hidden from assistive tech — callers state the numbers in text", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "blue" }]} max={100} />,
    );
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("survives a zero max without dividing by zero", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 0, color: "blue" }]} max={0} />,
    );
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("survives an empty segment list", () => {
    const { container } = render(<DitherFill segments={[]} max={100} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("applies the requested height", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 1, color: "green" }]} max={1} height={12} />,
    );
    expect(container.firstElementChild).toHaveStyle({ height: "12px" });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd frontend && bunx vitest run src/components/charts/DitherFill.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 7: Implement DitherFill**

Create `frontend/src/components/charts/DitherFill.tsx`:

```tsx
import { useEffect, useRef } from "react";
import {
  BAYER,
  OFF_TIER,
  backingSize,
  bloomLayerStyle,
  type BloomInput,
} from "../dither-kit/dither-paint";
import { rgb, seedOfColor, type DitherColor } from "../dither-kit/palette";
import { useDitherTheme } from "../../hooks/useDitherTheme";

export type DitherSegment = { value: number; color: DitherColor };

/**
 * A horizontal dithered magnitude bar. dither-kit's charts are vertical-only,
 * so this paints the same ordered dither — its Bayer matrix, cell size and
 * off-tier alpha — across a row instead of down a column, keeping the texture
 * identical to the charts beside it. Segments fill left to right; whatever is
 * left of `max` stays track.
 *
 * Rendered aria-hidden: every caller already states the value in text.
 */
export function DitherFill({
  segments,
  max,
  height = 10,
  bloom = "aura",
  className = "",
}: {
  segments: DitherSegment[];
  max: number;
  height?: number;
  bloom?: BloomInput;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bloomRef = useRef<HTMLCanvasElement>(null);
  const dark = useDitherTheme();

  // Segments arrive as a fresh array each render; key the effect on their
  // content so a parent re-render doesn't repaint the canvas needlessly.
  const sig = segments.map((s) => `${s.color}:${s.value}`).join("|");

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!(wrap && canvas)) return;

    const paint = () => {
      const w = Math.max(0, wrap.clientWidth);
      if (w === 0) return;
      const { cols, rows } = backingSize(w, height);
      if (cols <= 0 || rows <= 0) return;

      canvas.width = cols;
      canvas.height = rows;
      const c = canvas.getContext("2d");
      if (!c) return;
      c.clearRect(0, 0, cols, rows);

      const total = max > 0 ? max : 1;
      let x0 = 0;
      for (const seg of segments) {
        const span = Math.round((Math.max(0, seg.value) / total) * cols);
        const seed = seedOfColor(seg.color);
        const end = Math.min(cols, x0 + span);
        for (let x = x0; x < end; x++) {
          for (let y = 0; y < rows; y++) {
            // Ramp density from the bottom up, matching the charts' gradient
            // fill, then threshold it through the shared Bayer matrix.
            const t = rows > 1 ? 1 - y / (rows - 1) : 1;
            const on = t > BAYER[y % 4][x % 4];
            c.fillStyle = rgb(seed.fill, 1, on ? 1 : OFF_TIER);
            c.fillRect(x, y, 1, 1);
          }
        }
        x0 = end;
      }

      const bloomCanvas = bloomRef.current;
      const bc = bloomCanvas?.getContext("2d");
      if (bloomCanvas && bc) {
        bloomCanvas.width = cols;
        bloomCanvas.height = rows;
        bc.clearRect(0, 0, cols, rows);
        bc.drawImage(canvas, 0, 0);
      }
    };

    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(wrap);
    return () => ro.disconnect();
    // `sig` fully captures the segments' content, so `segments` itself is
    // deliberately not a dep — its identity changes on every parent render.
  }, [sig, max, height, dark]);

  const layer = "absolute inset-0 h-full w-full";
  const pixelated = { imageRendering: "pixelated" as const };

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      className={`relative w-full overflow-hidden rounded-full bg-surface-2 ${className}`}
      style={{ height }}
    >
      <canvas ref={canvasRef} className={layer} style={pixelated} />
      <canvas
        ref={bloomRef}
        className={layer}
        style={{ ...pixelated, ...(bloomLayerStyle(bloom, true) ?? { opacity: 0 }) }}
      />
    </div>
  );
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd frontend && bunx vitest run src/components/charts/DitherFill.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 9: Carry a dither seed on every breakdown row**

In `frontend/src/lib/lens.ts`:

Add to the imports:

```ts
import { bucketDither, categoryDither } from "./ditherColor";
import type { DitherColor } from "../components/dither-kit/palette";
```

Add to the `BreakdownRow` interface, after `color: string;`:

```ts
  /** dither-kit seed matching `color` — the canvas can't read a CSS var. */
  ditherColor: DitherColor;
```

Then add the field to each of the three row builders, beside the existing
`color` assignment:

- in `bucketRows`: `ditherColor: bucketDither(b.bucket),`
- in `categoryRows`: `ditherColor: categoryDither(i),`
- in `merchantRows`: `ditherColor: categoryDither(i),`

- [ ] **Step 10: Swap LensBreakdown's bar**

In `frontend/src/components/insights/LensBreakdown.tsx`, add the import:

```tsx
import { DitherFill } from "../charts/DitherFill";
```

and replace the bar div — the `<div className="mt-1.5 h-1.5 rounded-full bg-surface-2 overflow-hidden" aria-hidden>` block and its inner div — with:

```tsx
              <div className="mt-1.5">
                <DitherFill segments={[{ value: r.spent, color: r.ditherColor }]} max={max} height={10} />
              </div>
```

The bar goes from 6px to 10px so the 2px dither cell has room to read. Row
layout, drill-in button, delta badge, share and amount are untouched.

- [ ] **Step 11: Swap ComparativeSummary's split bar**

In `frontend/src/components/insights/ComparativeSummary.tsx`, add the imports:

```tsx
import { DitherFill } from "../charts/DitherFill";
import { bucketDither } from "../../lib/ditherColor";
```

and replace the split-bar block — `<div className="mt-3 flex h-2.5 rounded-full overflow-hidden bg-surface-2" aria-hidden>` and its mapped children — with:

```tsx
      {/* Spending split: one bar showing the need/want/saving proportions. */}
      <div className="mt-3">
        <DitherFill
          segments={buckets.filter((b) => b.spent > 0).map((b) => ({ value: b.spent, color: bucketDither(b.bucket) }))}
          max={total}
          height={12}
        />
      </div>
```

The legend chips below are untouched.

- [ ] **Step 12: Run the affected suites**

Run: `cd frontend && bunx vitest run src/components/insights/ src/lib/lens.test.ts`
Expected: PASS. If a `lens` test constructs a `BreakdownRow` literal, it now
needs `ditherColor` — add the matching seed rather than loosening the type.

- [ ] **Step 13: Run the full suite and typecheck**

Run: `cd frontend && bunx tsc -b && bun run test`
Expected: both green.

- [ ] **Step 14: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/components/charts/DitherFill.tsx \
        frontend/src/components/charts/DitherFill.test.tsx \
        frontend/src/lib/ditherColor.ts frontend/src/lib/ditherColor.test.ts \
        frontend/src/lib/lens.ts frontend/src/lib/lens.test.ts \
        frontend/src/components/insights/LensBreakdown.tsx \
        frontend/src/components/insights/ComparativeSummary.tsx
git commit -m "feat(charts): dither the breakdown bars via a shared DitherFill

dither-kit's bars are vertical-only, so DitherFill paints the same Bayer
matrix, cell size and off-tier alpha across a row instead of down a
column — identical texture, horizontal layout preserved. Bars thicken
(6->10px, 10->12px) so a 2px dither cell has room to read. Breakdown
rows now carry a dither seed alongside their CSS color."
```

---

### Task 6: Documentation and embedded bundle

**Files:**
- Modify: `CLAUDE.md`
- Modify: `frontend/src/components/README.md`
- Modify: `internal/web/dist/**` (rebuilt artifact)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Fix the stale frontend description in CLAUDE.md**

In the `### Frontend (frontend/src/)` section, the stack line names `recharts`,
which was never a dependency of this project. Replace `recharts` with
`dither-kit (vendored)` and add this paragraph after the `lib/` paragraph:

```markdown
`components/dither-kit/` is **vendored source** from the dither-kit shadcn
registry (charts, v0.1.0) — not an npm package. Only `core` + `bar-chart` are
installed. `palette.ts` is deliberately forked to carry the app's design tokens
in light and dark tables; see `components/dither-kit/README.md` before running
`shadcn add --diff` against it. dither-kit's bars are vertical-only, so
horizontal magnitude bars use `components/charts/DitherFill.tsx`, built on the
same painting primitives.
```

- [ ] **Step 2: Update the component catalog**

In `frontend/src/components/README.md`, add a `DitherFill` entry following the
file's existing format (purpose, when to use, when not to use), and update the
`TrendBars` / `FlowBars` / `LensBreakdown` / `ComparativeSummary` entries to say
they render dithered canvas fills. The `DitherFill` entry must state:

- **Use for** horizontal magnitude or proportion bars that should match the
  charts' dither texture.
- **Don't use for** progress or budget meters — those stay `ProgressBar`, which
  is CSS and stays legible at 6px.
- Minimum useful height is 10px; the dither cell is 2px, so anything thinner
  reads as a flat block.

- [ ] **Step 3: Rebuild the embedded bundle**

Parallel sessions run on `main`, so the committed `internal/web/dist/` must match
the frontend source before this branch is finished.

```bash
cd /root/Coding/ledger/frontend && bun run build
```

Expected: exit 0, writes `../internal/web/dist/`.

- [ ] **Step 4: Verify the Go build still embeds cleanly**

```bash
cd /root/Coding/ledger && CGO_ENABLED=0 go build -o /tmp/ledger-build-check ./cmd/ledger && rm -f /tmp/ledger-build-check
```

Expected: exit 0.

- [ ] **Step 5: Final full verification**

```bash
cd /root/Coding/ledger/frontend && bunx tsc -b && bun run test
cd /root/Coding/ledger && go test ./...
```

Expected: all green. `internal/config` may fail `TestAIConfigEnabledRequiresAPIKey`
if `LEDGER_AI_API_KEY` is set in the environment — that is a known sandbox
false-failure, not a regression from this branch.

- [ ] **Step 6: Commit**

```bash
cd /root/Coding/ledger
git add CLAUDE.md frontend/src/components/README.md internal/web/dist
git commit -m "docs(charts): document dither-kit vendoring; rebuild dist

CLAUDE.md named recharts, which was never a dependency here. Records the
vendored dither-kit directory, the palette.ts fork and the DitherFill
escape hatch for horizontal bars, and catalogs DitherFill."
```

---

## Post-implementation

After Task 6, run the `verify` skill to drive the real PWA on a scratch instance
and look at all four surfaces in both light and dark. Canvas output cannot be
asserted in jsdom, so this manual pass is the only check on what the dither
actually paints. Specifically confirm:

- `bloom="aura"` does not read as haze on the warm off-white background. If it
  does, drop the dial to `"low"` or `"off"` — a prop change in three call sites,
  no structural change.
- The 10px `LensBreakdown` bars read as dithered rather than as flat blocks.
- Dark mode repaints correctly when the OS theme flips.
