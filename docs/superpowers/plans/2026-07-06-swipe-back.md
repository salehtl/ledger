# Swipe-Back Gesture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Worktree/cwd note:** subagents start in `/root/Coding/ledger` even when the session runs in a worktree. Every dispatched task must `cd` to the correct checkout and verify the branch before touching files.

**Goal:** iOS-style interactive edge-swipe-back on all nine full-screen drill-in pages (the `SettingsPage` shell), with matching slide-in/slide-out page transitions.

**Architecture:** Mirrors the existing vertical dismiss stack (`lib/sheetDrag.ts` → `hooks/useSheetDrag.ts` → `Dialog`) rotated horizontal: pure geometry in `lib/edgeBack.ts`, pointer wiring in `hooks/useEdgeBack.ts` driving the panel's `translateX` directly (GPU, no re-render per move), attached once in `SettingsPage` via a 24px invisible edge strip. The shell gains Dialog's play-exit-then-unmount pattern so both the back arrow and a committed drag animate out before `onClose` fires.

**Tech Stack:** React 18 + TypeScript, vitest + Testing Library (jsdom), Tailwind v4 tokens (`--ease-drawer`), pointer events.

**Spec:** `docs/superpowers/specs/2026-07-06-swipe-back-design.md`

## Global Constraints

- Scope is the `SettingsPage` shell only — no changes to any of the nine drill-in pages, no Dialog changes, no tab/history changes.
- `onClose` prop semantics for consumers are unchanged (it still means "unmount me now"); the shell internally delays it by the exit animation.
- Commit rule: dismiss when `dx >= viewportWidth / 3` OR velocity `>= 0.11 px/ms`; leftward drags never commit.
- Activation: drag must start within 24px of the left edge; the strip wins over content beneath it.
- Reduced motion (`prefers-reduced-motion`): no tracking, no slides; a completed edge flick still triggers back. Same convention as `Dialog`/`useSheetDrag`.
- `setPointerCapture` must stay optional-chained (jsdom lacks it).
- `CategoryManager.test.tsx` asserts the shell root keeps `fixed` and `bg-bg` classes — do not restructure the root div's className.
- Frontend vitest is pinned to a single non-parallel fork in `vite.config.ts` — do not change that.
- `internal/web/dist/` is a committed build artifact; rebuild it before finishing the branch.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File map

| File | Change |
|---|---|
| `frontend/src/lib/edgeBack.ts` (new) | pure geometry: zone, offset clamp, commit rule |
| `frontend/src/lib/edgeBack.test.ts` (new) | unit tests for all three |
| `frontend/src/lib/motion.ts` | `pageTransition` alias |
| `frontend/src/hooks/useEdgeBack.ts` (new) | pointer wiring, transform driving |
| `frontend/src/screens/settings/SettingsPage.tsx` | edge strip, slide-in/out, requestClose |
| `frontend/src/screens/settings/SettingsPage.test.tsx` (new) | gesture + arrow component tests |
| `internal/web/dist/` | rebuilt embedded bundle |

---

### Task 1: Pure geometry — `lib/edgeBack.ts` + `pageTransition`

**Files:**
- Create: `frontend/src/lib/edgeBack.ts`
- Create: `frontend/src/lib/edgeBack.test.ts`
- Modify: `frontend/src/lib/motion.ts` (append one export)

**Interfaces:**
- Consumes: nothing.
- Produces (Task 2 imports exactly these): `EDGE_ZONE_PX = 24`, `BACK_COMMIT_FRACTION = 1/3`, `BACK_COMMIT_VELOCITY = 0.11`, `inEdgeZone(startX: number): boolean`, `edgeBackOffset(dx: number): number`, `shouldGoBack(dx: number, elapsedMs: number, viewportWidth: number): boolean`; and from `motion.ts`: `pageTransition(reduced: boolean): string`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/edgeBack.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BACK_COMMIT_VELOCITY, EDGE_ZONE_PX, edgeBackOffset, inEdgeZone, shouldGoBack } from "./edgeBack";

describe("inEdgeZone", () => {
  it("accepts starts within the zone and rejects beyond it", () => {
    expect(inEdgeZone(0)).toBe(true);
    expect(inEdgeZone(EDGE_ZONE_PX)).toBe(true);
    expect(inEdgeZone(EDGE_ZONE_PX + 1)).toBe(false);
  });
});

describe("edgeBackOffset", () => {
  it("follows rightward drag 1:1 and clamps leftward drag to rest", () => {
    expect(edgeBackOffset(120)).toBe(120);
    expect(edgeBackOffset(0)).toBe(0);
    expect(edgeBackOffset(-40)).toBe(0);
  });
});

