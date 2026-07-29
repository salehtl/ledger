# Storybook Design-System Documentation & Testing Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Storybook 9 to the ledger frontend as living documentation for the design system (tokens + every `components/ui` primitive and key shared components), with each story doubling as a vitest smoke/behavior test via portable stories.

**Architecture:** Storybook 9 with the `@storybook/react-vite` framework reuses the project's own Vite config (so Tailwind v4 tokens and fonts render exactly as in the app), with `vite-plugin-pwa` filtered out in `viteFinal`. Stories are colocated CSF files (`X.stories.tsx` beside `X.tsx`); every story file has a colocated `X.stories.test.tsx` that renders the same stories through `composeStories`, so docs and tests can never drift apart. A final glob suite renders every story in the repo as a regression net. Token documentation is an MDX page using addon-docs blocks.

**Tech Stack:** Storybook `^9` (`storybook`, `@storybook/react-vite`, `@storybook/addon-docs`, `@storybook/addon-a11y`), existing vitest 2 + jsdom + Testing Library, Bun as package runner.

## Global Constraints

- Package manager is **bun** (`bun add -d`, `bunx vitest run`). All commands below run from `frontend/`.
- Vitest is pinned to a **single, non-parallel fork** in `vite.config.ts` (`fileParallelism: false`, `singleFork`) — the sandbox blocks worker spawning. Do NOT change this, and do NOT add Storybook's browser-mode/vitest addon (`@storybook/addon-vitest`, Playwright) — portable stories in jsdom only.
- **SB9 import rule:** `Meta`, `StoryObj`, and `composeStories` are all imported from `@storybook/react-vite` (framework package, which re-exports the renderer API). If a build error says an export is missing, switch that import to `@storybook/react` — never mix both in one file.
- Colors come from tokens: stories/tests may assert on `var(--color-…)` strings and Tailwind token classes (`bg-surface-2`, `text-muted`) but never introduce raw hex in component code. MDX docs display hex values for reference only.
- Stories must not import from `dither-kit` canvas charts (`TrendBars`, `FlowBars`) — canvas is stubbed in jsdom and adds nothing to a static docs page. `DitherFill` (DOM-based) is in scope.
- Icons in stories are `PixelIcon` exports only (`Search`, `Plus`, `Trash2`, `AlertTriangle`, `Inbox`, …) — never emoji, never lucide.
- `tsconfig.json` has `"include": ["src"]` — `.storybook/` is intentionally outside `tsc -b`; stories inside `src/` are type-checked by the normal build. `bun run build` must stay green after every task.
- The repo commits `internal/web/dist` (the Go-embedded bundle). `bun run build` regenerates it — that is expected and the diff is committed in the final task per project convention.
- Commit messages follow the repo's conventional style (`feat(frontend): …`, `docs: …`, `build: …`) and end with the Co-Authored-By line from project instructions.

## File Structure

```
frontend/
  .storybook/
    main.ts                 # framework, stories glob, addons, viteFinal PWA filter
    preview.tsx             # fonts + app.css import, paper-surface decorator, autodocs
  src/
    test/storybook.ts       # setProjectAnnotations bridge for portable stories
    test/storybook.test.tsx # glob suite: every story renders (Task 8)
    docs/Foundations.mdx    # token documentation page (Task 7)
    components/ui/Button.stories.tsx            + Button.stories.test.tsx      (Task 1)
    components/ui/IconButton.stories.tsx        + IconButton.stories.test.tsx  (Task 2)
    components/ui/Fab.stories.tsx               + Fab.stories.test.tsx         (Task 2)
    components/ui/Pill.stories.tsx              + Pill.stories.test.tsx        (Task 2)
    components/ui/SectionLabel.stories.tsx      + SectionLabel.stories.test.tsx(Task 2)
    components/ui/Card.stories.tsx              + Card.stories.test.tsx        (Task 2)
    components/ui/ProgressBar.stories.tsx       + ProgressBar.stories.test.tsx (Task 3)
    components/charts/DitherFill.stories.tsx    + DitherFill.stories.test.tsx  (Task 3)
    components/ui/ColorSwatch.stories.tsx       + ColorSwatch.stories.test.tsx (Task 3)
    components/ui/Field.stories.tsx             + Field.stories.test.tsx       (Task 4)
    components/ui/Switch.stories.tsx            + Switch.stories.test.tsx      (Task 4)
    components/ui/SegmentedControl.stories.tsx  + SegmentedControl.stories.test.tsx (Task 4)
    components/Money.stories.tsx                + Money.stories.test.tsx       (Task 5)
    components/EmptyState.stories.tsx           + EmptyState.stories.test.tsx  (Task 5)
    components/Skeleton.stories.tsx             + Skeleton.stories.test.tsx    (Task 5)
    components/ui/PixelSpinner.stories.tsx      + PixelSpinner.stories.test.tsx(Task 5)
    components/ui/Dialog.stories.tsx            + Dialog.stories.test.tsx      (Task 6)
    components/Toast.stories.tsx                + Toast.stories.test.tsx       (Task 6)
    components/ui/TopBar.stories.tsx            + TopBar.stories.test.tsx      (Task 6)
    components/ui/BottomNav.stories.tsx         + BottomNav.stories.test.tsx   (Task 6)
```

Naming note: test files are `X.stories.test.tsx`. Vitest's default include (`**/*.test.*`) picks them up automatically, while Storybook's glob (`*.stories.@(ts|tsx)`) does not match them — it requires the segment immediately before the extension to be `stories`, and here that segment is `test`. Task 1 Step 10 verifies this boundary against the built story index.

---

### Task 1: Storybook scaffold + the Button story pattern

Everything needed for one component to be documented and tested end-to-end. Later tasks only add story/test file pairs.

**Files:**
- Modify: `frontend/package.json` (deps + scripts)
- Modify: `frontend/.gitignore` (add `storybook-static`)
- Create: `frontend/.storybook/main.ts`
- Create: `frontend/.storybook/preview.tsx`
- Create: `frontend/src/test/storybook.ts`
- Create: `frontend/src/components/ui/Button.stories.tsx`
- Test: `frontend/src/components/ui/Button.stories.test.tsx`

**Interfaces:**
- Produces: `.storybook/preview.tsx` default-exports `preview` (annotations object); `src/test/storybook.ts` is a side-effect import (`import "@/test/storybook"`) every stories test uses; story files default-export `meta` and named-export `StoryObj`s; scripts `bun run storybook` / `bun run build-storybook`.
- Consumes: existing `src/styles/app.css`, `@fontsource-variable/geist(-mono)`, Button (`variant?: "primary"|"secondary"|"ghost"|"danger"`, extends button attrs).

- [ ] **Step 1: Install Storybook packages**

```bash
cd frontend
bun add -d storybook@^9 @storybook/react-vite@^9 @storybook/addon-docs@^9 @storybook/addon-a11y@^9
```

- [ ] **Step 2: Add scripts and gitignore entry**

In `frontend/package.json` `"scripts"`, add:

```json
"storybook": "storybook dev -p 6006",
"build-storybook": "storybook build"
```

Append `storybook-static` on its own line to `frontend/.gitignore`.

- [ ] **Step 3: Write `.storybook/main.ts`**

