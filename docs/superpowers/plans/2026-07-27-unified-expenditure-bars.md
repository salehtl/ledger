# Unified Expenditure Bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every expenditure bar in the app use Home's CSS dot texture, and give Home's bucket bars the palette hues Insights already uses.

**Architecture:** `.dither-mask` (a `radial-gradient` dot grid at a uniform 2px pitch, already in `styles/app.css`) becomes the app's single dotted texture. `DitherFill` stops painting a `<canvas>` and renders masked DOM instead, resolving hues through `var(--color-…)` so the cascade handles theme. `ProgressBar` gains an optional hue. The two components stay separate — they measure different things and have different accessibility contracts — and share only the texture.

**Tech Stack:** React 19, TypeScript, Tailwind v4, Vitest + Testing Library (jsdom), Bun.

**Spec:** `docs/superpowers/specs/2026-07-27-unified-expenditure-bars-design.md`

## Global Constraints

- Work in the worktree at `.claude/worktrees/unified-expenditure-bars`, on branch `worktree-unified-expenditure-bars`. Do **not** `cd` to `/root/Coding/ledger`.
- Money is `int64` fils everywhere. Never introduce floats for money.
- Frontend tests run non-parallel by design (`fileParallelism: false`, `singleFork` in `vite.config.ts`). Do not "fix" this back to parallel.
- Run one test file with `cd frontend && bunx vitest run <path>`; the whole suite with `cd frontend && bun run test`.
- `components/dither-kit/` is **vendored source**. Do not edit or prune files in it, even if this work leaves exports unreferenced.
- Per CLAUDE.md, `frontend/src/components/README.md` is the shared-component catalog and must be updated **in the same commit** as any shared-component change. Each task below that touches a shared component includes its README edit.
- The hero total bar on Home stays monochrome. `ProgressBar` must ignore `color` whenever `onAccent` is set.
- `data-fill` takes the values `"dithered"` and `"solid"` in **both** components. Do not introduce a third spelling.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/lib/paletteColor.ts` | `DitherColor` → CSS var bridge | add `hueVar` |
| `frontend/src/components/ui/ProgressBar.tsx` | spend vs. target, `role="progressbar"` | add `color` prop |
| `frontend/src/screens/Home.tsx` | Home screen | pass bucket hues |
| `frontend/src/components/charts/DitherFill.tsx` | magnitude vs. max, multi-segment | canvas → DOM; narrow `Density` |
| `frontend/src/lib/ditherColor.ts` | bucket → hue / density | collapse `bucketDensity` |
| `frontend/src/lib/lens.ts` | breakdown row model | `density` doc + type |
| `frontend/src/components/insights/{LensBreakdown,ComparativeSummary}.tsx` | Insights bar consumers | follow the signature change |
| `frontend/src/lib/ditherFill.ts` | `segmentBounds` | **unchanged** — reused with `cols = 100` |

---

### Task 1: `hueVar` — the DitherColor → CSS var bridge

`lib/paletteColor.ts` already exists for exactly this reason (project colours must follow the theme, so they store a palette *name* that becomes a `var(--color-…)` the cascade re-resolves). It already asserts at compile time that `PALETTE_NAMES` and `DitherColor` are the same set, so this addition needs no fallback branch — unlike `projectColor`, which must handle legacy hex and unknown strings.

**Files:**
- Modify: `frontend/src/lib/paletteColor.ts`
- Test: `frontend/src/lib/paletteColor.test.ts`

**Interfaces:**
- Consumes: `DitherColor` from `components/dither-kit/palette` (already imported in this file).
- Produces: `hueVar(color: DitherColor): string` — returns `` `var(--color-${color})` ``. Used by Tasks 2 and 4.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/paletteColor.test.ts`:

```ts
describe("hueVar", () => {
  it("resolves a palette hue to its CSS custom property", () => {
    expect(hueVar("amber")).toBe("var(--color-amber)");
    expect(hueVar("lilac")).toBe("var(--color-lilac)");
    expect(hueVar("sage")).toBe("var(--color-sage)");
  });

  it("handles the -deep shades, which are palette names like any other", () => {
    expect(hueVar("azure-deep")).toBe("var(--color-azure-deep)");
  });

  it("covers every palette name — a hue with no var would render as nothing", () => {
    // var(--color-chartreuse) is valid CSS that resolves to nothing, so a
    // missing var fails silently at runtime. This is the guard against that.
    for (const name of PALETTE_NAMES) {
      expect(hueVar(name)).toBe(`var(--color-${name})`);
    }
  });
});
```

Add `hueVar` to the existing import at the top of that file — line 1 is already
`import { projectColor, PALETTE_NAMES, isPaletteName } from "./paletteColor";`,
so `PALETTE_NAMES` is in scope.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/paletteColor.test.ts`
Expected: FAIL — `hueVar is not a function` (or a TS error that it is not exported).

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/lib/paletteColor.ts`:

