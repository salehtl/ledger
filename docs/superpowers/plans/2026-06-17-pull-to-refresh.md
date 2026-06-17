# Pull-to-Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mobile pull-to-refresh gesture on the app's shared scroll container that refetches all active react-query data and shows a spinner.

**Architecture:** Pure gesture math lives in `lib/pullToRefresh.ts`. A `usePullToRefresh` hook attaches touch listeners to the `<main>` element via a ref, owns `pullDistance`/`refreshing` state, and calls an injected `onRefresh`. A presentational `PullToRefreshIndicator` renders the spinner. `AppShell` wires the hook to `queryClient.invalidateQueries()`.

**Tech Stack:** React 18 + TypeScript, TanStack Query v5, Tailwind v4, lucide-react (`Loader2`), vitest + @testing-library/react (jsdom). Run frontend tests with `cd frontend && bunx vitest run <file>`.

---

## File Structure

- `frontend/src/lib/pullToRefresh.ts` — **create**: `resist`, `shouldTrigger`, `PULL_THRESHOLD`, `MAX_PULL`.
- `frontend/src/lib/pullToRefresh.test.ts` — **create**: pure-helper tests.
- `frontend/src/components/PullToRefreshIndicator.tsx` — **create**: spinner overlay.
- `frontend/src/components/PullToRefreshIndicator.test.tsx` — **create**: component tests.
- `frontend/src/hooks/usePullToRefresh.ts` — **create**: gesture hook.
- `frontend/src/hooks/usePullToRefresh.test.ts` — **create**: hook tests.
- `frontend/src/app/AppShell.tsx` — **modify**: wire hook + indicator into `<main>`.
- `frontend/src/app/AppShell.test.tsx` — **modify**: gesture-triggers-refetch test.

---

## Task 1: Pure gesture helpers (`lib/pullToRefresh.ts`)

**Files:**
- Create: `frontend/src/lib/pullToRefresh.ts`
- Test: `frontend/src/lib/pullToRefresh.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/pullToRefresh.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resist, shouldTrigger, PULL_THRESHOLD, MAX_PULL } from "./pullToRefresh";

describe("resist", () => {
  it("returns 0 for non-positive travel", () => {
    expect(resist(0)).toBe(0);
    expect(resist(-50)).toBe(0);
  });

  it("damps raw finger travel", () => {
    expect(resist(100)).toBe(50); // 100 * 0.5
  });

  it("caps at MAX_PULL", () => {
    expect(resist(10_000)).toBe(MAX_PULL);
  });
});

describe("shouldTrigger", () => {
  it("triggers at or past the threshold", () => {
    expect(shouldTrigger(PULL_THRESHOLD)).toBe(true);
    expect(shouldTrigger(PULL_THRESHOLD + 1)).toBe(true);
  });

  it("does not trigger below the threshold", () => {
    expect(shouldTrigger(PULL_THRESHOLD - 1)).toBe(false);
    expect(shouldTrigger(0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/pullToRefresh.test.ts`
Expected: FAIL — module `./pullToRefresh` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/pullToRefresh.ts`:

```ts
/** Resisted pull distance (px) needed to trigger a refresh. */
export const PULL_THRESHOLD = 64;
/** Maximum resisted pull distance (px); caps indicator travel. */
export const MAX_PULL = 96;
/** Rubber-band damping applied to raw finger travel. */
const RESISTANCE = 0.5;

/**
 * Convert raw downward finger travel (px) into a damped, capped pull distance.
 * Upward / non-positive travel yields 0.
 */
export function resist(rawDelta: number): number {
  if (rawDelta <= 0) return 0;
  return Math.min(MAX_PULL, rawDelta * RESISTANCE);
}

/** Whether releasing at this resisted distance should trigger a refresh. */
export function shouldTrigger(distance: number): boolean {
  return distance >= PULL_THRESHOLD;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/pullToRefresh.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/pullToRefresh.ts frontend/src/lib/pullToRefresh.test.ts
git commit -m "feat(frontend): pure pull-to-refresh gesture helpers"
```

---

## Task 2: `PullToRefreshIndicator` component

**Files:**
- Create: `frontend/src/components/PullToRefreshIndicator.tsx`
- Test: `frontend/src/components/PullToRefreshIndicator.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/PullToRefreshIndicator.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PullToRefreshIndicator } from "./PullToRefreshIndicator";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";

