import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { BreakdownRow } from "../../lib/lens";
import { LensBreakdown } from "./LensBreakdown";

const rows: BreakdownRow[] = [
  { key: "cat:dining", name: "Dining", ditherColor: "azure", spent: 680n, share: 0.4, delta: 100n, deltaPct: 0.17, drill: { type: "category", category: "dining", name: "Dining" } },
  { key: "cat:shopping", name: "Shopping", ditherColor: "lilac", spent: 560n, share: 0.33, delta: -50n, deltaPct: -0.08, drill: { type: "category", category: "shopping", name: "Shopping" } },
];

describe("LensBreakdown", () => {
  it("renders ranked rows with their amounts and fires onDrill with the tapped row", () => {
    const onDrill = vi.fn();
    render(<LensBreakdown rows={rows} onDrill={onDrill} />);
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.getByText("6.80")).toBeInTheDocument();
    expect(screen.getByText("Shopping")).toBeInTheDocument();
    expect(screen.getByText(/tap a row to see its transactions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /see transactions for Dining/i }));
    expect(onDrill).toHaveBeenCalledWith(rows[0]);
  });

  it("prints a total past 2^53 exactly", () => {
    render(<LensBreakdown rows={[{ ...rows[0], spent: 9007199254740993n }]} onDrill={() => {}} />);
    expect(screen.getByText("90,071,992,547,409.93")).toBeInTheDocument();
  });

  it("shows an empty state when there are no rows", () => {
    render(<LensBreakdown rows={[]} onDrill={() => {}} />);
    expect(screen.getByText(/no spending this month/i)).toBeInTheDocument();
  });
});