```ts
/**
 * CSS colour for a categorical palette hue.
 *
 * No fallback branch, unlike `projectColor`: the compile-time assertion above
 * pins `PALETTE_NAMES` to `DitherColor`, so a `DitherColor` is always a name
 * with a matching `--color-…` var in both the light and dark tables.
 *
 * Anything painted in the DOM rather than on canvas should come through here,
 * so an OS theme flip is handled by the cascade instead of a `useDitherTheme()`
 * subscription and a repaint.
 */
export function hueVar(color: DitherColor): string {
  return `var(--color-${color})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/paletteColor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/paletteColor.ts frontend/src/lib/paletteColor.test.ts
git commit -m "feat(color): hueVar resolves a palette hue to its CSS var"
```

---

### Task 2: `ProgressBar` accepts a hue

Additive and isolated — no existing call site passes `color`, so every current
behaviour is unchanged. The hero guard is part of this task, not a later one:
`onAccent` must win over `color` so no future call site can tint the hero.

**Files:**
- Modify: `frontend/src/components/ui/ProgressBar.tsx`
- Modify: `frontend/src/components/README.md:224-228` (the `### ProgressBar` entry)
- Test: `frontend/src/components/ui/ProgressBar.test.tsx`

**Interfaces:**
- Consumes: `hueVar(color: DitherColor): string` from `lib/paletteColor` (Task 1).
- Produces: `ProgressBar` gains optional `color?: DitherColor`. Absent → today's `bg-fg` / `bg-hero-fg`. Present with `onAccent` → ignored. Used by Task 3.

- [ ] **Step 1: Write the failing test**

Append to the `describe("ProgressBar", …)` block in `frontend/src/components/ui/ProgressBar.test.tsx`:

```tsx
it("paints the fill in the given hue instead of the default ink", () => {
  const { getByRole } = render(<ProgressBar pct={0.5} color="amber" label="Needs" />);
  const fill = getByRole("progressbar").querySelector("[data-fill]") as HTMLElement;
  expect(fill.style.background).toBe("var(--color-amber)");
  expect(fill.className).not.toContain("bg-fg");
});

it("keeps the default ink when no hue is given", () => {
  const { getByRole } = render(<ProgressBar pct={0.5} label="Needs" />);
  const fill = getByRole("progressbar").querySelector("[data-fill]") as HTMLElement;
  expect(fill.className).toContain("bg-fg");
  expect(fill.style.background).toBe("");
});

it("onAccent overrides a hue — the hero totals all three buckets, so no single bucket hue is honest for it, and mid-chroma ink on the accent ground is a contrast problem", () => {
  const { getByRole } = render(<ProgressBar pct={0.5} color="amber" onAccent />);
  const fill = getByRole("progressbar").querySelector("[data-fill]") as HTMLElement;
  expect(fill.style.background).toBe("");
  expect(fill.className).toContain("bg-hero-fg");
});

it("a hue still goes solid at or over budget — over is a texture change, not a colour change", () => {
  const { getByRole } = render(<ProgressBar pct={1.2} color="lilac" label="Wants" />);
  const fill = getByRole("progressbar").querySelector("[data-fill]") as HTMLElement;
  expect(fill).toHaveAttribute("data-fill", "solid");
  expect(fill.className).not.toContain("dither-mask");
  expect(fill.style.background).toBe("var(--color-lilac)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/ui/ProgressBar.test.tsx`
