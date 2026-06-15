# PWA UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedded budgeting PWA genuinely usable on a phone — clear navigation, labeled actions, human-friendly inputs, real feedback (toasts/undo), and proper loading/empty/error/offline states — while keeping a light Windows-XP "retro shell" for identity.

**Architecture:** "Retro shell, modern interior." Keep the `xp.css` title bar + taskbar chrome for character, but replace the broken/cryptic parts of the *content* views with clean, modern, mobile-first patterns. Introduce a small set of reusable primitives (`Icon`, `Toast`, `Modal`, `EmptyState`, `Skeleton`, `useOnline`, formatting helpers) and rebuild each view on top of them. The currently-unused `public/icons/` Fugue set finally gets wired in. No backend changes — this is a `frontend/`-only milestone; the last task rebuilds the embedded `internal/web/dist` bundle so the Go binary serves the new UI.

**Tech Stack:** Bun 1.3 (build-time), Vite 5, React 18 + TypeScript, TanStack Query, `xp.css`, self-hosted Fugue PNG icons (`frontend/public/icons/*.png`), Vitest + `@testing-library/react`. Money stays `int64` **fils** over the wire; the UI converts to/from AED dirhams only at the input boundary.

**Conventions in this codebase (follow them):**
- All work happens under `/root/Coding/ledger/frontend`. Run the test suite with `bun run test` (alias for `vitest run`); run a single file with `bunx vitest run <path>`.
- Tests live next to the unit under test (`Foo.tsx` → `Foo.test.tsx`, `foo.ts` → `foo.test.ts`). Logic-only helpers get `.test.ts`; components get `.test.tsx` with `@testing-library/react` (`render`, `screen`, `fireEvent`). `@testing-library/jest-dom` matchers are auto-loaded via `src/test/setup.ts`.
- Money is `int64` **fils**. Never use floats for stored money. `lib/money.ts#formatFils` renders fils as `1,234.56` / `(500.00)` / `—`.
- API helpers: `getJSON<T>(url)`, `postJSON<T>(url, body, method?)`, `del(url)` from `src/api/client.ts`. `useLiveEvents()` invalidates `["summary"]`, `["transactions"]`, `["review"]` on SSE.
- Icons are served from the web root: `public/icons/gear.png` → `/icons/gear.png` at runtime (Vite copies `public/` to the dist root, which is embedded by Go).
- Frequent commits: one per task (after its tests pass).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `frontend/src/lib/format.ts` | Create | Pure formatters/parsers: `statusLabel`, `statusTone`, `dirhamsToFils`, `filsToDirhams`, `fractionToPercent`, `percentToFraction` |
| `frontend/src/lib/format.test.ts` | Create | Tests for the above |
| `frontend/src/components/Icon.tsx` | Create | Typed wrapper over the `public/icons/*.png` Fugue set |
| `frontend/src/components/Icon.test.tsx` | Create | Tests icon `src` + a11y |
| `frontend/src/components/Toast.tsx` | Create | `toastReducer`, `ToastProvider`, `useToast` — global notifications with optional Undo action |
| `frontend/src/components/Toast.test.tsx` | Create | Reducer + provider/consumer tests |
| `frontend/src/hooks/useOnline.ts` | Create | `navigator.onLine` + online/offline event subscription |
| `frontend/src/hooks/useOnline.test.ts` | Create | Tests offline transition |
| `frontend/src/components/EmptyState.tsx` | Create | Reusable empty-state block (icon + title + hint) |
| `frontend/src/components/EmptyState.test.tsx` | Create | Renders title/hint |
| `frontend/src/components/Skeleton.tsx` | Create | Loading placeholder bars |
| `frontend/src/components/Modal.tsx` | Create | Backdrop + centered retro window used by dialogs |
| `frontend/src/components/AppWindow.tsx` | Modify | Remove dead window controls; add offline status in the title bar |
| `frontend/src/components/AppWindow.test.tsx` | Create | Offline indicator + no dead buttons |
| `frontend/src/components/Taskbar.tsx` | Modify | Icon + label bottom nav; "History" label; gear Settings button |
| `frontend/src/components/Taskbar.test.tsx` | Modify | Keep badge/menu assertions; add icon assertions |
| `frontend/src/main.tsx` | Modify | Wrap app in `ToastProvider` |
| `frontend/src/App.tsx` | Modify | Pass `online` to `AppWindow` |
| `frontend/src/components/CategorizeDialog.tsx` | Modify | Build on `Modal`; add search box + bucket grouping |
| `frontend/src/components/CategorizeDialog.test.tsx` | Modify | Add search-filter test |
| `frontend/src/views/Review.tsx` | Modify | Labeled icon actions, tappable cards, toast + Undo |
| `frontend/src/views/Review.test.tsx` | Create | Action labels + undo wiring |
| `frontend/src/views/Transactions.tsx` | Modify | Mobile card list, status pills, count, empty state, tap-to-recategorize |
| `frontend/src/views/Transactions.recategorize.test.tsx` | Create | Tap opens dialog |
| `frontend/src/views/Dashboard.tsx` | Modify | Header hierarchy, icons, skeleton, empty/error states |
| `frontend/src/views/Dashboard.test.tsx` | Create | Loading skeleton + empty recent |
| `frontend/src/views/SettingsDrawer.tsx` | Modify | AED income input, whole-percent inputs, inline validation (no `alert`) |
| `frontend/src/views/SettingsDrawer.income.test.tsx` | Create | Dirhams↔fils round-trip in the input |
| `frontend/src/styles/theme.css` | Modify | Modern-interior tokens: cards, pills, list rows, modal/sheet, toast stack, skeleton, empty state, icon nav |

---

# Phase 1 — Foundation primitives

### Task 1: Formatting & parsing helpers

**Files:**
- Create: `frontend/src/lib/format.ts`
- Test: `frontend/src/lib/format.test.ts`

These pure functions remove the two worst "unintuitive" offenders: raw status enums and raw-fils/decimal-fraction inputs.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/format.test.ts
import { describe, it, expect } from "vitest";
import {
  statusLabel, statusTone, dirhamsToFils, filsToDirhams,
  fractionToPercent, percentToFraction,
} from "./format";

describe("statusLabel", () => {
  it("humanizes known statuses", () => {
    expect(statusLabel("needs_review")).toBe("Needs review");
    expect(statusLabel("confirmed")).toBe("Confirmed");
    expect(statusLabel("transfer")).toBe("Transfer");
    expect(statusLabel("ignored")).toBe("Ignored");
  });
  it("falls back to capitalized raw value", () => {
    expect(statusLabel("pending")).toBe("Pending");
  });
});

