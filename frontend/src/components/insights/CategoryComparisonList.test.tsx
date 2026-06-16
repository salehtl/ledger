import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryComparisonList } from "./CategoryComparisonList";
import type { CategoryDelta } from "../../lib/insights";

type Row = CategoryDelta & { pct: number };
const rows: Row[] = [
  { category_id: 1, name: "Groceries", bucket: "need", spent: 2000, prevSpent: 1520, delta: 480, deltaPct: 0.32, isNew: false, pct: 0.21 },
  { category_id: 2, name: "Gifts", bucket: "want", spent: 300, prevSpent: 0, delta: 300, deltaPct: null, isNew: true, pct: 0.03 },
];

describe("CategoryComparisonList", () => {
  it("renders each category with its share percent and delta", () => {
    render(<CategoryComparisonList rows={rows} />);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("21%")).toBeInTheDocument();
    expect(screen.getByText("32%")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.getByText("Needs")).toBeInTheDocument();
  });
  it("shows an empty state when there are no rows", () => {
    render(<CategoryComparisonList rows={[]} />);
    expect(screen.getByText(/nothing to break down yet/i)).toBeInTheDocument();
  });
});
