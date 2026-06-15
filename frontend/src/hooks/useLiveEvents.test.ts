import { describe, it, expect } from "vitest";
import { LIVE_INVALIDATE_KEYS } from "./useLiveEvents";

describe("useLiveEvents", () => {
  it("invalidates the live-data query keys", () => {
    expect(LIVE_INVALIDATE_KEYS).toEqual([["summary"], ["transactions"], ["review"], ["insights-categories"], ["insights-trend"]]);
  });
});
