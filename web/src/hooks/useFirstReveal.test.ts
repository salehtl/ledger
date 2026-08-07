import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFirstReveal } from "./useFirstReveal";

describe("useFirstReveal", () => {
  it("stays false while not ready, true on the first ready render, false after", () => {
    const { result, rerender } = renderHook(({ r }) => useFirstReveal(r), { initialProps: { r: false } });
    expect(result.current).toBe(false);   // loading skeleton, list absent
    rerender({ r: true });
    expect(result.current).toBe(true);    // first populated paint → stagger
    rerender({ r: true });
    expect(result.current).toBe(false);   // no replay on later renders
  });
});