Expected: FAIL — the hue tests fail because `background` is `""` (the `color` prop does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `frontend/src/components/ui/ProgressBar.tsx` with:

```tsx
import type { DitherColor } from "../dither-kit/palette";
import { hueVar } from "../../lib/paletteColor";

type Tone = "good" | "warn" | "bad";

/**
 * pct is a fraction (0..1+). Over budget is a *texture* change, not a colour
 * change: under budget the fill is dithered, at or over it fills to solid ink.
 * The `tone` prop still overrides the automatic reading (e.g. to mark by
 * projection rather than spend); "bad" means solid. An optional `pace` fraction
 * draws a vertical "today" marker. `onAccent` styles the track for the hero.
 *
 * `color` paints the fill in a palette hue instead of the default ink, so a
 * bucket bar matches the swatch dot beside its label. It is deliberately
 * ignored under `onAccent`: the hero bar totals all three buckets, so no single
 * bucket hue is honest for it, and mid-chroma ink on the branded accent ground
 * is a contrast problem.
 */
export function ProgressBar({ pct, label, pace, tone, onAccent = false, color }: {
  pct: number; label?: string; pace?: number; tone?: Tone; onAccent?: boolean; color?: DitherColor;
}) {
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const auto: Tone = pct >= 1.0 ? "bad" : pct >= 0.8 ? "warn" : "good";
  const solid = (tone ?? auto) === "bad";
  const track = onAccent ? "bg-hero-fg/25" : "bg-surface-2";
  const marker = onAccent ? "bg-hero-fg" : "bg-fg/70";
  const ink = onAccent ? "bg-hero-fg" : "bg-fg";
  const hue = !onAccent && color !== undefined ? hueVar(color) : undefined;
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`relative h-3 w-full overflow-hidden rounded-[var(--radius)] ${track}`}
    >
      <div
        data-fill={solid ? "solid" : "dithered"}
        className={`h-full transition-[width] duration-300 ${hue ? "" : ink} ${solid ? "" : "dither-mask"}`}
        style={{ width: `${clamped}%`, ...(hue ? { background: hue } : {}) }}
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/ui/ProgressBar.test.tsx`
Expected: PASS — all tests, including the pre-existing ones (the `bg-fg` / `bg-hero-fg` assertions still hold because no call site passes `color` yet).

- [ ] **Step 5: Update the component catalog**

Replace the `### ProgressBar` entry in `frontend/src/components/README.md` (currently lines 224–228) with:

```markdown
### ProgressBar
- **Purpose:** budget progress with auto tone signaled by texture: under budget
  (pct < 1.0) renders dithered, at or over budget (pct ≥ 1.0) fills solid ink.
  An optional `tone` prop overrides the automatic reading. Includes optional
  pace marker and `onAccent` variant for the hero panel.
- **`color`** paints the fill in a palette hue (`DitherColor`) instead of the
  default ink, so a bucket bar matches the swatch dot beside its label. Pass
  `bucketDither(bucket)` from `lib/ditherColor.ts` — never a literal — so the
  bar, the dot, and Insights' bars stay one mapping.
- **`color` is ignored under `onAccent`, on purpose.** The hero bar totals all
  three buckets, so no single bucket hue is honest for it, and mid-chroma ink on
  the branded accent ground is a contrast problem. The guard is in the component,
  not left to call sites.
- Shares its dot texture (`.dither-mask`, `styles/app.css`) with `DitherFill`.
  That class is the app's one definition of "dotted" — change it there, not by
  adding a second mask.
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ui/ProgressBar.tsx frontend/src/components/ui/ProgressBar.test.tsx frontend/src/components/README.md
git commit -m "feat(ui): ProgressBar can paint its fill in a palette hue"
```

---

### Task 3: Home's bucket bars get their hues

The swatch dot beside each bucket label already resolves through
`bucketColor(b.bucket)` (`--color-need` → `--color-amber`). The bar now resolves
through `bucketDither(b.bucket)` (`"amber"` → `--color-amber`) — the same ink by
two routes, which is why both must come from `lib/ditherColor.ts` rather than a
literal.

**Files:**
- Modify: `frontend/src/screens/Home.tsx` (import list, and the bucket `ProgressBar` at ~line 157)
- Test: `frontend/src/screens/Home.test.tsx`

**Interfaces:**
- Consumes: `ProgressBar`'s `color` prop (Task 2); `bucketDither(bucket: string): DitherColor` from `lib/ditherColor` (existing, unchanged).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/screens/Home.test.tsx`, inside its top-level `describe`.
The file already has a `wrap()` helper (it mounts `Home` inside a
`QueryClientProvider`) and a `beforeEach` fetch stub whose `summary` fixture has
`need` at `pct_used` 0.7, `want` 0.9, `saving` 0.92 — all under budget, so all
three bars render dithered. Use `wrap()`; do not add a new fetch stub.

```tsx
it("paints each bucket bar in its own hue, matching the swatch beside its label", async () => {
  wrap();
  const fillOf = async (label: string) => {
    const bar = await screen.findByLabelText(label);
    return (bar.querySelector("[data-fill]") as HTMLElement).style.background;
  };
  expect(await fillOf("Needs budget used")).toBe("var(--color-amber)");
  expect(await fillOf("Wants budget used")).toBe("var(--color-lilac)");
  expect(await fillOf("Savings budget used")).toBe("var(--color-sage)");
});

it("leaves the hero total bar monochrome — it sums all three buckets, so no single bucket hue is honest for it", async () => {
  wrap();
  const hero = await screen.findByLabelText("Total budget used");
  const fill = hero.querySelector("[data-fill]") as HTMLElement;
  expect(fill.style.background).toBe("");
  expect(fill.className).toContain("bg-hero-fg");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/screens/Home.test.tsx`
Expected: FAIL on the first test — each bucket fill's `background` is `""` because Home passes no `color`. The hero test should already PASS; that is intentional, it is a regression guard.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/screens/Home.tsx`, add the import:

```tsx
import { bucketDither } from "../lib/ditherColor";
```

Then add `color` to the bucket bar (the one with the `${name} budget used` label, ~line 157):

```tsx
<ProgressBar pct={b.pct_used} pace={pace} tone={tone} color={bucketDither(b.bucket)} label={`${name} budget used`} />
```

Leave the hero `ProgressBar` (~line 123, `label="Total budget used"`) exactly as it is — no `color`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/screens/Home.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/Home.tsx frontend/src/screens/Home.test.tsx
git commit -m "feat(home): bucket bars carry their bucket's hue"
```

---

### Task 4: `DitherFill` renders DOM instead of canvas

The texture swap. `Density` keeps all four members for now so no call site
changes and the build stays green — `dense`/`medium`/`sparse` all render the one
dot mask, `solid` renders solid. Task 5 narrows the type.

`segmentBounds` is reused unchanged with `cols = 100`, giving integer
percentages. Its cumulative-rounding property still earns its place: it pins the
last boundary to 100 when the segments sum to `max`, so a full bar shows no
sliver of leftover track.

**Files:**
- Modify: `frontend/src/components/charts/DitherFill.tsx` (full rewrite)
- Modify: `frontend/src/components/README.md:315-336` (the `### DitherFill` entry, down to but **not** including the `**Bucket encoding…**` bullet — Task 5 owns that)
- Test: `frontend/src/components/charts/DitherFill.test.tsx` (full rewrite)

**Interfaces:**
- Consumes: `hueVar` from `lib/paletteColor` (Task 1); `segmentBounds(values: number[], max: number, cols: number): [number, number][]` from `lib/ditherFill` (existing, unchanged).
- Produces: `DitherFill({ segments, max, height?, className? })`. `bloom` is **removed** — no call site passes it. `Density` and `DitherSegment` keep their current shape for Task 5 to narrow.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `frontend/src/components/charts/DitherFill.test.tsx` with:

```tsx
import { render } from "@testing-library/react";
import { DitherFill } from "./DitherFill";

describe("DitherFill", () => {
  it("renders no canvas — a flat rectangle of one hue never needed one", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "azure" }]} max={100} />,
    );
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("is hidden from assistive tech — callers state the numbers in text", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "azure" }]} max={100} />,
    );
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("paints each segment in its own hue", () => {
    const { container } = render(
      <DitherFill
        segments={[
          { value: 50, color: "amber" },
          { value: 30, color: "lilac" },
        ]}
        max={100}
      />,
    );
    const fills = container.querySelectorAll("[data-fill]");
    expect(fills).toHaveLength(2);
    expect((fills[0] as HTMLElement).style.background).toBe("var(--color-amber)");
    expect((fills[1] as HTMLElement).style.background).toBe("var(--color-lilac)");
  });

  it("sizes each segment by its share of max, leaving the remainder as track", () => {
    const { container } = render(
      <DitherFill
        segments={[
          { value: 50, color: "amber" },
          { value: 30, color: "lilac" },
        ]}
        max={100}
      />,
    );
    const fills = container.querySelectorAll("[data-fill]");
    expect((fills[0] as HTMLElement).style.width).toBe("50%");
    expect((fills[1] as HTMLElement).style.width).toBe("30%");
  });

  it("segments summing to max fill the bar exactly — no sliver of track at the end", () => {
    // segmentBounds rounds cumulative positions rather than each segment's own
    // share, so rounding-down cannot accumulate into a visible gap.
    const { container } = render(
      <DitherFill
        segments={[
          { value: 1, color: "amber" },
          { value: 1, color: "lilac" },
          { value: 1, color: "sage" },
        ]}
        max={3}
      />,
    );
    const total = [...container.querySelectorAll("[data-fill]")]
      .reduce((sum, el) => sum + parseFloat((el as HTMLElement).style.width), 0);
    expect(total).toBe(100);
  });

  it("dots by default and goes solid when a segment is over budget", () => {
    const { container } = render(
      <DitherFill
        segments={[
          { value: 50, color: "amber" },
          { value: 30, color: "lilac", density: "solid" },
        ]}
        max={100}
      />,
    );
    const fills = container.querySelectorAll("[data-fill]");
    expect(fills[0]).toHaveAttribute("data-fill", "dithered");
    expect(fills[0].className).toContain("dither-mask");
    expect(fills[1]).toHaveAttribute("data-fill", "solid");
    expect(fills[1].className).not.toContain("dither-mask");
  });

  it("survives a zero max without dividing by zero", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 0, color: "azure" }]} max={0} />,
    );
    expect((container.querySelector("[data-fill]") as HTMLElement).style.width).toBe("0%");
  });

  it("survives an empty segment list", () => {
    const { container } = render(<DitherFill segments={[]} max={100} />);
    expect(container.querySelectorAll("[data-fill]")).toHaveLength(0);
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it("applies the requested height", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 1, color: "sage" }]} max={1} height={12} />,
    );
    expect(container.firstElementChild).toHaveStyle({ height: "12px" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/charts/DitherFill.test.tsx`
Expected: FAIL — the current component renders `<canvas>` and no `[data-fill]` elements.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `frontend/src/components/charts/DitherFill.tsx` with:

```tsx
import { segmentBounds } from "../../lib/ditherFill";
import { hueVar } from "../../lib/paletteColor";
import type { DitherColor } from "../dither-kit/palette";

/**
 * Whether a segment reads as spending in progress or spending past its limit.
 * Dotted is the resting state; solid means at or over budget — the same
 * texture-not-colour reading `ProgressBar` gives its own fill at `pct >= 1.0`.
 */
export type Density = "dense" | "medium" | "sparse" | "solid";

export type DitherSegment = { value: number; color: DitherColor; density?: Density };

/**
 * A horizontal dotted magnitude bar. Segments fill left to right against `max`;
 * whatever is left of `max` stays track.
 *
 * The texture is `.dither-mask` (`styles/app.css`) — the same class `ProgressBar`
 * uses, and the app's one definition of "dotted". Hues resolve to
 * `var(--color-…)` rather than raw RGB, so an OS theme flip is handled by the
 * cascade instead of a repaint; only canvas consumers (`TrendBars`, `FlowBars`,
 * `SwipeDeck`) need `useDitherTheme()`.
 *
 * This was a `<canvas>` painting a Bayer matrix until the bars were unified. A
 * flat rectangle of one hue never needed one, and the canvas cost a
 * `ResizeObserver`, a repaint effect, and a theme subscription per instance —
 * ~20 of them in a scrolling `LensBreakdown`.
 *
 * Rendered aria-hidden: every caller already states the value in text.
 */
export function DitherFill({
  segments,
  max,
  height = 10,
  className = "",
}: {
  segments: DitherSegment[];
  max: number;
  height?: number;
  className?: string;
}) {
  // cols = 100 makes each boundary a percentage. Rounding cumulative positions
  // rather than each segment's own share keeps segments that sum to `max` from
  // finishing short and showing a sliver of track.
  const bounds = segmentBounds(segments.map((s) => s.value), max, 100);

  return (
    <div
      aria-hidden="true"
      className={`flex w-full overflow-hidden rounded-[var(--radius)] bg-surface-2 ${className}`}
      style={{ height }}
    >
      {segments.map((seg, i) => {
        const [start, end] = bounds[i];
        const solid = seg.density === "solid";
        return (
          <div
            key={i}
            data-fill={solid ? "solid" : "dithered"}
            className={`h-full shrink-0 ${solid ? "" : "dither-mask"}`}
            style={{ width: `${end - start}%`, background: hueVar(seg.color) }}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/charts/DitherFill.test.tsx`
Expected: PASS

- [ ] **Step 5: Verify no call site broke**

Run: `cd frontend && bunx vitest run src/components/insights src/screens/Insights.test.tsx`
Expected: PASS. `LensBreakdown` and `ComparativeSummary` still pass `density` values of `"dense"`/`"medium"`/`"sparse"`, which now all render dotted — no signature change yet.

Run: `cd frontend && bunx tsc -b --force`
Expected: no errors. If `bloom` or `BloomInput` is reported as unused or missing at a call site, a caller was passing `bloom` — remove that prop from the caller.

- [ ] **Step 6: Update the component catalog**

In `frontend/src/components/README.md`, replace the `### DitherFill (charts/)` entry's bullets from `- **Purpose:**` through the `` `bloom` defaults to `"off"` `` bullet (currently lines 316–336) with:

```markdown
- **Purpose:** a horizontal dotted magnitude/proportion bar. Segments fill
  left→right against `max`; the remainder stays track.
- **Use for:** horizontal magnitude or proportion bars (`LensBreakdown`'s row
  bars, `ComparativeSummary`'s need/want/saving split).
- **Don't use for:** progress or budget meters — those stay `ProgressBar`, which
  adds `role="progressbar"`, the pace marker, and spend-vs-target semantics.
- **Texture is `.dither-mask`** (`styles/app.css`), the same class `ProgressBar`
  uses. That class is the app's one definition of "dotted": both bars are the
  same dot grid at the same 2px pitch, differing only in hue. Change the texture
  there, never by adding a second mask.
- **Hues resolve through `hueVar`** (`lib/paletteColor.ts`) to `var(--color-…)`,
  so theme is handled by the cascade. Do not reach for `palette.ts`'s raw RGB
  seeds here — those are for canvas consumers (`TrendBars`, `FlowBars`,
  `SwipeDeck`), which must subscribe via `useDitherTheme()`.
- This was a canvas painting a 4×4 Bayer matrix until the bars were unified. A
  flat rectangle of one hue never needed one, and it cost a `ResizeObserver`, a
  repaint effect, and a theme subscription per instance — ~20 in a scrolling
  `LensBreakdown`. There is no `bloom` prop any more; it was clipped by the
  component's own `overflow-hidden` box at these heights and showed nothing.
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/charts/DitherFill.tsx frontend/src/components/charts/DitherFill.test.tsx frontend/src/components/README.md
git commit -m "refactor(charts): DitherFill paints masked DOM instead of canvas"
```

---

### Task 5: Density stops being an identity channel

Now that both screens share a texture, dot density no longer distinguishes
need/want/saving — hue does. Density narrows to a *state* channel: dotted, or
solid for at-or-over budget.

This is one atomic type change: a half-narrowed exported `Density` does not
compile, so the component, the helper, the row model, and both consumers move
together.

**Why this is safe to lose:** the codebase is already inconsistent about it.
Density was only ever set for the three bucket rows — category and merchant rows
(`categoryRows`, `merchantRows` in `lib/lens.ts`) have always run on hue alone.
Every bucket bar also sits beside its own text label on both screens. This makes
buckets consistent with what categories already do.

**Files:**
- Modify: `frontend/src/components/charts/DitherFill.tsx` (the `Density` type)
- Modify: `frontend/src/lib/ditherColor.ts` (`bucketDensity` + its doc comment)
- Modify: `frontend/src/lib/lens.ts` (the `density` field's doc comment, and `bucketRows`'s doc comment)
- Modify: `frontend/src/lib/swipe.ts:62` (a stale "double-encoded by hue *and* density" comment)
- Modify: `frontend/src/components/README.md` (the `**Bucket encoding…**` bullet, currently lines 337–358)
- Test: `frontend/src/lib/ditherColor.test.ts:26-45`, `frontend/src/lib/lens.test.ts:29-55`

**Interfaces:**
- Consumes: `DitherFill` from Task 4.
- Produces: `Density = "dotted" | "solid"`. `bucketDensity(bucket: string, isOverBudget?: boolean): Density` — returns `"solid"` when `isOverBudget`, else `"dotted"`; the `bucket` argument no longer affects the result and is kept only so call sites and the `BreakdownRow` shape are unchanged.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/ditherColor.test.ts`, replace the whole `describe("bucketDensity", …)` block (currently lines 26–45) with:

```ts
describe("bucketDensity", () => {
  it("is dotted for every bucket — hue tells buckets apart, not texture", () => {
    // Density used to encode bucket identity redundantly with hue. Once Home
    // and Insights shared one dot texture that second channel went away;
    // category and merchant rows had never carried it either.
    expect(bucketDensity("need")).toBe("dotted");
    expect(bucketDensity("want")).toBe("dotted");
    expect(bucketDensity("saving")).toBe("dotted");
  });

  it("is dotted for an unknown bucket", () => {
    expect(bucketDensity("mystery")).toBe("dotted");
  });

  it("goes solid for any bucket at or over budget — texture is now purely a state channel", () => {
    expect(bucketDensity("need", true)).toBe("solid");
    expect(bucketDensity("want", true)).toBe("solid");
    expect(bucketDensity("saving", true)).toBe("solid");
  });

  it("treats an omitted isOverBudget as under budget", () => {
    expect(bucketDensity("need")).toBe(bucketDensity("need", false));
  });
});
```

In `frontend/src/lib/lens.test.ts`, replace the two tests at lines 29–55 (`"assigns the signature density by bucket, not by rank"` and `"overrides a bucket's density to solid when it's in the overBudget set, leaving the others alone"`) with:

```ts
it("gives every bucket row the same dotted texture — identity is carried by hue", () => {
  const buckets = [
    { bucket: "need", spent: 50, prevSpent: 0, delta: 50 },
    { bucket: "want", spent: 30, prevSpent: 0, delta: 30 },
    { bucket: "saving", spent: 20, prevSpent: 0, delta: 20 },
  ] as Parameters<typeof bucketRows>[0];
  for (const row of bucketRows(buckets, 100)) {
    expect(row.density).toBe("dotted");
  }
});

it("marks only the over-budget buckets solid, leaving the others dotted", () => {
  const buckets = [
    { bucket: "need", spent: 50, prevSpent: 0, delta: 50 },
    { bucket: "want", spent: 30, prevSpent: 0, delta: 30 },
    { bucket: "saving", spent: 20, prevSpent: 0, delta: 20 },
  ] as Parameters<typeof bucketRows>[0];
  const rows = bucketRows(buckets, 100, new Set(["want"]));
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.density]));
  expect(byKey.want).toBe("solid");
  expect(byKey.need).toBe("dotted");
  expect(byKey.saving).toBe("dotted");
});
```

If the surrounding file already builds its bucket fixtures via a local helper or shares a `buckets` const across tests, reuse that instead of re-declaring the array — read the file before editing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/lib/ditherColor.test.ts src/lib/lens.test.ts`
Expected: FAIL — `bucketDensity("need")` still returns `"dense"`.

