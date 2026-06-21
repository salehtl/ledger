import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

const rows2 = [
  { category_id: 10, name: "Dining", bucket: "want", spent: 600, prevSpent: 400, delta: 200, deltaPct: 0.5, isNew: false, pct: 0.6 },
] as any;

describe("CategoryComparisonList onSelectCategory", () => {
  it("fires onSelectCategory when a category row is tapped", () => {
    const onSelectCategory = vi.fn();
    render(<CategoryComparisonList rows={rows2} onSelectCategory={onSelectCategory} />);
    fireEvent.click(screen.getByRole("button", { name: /Dining/ }));
    expect(onSelectCategory).toHaveBeenCalledWith(10, "Dining");
  });

  it("renders no buttons when onSelectCategory is absent", () => {
    render(<CategoryComparisonList rows={rows2} />);
    expect(screen.queryByRole("button", { name: /Dining/ })).toBeNull();
  });
});