describe("PullToRefreshIndicator", () => {
  it("shows a spinning loader while refreshing", () => {
    render(<PullToRefreshIndicator pullDistance={0} refreshing={true} />);
    const status = screen.getByRole("status", { name: /refreshing/i });
    expect(status).toBeInTheDocument();
    expect(status.classList.contains("animate-spin")).toBe(true);
  });

  it("grows the overlay with pull distance and does not spin", () => {
    render(<PullToRefreshIndicator pullDistance={32} refreshing={false} />);
    const overlay = screen.getByTestId("ptr-indicator");
    expect(overlay).toHaveStyle({ height: "32px" });
    expect(overlay.querySelector(".animate-spin")).toBeNull();
  });

  it("uses the threshold height while refreshing", () => {
    render(<PullToRefreshIndicator pullDistance={0} refreshing={true} />);
    expect(screen.getByTestId("ptr-indicator")).toHaveStyle({ height: `${PULL_THRESHOLD}px` });
  });

  it("is hidden at rest", () => {
    render(<PullToRefreshIndicator pullDistance={0} refreshing={false} />);
    expect(screen.getByTestId("ptr-indicator")).toHaveAttribute("aria-hidden", "true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/PullToRefreshIndicator.test.tsx`
Expected: FAIL — module `./PullToRefreshIndicator` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/components/PullToRefreshIndicator.tsx`:

```tsx
import { Loader2 } from "lucide-react";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";

export function PullToRefreshIndicator({ pullDistance, refreshing }: {
  pullDistance: number;
  refreshing: boolean;
}) {
  const height = refreshing ? PULL_THRESHOLD : pullDistance;
  const visible = refreshing || pullDistance > 0;
  const progress = Math.min(1, pullDistance / PULL_THRESHOLD);

  return (
    <div
      data-testid="ptr-indicator"
      aria-hidden={!visible}
      className="absolute inset-x-0 top-0 z-10 flex items-end justify-center overflow-hidden pointer-events-none"
      style={{ height }}
    >
      <div className="pb-2">
        {refreshing ? (
          <Loader2 size={24} role="status" aria-label="Refreshing" className="text-muted animate-spin" />
        ) : (
          <Loader2
            size={24}
            aria-hidden
            className="text-muted"
            style={{ opacity: progress, transform: `rotate(${progress * 270}deg)` }}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/PullToRefreshIndicator.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PullToRefreshIndicator.tsx frontend/src/components/PullToRefreshIndicator.test.tsx
git commit -m "feat(frontend): PullToRefreshIndicator spinner overlay"
```

---

## Task 3: `usePullToRefresh` hook

**Files:**
- Create: `frontend/src/hooks/usePullToRefresh.ts`
- Test: `frontend/src/hooks/usePullToRefresh.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/hooks/usePullToRefresh.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, fireEvent } from "@testing-library/react";
import { usePullToRefresh } from "./usePullToRefresh";

// jsdom's scrollTop is a no-op setter, so shadow it with an own property.
function makeEl(scrollTop = 0): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { configurable: true, value: scrollTop });
  document.body.appendChild(el);
  return el;
}

describe("usePullToRefresh", () => {
  it("tracks a downward pull from the top", () => {
    const el = makeEl(0);
    const { result } = renderHook(() => usePullToRefresh({ current: el }, async () => {}));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientY: 100 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientY: 200 }] }); });
    expect(result.current.pullDistance).toBeGreaterThan(0);
  });

  it("ignores pulls when not scrolled to the top", () => {
    const el = makeEl(50);
    const { result } = renderHook(() => usePullToRefresh({ current: el }, async () => {}));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientY: 100 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientY: 200 }] }); });
    expect(result.current.pullDistance).toBe(0);
  });

  it("fires onRefresh past the threshold and clears refreshing after it resolves", async () => {
    const el = makeEl(0);
    let resolve!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const { result } = renderHook(() => usePullToRefresh({ current: el }, onRefresh));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientY: 0 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientY: 400 }] }); }); // 400px raw → capped, past threshold
    act(() => { fireEvent.touchEnd(el); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(true);
    await act(async () => { resolve(); });
    expect(result.current.refreshing).toBe(false);
  });

  it("does not fire onRefresh for a sub-threshold pull", () => {
    const el = makeEl(0);
    const onRefresh = vi.fn(async () => {});
    const { result } = renderHook(() => usePullToRefresh({ current: el }, onRefresh));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientY: 100 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientY: 110 }] }); }); // 10px raw → 5px resisted
    act(() => { fireEvent.touchEnd(el); });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(result.current.pullDistance).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/hooks/usePullToRefresh.test.ts`
Expected: FAIL — module `./usePullToRefresh` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/hooks/usePullToRefresh.ts`:

```ts
import { useEffect, useRef, useState, type RefObject } from "react";
import { resist, shouldTrigger } from "../lib/pullToRefresh";

/**
 * Pull-to-refresh gesture on a scroll container. Tracking begins only when the
 * element is scrolled to the top; releasing past the threshold calls onRefresh
 * and keeps `refreshing` true until its promise settles.
 */
export function usePullToRefresh(
  ref: RefObject<HTMLElement>,
  onRefresh: () => Promise<unknown>,
): { pullDistance: number; refreshing: boolean } {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const startY = useRef<number | null>(null);
  const distanceRef = useRef(0);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const setDistance = (d: number) => { distanceRef.current = d; setPullDistance(d); };

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      startY.current = el.scrollTop <= 0 ? e.touches[0].clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current === null || refreshingRef.current) return;
      const dist = resist(e.touches[0].clientY - startY.current);
      if (dist > 0) {
        e.preventDefault(); // suppress native scroll/bounce while pulling
        setDistance(dist);
      }
    };
    const onEnd = () => {
      if (startY.current === null) return;
      startY.current = null;
      if (shouldTrigger(distanceRef.current)) {
        refreshingRef.current = true;
        setRefreshing(true);
        setDistance(0);
        Promise.resolve(onRefreshRef.current()).finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
        });
      } else {
        setDistance(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [ref]);

  return { pullDistance, refreshing };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/hooks/usePullToRefresh.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/usePullToRefresh.ts frontend/src/hooks/usePullToRefresh.test.ts
git commit -m "feat(frontend): usePullToRefresh touch gesture hook"
```

