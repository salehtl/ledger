import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
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