- [ ] **Step 3: Narrow the type**

In `frontend/src/components/charts/DitherFill.tsx`, replace the `Density` declaration with:

```tsx
/**
 * Whether a segment reads as spending in progress or spending past its limit.
 * Dotted is the resting state; solid means at or over budget — the same
 * texture-not-colour reading `ProgressBar` gives its own fill at `pct >= 1.0`.
 *
 * This is a *state* channel only. It used to double as bucket identity
 * (need dense, want medium, saving sparse) back when Insights' bars had no hue
 * of their own; hue carries identity now.
 */
export type Density = "dotted" | "solid";
```

- [ ] **Step 4: Collapse `bucketDensity`**

In `frontend/src/lib/ditherColor.ts`, replace the `bucketDensity` doc comment and function with:

```ts
/**
 * Texture for a bucket's bar: `"solid"` at or over budget, `"dotted"` otherwise —
 * exactly the texture-not-colour reading `ProgressBar` gives its own fill at
 * `pct >= 1.0`, so Home and Insights agree on what "over" looks like.
 *
 * The `bucket` argument no longer affects the result. Density used to encode
 * bucket identity redundantly with hue (need dense, want medium, saving
 * sparse), from when Insights' bars were monochrome. Once both screens shared
 * one dot texture that channel went away, and buckets now read the way category
 * and merchant rows always have: by hue, beside a visible text label. The
 * parameter stays so call sites and `BreakdownRow` are unchanged.
 *
 * This function stays pure and only knows what the caller already determined
 * about spend-vs-target for the period shown; it does not reach for that data
 * itself (see `overBudgetBuckets` in `lib/insights.ts`).
 */
export function bucketDensity(_bucket: string, isOverBudget = false): Density {
  return isOverBudget ? "solid" : "dotted";
}
```

