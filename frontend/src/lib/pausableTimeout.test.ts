import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPausableTimeout, type VisibilityDoc } from "./pausableTimeout";

/** A fake Document exposing just visibility state + the change event. */
function fakeDoc(hidden = false) {
  const listeners = new Set<() => void>();
  const doc: VisibilityDoc & { setHidden(h: boolean): void; listenerCount(): number } = {
    hidden,
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
    setHidden(h: boolean) {
      doc.hidden = h;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
  return doc;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startPausableTimeout", () => {
  it("fires once after the delay when the tab stays visible", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    startPausableTimeout(fn, 5000, doc);
    vi.advanceTimersByTime(4999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("pauses while hidden and resumes with the remaining time", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    startPausableTimeout(fn, 5000, doc);
    vi.advanceTimersByTime(2000);
    doc.setHidden(true);
    vi.advanceTimersByTime(60_000); // a long background stretch
    expect(fn).not.toHaveBeenCalled();
    doc.setHidden(false);
    vi.advanceTimersByTime(2999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // 2000 elapsed + 3000 after resume = 5000
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("survives repeated hide/show cycles, accumulating only visible time", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    startPausableTimeout(fn, 3000, doc);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(900);
      doc.setHidden(true);
      vi.advanceTimersByTime(10_000);
      doc.setHidden(false);
    }
    expect(fn).not.toHaveBeenCalled(); // 2700 visible ms so far
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ignores duplicate visibility events in the same state", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    startPausableTimeout(fn, 1000, doc);
    doc.setHidden(true);
    doc.setHidden(true); // must not double-subtract elapsed time
    vi.advanceTimersByTime(50_000);
    doc.setHidden(false);
    doc.setHidden(false); // must not double-arm the timer
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not start counting while created hidden", () => {
    const doc = fakeDoc(true);
    const fn = vi.fn();
    startPausableTimeout(fn, 1000, doc);
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
    doc.setHidden(false);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents the callback and detaches the listener", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    const t = startPausableTimeout(fn, 1000, doc);
    t.cancel();
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    expect(doc.listenerCount()).toBe(0);
    t.cancel(); // idempotent
  });

  it("detaches the listener after firing", () => {
    const doc = fakeDoc();
    startPausableTimeout(() => {}, 1000, doc);
    vi.advanceTimersByTime(1000);
    expect(doc.listenerCount()).toBe(0);
  });

  it("cancelling while hidden never fires on return", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    const t = startPausableTimeout(fn, 1000, doc);
    doc.setHidden(true);
    t.cancel();
    doc.setHidden(false);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
