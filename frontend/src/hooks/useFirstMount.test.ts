import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFirstMount } from "./useFirstMount";

describe("useFirstMount", () => {
  it("is true on first render and false after a re-render", () => {
    const { result, rerender } = renderHook(() => useFirstMount());
    expect(result.current).toBe(true);
    rerender();
    expect(result.current).toBe(false);
  });
});
