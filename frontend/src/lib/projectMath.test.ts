import { describe, it, expect } from "vitest";
import { projectRemaining, projectPctUsed, isOverBudget } from "./projectMath";

describe("projectMath", () => {
  it("remaining is null when no budget", () => {
    expect(projectRemaining(null, 5000)).toBeNull();
    expect(projectRemaining(30000, 8400)).toBe(21600);
  });
  it("pct used", () => {
    expect(projectPctUsed(null, 5000)).toBeNull();
    expect(projectPctUsed(30000, 15000)).toBeCloseTo(0.5);
    expect(projectPctUsed(0, 100)).toBeNull(); // zero budget → no meaningful pct
  });
  it("over budget only when budget set and exceeded", () => {
    expect(isOverBudget(null, 999999)).toBe(false);
    expect(isOverBudget(30000, 30001)).toBe(true);
    expect(isOverBudget(30000, 30000)).toBe(false);
  });
});
