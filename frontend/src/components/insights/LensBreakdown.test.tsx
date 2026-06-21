import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { BreakdownRow } from "../../lib/lens";
import { LensBreakdown } from "./LensBreakdown";

const rows: BreakdownRow[] = [
  { key: "cat:10", name: "Dining", color: "#1373d9", spent: 680, share: 0.4, delta: 100, deltaPct: 0.17, categoryId: 10 },
  { key: "cat:11", name: "Shopping", color: "#7b35b8", spent: 560, share: 0.33, delta: -50, deltaPct: -0.08, categoryId: 11 },
];

describe("LensBreakdown", () => {
  it("renders ranked rows and fires onDrill with the tapped row", () => {
    const onDrill = vi.fn();
    render(<LensBreakdown rows={rows} onDrill={onDrill} />);
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.getByText("Shopping")).toBeInTheDocument();
    expect(screen.getByText(/tap a row to see its transactions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /see transactions for Dining/i }));
    expect(onDrill).toHaveBeenCalledWith(rows[0]);
  });

  it("shows an empty state when there are no rows", () => {
    render(<LensBreakdown rows={[]} onDrill={() => {}} />);
    expect(screen.getByText(/no spending this month/i)).toBeInTheDocument();
  });
});
