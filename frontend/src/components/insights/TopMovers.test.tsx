import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopMovers } from "./TopMovers";
import type { CategoryDelta } from "../../lib/insights";

const movers: CategoryDelta[] = [
  { category_id: 1, name: "Groceries", bucket: "need", spent: 2000, prevSpent: 1520, delta: 480, deltaPct: 0.32, isNew: false },
  { category_id: 2, name: "Dining", bucket: "want", spent: 950, prevSpent: 1160, delta: -210, deltaPct: -0.18, isNew: false },
];

describe("TopMovers", () => {
  it("lists movers with names", () => {
    render(<TopMovers movers={movers} hasPrev />);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Dining")).toBeInTheDocument();
  });
  it("shows a no-prior-month message when there's no comparison baseline", () => {
    render(<TopMovers movers={[]} hasPrev={false} />);
    expect(screen.getByText(/no prior month to compare/i)).toBeInTheDocument();
  });
  it("shows a no-changes message when there's a baseline but nothing moved", () => {
    render(<TopMovers movers={[]} hasPrev />);
    expect(screen.getByText(/no notable changes/i)).toBeInTheDocument();
  });
});