describe("shouldGoBack", () => {
  const width = 390; // iPhone-ish viewport

  it("commits past a third of the viewport width", () => {
    expect(shouldGoBack(130, 5000, width)).toBe(true);
    expect(shouldGoBack(129, 5000, width)).toBe(false);
  });

  it("commits a fast flick regardless of distance", () => {
    expect(shouldGoBack(40, 40 / BACK_COMMIT_VELOCITY - 1, width)).toBe(true);
  });

  it("rejects slow short drags and leftward drags", () => {
    expect(shouldGoBack(40, 2000, width)).toBe(false);
    expect(shouldGoBack(-200, 10, width)).toBe(false);
    expect(shouldGoBack(0, 10, width)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/lib/edgeBack.test.ts`
Expected: FAIL — cannot resolve `./edgeBack`.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/edgeBack.ts`:

```ts
// Pure edge-swipe-back geometry for full-screen drill-in pages. Framework-free
// so the activation zone and the commit rule are unit-tested without rendering.
// Horizontal sibling of lib/sheetDrag.ts.

/** A back drag must START within this many px of the left screen edge. */
export const EDGE_ZONE_PX = 24;
/** Fraction of the viewport width that commits the back navigation. */
export const BACK_COMMIT_FRACTION = 1 / 3;
/** Flick velocity (px/ms) that commits regardless of distance. */
export const BACK_COMMIT_VELOCITY = 0.11;

/** Did the drag start close enough to the left edge to be a back gesture? */
export function inEdgeZone(startX: number): boolean {
  return startX <= EDGE_ZONE_PX;
}

/**
 * Resolve raw horizontal drag into the page's visible offset. Rightward
 * (dx > 0) moves 1:1; leftward is clamped to rest — there is nothing to
 * the left to reveal.
 */
export function edgeBackOffset(dx: number): number {
  return Math.max(0, dx);
}

/** Should the page pop on release? A long drag right OR a quick flick right. */
export function shouldGoBack(dx: number, elapsedMs: number, viewportWidth: number): boolean {
  if (dx <= 0) return false;
  const velocity = dx / Math.max(1, elapsedMs);
  return dx >= viewportWidth * BACK_COMMIT_FRACTION || velocity >= BACK_COMMIT_VELOCITY;
}
```

Append to `frontend/src/lib/motion.ts` (after `sheetTransition`):

```ts
/** Drill-in pages slide on the same drawer curve and timing as sheets. */
export const pageTransition = sheetTransition;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/lib/edgeBack.test.ts src/lib/motion.test.ts 2>/dev/null || bunx vitest run src/lib/edgeBack.test.ts`
Expected: PASS (motion has no test file today; the alias is covered by Task 2's component tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/edgeBack.ts frontend/src/lib/edgeBack.test.ts frontend/src/lib/motion.ts
git commit -m "feat(web): edge-back gesture geometry and page transition curve

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `useEdgeBack` hook + SettingsPage shell wiring

**Files:**
- Create: `frontend/src/hooks/useEdgeBack.ts`
- Modify: `frontend/src/screens/settings/SettingsPage.tsx` (full replacement below)
- Create: `frontend/src/screens/settings/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: everything from Task 1; `usePrefersReducedMotion` (existing hook); `SHEET_EXIT_MS` from `lib/motion`.
- Produces: `useEdgeBack(panelRef: RefObject<HTMLDivElement>, onBack: () => void, reduced: boolean)` returning `{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel }`; `SettingsPage` keeps its exact public props (`title`, `onClose`, `headerRight`, `children`).

- [ ] **Step 1: Write the failing component tests**

Create `frontend/src/screens/settings/SettingsPage.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

function renderPage(onClose = vi.fn()) {
  render(
    <SettingsPage title="Budget" onClose={onClose}>
      <p>body</p>
    </SettingsPage>,
  );
  return onClose;
}

afterEach(() => vi.restoreAllMocks());

describe("SettingsPage swipe-back", () => {
  it("pops the page after a committing edge drag", async () => {
    const onClose = renderPage();
    const strip = screen.getByTestId("edge-back-strip");
    fireEvent.pointerDown(strip, { clientX: 10, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 400, clientY: 300, pointerId: 1 });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("springs back without closing on a short slow drag", () => {
    // Script the clock: pointerDown reads Date.now() once (start), pointerUp
    // once (elapsed). 50px over 1000ms is below both distance and velocity
    // thresholds — jsdom's real timestamps would fake a lightning flick.
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1000);
    const onClose = renderPage();
    const strip = screen.getByTestId("edge-back-strip");
    fireEvent.pointerDown(strip, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 60, pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 60, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores drags that start outside the edge zone", () => {
    const onClose = renderPage();
    const strip = screen.getByTestId("edge-back-strip");
    fireEvent.pointerDown(strip, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 600, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("back arrow still closes (after the exit animation)", async () => {
    const onClose = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Back from Budget" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/screens/settings/SettingsPage.test.tsx`
Expected: FAIL — no `edge-back-strip` testid, and the arrow calls `onClose` synchronously (waitFor still passes for the arrow test; the two gesture tests fail).

- [ ] **Step 3: Implement the hook**

Create `frontend/src/hooks/useEdgeBack.ts`:

```ts
import { useCallback, useRef, type PointerEvent, type RefObject } from "react";
import { edgeBackOffset, inEdgeZone, shouldGoBack } from "../lib/edgeBack";
import { pageTransition } from "../lib/motion";

/**
 * iOS-style interactive edge-swipe-back. Spread the returned handlers onto a
 * narrow edge strip; the hook drives the full-page panel's transform directly
 * (no React state per move — stays on the GPU). On commit it calls onBack();
 * the page plays its own exit, same contract as useSheetDrag → Dialog.
 * Under reduced motion there is no tracking — a committed flick still fires
 * onBack, untracked.
 */
export function useEdgeBack(
  panelRef: RefObject<HTMLDivElement>,
  onBack: () => void,
  reduced: boolean,
) {
  const startX = useRef<number | null>(null);
  const startT = useRef(0);
  const dx = useRef(0);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (dragging.current || !inEdgeZone(e.clientX)) return; // multi-touch + zone guard
    dragging.current = true;
    startX.current = e.clientX;
    startT.current = Date.now();
    dx.current = 0;
    e.currentTarget.setPointerCapture?.(e.pointerId);        // keep events if pointer leaves
    const panel = panelRef.current;
    if (panel && !reduced) panel.style.transition = "none";  // 1:1 follow while dragging
  }, [reduced, panelRef]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current || startX.current === null) return;
    dx.current = e.clientX - startX.current;
    if (reduced) return;                                     // flick-only under reduced motion
    const panel = panelRef.current;
    if (panel) panel.style.transform = `translateX(${edgeBackOffset(dx.current)}px)`;
  }, [panelRef, reduced]);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    const elapsed = Date.now() - startT.current;
    const panel = panelRef.current;
    const width = panel?.offsetWidth || window.innerWidth;   // jsdom: offsetWidth is 0
    if (panel && !reduced) panel.style.transition = pageTransition(reduced);
    if (shouldGoBack(dx.current, elapsed, width)) {
      startX.current = null;
      onBack();                                              // page plays the slide-out
      return;
    }
    if (panel && !reduced) panel.style.transform = "translateX(0)"; // snap back to rest
    startX.current = null;
  }, [panelRef, onBack, reduced]);

  const onPointerCancel = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    startX.current = null;
    const panel = panelRef.current;
    if (panel && !reduced) {
      panel.style.transition = pageTransition(reduced);
      panel.style.transform = "translateX(0)";
    }
  }, [panelRef, reduced]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
```

- [ ] **Step 4: Rewire the shell**

Replace the entire contents of `frontend/src/screens/settings/SettingsPage.tsx` with:

```tsx
import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { IconButton } from "../../components/ui/IconButton";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useEdgeBack } from "../../hooks/useEdgeBack";
import { pageTransition, SHEET_EXIT_MS } from "../../lib/motion";

/**
 * Shared full-screen drill-in shell for a Settings subpage. Matches the
 * CategoryManager / RulesManager panel: a back-arrow header over a scrolling
 * body. `headerRight` hosts the page's autosave feedback.
 *
 * The shell slides in from the right and supports iOS-style edge-swipe-back:
 * a drag starting in the 24px left-edge strip tracks the finger and reveals
 * the screen underneath; the back arrow and a committed drag both play the
 * slide-out before onClose unmounts the page. Reduced motion drops all
 * slides; an edge flick still navigates back.
 */
export function SettingsPage({
  title,
  onClose,
  headerRight,
  children,
}: {
  title: string;
  onClose: () => void;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closingRef = useRef(false);   // guards against double-close
  const timerRef = useRef<number | null>(null);

  // Slide in from the right on mount. Double rAF lets the browser paint the
  // offscreen start state before transitioning to rest (same as Dialog).
  useEffect(() => {
    const panel = panelRef.current;
    if (reduced || !panel) return;
    panel.style.transform = "translateX(100%)";
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => { panel.style.transform = "translateX(0)"; });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [reduced]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // Play the exit, then ask the parent to unmount us. Under reduced motion,
  // close immediately (no slide).
  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reduced) { onCloseRef.current(); return; }
    const panel = panelRef.current;
    if (panel) panel.style.transform = "translateX(100%)";
    timerRef.current = window.setTimeout(() => onCloseRef.current(), SHEET_EXIT_MS);
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  const drag = useEdgeBack(panelRef, () => requestCloseRef.current(), reduced);

  return (
    <div
      ref={panelRef}
      style={{ transition: pageTransition(reduced), willChange: reduced ? "auto" : "transform" }}
      className="fixed inset-0 z-40 bg-bg flex flex-col"
    >
      {/* Invisible activation strip: touch-none here (and only here) lets
          horizontal pointermoves reach us instead of scrolling the page. */}
      <div
        aria-hidden
        data-testid="edge-back-strip"
        className="absolute left-0 inset-y-0 w-6 z-10 touch-none"
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      />
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        <IconButton label={`Back from ${title}`} className="-ml-2" onClick={requestClose}>
          <ArrowLeft size={20} />
        </IconButton>
        <h1 className="flex-1 text-lg font-semibold text-fg">{title}</h1>
        {headerRight}
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 max-w-screen-sm w-full mx-auto">
        {children}
      </div>
    </div>
  );
}
```

(Note the root div keeps `fixed inset-0 z-40 bg-bg flex flex-col` untouched — `CategoryManager.test.tsx` asserts on it. `w-6` = 24px = `EDGE_ZONE_PX`.)

- [ ] **Step 5: Run the new tests plus every shell consumer's suite**

Run: `cd frontend && bunx vitest run src/screens/settings/SettingsPage.test.tsx src/screens/CategoryManager.test.tsx src/screens/Settings.test.tsx src/screens/Settings.accounts.test.tsx src/screens/Settings.rates.test.tsx src/screens/Settings.categorization.test.tsx src/screens/settings/IngestHealthPage.test.tsx src/screens/settings/TextSizePage.test.tsx`
Expected: PASS. If a consumer test clicks the back arrow and asserts a synchronous close, switch that assertion to `waitFor` — the arrow now animates out first (SHEET_EXIT_MS = 240ms, within waitFor's default timeout).

- [ ] **Step 6: Run the full frontend suite**

Run: `cd frontend && bun run test`
Expected: all files PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useEdgeBack.ts frontend/src/screens/settings/SettingsPage.tsx frontend/src/screens/settings/SettingsPage.test.tsx
git commit -m "feat(web): iOS-style edge-swipe-back and slide transitions on drill-in pages

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Rebuild embedded dist and verify

**Files:**
- Modify: `internal/web/dist/` (committed build artifact)

**Interfaces:**
- Consumes: everything above.
- Produces: a deployable branch whose embedded bundle matches the frontend source.

- [ ] **Step 1: Re-check main for parallel-session drift**

Run `git log --oneline main..HEAD && git log --oneline HEAD..main` (if on a branch). If `main` moved, merge it and re-run the suite before building.

- [ ] **Step 2: Full verification**

```bash
cd frontend && bun run test && bun run build
cd .. && CGO_ENABLED=0 go build -o /tmp/ledger-verify ./cmd/ledger && rm /tmp/ledger-verify
```
Expected: suite PASS; `bun run build` succeeds (TypeScript typecheck); Go binary builds with the new embedded dist.

- [ ] **Step 3: Commit the dist**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded dist (swipe-back)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** activation zone/tracking/commit/cancel → Task 1 geometry + Task 2 hook; entrance/exit slides + arrow parity → Task 2 shell; reduced-motion flick → hook's `reduced` branches; sheets-above inertness needs no code (z-50 Dialog covers the z-10 strip); dist rebuild → Task 3.
- **Type consistency:** `useEdgeBack(panelRef, onBack, reduced)` matches between Task 2's hook and shell; `pageTransition`/`SHEET_EXIT_MS` imports match Task 1's exports; `EDGE_ZONE_PX` (24) matches the strip's `w-6`.
- **Known judgment calls:** exit timer (240ms) fires slightly before the 300ms transition completes — same accepted pattern as Dialog; vertical scrolling that starts inside the 24px strip is sacrificed to the gesture (iOS trade-off, per spec).
