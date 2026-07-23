import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInvalidationScheduler } from "./liveInvalidation";

describe("createInvalidationScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst into one flush after the trailing delay", () => {
    const flush = vi.fn();
    const s = createInvalidationScheduler(flush, 300, 2000);
    for (let i = 0; i < 10; i++) {
      s.schedule();
      vi.advanceTimersByTime(50); // events 50ms apart — inside the 300ms window
    }
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("max-wait flushes during a sustained burst", () => {
    const flush = vi.fn();
    const s = createInvalidationScheduler(flush, 300, 2000);
    // An event every 100ms for 3s: the trailing debounce alone would starve.
    for (let i = 0; i < 30; i++) {
      s.schedule();
      vi.advanceTimersByTime(100);
    }
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("cancel prevents any pending flush", () => {
    const flush = vi.fn();
    const s = createInvalidationScheduler(flush, 300, 2000);
    s.schedule();
    s.cancel();
    vi.advanceTimersByTime(5000);
    expect(flush).not.toHaveBeenCalled();
  });

  it("a flush resets state so the next event schedules again", () => {
    const flush = vi.fn();
    const s = createInvalidationScheduler(flush, 300, 2000);
    s.schedule();
    vi.advanceTimersByTime(300);
    s.schedule();
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