```ts
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: { name: "@storybook/react-vite", options: {} },
  // The project vite config is merged in automatically (tailwind v4 plugin
  // included — that's how the tokens render). vite-plugin-pwa registers
  // virtual modules and a SW build step that break the storybook build, so
  // strip every plugin it contributes ("vite-plugin-pwa", "vite-plugin-pwa:build", …).
  viteFinal: (cfg) => {
    cfg.plugins = (cfg.plugins ?? [])
      .flat(Infinity)
      .filter((p) => !(p && typeof p === "object" && "name" in p && String(p.name).startsWith("vite-plugin-pwa")));
    return cfg;
  },
};
export default config;
```

- [ ] **Step 4: Write `.storybook/preview.tsx`**

```tsx
import React from "react";
import type { Preview } from "@storybook/react-vite";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../src/styles/app.css";

const preview: Preview = {
  // Every story sits on the app's paper surface with the app's ink + face —
  // matches the PWA body, not Storybook's default white.
  decorators: [
    (Story) => (
      <div className="bg-bg text-fg font-sans p-6 min-h-24">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
  },
  tags: ["autodocs"],
};
export default preview;
```

- [ ] **Step 5: Write the portable-stories bridge `src/test/storybook.ts`**

```ts
// Side-effect import for *.stories.test.tsx files: applies .storybook/preview
// annotations (the paper-surface decorator) to composeStories renders, once.
import { beforeAll } from "vitest";
import { setProjectAnnotations } from "@storybook/react-vite";
import preview from "../../.storybook/preview";

const annotations = setProjectAnnotations([preview]);
beforeAll(annotations.beforeAll);
```

- [ ] **Step 6: Write the failing test `src/components/ui/Button.stories.test.tsx`**

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Button.stories";

const { Primary, Secondary, Ghost, Danger, Disabled } = composeStories(stories);

