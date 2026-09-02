import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDebouncedValue } from "./useDebouncedValue";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("starts with the initial value and settles only after the delay", () => {
  const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), { initialProps: { v: "a" } });
  expect(result.current).toBe("a");
  rerender({ v: "ab" });
  expect(result.current).toBe("a");
  act(() => { vi.advanceTimersByTime(199); });
  expect(result.current).toBe("a");
  act(() => { vi.advanceTimersByTime(1); });
  expect(result.current).toBe("ab");
});

it("a change inside the window restarts it, so only the last value lands", () => {
  const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), { initialProps: { v: "" } });
  rerender({ v: "w" });
  act(() => { vi.advanceTimersByTime(150); });
  rerender({ v: "wo" });
  act(() => { vi.advanceTimersByTime(150); });
  expect(result.current).toBe("");
  act(() => { vi.advanceTimersByTime(50); });
  expect(result.current).toBe("wo");
});