Also update the `bucketDither` doc comment: its first paragraph says the canvas "paints raw RGB and can't read a CSS var". That is now only true of `TrendBars`/`FlowBars`/`SwipeDeck`. Replace that sentence with:

```
 * Which palette hue each budget bucket paints in. Canvas consumers
 * (`TrendBars`, `FlowBars`, `SwipeDeck`) need raw RGB and can't read a CSS var,
 * so the seed is chosen here; DOM consumers pass the same name through
 * `hueVar` (`lib/paletteColor.ts`) and let the cascade resolve it.
```

Leave the ΔE validation paragraph that follows exactly as it is.

- [ ] **Step 5: Fix the row-model comment**

In `frontend/src/lib/lens.ts`, replace the doc comment on `BreakdownRow`'s `density` field (currently lines 25–31) with:

```ts
  /**
   * Bar texture for this row — `"solid"` when the row is at or over budget.
   * Only set for bucket rows, since only buckets have a target to be over.
   * Category and merchant rows leave it undefined, which `DitherFill` renders
   * dotted.
   */
```

And in `bucketRows`'s doc comment (currently lines 47–54), replace the sentence beginning "when a bucket is in it, its density goes `\"solid\"`…" through the end with:

```
 * is in it, its bar renders solid instead of dotted. Omit it (or pass an empty
 * set) where over-budget data isn't available; every bucket then renders dotted.
```