---

## Task 4: Wire into `AppShell`

**Files:**
- Modify: `frontend/src/app/AppShell.tsx`
- Test: `frontend/src/app/AppShell.test.tsx`

- [ ] **Step 1: Write the failing test**

Add this import line at the top of `frontend/src/app/AppShell.test.tsx` alongside the existing `@testing-library/react` import (replace the existing import line):

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
```

Then add this test inside the `describe("AppShell", …)` block (after the existing tests):

```tsx
  it("refetches data when the user pulls down from the top", async () => {
    wrap();
    await screen.findByRole("button", { name: /home/i });
    const fetchMock = global.fetch as unknown as { mock: { calls: unknown[][] } };
    const summaryCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/summary")).length;
    const before = summaryCalls();

    const main = screen.getByRole("main");
    fireEvent.touchStart(main, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(main, { touches: [{ clientY: 400 }] }); // past threshold
    fireEvent.touchEnd(main);

    await waitFor(() => expect(summaryCalls()).toBeGreaterThan(before));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/app/AppShell.test.tsx`
Expected: FAIL — pulling does nothing yet, so `summaryCalls()` never exceeds `before` and `waitFor` times out.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/app/AppShell.tsx`:

1. Replace the React import line `import { useState } from "react";` with:

```tsx
import { useRef, useState } from "react";
```

2. Extend the react-query import line `import { useQuery } from "@tanstack/react-query";` to:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
```

3. Add these imports alongside the other hook/component imports (e.g. after `import { useLiveEvents } from "../hooks/useLiveEvents";`):

```tsx
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { PullToRefreshIndicator } from "../components/PullToRefreshIndicator";
```

4. Inside the `AppShell` component, after `useLiveEvents();`, add:

```tsx
  const qc = useQueryClient();
  const mainRef = useRef<HTMLElement>(null);
  const { pullDistance, refreshing } = usePullToRefresh(mainRef, () => qc.invalidateQueries());
```

5. Replace the opening `<main>` tag:

```tsx
      <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
```

with (add `ref` + `relative`, then render the indicator as the first child):

```tsx
      <main ref={mainRef} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />
```

(The existing `<div className="max-w-screen-sm …">` content block stays exactly as-is, now following the indicator inside `<main>`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/app/AppShell.test.tsx`
Expected: PASS (original 3 tests + 1 new = 4).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx
git commit -m "feat(frontend): wire pull-to-refresh into AppShell scroll container"
```

---

## Task 5: Full verification + rebuild embedded bundle

**Files:**
- Modify: `internal/web/dist/` (rebuilt artifact)

- [ ] **Step 1: Run the full frontend test suite**

Run: `cd frontend && bun run test`
Expected: PASS — all files green, including the four new/extended pull-to-refresh test files.

- [ ] **Step 2: Typecheck / build the frontend**

Run: `cd frontend && bun run build`
Expected: build succeeds (`tsc -b && vite build`) with no TypeScript errors; assets emitted to `internal/web/dist/`.

(Per CLAUDE.md, `internal/web/dist/` is a committed build artifact and parallel sessions run on `main`, so the embedded bundle must match source before finishing.)

- [ ] **Step 3: Build the Go binary to confirm the embed still compiles**

Run: `cd /root/Coding/ledger && CGO_ENABLED=0 go build -o ledger ./cmd/ledger`
Expected: builds with no errors.

- [ ] **Step 4: Commit the rebuilt bundle**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for pull-to-refresh"
```

---

## Self-Review Notes

- **Spec coverage:** gesture on shared `<main>` for all tabs (Task 4); refresh = `qc.invalidateQueries()` (Task 4); engage only at top via `scrollTop <= 0` (Task 3); rubber-band damp+cap (Task 1); spinner indicator (Task 2); no new dependency (uses existing `lucide-react`/react-query). All covered.
- **Type consistency:** `usePullToRefresh(ref, onRefresh)` returns `{ pullDistance, refreshing }` — the exact shape consumed by `AppShell` and passed to `PullToRefreshIndicator`'s `{ pullDistance, refreshing }` props. `resist`/`shouldTrigger`/`PULL_THRESHOLD`/`MAX_PULL` names match between definition (Task 1) and use (Tasks 2–3). `onRefresh: () => Promise<unknown>` matches `() => qc.invalidateQueries()` (returns a Promise).
- **No placeholders:** every code/test step contains complete code and an exact run command.
- **jsdom note:** `scrollTop` is shadowed via `Object.defineProperty` in the hook test because jsdom's setter is a no-op; `fireEvent.touch*` carries the `touches` array onto the dispatched event.
