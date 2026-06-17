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
