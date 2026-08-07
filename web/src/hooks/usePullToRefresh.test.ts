import { describe, it, expect, vi, afterEach } from "vitest";
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
  afterEach(() => { document.body.innerHTML = ""; });

  it("tracks a downward pull from the top", () => {
    const el = makeEl(0);
    const { result } = renderHook(() => usePullToRefresh({ current: el }, async () => {}));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 100 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientX: 0, clientY: 200 }] }); });
    expect(result.current.pullDistance).toBeGreaterThan(0);
  });

  it("ignores pulls when not scrolled to the top", () => {
    const el = makeEl(50);
    const { result } = renderHook(() => usePullToRefresh({ current: el }, async () => {}));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 100 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientX: 0, clientY: 200 }] }); });
    expect(result.current.pullDistance).toBe(0);
  });

  it("fires onRefresh past the threshold and clears refreshing after it resolves", async () => {
    const el = makeEl(0);
    let resolve!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const { result } = renderHook(() => usePullToRefresh({ current: el }, onRefresh));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 0 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientX: 0, clientY: 400 }] }); }); // 400px raw → capped, past threshold
    act(() => { fireEvent.touchEnd(el); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(true);
    await act(async () => { resolve(); });
    expect(result.current.refreshing).toBe(false);
  });

  it("never starts from a touch inside an open dialog", () => {
    const el = makeEl(0);
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    el.appendChild(sheet);
    const { result } = renderHook(() => usePullToRefresh({ current: el }, async () => {}));
    // Touch lands on the sheet; the event bubbles to the container.
    act(() => { fireEvent.touchStart(sheet, { touches: [{ clientX: 0, clientY: 100 }] }); });
    act(() => { fireEvent.touchMove(sheet, { touches: [{ clientX: 0, clientY: 300 }] }); });
    expect(result.current.pullDistance).toBe(0);
  });

  it("never starts from a PTR-exempt surface (deck card)", () => {
    const el = makeEl(0);
    const card = document.createElement("div");
    card.setAttribute("data-ptr-exempt", "");
    el.appendChild(card);
    const { result } = renderHook(() => usePullToRefresh({ current: el }, async () => {}));
    act(() => { fireEvent.touchStart(card, { touches: [{ clientX: 0, clientY: 100 }] }); });
    act(() => { fireEvent.touchMove(card, { touches: [{ clientX: 0, clientY: 300 }] }); });
    expect(result.current.pullDistance).toBe(0);
  });

  it("rejects a horizontal drag with downward drift (row swipe)", () => {
    const el = makeEl(0);
    const onRefresh = vi.fn(async () => {});
    const { result } = renderHook(() => usePullToRefresh({ current: el }, onRefresh));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 0 }] }); });
    // Judged horizontal at first decisive move; later pure-vertical travel
    // must stay rejected for the rest of the touch.
    act(() => { fireEvent.touchMove(el, { touches: [{ clientX: 40, clientY: 20 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientX: 40, clientY: 300 }] }); });
    act(() => { fireEvent.touchEnd(el); });
    expect(result.current.pullDistance).toBe(0);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("abandons the pull when a second finger lands", () => {
    const el = makeEl(0);
    const { result } = renderHook(() => usePullToRefresh({ current: el }, async () => {}));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 0 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientX: 0, clientY: 100 }] }); });
    expect(result.current.pullDistance).toBeGreaterThan(0);
    act(() => {
      fireEvent.touchMove(el, { touches: [{ clientX: 0, clientY: 120 }, { clientX: 50, clientY: 120 }] });
    });
    expect(result.current.pullDistance).toBe(0);
  });

  it("does nothing when disabled (offline)", () => {
    const el = makeEl(0);
    const onRefresh = vi.fn(async () => {});
    const { result } = renderHook(() => usePullToRefresh({ current: el }, onRefresh, false));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 0 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientX: 0, clientY: 400 }] }); });
    act(() => { fireEvent.touchEnd(el); });
    expect(result.current.pullDistance).toBe(0);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not fire onRefresh for a sub-threshold pull", () => {
    const el = makeEl(0);
    const onRefresh = vi.fn(async () => {});
    const { result } = renderHook(() => usePullToRefresh({ current: el }, onRefresh));
    act(() => { fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 100 }] }); });
    act(() => { fireEvent.touchMove(el, { touches: [{ clientX: 0, clientY: 110 }] }); }); // 10px raw → 5px resisted
    act(() => { fireEvent.touchEnd(el); });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(result.current.pullDistance).toBe(0);
  });
});
