import { describe, it, expect } from "vitest";
import { usagePathLabel } from "./aiUsageLabel";

describe("usagePathLabel", () => {
  it("names the AI check in plain words", () => {
    expect(usagePathLabel("txn_check")).toBe("email check");
  });

  it("returns every other path unchanged", () => {
    expect(usagePathLabel("categorize")).toBe("categorize");
    expect(usagePathLabel("extract")).toBe("extract");
    expect(usagePathLabel("")).toBe("");
  });
});