describe("statusTone", () => {
  it("maps statuses to a pill tone", () => {
    expect(statusTone("confirmed")).toBe("good");
    expect(statusTone("needs_review")).toBe("warn");
    expect(statusTone("ignored")).toBe("muted");
    expect(statusTone("transfer")).toBe("neutral");
  });
});

describe("money <-> dirhams", () => {
  it("converts dirhams to fils with rounding", () => {
    expect(dirhamsToFils(12.34)).toBe(1234);
    expect(dirhamsToFils(0)).toBe(0);
    expect(dirhamsToFils(10)).toBe(1000);
  });
  it("converts fils to dirhams", () => {
    expect(filsToDirhams(1234)).toBe(12.34);
    expect(filsToDirhams(0)).toBe(0);
  });
});

describe("fraction <-> percent", () => {
  it("rounds fraction to whole percent", () => {
    expect(fractionToPercent(0.5)).toBe(50);
    expect(fractionToPercent(0.2)).toBe(20);
  });
  it("converts whole percent to fraction", () => {
    expect(percentToFraction(30)).toBeCloseTo(0.3, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/format.test.ts`
Expected: FAIL — cannot find module `./format`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/format.ts
const STATUS_LABELS: Record<string, string> = {
  needs_review: "Needs review",
  confirmed: "Confirmed",
  transfer: "Transfer",
  ignored: "Ignored",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

export type Tone = "good" | "warn" | "muted" | "neutral";

export function statusTone(status: string): Tone {
  switch (status) {
    case "confirmed": return "good";
    case "needs_review": return "warn";
    case "ignored": return "muted";
    default: return "neutral";
  }
}

/** AED has 2 minor units. Inputs are in dirhams; storage is in fils. */
export function dirhamsToFils(dirhams: number): number {
  return Math.round(dirhams * 100);
}
export function filsToDirhams(fils: number): number {
  return fils / 100;
}

/** Budget splits are stored as fractions (0.5) but shown as whole percents (50). */
export function fractionToPercent(fraction: number): number {
  return Math.round(fraction * 100);
}
export function percentToFraction(percent: number): number {
  return percent / 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/format.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/format.ts frontend/src/lib/format.test.ts
git commit -m "feat(pwa): formatting helpers — status labels, dirhams/percent conversions"
```

---

### Task 2: Icon component

**Files:**
- Create: `frontend/src/components/Icon.tsx`
- Test: `frontend/src/components/Icon.test.tsx`

Wires the shipped-but-unused `public/icons/*.png` set behind a typed name map so views never hardcode paths.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Icon.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("resolves a name to its png under /icons", () => {
    render(<Icon name="gear" alt="Settings" />);
    const img = screen.getByAltText("Settings") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/icons/gear.png");
  });
  it("maps aliases to the real filename", () => {
    render(<Icon name="transfer" alt="Transfer" />);
    expect((screen.getByAltText("Transfer") as HTMLImageElement).getAttribute("src"))
      .toBe("/icons/arrow-switch.png");
  });
  it("is decorative (aria-hidden) when alt is empty", () => {
    const { container } = render(<Icon name="chart" />);
    expect(container.querySelector("img")?.getAttribute("aria-hidden")).toBe("true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/Icon.test.tsx`
Expected: FAIL — cannot find module `./Icon`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/Icon.tsx
// Filenames live in frontend/public/icons/*.png (Fugue, CC BY 3.0).
const ICONS = {
  chart: "chart-up",
  table: "table",
  flag: "flag-red",
  gear: "gear",
  money: "money-coin",
  transfer: "arrow-switch",
  cross: "cross",
  tick: "tick",
  alert: "exclamation",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, alt = "" }: { name: IconName; size?: number; alt?: string }) {
  return (
    <img
      className="icon"
      src={`/icons/${ICONS[name]}.png`}
      width={size}
      height={size}
      alt={alt}
      aria-hidden={alt === "" ? "true" : undefined}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/Icon.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Icon.tsx frontend/src/components/Icon.test.tsx
git commit -m "feat(pwa): typed Icon component over the Fugue png set"
```

---

### Task 3: Toast system (with Undo)

**Files:**
- Create: `frontend/src/components/Toast.tsx`
- Test: `frontend/src/components/Toast.test.tsx`

Global feedback. A toast may carry one action button (used for Undo). The reducer is exported so its logic is unit-tested without timers.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Toast.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { toastReducer, ToastProvider, useToast } from "./Toast";

describe("toastReducer", () => {
  it("adds and removes by id", () => {
    const added = toastReducer([], { type: "add", toast: { id: 1, message: "Hi" } });
    expect(added).toHaveLength(1);
    const removed = toastReducer(added, { type: "remove", id: 1 });
    expect(removed).toHaveLength(0);
  });
});

function Trigger() {
  const { show } = useToast();
  const onUndo = vi.fn();
  // expose the spy so the test can assert it fired
  (globalThis as Record<string, unknown>).__undo = onUndo;
  return (
    <button onClick={() => show({ message: "Ignored Spinneys", action: { label: "Undo", onAction: onUndo } })}>
      go
    </button>
  );
}

describe("ToastProvider", () => {
  it("shows a toast and fires its action", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("Ignored Spinneys")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect((globalThis as Record<string, unknown>).__undo).toBeTruthy();
    expect(((globalThis as Record<string, () => void> & { __undo: ReturnType<typeof vi.fn> }).__undo)).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/Toast.test.tsx`
Expected: FAIL — cannot find module `./Toast`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/Toast.tsx
import { createContext, useCallback, useContext, useReducer, type ReactNode } from "react";

export interface ToastAction { label: string; onAction: () => void; }
export interface Toast {
  id: number;
  message: string;
  tone?: "info" | "success" | "error";
  action?: ToastAction;
}

type State = Toast[];
type Action = { type: "add"; toast: Toast } | { type: "remove"; id: number };

export function toastReducer(state: State, action: Action): State {
  switch (action.type) {
    case "add": return [...state, action.toast];
    case "remove": return state.filter((t) => t.id !== action.id);
  }
}

interface Ctx { show: (t: Omit<Toast, "id">) => void; }
const ToastContext = createContext<Ctx | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);

  const show = useCallback((t: Omit<Toast, "id">) => {
    const id = nextId++;
    dispatch({ type: "add", toast: { ...t, id } });
    setTimeout(() => dispatch({ type: "remove", id }), 5000);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-stack" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone ?? "info"}`}>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => { t.action!.onAction(); dispatch({ type: "remove", id: t.id }); }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast-close" aria-label="Dismiss" onClick={() => dispatch({ type: "remove", id: t.id })}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Ctx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/Toast.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Toast.tsx frontend/src/components/Toast.test.tsx
git commit -m "feat(pwa): global toast system with optional undo action"
```

---

### Task 4: useOnline hook

**Files:**
- Create: `frontend/src/hooks/useOnline.ts`
- Test: `frontend/src/hooks/useOnline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/hooks/useOnline.test.ts
import { describe, it, expect, act } from "vitest";
import { renderHook } from "@testing-library/react";
import { useOnline } from "./useOnline";

describe("useOnline", () => {
  it("reacts to offline/online events", () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(result.current).toBe(false);
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(result.current).toBe(true);
  });
});
```

Note: `act` is re-exported by vitest's `@testing-library/react` via React. If `import { act } from "vitest"` errors in this repo, use `import { act } from "@testing-library/react"` instead — both are valid; pick the one that resolves.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/hooks/useOnline.test.ts`
Expected: FAIL — cannot find module `./useOnline`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/hooks/useOnline.ts
import { useEffect, useState } from "react";

export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  return online;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/hooks/useOnline.test.ts`
Expected: PASS. If the `act` import errored in Step 1, switch it to `@testing-library/react` and re-run.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useOnline.ts frontend/src/hooks/useOnline.test.ts
git commit -m "feat(pwa): useOnline hook for offline awareness"
```

---

### Task 5: EmptyState, Skeleton, Modal primitives

**Files:**
- Create: `frontend/src/components/EmptyState.tsx`
- Create: `frontend/src/components/Skeleton.tsx`
- Create: `frontend/src/components/Modal.tsx`
- Test: `frontend/src/components/EmptyState.test.tsx`

`Skeleton` and `Modal` are tiny presentational helpers used later; only `EmptyState` gets a unit test (the others are exercised by the view tests).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/EmptyState.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title and hint", () => {
    render(<EmptyState icon="tick" title="All caught up" hint="Nothing to review" />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
    expect(screen.getByText("Nothing to review")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/EmptyState.test.tsx`
Expected: FAIL — cannot find module `./EmptyState`.

- [ ] **Step 3: Write minimal implementations**

```tsx
// frontend/src/components/EmptyState.tsx
import { Icon, type IconName } from "./Icon";

export function EmptyState({ icon, title, hint }: { icon?: IconName; title: string; hint?: string }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={40} alt="" />}
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}
```

```tsx
// frontend/src/components/Skeleton.tsx
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton-bar" />)}
    </div>
  );
}
```

```tsx
// frontend/src/components/Modal.tsx
import type { ReactNode } from "react";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="window modal-window" onClick={(e) => e.stopPropagation()}>
        <div className="title-bar">
          <div className="title-bar-text">{title}</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body">{children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/EmptyState.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/EmptyState.tsx frontend/src/components/EmptyState.test.tsx frontend/src/components/Skeleton.tsx frontend/src/components/Modal.tsx
git commit -m "feat(pwa): EmptyState, Skeleton, and Modal primitives"
```

---

# Phase 2 — Retro shell (chrome that works)

### Task 6: AppWindow — drop dead controls, add offline status

**Files:**
- Modify: `frontend/src/components/AppWindow.tsx`
- Test: `frontend/src/components/AppWindow.test.tsx`

The three title-bar buttons (Minimize/Maximize/Close) do nothing and confuse users. Replace them with a meaningful **Offline** indicator that only appears when disconnected.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/AppWindow.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppWindow } from "./AppWindow";

describe("AppWindow", () => {
  it("shows the title and no dead window controls", () => {
    render(<AppWindow title="Dashboard" online={true}>body</AppWindow>);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.queryByLabelText("Close")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Minimize")).not.toBeInTheDocument();
  });
  it("shows an offline indicator when disconnected", () => {
    render(<AppWindow title="Dashboard" online={false}>body</AppWindow>);
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/AppWindow.test.tsx`
Expected: FAIL — currently `Close`/`Minimize` buttons exist and `online` prop is unsupported.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/AppWindow.tsx
import { ReactNode } from "react";

export function AppWindow({ title, online = true, children }: { title: string; online?: boolean; children: ReactNode }) {
  return (
    <div className="window app-window">
      <div className="title-bar">
        <div className="title-bar-text">{title}</div>
        {!online && <div className="title-bar-status" role="status">● Offline</div>}
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/AppWindow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AppWindow.tsx frontend/src/components/AppWindow.test.tsx
git commit -m "feat(pwa): AppWindow drops dead controls, gains offline indicator"
```

---

### Task 7: Taskbar — icon + label navigation

**Files:**
- Modify: `frontend/src/components/Taskbar.tsx`
- Modify: `frontend/src/components/Taskbar.test.tsx`

Replace text-only tabs and the bare `≡` with icon+label buttons. Transactions is relabeled **History** (clearer for a money app). The existing badge/menu behaviour is preserved.

- [ ] **Step 1: Update the test (add icon assertions, keep existing behaviour)**

```tsx
// frontend/src/components/Taskbar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Taskbar } from "./Taskbar";

describe("Taskbar", () => {
  it("shows a review badge when count > 0 and fires onMenu", () => {
    const onMenu = vi.fn();
    render(<Taskbar active="dashboard" reviewCount={3} onMenu={onMenu} onNavigate={() => {}} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    screen.getByRole("button", { name: /menu/i }).click();
    expect(onMenu).toHaveBeenCalled();
  });

  it("hides the badge when count is 0", () => {
    render(<Taskbar active="review" reviewCount={0} onMenu={() => {}} onNavigate={() => {}} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders an icon and label for each tab", () => {
    render(<Taskbar active="dashboard" reviewCount={0} onMenu={() => {}} onNavigate={() => {}} />);
    expect(screen.getByRole("button", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /history/i })).toBeInTheDocument();
    // four nav buttons total: settings + 3 tabs
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/Taskbar.test.tsx`
Expected: FAIL — no `/history/i` button yet; button count differs.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/Taskbar.tsx
import { Icon, type IconName } from "./Icon";

export type Tab = "dashboard" | "review" | "transactions";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "dashboard", label: "Dashboard", icon: "chart" },
  { id: "review", label: "Review", icon: "flag" },
  { id: "transactions", label: "History", icon: "table" },
];

export function Taskbar(props: {
  active: Tab;
  reviewCount: number;
  onMenu: () => void;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <nav className="taskbar">
      <button className="menu-btn" aria-label="menu" onClick={props.onMenu}>
        <Icon name="gear" alt="" />
        <span className="tab-label">Settings</span>
      </button>
      {TABS.map((t) => (
        <button
          key={t.id}
          className={props.active === t.id ? "tab-active" : ""}
          aria-pressed={props.active === t.id}
          aria-label={t.label}
          onClick={() => props.onNavigate(t.id)}
        >
          <span className="tab-icon">
            <Icon name={t.icon} alt="" />
            {t.id === "review" && props.reviewCount ? <span className="badge">{props.reviewCount}</span> : null}
          </span>
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/Taskbar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Taskbar.tsx frontend/src/components/Taskbar.test.tsx
git commit -m "feat(pwa): icon+label bottom navigation"
```

---

### Task 8: Wire ToastProvider and online state into the app

**Files:**
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Wrap the app in ToastProvider**

```tsx
// frontend/src/main.tsx
import "xp.css/dist/XP.css";
import "./styles/theme.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { ToastProvider } from "./components/Toast";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 2: Pass online state to AppWindow**

```tsx
// frontend/src/App.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "./api/client";
import type { Txn } from "./api/types";
import { AppWindow } from "./components/AppWindow";
import { Taskbar } from "./components/Taskbar";
import type { Tab } from "./components/Taskbar";
import { Dashboard } from "./views/Dashboard";
import { Review } from "./views/Review";
import { Transactions } from "./views/Transactions";
import { SettingsDrawer } from "./views/SettingsDrawer";
import { useLiveEvents } from "./hooks/useLiveEvents";
import { useOnline } from "./hooks/useOnline";

const TITLES: Record<Tab, string> = {
  dashboard: "Dashboard",
  review: "Review",
  transactions: "History",
};

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [menuOpen, setMenuOpen] = useState(false);
  const online = useOnline();
  useLiveEvents();

  const review = useQuery({
    queryKey: ["review"],
    queryFn: () => getJSON<Txn[]>("/api/review"),
  });

  return (
    <>
      <AppWindow title={TITLES[tab]} online={online}>
        {tab === "dashboard" && <Dashboard />}
        {tab === "review" && <Review />}
        {tab === "transactions" && <Transactions />}
      </AppWindow>
      <Taskbar
        active={tab}
        reviewCount={review.data?.length ?? 0}
        onMenu={() => setMenuOpen(true)}
        onNavigate={setTab}
      />
      {menuOpen && <SettingsDrawer onClose={() => setMenuOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 3: Verify the full suite still passes**

Run: `bun run test`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/main.tsx frontend/src/App.tsx
git commit -m "feat(pwa): wire ToastProvider and online awareness into the shell"
```

---

# Phase 3 — Review redesign (the core daily loop)

### Task 9: Review — labeled actions, tappable cards, toast + undo

**Files:**
- Modify: `frontend/src/views/Review.tsx`
- Test: `frontend/src/views/Review.test.tsx`

Replace cryptic `⇄`/`✕` glyph buttons with icon **+ visible label** buttons, make the "tap to categorize" affordance explicit, and fire a toast with **Undo** after transfer/ignore (undo restores `needs_review`).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/views/Review.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Review } from "./Review";
import type { Txn, Category } from "../api/types";

const txns: Txn[] = [
  { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Confidence: 0, Source: "email" },
];
const cats: Category[] = [{ ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true }];

const calls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/review") return new Response(JSON.stringify(txns));
    if (url === "/api/categories") return new Response(JSON.stringify(cats));
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    return new Response("{}");
  }));
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
}

describe("Review", () => {
  it("renders labeled Transfer and Ignore actions", async () => {
    wrap(<Review />);
    expect(await screen.findByRole("button", { name: /transfer/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ignore/i })).toBeInTheDocument();
  });

  it("ignores an item and offers Undo", async () => {
    wrap(<Review />);
    fireEvent.click(await screen.findByRole("button", { name: /ignore/i }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/transactions/1/status")).toBe(true));
    expect(screen.getByText(/ignored/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/views/Review.test.tsx`
Expected: FAIL — current actions have no accessible "transfer"/"ignore" text (only `title=` on glyphs) and no toast/undo.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/views/Review.tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { Money } from "../components/Money";
import { Icon } from "../components/Icon";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { CategorizeDialog } from "../components/CategorizeDialog";
import { useToast } from "../components/Toast";

export function Review() {
  const qc = useQueryClient();
  const { show } = useToast();
  const [active, setActive] = useState<Txn | null>(null);
  const items = useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["review"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };
  const setStatus = async (id: number, status: string) => {
    await postJSON(`/api/transactions/${id}/status`, { status });
    invalidate();
  };
  const act = async (txn: Txn, status: string, verb: string) => {
    const name = txn.MerchantRaw || "transaction";
    await setStatus(txn.ID, status);
    show({
      message: `${verb} ${name}`,
      action: { label: "Undo", onAction: () => setStatus(txn.ID, "needs_review") },
    });
  };
  const categorize = async (txn: Txn, body: { category_id: number; make_rule: boolean }) => {
    await postJSON(`/api/transactions/${txn.ID}/categorize`, { ...body, merchant_raw: txn.MerchantRaw });
    setActive(null);
    invalidate();
    show({ message: `Categorized ${txn.MerchantRaw || "transaction"}`, tone: "success" });
  };

  if (items.isLoading) return <Skeleton rows={4} />;
  const rows = items.data ?? [];
  if (rows.length === 0) {
    return <EmptyState icon="tick" title="All caught up" hint="No transactions need review right now." />;
  }
  return (
    <div className="list">
      {rows.map((t) => (
        <div key={t.ID} className="card review-card">
          <button className="card-main" onClick={() => setActive(t)}>
            <span className="card-merchant">{t.MerchantRaw || "—"}</span>
            <span className="card-sub">{t.PostedAt.slice(0, 10)} · tap to categorize</span>
          </button>
          <Money fils={-t.AmountFils} />
          <div className="card-actions">
            <button className="action" onClick={() => act(t, "transfer", "Marked transfer")}>
              <Icon name="transfer" alt="" /> Transfer
            </button>
            <button className="action" onClick={() => act(t, "ignored", "Ignored")}>
              <Icon name="cross" alt="" /> Ignore
            </button>
          </div>
        </div>
      ))}
      {active && cats.data && (
        <CategorizeDialog
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/views/Review.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/Review.tsx frontend/src/views/Review.test.tsx
git commit -m "feat(pwa): Review — labeled actions, tap-to-categorize, toast+undo"
```

---

### Task 10: CategorizeDialog — search + bucket grouping on the Modal

**Files:**
- Modify: `frontend/src/components/CategorizeDialog.tsx`
- Modify: `frontend/src/components/CategorizeDialog.test.tsx`

Rebuild on the `Modal` primitive, add a search box that filters categories by name, and group the (filtered) options under their bucket. The existing submit/disable behaviour is preserved.

- [ ] **Step 1: Update the test (keep existing cases, add search)**

```tsx
// frontend/src/components/CategorizeDialog.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategorizeDialog } from "./CategorizeDialog";
import type { Category, Txn } from "../api/types";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];
const txn: Txn = { ID: 9, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "CARREFOUR", Status: "needs_review", Confidence: 0, Source: "email" };

describe("CategorizeDialog", () => {
  it("submits the chosen category + make_rule flag", () => {
    const onSubmit = vi.fn();
    render(<CategorizeDialog txn={txn} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Dining"));
    fireEvent.click(screen.getByLabelText(/save as rule/i));
    fireEvent.click(screen.getByRole("button", { name: /ok/i }));
    expect(onSubmit).toHaveBeenCalledWith({ category_id: 2, make_rule: true });
  });

  it("disables OK until a category is chosen", () => {
    render(<CategorizeDialog txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /ok/i })).toBeDisabled();
  });

  it("filters categories by the search box", () => {
    render(<CategorizeDialog txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "din" } });
    expect(screen.getByLabelText("Dining")).toBeInTheDocument();
    expect(screen.queryByLabelText("Groceries")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/CategorizeDialog.test.tsx`
Expected: FAIL — no search box / `placeholder` yet.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/CategorizeDialog.tsx
import { useMemo, useState } from "react";
import type { Category, Txn } from "../api/types";
import { Money } from "./Money";
import { Modal } from "./Modal";

const BUCKET_LABELS: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

export function CategorizeDialog(props: {
  txn: Txn;
  categories: Category[];
  onSubmit: (body: { category_id: number; make_rule: boolean }) => void;
  onClose: () => void;
}) {
  const [catID, setCatID] = useState<number | null>(null);
  const [makeRule, setMakeRule] = useState(false);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = props.categories.filter((c) => !q || c.Name.toLowerCase().includes(q));
    const byBucket = new Map<string, Category[]>();
    for (const c of matched) {
      const list = byBucket.get(c.Bucket) ?? [];
      list.push(c);
      byBucket.set(c.Bucket, list);
    }
    return [...byBucket.entries()];
  }, [props.categories, query]);

  return (
    <Modal title="Categorize" onClose={props.onClose}>
      <p className="dialog-txn">{props.txn.MerchantRaw || "—"} · <Money fils={-props.txn.AmountFils} /></p>
      <input
        className="search"
        type="search"
        placeholder="Search categories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="cat-list">
        {groups.map(([bucket, list]) => (
          <fieldset key={bucket} className="cat-group">
            <legend>{BUCKET_LABELS[bucket] ?? bucket}</legend>
            {list.map((c) => (
              <label key={c.ID} className="cat-option">
                <input type="radio" name="cat" value={c.ID} onChange={() => setCatID(c.ID)} /> {c.Name}
              </label>
            ))}
          </fieldset>
        ))}
        {groups.length === 0 && <p className="muted">No matching categories.</p>}
      </div>
      <label className="rule-toggle">
        <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} /> Save as rule
      </label>
      <div className="dialog-actions">
        <button onClick={props.onClose}>Cancel</button>
        <button
          disabled={catID === null}
          onClick={() => catID !== null && props.onSubmit({ category_id: catID, make_rule: makeRule })}
        >OK</button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/CategorizeDialog.test.tsx`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CategorizeDialog.tsx frontend/src/components/CategorizeDialog.test.tsx
git commit -m "feat(pwa): CategorizeDialog — search + bucket grouping on Modal"
```

---

# Phase 4 — Transactions (History) redesign

### Task 11: Transactions — card list, status pills, count, empty state, tap-to-recategorize

**Files:**
- Modify: `frontend/src/views/Transactions.tsx`
- Test: `frontend/src/views/Transactions.recategorize.test.tsx`

Note: the existing `frontend/src/views/Transactions.filters.test.ts` tests `buildTxnQuery` — keep that function and its export name unchanged so that test stays green.

Replace the cramped 4-column table with a mobile card list: merchant + date, a human status **pill**, amount, a result count, an empty state, and tap-to-recategorize via the shared dialog.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/views/Transactions.recategorize.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Transactions } from "./Transactions";
import type { Txn, Category } from "../api/types";

const txns: Txn[] = [
  { ID: 7, PostedAt: "2026-06-09", AmountFils: 2500, Currency: "AED", Direction: "debit", MerchantRaw: "NOON", Status: "needs_review", Confidence: 0, Source: "email" },
];
const cats: Category[] = [{ ID: 1, Name: "Shopping", Kind: "spending", Bucket: "want", IsActive: true }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/transactions")) return new Response(JSON.stringify(txns));
    if (url === "/api/categories") return new Response(JSON.stringify(cats));
    return new Response("{}");
  }));
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
}

describe("Transactions", () => {
  it("shows a human status pill and a count", async () => {
    wrap(<Transactions />);
    expect(await screen.findByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText(/1 transaction/i)).toBeInTheDocument();
  });

  it("opens the categorize dialog when a row is tapped", async () => {
    wrap(<Transactions />);
    fireEvent.click(await screen.findByText("NOON"));
    expect(await screen.findByRole("button", { name: /ok/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/views/Transactions.recategorize.test.tsx`
Expected: FAIL — current view renders the raw enum `needs_review`, no count, no tappable dialog.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/views/Transactions.tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { Money } from "../components/Money";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { CategorizeDialog } from "../components/CategorizeDialog";
import { useToast } from "../components/Toast";
import { statusLabel, statusTone } from "../lib/format";

export interface TxnFilters { status: string; from: string; to: string; }

export function buildTxnQuery(f: TxnFilters): string {
  const params = new URLSearchParams();
  if (f.status) params.set("status", f.status);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  const qs = params.toString();
  return qs ? `/api/transactions?${qs}` : "/api/transactions";
}

export function Transactions() {
  const qc = useQueryClient();
  const { show } = useToast();
  const [filters, setFilters] = useState<TxnFilters>({ status: "", from: "", to: "" });
  const [active, setActive] = useState<Txn | null>(null);
  const q = useQuery({
    queryKey: ["transactions", filters],
    queryFn: () => getJSON<Txn[]>(buildTxnQuery(filters)),
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const set = (patch: Partial<TxnFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const categorize = async (txn: Txn, body: { category_id: number; make_rule: boolean }) => {
    await postJSON(`/api/transactions/${txn.ID}/categorize`, { ...body, merchant_raw: txn.MerchantRaw });
    setActive(null);
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
    show({ message: `Categorized ${txn.MerchantRaw || "transaction"}`, tone: "success" });
  };

  const rows = q.data ?? [];
  return (
    <div>
      <div className="filters">
        <select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="needs_review">Needs review</option>
          <option value="transfer">Transfer</option>
          <option value="ignored">Ignored</option>
        </select>
        <input type="date" aria-label="From" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
        <input type="date" aria-label="To" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
      </div>

      {q.isLoading ? <Skeleton rows={6} /> : rows.length === 0 ? (
        <EmptyState icon="table" title="No transactions" hint="Try widening the date range or clearing filters." />
      ) : (
        <>
          <p className="result-count">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>
          <div className="list">
            {rows.map((t) => (
              <button key={t.ID} className="card txn-card" onClick={() => setActive(t)}>
                <span className="card-main">
                  <span className="card-merchant">{t.MerchantRaw || "—"}</span>
                  <span className="card-sub">{t.PostedAt.slice(0, 10)}</span>
                </span>
                <span className={`pill pill-${statusTone(t.Status)}`}>{statusLabel(t.Status)}</span>
                <Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} />
              </button>
            ))}
          </div>
        </>
      )}

      {active && cats.data && (
        <CategorizeDialog
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

- [ ] **Step 4: Run tests to verify they pass (new + the untouched filters test)**

Run: `bunx vitest run src/views/Transactions.recategorize.test.tsx src/views/Transactions.filters.test.ts`
Expected: PASS for both files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/Transactions.tsx frontend/src/views/Transactions.recategorize.test.tsx
git commit -m "feat(pwa): Transactions — card list, status pills, count, tap-to-recategorize"
```

---

# Phase 5 — Dashboard polish

### Task 12: Dashboard — hierarchy, icons, loading/empty/error states

**Files:**
- Modify: `frontend/src/views/Dashboard.tsx`
- Test: `frontend/src/views/Dashboard.test.tsx`

Give the screen a clear header (income with the money icon + period), a loading **skeleton** instead of bare "Loading…", and an empty state for "Recent" when there's nothing yet. Buckets keep using `BucketBox`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/views/Dashboard.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "./Dashboard";
import type { Summary } from "../api/types";

const summary: Summary = {
  period: "2026-06", income: 1500000, month_progress: 0.5,
  buckets: [{ bucket: "need", target: 750000, spent: 100000, remaining: 650000, pct_used: 0.13, projection: 200000 }],
  recent: [],
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(summary))));
  });
  it("shows an empty state when there are no recent transactions", async () => {
    wrap(<Dashboard />);
    expect(await screen.findByText(/no recent activity/i)).toBeInTheDocument();
  });
  it("renders the income header", async () => {
    wrap(<Dashboard />);
    expect(await screen.findByText(/income/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/views/Dashboard.test.tsx`
Expected: FAIL — current view renders the recent `<ul>` with no empty-state copy.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/views/Dashboard.tsx
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Summary } from "../api/types";
import { BucketBox } from "../components/BucketBox";
import { Money } from "../components/Money";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";

export function Dashboard() {
  const q = useQuery({ queryKey: ["summary"], queryFn: () => getJSON<Summary>("/api/summary?period=current") });
  if (q.isLoading) return <Skeleton rows={6} />;
  if (q.error) return <EmptyState icon="alert" title="Couldn’t load summary" hint="Check your connection and try again." />;
  const s = q.data!;
  const monthPct = Math.round(s.month_progress * 100);
  return (
    <div>
      <header className="dash-header">
        <Icon name="money" size={28} alt="" />
        <div>
          <div className="dash-income"><Money fils={s.income} /></div>
          <small className="muted">Income · {s.period}</small>
        </div>
      </header>

      {s.buckets.map((b) => <BucketBox key={b.bucket} b={b} />)}

      <fieldset>
        <legend>Month progress</legend>
        <div className="bar"><div className="bar-fill bar-green" style={{ width: `${monthPct}%` }} /></div>
        <small>{monthPct}% of the month elapsed</small>
      </fieldset>

      <fieldset>
        <legend>Recent</legend>
        {s.recent.length === 0 ? (
          <EmptyState title="No recent activity" hint="New transactions will appear here." />
        ) : (
          <ul className="recent">
            {s.recent.map((t) => (
              <li key={t.ID} className="recent-row">
                <span>{t.MerchantRaw || "—"}</span>
                <Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} />
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/views/Dashboard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/Dashboard.tsx frontend/src/views/Dashboard.test.tsx
git commit -m "feat(pwa): Dashboard — header hierarchy, skeleton, empty/error states"
```

---

# Phase 6 — Settings humanization

### Task 13: SettingsDrawer — AED income, whole-percent splits, inline validation

**Files:**
- Modify: `frontend/src/views/SettingsDrawer.tsx`
- Test: `frontend/src/views/SettingsDrawer.income.test.tsx`

Note: keep `pctsValid` exported with the same signature — `SettingsDrawer.pct.test.ts` depends on it. Replace raw-fils income with an **AED** input, decimal-fraction percents with **whole-number** percents, and the blocking `alert()` with an inline error message.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/views/SettingsDrawer.income.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsDrawer } from "./SettingsDrawer";
import type { BudgetConfig } from "../api/types";

const budget: BudgetConfig = {
  monthly_income: 1500000, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2,
  income_source: "config", freeze_history: false,
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("SettingsDrawer income", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/budget") return new Response(JSON.stringify(budget));
      return new Response("[]");
    }));
  });
  it("displays monthly income in AED, not raw fils", async () => {
    wrap(<SettingsDrawer onClose={() => {}} />);
    const input = await screen.findByLabelText(/monthly income/i) as HTMLInputElement;
    expect(input.value).toBe("15000"); // 1,500,000 fils -> 15000 AED
  });
  it("shows budget splits as whole percents", async () => {
    wrap(<SettingsDrawer onClose={() => {}} />);
    const need = await screen.findByLabelText(/need %/i) as HTMLInputElement;
    expect(need.value).toBe("50");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/views/SettingsDrawer.income.test.tsx`
Expected: FAIL — income input currently shows `1500000`, the percent input shows `0.5`, and there's no accessible `Monthly income` label association.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/views/SettingsDrawer.tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON, del } from "../api/client";
import type { BudgetConfig, Category, Rule } from "../api/types";
import { dirhamsToFils, filsToDirhams, fractionToPercent, percentToFraction } from "../lib/format";

export function pctsValid(need: number, want: number, saving: number): boolean {
  return Math.abs(need + want + saving - 1.0) < 0.001;
}

const BUCKETS = ["need", "want", "saving"] as const;

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => getJSON<Rule[]>("/api/rules") });

  const [draft, setDraft] = useState<BudgetConfig | null>(null);
  const [error, setError] = useState("");
  const cfg = draft ?? budget.data ?? null;
  const patch = (p: Partial<BudgetConfig>) => cfg && setDraft({ ...cfg, ...p });

  const saveBudget = async () => {
    if (!cfg) return;
    if (!pctsValid(cfg.need_pct, cfg.want_pct, cfg.saving_pct)) {
      setError("Need / Want / Saving must add up to 100%.");
      return;
    }
    setError("");
    await postJSON("/api/budget", cfg, "PUT");
    setDraft(null);
    qc.invalidateQueries({ queryKey: ["budget"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const reassign = async (c: Category, bucket: string) => {
    await postJSON(`/api/categories/${c.ID}`, { name: c.Name, kind: c.Kind, bucket }, "PUT");
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const deleteRule = async (id: number) => {
    await del(`/api/rules/${id}`);
    qc.invalidateQueries({ queryKey: ["rules"] });
  };

  const catName = (id: number) => cats.data?.find((c) => c.ID === id)?.Name ?? `#${id}`;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h4>Settings</h4>

        {cfg && (
          <fieldset>
            <legend>Budget</legend>
            <label>Monthly income (AED)
              <input
                type="number" min="0" step="0.01"
                value={filsToDirhams(cfg.monthly_income)}
                onChange={(e) => patch({ monthly_income: dirhamsToFils(Number(e.target.value)) })}
              />
            </label>
            <label>Income source
              <select value={cfg.income_source} onChange={(e) => patch({ income_source: e.target.value })}>
                <option value="config">Use the figure above</option>
                <option value="categories">Sum income categories</option>
              </select>
            </label>
            <div className="field-row">
              <label>Need %
                <input type="number" min="0" max="100" step="1"
                  value={fractionToPercent(cfg.need_pct)}
                  onChange={(e) => patch({ need_pct: percentToFraction(Number(e.target.value)) })} />
              </label>
              <label>Want %
                <input type="number" min="0" max="100" step="1"
                  value={fractionToPercent(cfg.want_pct)}
                  onChange={(e) => patch({ want_pct: percentToFraction(Number(e.target.value)) })} />
              </label>
              <label>Saving %
                <input type="number" min="0" max="100" step="1"
                  value={fractionToPercent(cfg.saving_pct)}
                  onChange={(e) => patch({ saving_pct: percentToFraction(Number(e.target.value)) })} />
              </label>
            </div>
            <label><input type="checkbox" checked={cfg.freeze_history} onChange={(e) => patch({ freeze_history: e.target.checked })} /> Freeze history</label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button onClick={saveBudget}>Save budget</button>
          </fieldset>
        )}

        {BUCKETS.map((bucket) => (
          <fieldset key={bucket}>
            <legend style={{ textTransform: "capitalize" }}>{bucket}</legend>
            {(cats.data ?? []).filter((c) => c.Kind === "spending" && c.Bucket === bucket).map((c) => (
              <div key={c.ID} className="field-row" style={{ justifyContent: "space-between" }}>
                <span>{c.Name}</span>
                <select value={c.Bucket} onChange={(e) => reassign(c, e.target.value)}>
                  {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            ))}
          </fieldset>
        ))}

        <fieldset>
          <legend>Rules</legend>
          {(rules.data ?? []).map((r) => (
            <div key={r.ID} className="field-row" style={{ justifyContent: "space-between" }}>
              <span>{r.MatchType}: "{r.Pattern}" → {catName(r.CategoryID)}</span>
              <button onClick={() => deleteRule(r.ID)}>✕</button>
            </div>
          ))}
          {rules.data?.length === 0 && <small>No rules yet — confirm a review item with "Save as rule".</small>}
        </fieldset>

        <fieldset>
          <legend>About</legend>
          <small>Fugue Icons by Yusuke Kamiyamane (CC BY 3.0). Chrome: XP.css (MIT).</small>
        </fieldset>

        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass (new income test + the untouched pct test)**

Run: `bunx vitest run src/views/SettingsDrawer.income.test.tsx src/views/SettingsDrawer.pct.test.ts`
Expected: PASS for both files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/SettingsDrawer.tsx frontend/src/views/SettingsDrawer.income.test.tsx
git commit -m "feat(pwa): Settings — AED income, whole-percent splits, inline validation"
```

---

# Phase 7 — Modern-interior styling & ship

### Task 14: Theme CSS — cards, pills, modal, toast, skeleton, empty, icon nav

**Files:**
- Modify: `frontend/src/styles/theme.css`

This is the "modern interior" layer. It styles the new class names introduced across Phases 1–6 while leaving the retro title bar / taskbar gradient intact. No unit test — verified by build + a manual look in Task 16.

- [ ] **Step 1: Append the new styles**

Append the following to the end of `frontend/src/styles/theme.css`:

```css
/* ---------- modern interior ---------- */
.icon { display: inline-block; vertical-align: middle; image-rendering: -webkit-optimize-contrast; }

/* bottom nav: icon over label */
.taskbar button {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; line-height: 1;
}
.taskbar .tab-label { font-size: 11px; }
.taskbar .tab-icon { position: relative; }
.taskbar .tab-icon .badge { position: absolute; top: -6px; right: -10px; }
.title-bar-status { color: #ffd; font-size: 12px; padding-right: 6px; }

/* card list */
.list { display: flex; flex-direction: column; gap: 8px; }
.card {
  display: flex; align-items: center; gap: 10px; width: 100%;
  background: #fff; border: 1px solid #0003; box-shadow: 1px 1px 0 #0001;
  padding: 10px; text-align: left;
}
button.card { font: inherit; cursor: pointer; }
.card-main { display: flex; flex-direction: column; flex: 1; min-width: 0; background: none; border: 0; padding: 0; text-align: left; }
.card-merchant { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-sub { font-size: 12px; color: #666; }
.review-card { flex-wrap: wrap; }
.card-actions { display: flex; gap: 6px; width: 100%; }
.card-actions .action { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; }

/* status pills */
.pill { font-size: 12px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; border: 1px solid #0002; }
.pill-good { background: #e3f4e3; color: #1d6b1d; }
.pill-warn { background: #fdf2d6; color: #8a6100; }
.pill-muted { background: #eee; color: #777; }
.pill-neutral { background: #e6eefb; color: #1e4fa6; }
.result-count { font-size: 12px; color: #666; margin: 4px 0 8px; }

/* filters row */
.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }

/* dashboard header */
.dash-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.dash-income { font-size: 22px; font-weight: 700; }
.muted { color: #777; }
.recent { list-style: none; margin: 0; padding: 0; }
.recent-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #0001; }

/* modal dialog */
.modal-backdrop { position: fixed; inset: 0; background: #0007; display: flex; align-items: flex-end; justify-content: center; z-index: 50; }
.modal-window { width: min(96vw, 420px); margin-bottom: var(--touch); animation: slide-up .18s ease-out; }
@keyframes slide-up { from { transform: translateY(16px); opacity: 0; } to { transform: none; opacity: 1; } }
.dialog-txn { margin: 0 0 8px; }
.search { width: 100%; margin-bottom: 8px; }
.cat-list { max-height: 46vh; overflow-y: auto; }
.cat-group { margin-bottom: 8px; }
.cat-option { display: block; padding: 8px 0; }
.rule-toggle { display: block; margin: 8px 0; }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }

/* toast stack */
.toast-stack { position: fixed; left: 0; right: 0; bottom: calc(var(--touch) + 8px); display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 60; pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 12px; max-width: 92vw; background: #323232; color: #fff; padding: 10px 12px; box-shadow: 1px 1px 4px #0006; animation: slide-up .18s ease-out; }
.toast-success { background: #1d6b1d; }
.toast-error { background: #a11; }
.toast-action { background: none; border: 0; color: #9cf; font-weight: 700; min-height: auto; }
.toast-close { background: none; border: 0; color: #ccc; min-height: auto; font-size: 16px; }

/* skeleton + empty + form error */
.skeleton { display: flex; flex-direction: column; gap: 8px; }
.skeleton-bar { height: 18px; background: linear-gradient(90deg, #ddd 25%, #eee 37%, #ddd 63%); background-size: 400% 100%; animation: shimmer 1.2s ease-in-out infinite; }
@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
.empty { text-align: center; padding: 28px 16px; color: #666; }
.empty-title { font-weight: 600; margin: 8px 0 2px; }
.empty-hint { font-size: 13px; margin: 0; }
.form-error { color: var(--red); font-size: 13px; margin: 6px 0; }
```

- [ ] **Step 2: Run the full test suite (no regressions from CSS, sanity check)**

Run: `bun run test`
Expected: PASS — CSS is import-only; all existing/new tests stay green.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles/theme.css
git commit -m "feat(pwa): modern-interior styles — cards, pills, modal, toast, skeleton"
```

---

### Task 15: Manual smoke test in the dev server

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `cd /root/Coding/ledger/frontend && bun run dev`
(Vite proxies/serves on its default port; the API is served by the Go binary — for a pure UI smoke test the views render with their loading/empty states even without the backend.)

- [ ] **Step 2: Walk the checklist (visually confirm each)**

- Bottom nav shows four icon+label buttons (Settings, Dashboard, Review, History); the dead Minimize/Maximize/Close buttons are gone.
- Review items show **Transfer** and **Ignore** buttons with icons and text; ignoring one pops a toast with **Undo**; undo returns it to the list.
- Tapping a Review or History row opens the Categorize modal; the search box filters the category list; categories are grouped by Needs/Wants/Savings.
- History shows human status pills ("Needs review") and an "N transactions" count; empty filters show the empty state.
- Settings shows income in **AED** (e.g. 15000) and splits as whole percents (50/30/20); entering splits that don't total 100% shows an inline error, not a browser alert.
- Toggle the network offline (DevTools) → the title bar shows "● Offline".

- [ ] **Step 3: Stop the dev server**

Press `Ctrl-C` in the dev server terminal.

(No commit — verification task.)

---

### Task 16: Build the embedded bundle & verify the Go binary serves it

**Files:** regenerates `frontend/` build output into `internal/web/dist/` (committed artifacts).

The Go binary serves the UI from `//go:embed all:dist`. Rebuild so production serves the overhauled app.

- [ ] **Step 1: Run the full frontend suite one last time**

Run: `cd /root/Coding/ledger/frontend && bun run test`
Expected: PASS — every test file green.

- [ ] **Step 2: Type-check and build into the embedded dist**

Run: `cd /root/Coding/ledger/frontend && bun run build`
Expected: `tsc -b` reports no errors; Vite writes assets to `../internal/web/dist` (the build's `outDir`).

- [ ] **Step 3: Confirm Go still builds with the new embedded assets**

Run: `cd /root/Coding/ledger && go build ./... && go test ./internal/web/...`
Expected: build succeeds; embed package tests pass (the `dist/` directory is non-empty and embeddable).

- [ ] **Step 4: Commit the rebuilt bundle**

```bash
cd /root/Coding/ledger
git add internal/web/dist frontend
git commit -m "build(pwa): rebuild embedded dist with the UX overhaul"
```

- [ ] **Step 5: (Deploy is local — this box is the prod server.) Restart the service to serve the new bundle**

Run: `sudo systemctl restart ledger.service && systemctl --no-pager status ledger.service`
Expected: service is `active (running)`. Load the PWA and confirm the new navigation appears.

---

## Self-Review

**1. Spec coverage** (against the diagnosis + user's "comprehensive, retro-shell/modern-interior" choice):
- Dead window chrome → Task 6. ✅
- Unused icon set wired in → Tasks 2, 7, 9, 12. ✅
- Cryptic Review actions + no feedback/undo → Tasks 3, 9. ✅
- Category dialog has no search → Task 10. ✅
- Cramped Transactions table, raw enum status, no count/empty → Task 11. ✅
- Raw-fils / decimal-fraction Settings inputs, blocking alert → Tasks 1, 13. ✅
- No global toasts → Tasks 3, 8. ✅
- No offline indicator → Tasks 4, 6, 8. ✅
- Loading/empty/error states across views → Tasks 5, 9, 11, 12. ✅
- Polish/animations → Task 14. ✅
- Ship to the embedded binary → Task 16. ✅

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" — every code step contains full source. ✅

**3. Type consistency:**
- `IconName` union defined in Task 2 is used as `name="gear" | "chart" | "flag" | "table" | "transfer" | "cross" | "tick" | "alert" | "money"` everywhere downstream — all referenced names exist in the `ICONS` map. ✅
- `useToast().show(t: Omit<Toast,"id">)` — callers in Review/Transactions pass `{ message, tone?, action? }`, matching the type. ✅
- `buildTxnQuery` / `pctsValid` keep their original signatures and exports, so the pre-existing `Transactions.filters.test.ts` and `SettingsDrawer.pct.test.ts` stay valid. ✅
- `statusLabel`/`statusTone` (Task 1) consumed in Task 11 with matching signatures. ✅
- `Modal` props `{ title, onClose, children }` (Task 5) match the call in `CategorizeDialog` (Task 10). ✅

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-14-pwa-ux-overhaul.md`.**
</content>
</invoke>