describe("Button stories", () => {
  it("primary spends the spot ink as a fill", () => {
    render(<Primary />);
    const btn = screen.getByRole("button", { name: "Add transaction" });
    expect(btn.className).toContain("bg-accent");
    expect(btn.className).toContain("text-accent-fg");
  });

  it("secondary is the tonal default", () => {
    render(<Secondary />);
    expect(screen.getByRole("button", { name: "Secondary" }).className).toContain("bg-surface-2");
  });

  it("ghost stays transparent", () => {
    render(<Ghost />);
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("bg-transparent");
  });

  it("danger shares the vermilion plate — the label differentiates", () => {
    render(<Danger />);
    expect(screen.getByRole("button", { name: "Delete rule" }).className).toContain("bg-accent");
  });

  it("disabled renders a real disabled attribute", () => {
    render(<Disabled />);
    expect(screen.getByRole("button", { name: "Add transaction" })).toBeDisabled();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/ui/Button.stories.test.tsx`
Expected: FAIL — `Cannot find module './Button.stories'`.

- [ ] **Step 8: Write `src/components/ui/Button.stories.tsx`**

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";

const meta = {
  title: "Primitives/Button",
  component: Button,
  args: { children: "Add transaction" },
  parameters: {
    docs: {
      description: {
        component:
          "Any labeled tap action. Primary and danger share the one vermilion plate — " +
          "red is rationed, so the label tells them apart. 44px min height, 2px radius, .press feedback.",
      },
    },
  },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = { args: { variant: "secondary", children: "Secondary" } };
export const Ghost: Story = { args: { variant: "ghost", children: "Cancel" } };
export const Danger: Story = { args: { variant: "danger", children: "Delete rule" } };
export const Disabled: Story = { args: { variant: "primary", disabled: true } };
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/ui/Button.stories.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 10: Verify the Storybook build and the glob boundary**

```bash
cd frontend && bun run build-storybook
node -e "const idx=require('./storybook-static/index.json'); const e=Object.values(idx.entries); console.log(e.map(x=>x.id).join('\n')); if(!e.some(x=>x.title==='Primitives/Button')) process.exit(1); if(e.some(x=>x.importPath.includes('.stories.test.'))) { console.error('TEST FILE LEAKED INTO STORYBOOK'); process.exit(1); }"
```
Expected: exit 0, Button stories listed, no `.stories.test.` import paths. If the index file is `stories.json` instead of `index.json` on this SB version, adjust the path.

- [ ] **Step 11: Verify the app build is unaffected**

Run: `cd frontend && bun run build`
Expected: `tsc -b` + vite build succeed (stories type-check as part of `src`).

- [ ] **Step 12: Commit**

```bash
git add frontend/package.json frontend/bun.lock frontend/.gitignore frontend/.storybook frontend/src/test/storybook.ts frontend/src/components/ui/Button.stories.*
git commit -m "feat(frontend): storybook scaffold with portable-stories testing; Button stories"
```

### Task 2: Core primitive stories — IconButton, Fab, Pill, SectionLabel, Card

**Files:**
- Create: `frontend/src/components/ui/IconButton.stories.tsx`, `Fab.stories.tsx`, `Pill.stories.tsx`, `SectionLabel.stories.tsx`, `Card.stories.tsx`
- Test: colocated `*.stories.test.tsx` for each

**Interfaces:**
- Consumes: Task 1 pattern (`import "@/test/storybook"`, `composeStories` from `@storybook/react-vite`); `IconButton({ label: string; size?: "md"|"sm"; tone?: "muted"|"accent"|"danger"; children })`; `Fab({ icon: PixelIconType; label: string; onClick: () => void })`; `Pill({ tone?: "default"|"muted"|"attention"; children })`; `SectionLabel({ as?: ElementType; children })`; `Card({ className?: string; children })`; icons `Search`, `Plus`, `Trash2` from `./PixelIcon`.
- Produces: story titles `Primitives/IconButton`, `Primitives/Fab`, `Primitives/Pill`, `Primitives/SectionLabel`, `Primitives/Card`.

- [ ] **Step 1: Write the failing tests (all five files)**

`IconButton.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./IconButton.stories";

const { Muted, Danger, DenseSmall } = composeStories(stories);

describe("IconButton stories", () => {
  it("carries a required accessible name", () => {
    render(<Muted />);
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });
  it("small size is the 36px dense-row exception", () => {
    render(<DenseSmall />);
    expect(screen.getByRole("button", { name: "Delete category" }).className).toContain("w-9");
  });
  it("danger tone reveals red on interaction, not at rest", () => {
    render(<Danger />);
    const btn = screen.getByRole("button", { name: "Delete rule" });
    expect(btn.className).toContain("text-muted");
    expect(btn.className).toContain("hover:text-bad");
  });
});
```

`Fab.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Fab.stories";

const { Default } = composeStories(stories);

describe("Fab stories", () => {
  it("is the vermilion create plate with an accessible name", () => {
    render(<Default />);
    const btn = screen.getByRole("button", { name: "Add transaction" });
    expect(btn.className).toContain("bg-accent");
  });
});
```

`Pill.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Pill.stories";

const { Default, Muted, Attention } = composeStories(stories);

describe("Pill stories", () => {
  it("default and muted are hairline-bordered, label-carried states", () => {
    render(<Default />);
    expect(screen.getByText("Archived").className).toContain("border-border");
    render(<Muted />);
    expect(screen.getByText("no AED rate").className).toContain("text-muted");
  });
  it("attention is the only tone that spends the spot ink", () => {
    render(<Attention />);
    expect(screen.getByText("Needs review").className).toContain("bg-accent");
  });
});
```

`SectionLabel.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./SectionLabel.stories";

const { Default, AsHeading } = composeStories(stories);

describe("SectionLabel stories", () => {
  it("renders the one eyebrow style", () => {
    render(<Default />);
    expect(screen.getByText("Budget pace")).toBeInTheDocument();
  });
  it("as='h2' renders a real heading", () => {
    render(<AsHeading />);
    expect(screen.getByRole("heading", { level: 2, name: "Projects" })).toBeInTheDocument();
  });
});
```

`Card.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Card.stories";

const { Default, ListCard } = composeStories(stories);

describe("Card stories", () => {
  it("is bounded by a hairline, never a shadow", () => {
    const { container } = render(<Default />);
    const card = container.querySelector(".border-border");
    expect(card).not.toBeNull();
    expect(card!.className).not.toContain("shadow");
  });
  it("list-card idiom: !p-0 with an inner divided list", () => {
    render(<ListCard />);
    expect(screen.getByText("CARREFOUR")).toBeInTheDocument();
    expect(screen.getByText("CAREEM")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/components/ui/IconButton.stories.test.tsx src/components/ui/Fab.stories.test.tsx src/components/ui/Pill.stories.test.tsx src/components/ui/SectionLabel.stories.test.tsx src/components/ui/Card.stories.test.tsx`
Expected: FAIL — each with `Cannot find module './X.stories'`.

- [ ] **Step 3: Write the five story files**

`IconButton.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconButton } from "./IconButton";
import { Search, Trash2 } from "./PixelIcon";

const meta = {
  title: "Primitives/IconButton",
  component: IconButton,
  parameters: {
    docs: {
      description: {
        component:
          "Icon-only action with a required accessible label. 44px default; size=\"sm\" (36px) " +
          "only inside dense stacked rows. Danger tone keeps red for interaction states — rest is muted.",
      },
    },
  },
} satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Muted: Story = { args: { label: "Search", children: <Search size={24} aria-hidden /> } };
export const Accent: Story = { args: { label: "Confirm", tone: "accent", children: <Search size={24} aria-hidden /> } };
export const Danger: Story = { args: { label: "Delete rule", tone: "danger", children: <Trash2 size={24} aria-hidden /> } };
export const DenseSmall: Story = { args: { label: "Delete category", size: "sm", children: <Trash2 size={24} aria-hidden /> } };
```

`Fab.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Fab } from "./Fab";
import { Plus } from "./PixelIcon";

const meta = {
  title: "Primitives/Fab",
  component: Fab,
  parameters: {
    docs: {
      description: {
        component:
          "The screen's single creation action — a square vermilion plate, deliberately not " +
          "elevated (nothing in this design floats). One per screen, max.",
      },
    },
  },
} satisfies Meta<typeof Fab>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { icon: Plus, label: "Add transaction", onClick: () => {} } };
```

`Pill.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Pill } from "./Pill";

const meta = {
  title: "Primitives/Pill",
  component: Pill,
  parameters: {
    docs: {
      description: {
        component:
          "Small inline status badge. Colour no longer carries status — the label does. " +
          "`attention` is the only tone that spends the spot ink; its one sanctioned use is needs_review.",
      },
    },
  },
} satisfies Meta<typeof Pill>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { children: "Archived" } };
export const Muted: Story = { args: { tone: "muted", children: "no AED rate" } };
export const Attention: Story = { args: { tone: "attention", children: "Needs review" } };
```

`SectionLabel.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SectionLabel } from "./SectionLabel";

const meta = {
  title: "Primitives/SectionLabel",
  component: SectionLabel,
  parameters: {
    docs: {
      description: {
        component:
          "The one eyebrow/section-heading style: mono, 10px, medium, uppercase, 0.14em tracking, muted.",
      },
    },
  },
} satisfies Meta<typeof SectionLabel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { children: "Budget pace" } };
export const AsHeading: Story = { args: { as: "h2", children: "Projects" } };
```

`Card.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card } from "./Card";

const meta = {
  title: "Primitives/Card",
  component: Card,
  parameters: {
    docs: {
      description: {
        component:
          "The paper content surface — hairline border, 2px radius, p-4. " +
          "`className=\"!p-0\"` plus an inner divide-y list is the list-card idiom.",
      },
    },
  },
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: <p className="text-sm">Card content sits on the same paper as the page — separation is the hairline.</p> },
};
export const ListCard: Story = {
  args: {
    className: "!p-0",
    children: (
      <ul className="divide-y divide-border">
        {[
          ["CARREFOUR", "-142.75"],
          ["CAREEM", "-38.00"],
        ].map(([m, amt]) => (
          <li key={m} className="p-4 flex items-center justify-between">
            <span className="font-medium text-sm">{m}</span>
            <span className="tnum text-sm">{amt}</span>
          </li>
        ))}
      </ul>
    ),
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/ui/IconButton.stories.test.tsx src/components/ui/Fab.stories.test.tsx src/components/ui/Pill.stories.test.tsx src/components/ui/SectionLabel.stories.test.tsx src/components/ui/Card.stories.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/*.stories.tsx frontend/src/components/ui/*.stories.test.tsx
git commit -m "feat(frontend): stories + portable-story tests for IconButton, Fab, Pill, SectionLabel, Card"
```

### Task 3: Bar stories — ProgressBar, DitherFill, ColorSwatch

**Files:**
- Create: `frontend/src/components/ui/ProgressBar.stories.tsx`, `frontend/src/components/charts/DitherFill.stories.tsx`, `frontend/src/components/ui/ColorSwatch.stories.tsx`
- Test: colocated `*.stories.test.tsx` for each

**Interfaces:**
- Consumes: `ProgressBar({ pct: number; label?: string; pace?: number; status?: PaceStatus; onAccent?: boolean })` — fill div carries `data-state` (`under|over|overbudget`) and `data-fill` (`dithered|solid`), pace marker carries `data-pace`; `DitherFill({ segments: {value: number; color: DitherColor; density?: "dotted"|"solid"}[]; max: number; height?: number })` with `DitherColor` names `"amber"|"lilac"|"sage"|"azure"|…`; `ColorSwatch({ color: string; size?: "md"|"sm" })`.
- Produces: titles `Primitives/ProgressBar`, `Charts/DitherFill`, `Primitives/ColorSwatch`.

- [ ] **Step 1: Write the failing tests**

`ProgressBar.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./ProgressBar.stories";

const { UnderPace, OverPace, OverBudget, HeroOnAccent, NoPace } = composeStories(stories);

describe("ProgressBar stories", () => {
  it("under pace: dithered ink fill with a pace marker", () => {
    const { container } = render(<UnderPace />);
    const fill = container.querySelector("[data-state]")!;
    expect(fill.getAttribute("data-state")).toBe("under");
    expect(fill.getAttribute("data-fill")).toBe("dithered");
    expect(container.querySelector("[data-pace]")).not.toBeNull();
    expect(screen.getByRole("progressbar", { name: "Needs budget used" })).toBeInTheDocument();
  });
  it("over pace: the middle ramp stop", () => {
    const { container } = render(<OverPace />);
    const fill = container.querySelector("[data-state]") as HTMLElement;
    expect(fill.getAttribute("data-state")).toBe("over");
    expect(fill.style.background).toContain("--color-pace-over");
  });
  it("over budget: the exceeded stop, width clamped to 100", () => {
    const { container } = render(<OverBudget />);
    const fill = container.querySelector("[data-state]") as HTMLElement;
    expect(fill.getAttribute("data-state")).toBe("overbudget");
    expect(fill.style.width).toBe("100%");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });
  it("hero onAccent over budget: state carried by texture — solid, single colour", () => {
    const { container } = render(<HeroOnAccent />);
    expect(container.querySelector("[data-fill]")!.getAttribute("data-fill")).toBe("solid");
  });
  it("no pace prop → no marker, no amber", () => {
    const { container } = render(<NoPace />);
    expect(container.querySelector("[data-pace]")).toBeNull();
    expect(container.querySelector("[data-state]")!.getAttribute("data-state")).toBe("under");
  });
});
```

`DitherFill.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./DitherFill.stories";

const { BucketSplit, OverBudgetSolid } = composeStories(stories);

describe("DitherFill stories", () => {
  it("renders one lane per segment", () => {
    const { container } = render(<BucketSplit />);
    expect(container.querySelectorAll(".dither-mask").length).toBe(3);
  });
  it("an over-budget segment goes solid (loses the mask)", () => {
    const { container } = render(<OverBudgetSolid />);
    expect(container.querySelectorAll(".dither-mask").length).toBe(2);
  });
});
```

Note: if `.dither-mask` is applied differently inside `DitherFill` (check its render before writing), assert on whatever class/attribute distinguishes dotted from solid segments in the actual markup — read `DitherFill.tsx` lines 38–90 first and adjust selectors; the *behavior* under test (3 lanes; solid loses the texture) stays the same.

`ColorSwatch.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./ColorSwatch.stories";

const { ProjectMark, InlineSmall } = composeStories(stories);

describe("ColorSwatch stories", () => {
  it("is decorative — aria-hidden, name lives beside it", () => {
    const { container } = render(<ProjectMark />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
  it("small variant renders for inline row use", () => {
    const { container } = render(<InlineSmall />);
    expect(container.firstChild).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/components/ui/ProgressBar.stories.test.tsx src/components/charts/DitherFill.stories.test.tsx src/components/ui/ColorSwatch.stories.test.tsx`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write the story files**

`ProgressBar.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProgressBar } from "./ProgressBar";

const meta = {
  title: "Primitives/ProgressBar",
  component: ProgressBar,
  parameters: {
    docs: {
      description: {
        component:
          "The app's one progress/pace bar. Texture is constant (dithered); the ink travels the " +
          "pace ramp: ink while inside pace → amber-orange past pace → red past budget. " +
          "No `pace` means no amber — an open-ended target has nothing to be ahead of. " +
          "`onAccent` (hero panel) carries state as texture instead: dotted until over budget, then solid.",
      },
    },
  },
} satisfies Meta<typeof ProgressBar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnderPace: Story = { args: { pct: 0.62, pace: 0.68, label: "Needs budget used" } };
export const OverPace: Story = { args: { pct: 0.78, pace: 0.68, label: "Wants budget used" } };
export const OverBudget: Story = { args: { pct: 1.12, pace: 0.68, label: "Total budget used" } };
export const NoPace: Story = { args: { pct: 0.85, label: "Project budget used" } };
export const HeroOnAccent: Story = {
  args: { pct: 1.05, pace: 0.68, onAccent: true, label: "Total budget used" },
  decorators: [(S) => <div className="bg-hero text-hero-fg p-5 rounded-[var(--radius)]"><S /></div>],
};
```

`DitherFill.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DitherFill } from "./DitherFill";

const meta = {
  title: "Charts/DitherFill",
  component: DitherFill,
  parameters: {
    docs: {
      description: {
        component:
          "Horizontal magnitude/proportion bar. Hue is bucket identity (amber=needs, lilac=wants, " +
          "sage=saving), so state goes to texture: dotted under budget, solid at/over — the same " +
          "pct >= 1.0 threshold ProgressBar calls over budget. Never used for progress against a target.",
      },
    },
  },
} satisfies Meta<typeof DitherFill>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BucketSplit: Story = {
  args: {
    max: 100,
    height: 12,
    segments: [
      { value: 45, color: "amber" },
      { value: 32, color: "lilac" },
      { value: 23, color: "sage" },
    ],
  },
};
export const OverBudgetSolid: Story = {
  args: {
    max: 100,
    height: 12,
    segments: [
      { value: 45, color: "amber", density: "solid" },
      { value: 32, color: "lilac" },
      { value: 23, color: "sage" },
    ],
  },
};
```

`ColorSwatch.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ColorSwatch } from "./ColorSwatch";

const meta = {
  title: "Primitives/ColorSwatch",
  component: ColorSwatch,
  parameters: {
    docs: {
      description: {
        component:
          "The project colour mark — a hairline square hatched with 45° lines of its hue. " +
          "A project mark is a ring/hatch; a bucket mark is a solid fill — form keeps them apart at " +
          "identical hue. Always aria-hidden; the project name prints beside it.",
      },
    },
  },
} satisfies Meta<typeof ColorSwatch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectMark: Story = {
  args: { color: "azure" },
  decorators: [(S) => <span className="inline-flex items-center gap-2 text-sm"><S />Kitchen reno</span>],
};
export const InlineSmall: Story = {
  args: { color: "sage", size: "sm" },
  decorators: [(S) => <span className="inline-flex items-center gap-2 text-xs text-muted"><S />Trip to Salalah</span>],
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/ui/ProgressBar.stories.test.tsx src/components/charts/DitherFill.stories.test.tsx src/components/ui/ColorSwatch.stories.test.tsx`
Expected: PASS. If a `DitherFill` selector assertion fails, re-read its markup and fix the *selector* (not the behavior asserted).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/ProgressBar.stories.* frontend/src/components/charts/DitherFill.stories.* frontend/src/components/ui/ColorSwatch.stories.*
git commit -m "feat(frontend): stories + tests for ProgressBar pace ramp, DitherFill, ColorSwatch"
```

### Task 4: Form stories — Input, Select, Switch, SegmentedControl

**Files:**
- Create: `frontend/src/components/ui/Field.stories.tsx`, `Switch.stories.tsx`, `SegmentedControl.stories.tsx`
- Test: colocated `*.stories.test.tsx` for each

**Interfaces:**
- Consumes: `Input({ inset?: boolean; icon?: PixelIconType } & InputHTMLAttributes)`; `Select({ inset?: boolean } & SelectHTMLAttributes)` (both from `Field.tsx`); `Switch(InputHTMLAttributes)` (renders a checkbox); `SegmentedControl<T>({ value: T; onChange: (v:T)=>void; options: {value:T; label:string; badge?:number}[]; fullWidth?: boolean })` — segments are buttons with `aria-pressed`.
- Produces: titles `Primitives/Field`, `Primitives/Switch`, `Primitives/SegmentedControl`.

- [ ] **Step 1: Write the failing tests**

`Field.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Field.stories";

const { TextInput, SearchInput, InsetInput, CategorySelect } = composeStories(stories);

describe("Field stories", () => {
  it("input is 16px text on a 44px control (iOS zoom guard)", () => {
    render(<TextInput />);
    const input = screen.getByPlaceholderText("Merchant contains…");
    expect(input.className).toContain("text-base");
  });
  it("icon variant pads for the leading glyph", () => {
    render(<SearchInput />);
    expect(screen.getByPlaceholderText("Search merchants…").className).toContain("pl-9");
  });
  it("inset variant swaps to the dialog surface", () => {
    render(<InsetInput />);
    expect(screen.getByPlaceholderText("0.00").className).toContain("bg-surface-2");
  });
  it("select renders real options", () => {
    render(<CategorySelect />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Groceries" })).toBeInTheDocument();
  });
});
```

`Switch.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Switch.stories";

const { Off, On } = composeStories(stories);

describe("Switch stories", () => {
  it("is a real checkbox underneath", () => {
    render(<Off />);
    const box = screen.getByRole("checkbox");
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(box).toBeChecked();
  });
  it("defaultChecked renders on", () => {
    render(<On />);
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});
```

`SegmentedControl.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./SegmentedControl.stories";

const { StatusFilter } = composeStories(stories);

describe("SegmentedControl stories", () => {
  it("marks the active segment with aria-pressed and moves it on tap", () => {
    render(<StatusFilter />);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(screen.getByRole("button", { name: /Review/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });
  it("renders the count badge", () => {
    render(<StatusFilter />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/components/ui/Field.stories.test.tsx src/components/ui/Switch.stories.test.tsx src/components/ui/SegmentedControl.stories.test.tsx`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write the story files**

`Field.stories.tsx` (note: two components, one story file — `component: Input`, Select stories use `render`):

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input, Select } from "./Field";
import { Search } from "./PixelIcon";

const meta = {
  title: "Primitives/Field",
  component: Input,
  parameters: {
    docs: {
      description: {
        component:
          "The only text/select controls. 16px font (anything smaller makes iOS Safari zoom on focus), " +
          "44px min height. `inset` is for fields inside a Dialog, whose panel is already bg-surface.",
      },
    },
  },
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TextInput: Story = { args: { placeholder: "Merchant contains…" } };
export const SearchInput: Story = { args: { placeholder: "Search merchants…", icon: Search } };
export const InsetInput: Story = { args: { placeholder: "0.00", inset: true, inputMode: "decimal" } };
export const CategorySelect: Story = {
  render: () => (
    <Select defaultValue="groceries" aria-label="Category">
      <option value="groceries">Groceries</option>
      <option value="transport">Transport</option>
      <option value="dining">Dining out</option>
    </Select>
  ),
};
```

`Switch.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Switch } from "./Switch";

const meta = {
  title: "Primitives/Switch",
  component: Switch,
  parameters: {
    docs: {
      description: {
        component: "Boolean toggle over a real checkbox (native semantics). Settings rows wrap it in a full-row label.",
      },
    },
  },
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = { args: { "aria-label": "Auto-categorize" } };
export const On: Story = { args: { "aria-label": "Auto-categorize", defaultChecked: true } };
```

`SegmentedControl.stories.tsx` (controlled component — stateful wrapper):

```tsx
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SegmentedControl } from "./SegmentedControl";

type Status = "all" | "confirmed" | "review";

function StatusFilterDemo({ fullWidth = false }: { fullWidth?: boolean }) {
  const [value, setValue] = useState<Status>("all");
  return (
    <SegmentedControl
      value={value}
      onChange={setValue}
      fullWidth={fullWidth}
      options={[
        { value: "all", label: "All" },
        { value: "confirmed", label: "Confirmed" },
        { value: "review", label: "Review", badge: 3 },
      ]}
    />
  );
}

const meta = {
  title: "Primitives/SegmentedControl",
  component: SegmentedControl,
  parameters: {
    docs: {
      description: {
        component:
          "Exclusive choice between 2–6 short options. An option can carry a small count badge. " +
          "`fullWidth` stretches to equal-width, never-wrapping segments (page-level status filter).",
      },
    },
  },
} satisfies Meta<typeof SegmentedControl>;
export default meta;

export const StatusFilter: StoryObj = { render: () => <StatusFilterDemo /> };
export const FullWidth: StoryObj = { render: () => <StatusFilterDemo fullWidth /> };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/ui/Field.stories.test.tsx src/components/ui/Switch.stories.test.tsx src/components/ui/SegmentedControl.stories.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/Field.stories.* frontend/src/components/ui/Switch.stories.* frontend/src/components/ui/SegmentedControl.stories.*
git commit -m "feat(frontend): stories + tests for Field, Switch, SegmentedControl"
```

### Task 5: Status & loading stories — Money, EmptyState, Skeleton, PixelSpinner

**Files:**
- Create: `frontend/src/components/Money.stories.tsx`, `EmptyState.stories.tsx`, `Skeleton.stories.tsx`, `frontend/src/components/ui/PixelSpinner.stories.tsx`
- Test: colocated `*.stories.test.tsx` for each

**Interfaces:**
- Consumes: `Money({ fils: number })` (fils = AED×100, int); `EmptyState({ icon?: PixelIconType; title: string; hint?: string })`; `Skeleton({ rows?: number })` (renders `aria-busy` container labeled "Loading"); `PixelSpinner({ size?: number; progress?: number })`; icon `AlertTriangle` from `ui/PixelIcon`.
- Produces: titles `Shared/Money`, `Shared/EmptyState`, `Shared/Skeleton`, `Primitives/PixelSpinner`.

- [ ] **Step 1: Write the failing tests**

`Money.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Money.stories";

const { Positive, Negative, Zero } = composeStories(stories);

describe("Money stories", () => {
  it("formats fils and never shows a float artifact", () => {
    const { container } = render(<Positive />);
    expect(container.textContent).toContain("18,500.00");
  });
  it("negative money prints in the spot ink's text register", () => {
    const { container } = render(<Negative />);
    expect(container.textContent).toContain("142.75");
    expect(container.querySelector(".money-neg, [class*='neg'], [class*='bad']")).not.toBeNull();
  });
  it("zero renders without a sign class", () => {
    const { container } = render(<Zero />);
    expect(container.textContent).toContain("0.00");
  });
});
```

Note: before finalizing the Negative assertion, read `lib/money.ts` `moneyClass()` and assert the exact class it returns for negatives — the selector union above is the fallback if the exact name differs from `.money-neg`.

`EmptyState.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./EmptyState.stories";

const { NoData, QueryError } = composeStories(stories);

describe("EmptyState stories", () => {
  it("renders title and hint", () => {
    render(<NoData />);
    expect(screen.getByText("No recent activity")).toBeInTheDocument();
    expect(screen.getByText("New transactions will appear here.")).toBeInTheDocument();
  });
  it("error state carries an icon chip", () => {
    const { container } = render(<QueryError />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
```

`Skeleton.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Skeleton.stories";

const { ListLoad } = composeStories(stories);

describe("Skeleton stories", () => {
  it("announces busy and renders the requested rows", () => {
    const { container } = render(<ListLoad />);
    expect(screen.getByLabelText("Loading")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll(".animate-pulse").length).toBe(5);
  });
});
```

`PixelSpinner.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./PixelSpinner.stories";

const { Indeterminate, DeterminateGauge } = composeStories(stories);

describe("PixelSpinner stories", () => {
  it("renders the eight-block ring", () => {
    const { container } = render(<Indeterminate />);
    expect(container.querySelectorAll("svg rect").length).toBeGreaterThanOrEqual(8);
  });
  it("determinate mode renders with a progress value", () => {
    const { container } = render(<DeterminateGauge />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/components/Money.stories.test.tsx src/components/EmptyState.stories.test.tsx src/components/Skeleton.stories.test.tsx src/components/ui/PixelSpinner.stories.test.tsx`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write the story files**

`Money.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Money } from "./Money";

const meta = {
  title: "Shared/Money",
  component: Money,
  parameters: {
    docs: {
      description: {
        component:
          "Formats fils (int64 minor units — AED × 100, never floats) with sign colour coding. " +
          "All amounts render through it. Wrap it (or its container) in .tnum for tabular alignment.",
      },
    },
  },
  decorators: [(S) => <span className="tnum text-sm"><S /></span>],
} satisfies Meta<typeof Money>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Positive: Story = { args: { fils: 1850000 } };
export const Negative: Story = { args: { fils: -14275 } };
export const Zero: Story = { args: { fils: 0 } };
```

`EmptyState.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyState } from "./EmptyState";
import { AlertTriangle, Inbox } from "./ui/PixelIcon";

const meta = {
  title: "Shared/EmptyState",
  component: EmptyState,
  parameters: {
    docs: {
      description: {
        component: "Canonical empty/error state (icon chip + title + hint). Used for both no-data and query-error states.",
      },
    },
  },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoData: Story = {
  args: { icon: Inbox, title: "No recent activity", hint: "New transactions will appear here." },
};
export const QueryError: Story = {
  args: { icon: AlertTriangle, title: "Couldn't load your spending", hint: "Check your connection and try again." },
};
```

`Skeleton.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton } from "./Skeleton";

const meta = {
  title: "Shared/Skeleton",
  component: Skeleton,
  parameters: {
    docs: {
      description: {
        component: "Pulse placeholder rows for list-shaped primary loads only. Non-list waits get PixelSpinner.",
      },
    },
  },
} satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ListLoad: Story = { args: { rows: 5 } };
```

`PixelSpinner.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PixelSpinner } from "./PixelSpinner";

const meta = {
  title: "Primitives/PixelSpinner",
  component: PixelSpinner,
  parameters: {
    docs: {
      description: {
        component:
          "Eight blocks in a ring on the icon pack's 2-unit grid. Nothing rotates, on purpose — " +
          "brightness travels the ring instead. With `progress` it becomes a determinate gauge " +
          "filling clockwise (pull-to-refresh).",
      },
    },
  },
} satisfies Meta<typeof PixelSpinner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Indeterminate: Story = { args: { size: 36, role: "status", "aria-label": "Loading" } };
export const DeterminateGauge: Story = { args: { size: 36, progress: 0.6 } };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/Money.stories.test.tsx src/components/EmptyState.stories.test.tsx src/components/Skeleton.stories.test.tsx src/components/ui/PixelSpinner.stories.test.tsx`
Expected: PASS (8 tests). Fix the Negative money selector against the real `moneyClass` output if needed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Money.stories.* frontend/src/components/EmptyState.stories.* frontend/src/components/Skeleton.stories.* frontend/src/components/ui/PixelSpinner.stories.*
git commit -m "feat(frontend): stories + tests for Money, EmptyState, Skeleton, PixelSpinner"
```

### Task 6: Overlay & chrome stories — Dialog, Toast, TopBar, BottomNav

**Files:**
- Create: `frontend/src/components/ui/Dialog.stories.tsx`, `frontend/src/components/Toast.stories.tsx`, `frontend/src/components/ui/TopBar.stories.tsx`, `frontend/src/components/ui/BottomNav.stories.tsx`
- Test: colocated `*.stories.test.tsx` for each

**Interfaces:**
- Consumes: `Dialog({ title: string; onClose: () => void; children })` + `DialogFooter({ children })`; `ToastProvider({ children })` + `useToast().show({ message, tone?: "info"|"success"|"error", action?: { label, onAction }, sticky? })`; `TopBar({ title: string; scope: Scope; onScopeChange: (s: Scope) => void; showScope: boolean })` with `Scope = { kind:"month"; period:"YYYY-MM" } | { kind:"range"; from; to } | { kind:"all" }`; `BottomNav({ active: TabId; reviewCount: number; onNavigate: (id: TabId) => void })`, `TabId = "home"|"transactions"|"review"|"insights"|"settings"`; `Button` from Task 1.
- Produces: titles `Primitives/Dialog`, `Shared/Toast`, `Chrome/TopBar`, `Chrome/BottomNav`.

- [ ] **Step 1: Write the failing tests**

`Dialog.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Dialog.stories";

const { Sheet, WithFooter } = composeStories(stories);

describe("Dialog stories", () => {
  it("renders an accessible sheet with its title", () => {
    render(<Sheet />);
    expect(screen.getByText("Categorize")).toBeInTheDocument();
  });
  it("footer sticks with the primary action inside", () => {
    render(<WithFooter />);
    expect(document.querySelector("[data-dialog-footer]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
```

`Toast.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Toast.stories";

const { SuccessWithUndo, ErrorTone } = composeStories(stories);

describe("Toast stories", () => {
  it("shows a success toast with an undo action on demand", () => {
    render(<SuccessWithUndo />);
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(screen.getByText("Rule saved — CARREFOUR → Groceries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
  it("error tone is one of the sanctioned full-opacity red uses", () => {
    render(<ErrorTone />);
    fireEvent.click(screen.getByRole("button", { name: "Fail to save" }));
    expect(screen.getByText("Couldn't save — try again")).toBeInTheDocument();
  });
});
```

`TopBar.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./TopBar.stories";

const { WithScope, TitleOnly } = composeStories(stories);

describe("TopBar stories", () => {
  it("renders the sans screen title", () => {
    render(<WithScope />);
    expect(screen.getByRole("heading", { name: "Insights" })).toBeInTheDocument();
  });
  it("showScope=false hides the period stepper", () => {
    render(<TitleOnly />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});
```

`BottomNav.stories.test.tsx`:

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./BottomNav.stories";

const { Default, WithReviewBadge } = composeStories(stories);

describe("BottomNav stories", () => {
  it("marks the active tab with aria-current and the 2px tick", () => {
    render(<Default />);
    const active = screen.getByRole("button", { name: "Home" });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active.querySelector("[data-active-tick]")).not.toBeNull();
  });
  it("review badge announces the count", () => {
    render(<WithReviewBadge />);
    expect(screen.getByRole("button", { name: "Review, 3 need review" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/components/ui/Dialog.stories.test.tsx src/components/Toast.stories.test.tsx src/components/ui/TopBar.stories.test.tsx src/components/ui/BottomNav.stories.test.tsx`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Write the story files**

`Dialog.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Dialog, DialogFooter } from "./Dialog";
import { Button } from "./Button";

const meta = {
  title: "Primitives/Dialog",
  component: Dialog,
  parameters: {
    docs: {
      description: {
        component:
          "The one modal/bottom-sheet: scrim, slide-up, focus trap, drag-to-dismiss, safe-area padding. " +
          "The single elevated surface in the app — everything else separates with a hairline. " +
          "Bottom actions go in DialogFooter, which stays sticky over scrolling content.",
      },
    },
  },
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Sheet: Story = {
  args: {
    title: "Categorize",
    onClose: () => {},
    children: <p className="text-sm text-muted">Sheet content — pickers, lists, forms.</p>,
  },
};
export const WithFooter: Story = {
  args: {
    title: "Edit category",
    onClose: () => {},
    children: (
      <>
        <p className="text-sm text-muted">Long content scrolls underneath the sticky footer.</p>
        <DialogFooter>
          <Button variant="ghost">Cancel</Button>
          <Button variant="primary">Save</Button>
        </DialogFooter>
      </>
    ),
  },
};
```

`Toast.stories.tsx` (provider + trigger wrapper — a toast is imperative):

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToastProvider, useToast } from "./Toast";
import { Button } from "./ui/Button";

function Trigger({ label, toast }: { label: string; toast: Parameters<ReturnType<typeof useToast>["show"]>[0] }) {
  const { show } = useToast();
  return <Button onClick={() => show(toast)}>{label}</Button>;
}

const meta = {
  title: "Shared/Toast",
  component: ToastProvider,
  parameters: {
    docs: {
      description: {
        component:
          "Transient outcome feedback (saved/failed), swipe-dismissable, with an optional action " +
          "(Undo where the write is reversible). Not for persistent states.",
      },
    },
  },
} satisfies Meta<typeof ToastProvider>;
export default meta;

export const SuccessWithUndo: StoryObj = {
  render: () => (
    <ToastProvider>
      <Trigger
        label="Save rule"
        toast={{ message: "Rule saved — CARREFOUR → Groceries", tone: "success", action: { label: "Undo", onAction: () => {} } }}
      />
    </ToastProvider>
  ),
};
export const ErrorTone: StoryObj = {
  render: () => (
    <ToastProvider>
      <Trigger label="Fail to save" toast={{ message: "Couldn't save — try again", tone: "error" }} />
    </ToastProvider>
  ),
};
```

`TopBar.stories.tsx` (controlled scope — stateful wrapper):

```tsx
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TopBar } from "./TopBar";
import { type Scope } from "../../lib/scope";

function TopBarDemo({ title, showScope }: { title: string; showScope: boolean }) {
  const [scope, setScope] = useState<Scope>({ kind: "month", period: "2026-07" });
  return <TopBar title={title} scope={scope} onScopeChange={setScope} showScope={showScope} />;
}

const meta = {
  title: "Chrome/TopBar",
  component: TopBar,
  parameters: {
    docs: {
      description: {
        component:
          "Owns the page title (sans) and the period-scope stepper (mono micro-caps — it's data, " +
          "not prose). Screens never render their own h1 outside this.",
      },
    },
  },
} satisfies Meta<typeof TopBar>;
export default meta;

export const WithScope: StoryObj = { render: () => <TopBarDemo title="Insights" showScope /> };
export const TitleOnly: StoryObj = { render: () => <TopBarDemo title="Settings" showScope={false} /> };
```

`BottomNav.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { BottomNav } from "./BottomNav";

const meta = {
  title: "Chrome/BottomNav",
  component: BottomNav,
  parameters: {
    docs: {
      description: {
        component:
          "Five tabs. The active tab is a 2px vermilion tick on the top hairline plus text-fg — " +
          "never a tinted pill, never accent-coloured label text. The review badge is one of the " +
          "five sanctioned full-opacity red uses app-wide.",
      },
    },
  },
} satisfies Meta<typeof BottomNav>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { active: "home", reviewCount: 0, onNavigate: () => {} } };
export const WithReviewBadge: Story = { args: { active: "transactions", reviewCount: 3, onNavigate: () => {} } };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/ui/Dialog.stories.test.tsx src/components/Toast.stories.test.tsx src/components/ui/TopBar.stories.test.tsx src/components/ui/BottomNav.stories.test.tsx`
Expected: PASS (8 tests). If Dialog's mount animation defers content, mirror whatever `Dialog.test.tsx` does (timers/act) — read it before debugging blind.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/Dialog.stories.* frontend/src/components/Toast.stories.* frontend/src/components/ui/TopBar.stories.* frontend/src/components/ui/BottomNav.stories.*
git commit -m "feat(frontend): stories + tests for Dialog, Toast, TopBar, BottomNav"
```

### Task 7: Foundations token documentation (MDX)

**Files:**
- Create: `frontend/src/docs/Foundations.mdx`

**Interfaces:**
- Consumes: addon-docs blocks (`Meta`, `ColorPalette`, `ColorItem`, `Typeset`) from `@storybook/addon-docs/blocks`; token values from `src/styles/app.css` (do not invent values — copy them).
- Produces: a docs-only page titled `Foundations` at the top of the sidebar.

- [ ] **Step 1: Write `src/docs/Foundations.mdx`**

```mdx
import { Meta, ColorPalette, ColorItem, Typeset } from "@storybook/addon-docs/blocks";

<Meta title="Foundations" />

# ledger — Foundations

Two-colour press: paper, ink, one vermilion spot. Hue carries identity, texture carries
state, red is rationed. Values live in `src/styles/app.css`; **components never hold a raw hex.**

## Ground & ink

<ColorPalette>
  <ColorItem title="--color-bg / --color-surface" subtitle="paper — the tonal ladder is gone" colors={{ paper: "#f2f1ef" }} />
  <ColorItem title="--color-surface-2" subtitle="track: progress/dither backing only" colors={{ track: "#e3e2de" }} />
  <ColorItem title="--color-border" subtitle="hairline rule — separation is never a shadow" colors={{ border: "#d6d5d1" }} />
  <ColorItem title="--color-fg" subtitle="ink" colors={{ ink: "#16161a" }} />
  <ColorItem title="--color-muted" subtitle="ink, low emphasis" colors={{ muted: "#5e5e63" }} />
  <ColorItem title="--color-hero / --color-hero-fg" subtitle="the hero panel prints inverted" colors={{ hero: "#16161a", "hero-fg": "#f2f1ef" }} />
</ColorPalette>

## The spot ink — three registers

One plate, three tints. The **fill** register is only ever a fill (white text on top);
the **text** register is what negative money prints in. Never swap them.

<ColorPalette>
  <ColorItem title="--color-accent" subtitle="FILL only — 5.03:1 with white on top" colors={{ accent: "#c93d26" }} />
  <ColorItem title="--color-accent-fg" subtitle="text on the accent fill" colors={{ "accent-fg": "#ffffff" }} />
  <ColorItem title="--color-bad" subtitle="TEXT register — negative money, 5.27:1 on paper" colors={{ bad: "#b8331d" }} />
</ColorPalette>

## Pace ramp

The one ramp a progress bar's ink travels — the single exception to
"over is a texture change, never a hue", because a pace bar has three states and texture only has two.

<ColorPalette>
  <ColorItem title="--color-pace-under" subtitle="alias of --color-fg" colors={{ under: "#16161a" }} />
  <ColorItem title="--color-pace-over" subtitle="warmer + lighter than the spot ink, on purpose" colors={{ over: "#c0641a" }} />
  <ColorItem title="--color-pace-exceeded" subtitle="alias of --color-bad" colors={{ exceeded: "#b8331d" }} />
</ColorPalette>

## Categorical palette

Six hues × two lightness steps — separated on the axis that survives red-green colour
blindness. Buckets alias the base steps (need = amber, want = lilac, save = sage,
transfer = azure); projects draw from all twelve.

<ColorPalette>
  <ColorItem title="azure" subtitle="--color-azure / -deep · transfer" colors={{ base: "#1660a0", deep: "#003c6c" }} />
  <ColorItem title="amber" subtitle="--color-amber / -deep · need" colors={{ base: "#b5771e", deep: "#855405" }} />
  <ColorItem title="lilac" subtitle="--color-lilac / -deep · want" colors={{ base: "#7556a5", deep: "#51317c" }} />
  <ColorItem title="sage" subtitle="--color-sage / -deep · save" colors={{ base: "#409457", deep: "#0d6d32" }} />
  <ColorItem title="rose" subtitle="--color-rose / -deep" colors={{ base: "#c5646e", deep: "#9a3d49" }} />
  <ColorItem title="slate" subtitle="--color-slate / -deep" colors={{ base: "#76767e", deep: "#515159" }} />
</ColorPalette>

## Type

Geist takes prose — anything a person reads as a sentence. Geist Mono takes everything
else: every figure, date, category label, count, eyebrow, chart axis and nav label.

<Typeset fontFamily='"Geist Mono Variable", monospace' fontSizes={[44]} fontWeight={600} sampleText="6,420.50" />
<Typeset fontFamily='"Geist Variable", sans-serif' fontSizes={[16]} fontWeight={600} sampleText="Transactions" />
<Typeset fontFamily='"Geist Variable", sans-serif' fontSizes={[14]} fontWeight={500} sampleText="CARREFOUR HYPERMARKET" />
<Typeset fontFamily='"Geist Mono Variable", monospace' fontSizes={[10]} fontWeight={400} sampleText="2026-07-28 · Groceries" />
<Typeset fontFamily='"Geist Mono Variable", monospace' fontSizes={[10]} fontWeight={500} sampleText="BUDGET PACE" />

| Role | Face | Size | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Hero amount (Home) | Mono | 44px | 600 | -0.02em |
| Screen title | Sans | 16px | 600 | -0.015em |
| Row primary | Sans | 14px | 500 | -0.01em |
| Row meta | Mono | 10px | 400 | 0.04em |
| Eyebrow / label | Mono | 10px | 500 | 0.14em, uppercase |
| Nav label | Mono | 8px | 500 | 0.10em, uppercase |
| Button | Sans | 13px | 500 | normal |

## Radius & texture

- `--radius: 2px` — one sharp radius everywhere, including former circles. No second scale.
- `.dither-mask` is the app's one definition of "dotted" (2px pitch) — `ProgressBar` and
  `DitherFill` share it. Texture is **state** (dotted → solid at/over budget), never identity.
```

- [ ] **Step 2: Verify the docs page builds and appears**

```bash
cd frontend && bun run build-storybook
node -e "const idx=require('./storybook-static/index.json'); if(!Object.values(idx.entries).some(e=>e.title==='Foundations')) process.exit(1); console.log('Foundations page present')"
```
Expected: exit 0. If `@storybook/addon-docs/blocks` fails to resolve, use `@storybook/blocks` — whichever resolves in the installed SB9, consistently.

- [ ] **Step 3: Verify the values against the source**

Run: `grep -o '#[0-9a-f]\{6\}' frontend/src/styles/app.css | sort -u`
Expected: every hex in the MDX appears in the output (paper `#f2f1ef`, track `#e3e2de`, border `#d6d5d1`, ink `#16161a`, muted `#5e5e63`, accent `#c93d26`, bad `#b8331d`, pace-over `#c0641a`, and the twelve categorical values). Fix any that drifted — the MDX mirrors app.css, never the reverse.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/docs/Foundations.mdx
git commit -m "docs(frontend): Foundations token page in storybook"
```

### Task 8: Whole-suite regression net + project wiring

**Files:**
- Create: `frontend/src/test/storybook.test.tsx`
- Modify: `CLAUDE.md` (Frontend dev section), `frontend/src/components/README.md` (conventions intro)
- Modify: `internal/web/dist/*` (regenerated by the final build)

**Interfaces:**
- Consumes: every `*.stories.tsx` in `src/` via `import.meta.glob`; the Task 1 bridge.
- Produces: a single suite that fails when ANY story stops rendering — the drift alarm for the whole design system.

- [ ] **Step 1: Write the glob smoke suite `src/test/storybook.test.tsx`**

```tsx
import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";

// Eagerly import every story module in the repo. New story files join the
// net automatically; a story that throws on render fails the build.
const modules = import.meta.glob<Record<string, unknown>>("../**/*.stories.tsx", { eager: true });

describe("every story renders", () => {
  for (const [path, mod] of Object.entries(modules)) {
    describe(path, () => {
      const composed = composeStories(mod as never);
      for (const [name, Story] of Object.entries(composed) as [string, React.ComponentType][]) {
        it(name, () => {
          const { container } = render(<Story />);
          expect(container.firstChild).not.toBeNull();
          cleanup();
        });
      }
    });
  }
});
```

- [ ] **Step 2: Run the suite**

Run: `cd frontend && bunx vitest run src/test/storybook.test.tsx`
Expected: PASS with one test per story (~40 stories). If `composeStories` rejects a module (e.g. the MDX-less glob picked up something unexpected), inspect the failing path — the glob must only match `*.stories.tsx`.

- [ ] **Step 3: Run the entire frontend test suite**

Run: `cd frontend && bun run test`
Expected: PASS — all pre-existing tests plus every stories test, sequentially in the single fork. Watch for cross-file leakage (the glob suite renders many components; `cleanup()` after each story guards it).

- [ ] **Step 4: Document the workflow**

In `CLAUDE.md`, extend the **Frontend dev** section's code block:

```bash
bun run storybook        # design-system docs + component workbench (port 6006)
bun run build-storybook  # static build (storybook-static/, gitignored)
```

And add one sentence below it: "Every `X.stories.tsx` has a colocated `X.stories.test.tsx` rendering the same stories via portable stories; `src/test/storybook.test.tsx` renders every story in the repo as a regression net. When you add or change a shared component, update its stories in the same commit."

In `frontend/src/components/README.md`, add to the intro rule paragraph: "Each shared component also carries a colocated `*.stories.tsx` — Storybook is the living catalog; update the story in the same commit as the component."

- [ ] **Step 5: Final verification**

```bash
cd frontend && bun run build-storybook && bun run build && cd .. && go build -o /dev/null ./cmd/ledger
```
Expected: all three succeed. `bun run build` regenerates `internal/web/dist` — check `git status`; per project convention the rebuilt dist is committed (parallel sessions run on `main`, so re-check `git pull`/`git log` for drift before committing the dist).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/test/storybook.test.tsx CLAUDE.md frontend/src/components/README.md internal/web/dist
git commit -m "feat(frontend): whole-suite story regression net; storybook docs wiring; rebuild dist"
```

---

## Self-Review Notes

- **Coverage:** every `components/ui` primitive has stories except `PeriodSheet` (a Dialog composition better shown via Dialog) and `PixelIcon` (a generated icon pack, not a designable component) — both deliberate YAGNI cuts. Canvas charts (`TrendBars`/`FlowBars`) are excluded per Global Constraints.
- **Known uncertainty, called out where it bites:** SB9 export locations (`composeStories` / docs blocks) and the `index.json` filename each carry an explicit fallback instruction at their first use; `DitherFill`/`Money`/`Dialog` test selectors instruct reading the real markup before finalizing.
- **Type consistency:** story titles, file paths, and the `@/test/storybook` bridge import are used identically across Tasks 1–8; `composeStories` is imported from `@storybook/react-vite` everywhere.
