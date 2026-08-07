import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopMovers } from "./TopMovers";
import type { CategoryDelta } from "../../v2/sources/insights";

const movers: CategoryDelta[] = [
  { key: "cat:groceries", name: "Groceries", category: "groceries", bucket: "need", spent: 2000n, prevSpent: 1520n, delta: 480n, deltaPct: 0.32, isNew: false, isGone: false },
  { key: "cat:dining", name: "Dining", category: "dining", bucket: "want", spent: 950n, prevSpent: 1160n, delta: -210n, deltaPct: -0.18, isNew: false, isGone: false },
];

describe("TopMovers", () => {
  it("lists movers with names and the magnitude of the change", () => {
    render(<TopMovers movers={movers} hasPrev />);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.getByText("4.80")).toBeInTheDocument();
    expect(screen.getByText("2.10")).toBeInTheDocument();
  });
  it("shows a no-prior-month message when there's no comparison baseline", () => {
    render(<TopMovers movers={[]} hasPrev={false} />);
    expect(screen.getByText(/no prior month to compare/i)).toBeInTheDocument();
  });
  it("shows a no-changes message when there's a baseline but nothing moved", () => {
    render(<TopMovers movers={[]} hasPrev />);
    expect(screen.getByText(/no notable changes/i)).toBeInTheDocument();
  });
  it("keeps a change past 2^53 exact", () => {
    render(
      <TopMovers
        movers={[{ ...movers[0], delta: -9007199254740993n, deltaPct: null }]}
        hasPrev
      />,
    );
    expect(screen.getAllByText("90,071,992,547,409.93").length).toBeGreaterThan(0);
  });
});
