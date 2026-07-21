import { describe, it, expect } from "vitest";
import { projectRemaining, projectPctUsed, isOverBudget, projectCoversDate, orderProjectsForReview } from "./projectMath";
import type { Project } from "../api/types";

function project(p: Partial<Project>): Project {
  return {
    id: 1, name: "Trip", budget_fils: null, color: "#8b5cf6",
    starts_on: "", ends_on: "", status: "active", count_in_monthly: true,
    completed_at: "", net_spent_fils: 0, pending_fils: 0, txn_count: 0,
    ...p,
  };
}

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

describe("projectCoversDate", () => {
  it("covers when the posted date falls inside the window", () => {
    const p = project({ starts_on: "2026-07-01", ends_on: "2026-07-20" });
    expect(projectCoversDate(p, "2026-07-03T10:00:00Z")).toBe(true);
    expect(projectCoversDate(p, "2026-07-01T00:00:00Z")).toBe(true); // inclusive start
    expect(projectCoversDate(p, "2026-07-20T23:00:00Z")).toBe(true); // inclusive end
    expect(projectCoversDate(p, "2026-06-30T23:59:00Z")).toBe(false);
    expect(projectCoversDate(p, "2026-07-21T00:00:00Z")).toBe(false);
  });

  it("treats missing bounds as open-ended", () => {
    expect(projectCoversDate(project({ starts_on: "2026-07-01", ends_on: "" }), "2027-01-01T00:00:00Z")).toBe(true);
    expect(projectCoversDate(project({ starts_on: "", ends_on: "2026-07-20" }), "2020-01-01T00:00:00Z")).toBe(true);
    expect(projectCoversDate(project({ starts_on: "", ends_on: "" }), "2026-07-03T10:00:00Z")).toBe(true);
  });
});

describe("orderProjectsForReview", () => {
  it("puts window-matching projects first, keeps others, drops completed", () => {
    const georgia = project({ id: 1, name: "Georgia trip", starts_on: "2026-07-01", ends_on: "2026-07-20" });
    const kitchen = project({ id: 2, name: "Kitchen reno", starts_on: "2026-01-01", ends_on: "2026-03-01" });
    const done = project({ id: 3, name: "Done", status: "completed", starts_on: "2026-07-01", ends_on: "2026-07-20" });
    const out = orderProjectsForReview([kitchen, georgia, done], "2026-07-03T10:00:00Z");
    expect(out.map((p) => p.id)).toEqual([1, 2]);
    expect(out[0].suggested).toBe(true);
    expect(out[1].suggested).toBe(false);
  });
});