Also update the `ditherColor` field's comment on `BreakdownRow` (lines 17–23): it claims "the canvas paints raw RGB and can't read a CSS var", which is no longer why the field exists. Replace its first sentence with:

```
   * Palette hue for this row's bar, as a name rather than a CSS colour.
```

Leave the rest of that comment (the "no parallel CSS-color field" reasoning) intact — it still holds.

- [ ] **Step 6: Fix the stale swipe comment**

In `frontend/src/lib/swipe.ts`, the comment at ~line 62 reads "Buckets are deliberately double-encoded by hue *and* density — redundancy is an accessibility win, and it is what the charts already do." The swipe rails never carried density at all, and the charts no longer do. Replace those two lines with:

```
 * a dark table. Buckets are told apart by hue, the same mapping the bars and
 * the swatch dots use — `bucketDither` is the single source of truth.
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/lib/ditherColor.test.ts src/lib/lens.test.ts`
Expected: PASS

Run: `cd frontend && bunx tsc -b --force`
Expected: no errors. `ComparativeSummary` and `LensBreakdown` need no code change — they pass `bucketDensity(...)` and `r.density` straight through, and both now yield the narrowed type. If `tsc` reports an error at either, fix it there; do not widen `Density` back.

- [ ] **Step 8: Run the consumers' tests**

Run: `cd frontend && bunx vitest run src/components/insights src/screens/Insights.test.tsx`
Expected: PASS, including `Insights.test.tsx`'s "still renders the buckets lens and its labels when a bucket is over budget" — that test asserts labels and rendering, not density values, so it should be unaffected.

- [ ] **Step 9: Update the component catalog**

In `frontend/src/components/README.md`, replace the whole `- **Bucket encoding (double-encoded for accessibility).**` bullet (currently lines 337–358) with:

```markdown
- **Bucket encoding.** The 50/30/20 buckets are told apart by **hue**:
  `bucketDither` (`lib/ditherColor.ts`) maps amber → needs, lilac → wants,
  sage → saving, and is the single source of truth — the bars, the swatch dots,
  and the swipe rails all resolve through it. The hue is never the sole
  encoding: every call site (`ComparativeSummary`'s legend, `LensBreakdown`'s
  row name, Home's bucket label) states the bucket in visible text next to the
  bar, since the bar itself is `aria-hidden`.
- **Texture is state, not identity.** `bucketDensity` returns `"solid"` at or
  over budget and `"dotted"` otherwise — the same reading as `ProgressBar`'s
  `pct >= 1.0`, and wired to agree with it: `bucketDensity` takes an
  `isOverBudget` flag, and `overBudgetBuckets` (`lib/insights.ts`) turns a
  period's `BucketSummary[]` (`pct_used >= 1.0`) into the set of names callers
  pass in. `Insights.tsx` threads its `summary` query's buckets through to both
  `ComparativeSummary` (`overBudgetBuckets` prop) and `LensBreakdown`'s buckets
  lens (`bucketRows`'s `overBudget` param) so their bars go solid in step with
  Home's `ProgressBar`s for the same period.
- Density used to double as bucket identity (need dense, want medium, saving
  sparse), from when Insights' bars were monochrome and hue was unavailable.
  Once Home and Insights shared one dot texture, hue took over identity — which
  is how category and merchant rows had always worked anyway. Don't reintroduce
  a per-bucket pitch.
- Same **red is rationed** rule as everywhere else: this encoding exists
  specifically so buckets never need another spent-ink use — don't reach for
  `--color-accent` on a bucket bar to "help" it read as urgent.
```

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/charts/DitherFill.tsx frontend/src/lib/ditherColor.ts frontend/src/lib/ditherColor.test.ts frontend/src/lib/lens.ts frontend/src/lib/lens.test.ts frontend/src/lib/swipe.ts frontend/src/components/README.md
git commit -m "refactor(charts): density is a state channel, not bucket identity"
```

---

### Task 6: Full verification and rebuild

The change is purely visual. A green suite proves structure, not that coloured
dots at a 10px bar height actually read — that needs eyes on a device.

**Files:**
- Modify: `internal/web/dist/**` (rebuilt bundle — a committed build artifact)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run the whole frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS, no skips. Fix any fallout before continuing — do not proceed with a red suite.

- [ ] **Step 2: Run the Go suite**

Run: `go test ./...`
Expected: PASS. Nothing here touches Go, so this is a guard against an unrelated break arriving from `main`, not a check of this work.

Note: `internal/config`'s `TestAIConfigEnabledRequiresAPIKey` fails on this box when `LEDGER_AI_API_KEY` is set in the environment. That is a known sandbox false-failure, not a regression from this branch.

- [ ] **Step 3: Confirm nothing still references the removed API**

Run:
```bash
grep -rn "DENSITY_BIAS\|bloom\|BloomInput" frontend/src --include=*.ts --include=*.tsx | grep -v "dither-kit/"
```
Expected: no output. Hits inside `components/dither-kit/` are vendored source and must be left alone.

Run:
```bash
grep -rn "dense\|sparse\|medium" frontend/src/lib/ditherColor.ts frontend/src/lib/lens.ts frontend/src/components/charts/DitherFill.tsx
```
Expected: only prose in doc comments explaining what the old encoding *was*. No live code paths.

- [ ] **Step 4: Rebuild the embedded bundle**

Other sessions run in parallel on `main`, so re-check it first and rebuild the combined dist — the embedded bundle must match the combined frontend source, not just this branch's.

```bash
git fetch origin
git log --oneline -1 origin/main
git merge origin/main
cd frontend && bun install && bun run build
```
Expected: `bun run build` succeeds (it runs `tsc -b` first, so this is also the final typecheck). If the merge brings in frontend changes, re-run `bun run test` before continuing.

- [ ] **Step 5: Build the binary**

```bash
CGO_ENABLED=0 go build -o ledger ./cmd/ledger
```
Expected: builds clean.

- [ ] **Step 6: See it on both screens**

Use the `verify` skill to launch an isolated scratch instance and drive the PWA.

**Do not run the bare binary with a default or empty config** — that binds `:8080` and opens `/var/lib/ledger/ledger.db`, which is the live production instance on this box. Use a scratch `data_dir` and a free port.

Check, in light **and** dark:
- **Home** — the three bucket bars carry amber / lilac / sage and match the swatch dot beside each label. The hero total bar is still monochrome.
- **Insights** — `LensBreakdown` row bars and `ComparativeSummary`'s split bar show the *dot* texture, not the old Bayer texture, and are visibly the same grid as Home's.
- **The two risks from the spec.** (a) Do the dots read as texture on mid-chroma hues against `bg-surface-2`, or do they turn to mud at 10px? The mask was tuned against near-max-contrast `bg-fg`. (b) In `ComparativeSummary`'s 12px bar, three hues meet edge-to-edge, each dropping ~half its pixels to track — are the boundaries still legible? The palette triple was validated for adjacency on *solid* fills.

If either risk lands badly, the fix is a `.dither-mask` tweak in `styles/app.css` (dot radius or pitch) — report back before changing direction, since that class is now shared by both components and a change affects Home too.

- [ ] **Step 7: Commit the rebuilt bundle**

```bash
git add internal/web/dist
git commit -m "build: rebuild embedded bundle for unified expenditure bars"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `.dither-mask` as the one texture | 4 (DitherFill adopts it), 2 (README states the rule) |
| `hueVar` in `lib/paletteColor.ts` | 1 |
| `ProgressBar` gains `color` | 2 |
| Hero bar stays monochrome | 2 (guard in component), 3 (regression test) |
| `DitherFill` canvas → DOM | 4 |
| `bloom` removed | 4 (removed), 6 (grep guard) |
| `segmentBounds` reused with `cols = 100` | 4 |
| `Density` narrows to `"dotted" \| "solid"` | 5 |
| `bucketDensity` collapses; `DENSITY_BIAS` deleted | 5 (collapse), 4 (deletion, with the rewrite), 6 (grep guard) |
| Double-encoding comments rewritten | 5 (`ditherColor.ts`, `lens.ts`, `swipe.ts`, README) |
| `useDitherTheme` survives for canvas consumers | 4 (not touched; asserted in the README bullet) |
| `TrendBars`/`FlowBars` out of scope | never modified by any task |
| Testing plan | 1–5 per task, 6 for the suite |
| Both spec risks | 6, Step 6 |

**Type consistency:** `hueVar(color: DitherColor): string` is defined in Task 1 and consumed with that exact signature in Tasks 2 and 4. `Density` is declared in `DitherFill.tsx` in Task 4 and narrowed in the same file in Task 5; `ditherColor.ts` imports it in both states. `bucketDensity(_bucket, isOverBudget = false): Density` keeps its arity, so `lens.ts:62` and `ComparativeSummary.tsx:35` need no edit. `data-fill` is `"dithered" | "solid"` in both components.

**Known ordering hazard:** Task 4 deletes `DENSITY_BIAS`, which `DitherFill.test.tsx` currently imports. That is safe only because Task 4 replaces that test file wholesale in the same task. Do not land Task 4's component rewrite without its test rewrite.
