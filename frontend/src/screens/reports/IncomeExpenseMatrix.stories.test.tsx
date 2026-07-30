import "@/test/storybook";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./IncomeExpenseMatrix.stories";

const { ThreeMonths, DeficitMonths, Empty } = composeStories(stories);

describe("IncomeExpenseMatrix stories", () => {
  it("scrolls inside its own two-axis container with months newest-first", () => {
    const { container } = render(<ThreeMonths />);
    expect(container.querySelector('[data-testid="matrix-scroll"]')).toHaveClass("overflow-auto", "max-h-[60vh]");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Category", "Jul ’26", "Jun ’26", "May ’26", "Avg/mo", "Total"]);
  });

  it("month headers stay sticky through vertical scroll; the corner cell through both axes", () => {
    render(<ThreeMonths />);
    const month = screen.getByRole("columnheader", { name: "Jul ’26" });
    expect(month.className).toContain("sticky");
    expect(month.className).toContain("top-0");
    const corner = screen.getByRole("columnheader", { name: "Category" });
    expect(corner.className).toContain("top-0");
    expect(corner.className).toContain("left-0");
  });

  it("income block sorts before spending, both labelled", () => {
    render(<ThreeMonths />);
    const groups = screen.getAllByText(/^(Income|Spending)$/).map((el) => el.textContent);
    expect(groups).toEqual(["Income", "Spending"]);
  });

  it("every cell drills: month cell, category row, net month", () => {
    const onDrillCell = vi.fn();
    const onDrillMonth = vi.fn();
    render(<ThreeMonths onDrillCell={onDrillCell} onDrillMonth={onDrillMonth} />);
    fireEvent.click(screen.getByRole("button", { name: "Groceries, Jul ’26: 1,743.50" }));
    expect(onDrillCell).toHaveBeenCalledWith(expect.objectContaining({ name: "Groceries" }), "2026-07");
    fireEvent.click(screen.getByRole("button", { name: "Net for Jun ’26: 15,715.00" }));
    expect(onDrillMonth).toHaveBeenCalledWith("2026-06");
  });

  it("a zero cell prints the muted dash, not 0.00", () => {
    render(<ThreeMonths />);
    const cell = screen.getByRole("button", { name: "Freelance, Jul ’26: —" });
    expect(cell.querySelector(".money-zero")).not.toBeNull();
  });

  it("negative net months print in the negative money register", () => {
    const { container } = render(<DeficitMonths />);
    expect(container.querySelectorAll("tfoot .money-neg").length).toBeGreaterThan(0);
  });

  it("empty window states fact and expectation", () => {
    render(<Empty />);
    expect(screen.getByText("Nothing to compare yet")).toBeInTheDocument();
    expect(screen.getByText(/fill this matrix in/)).toBeInTheDocument();
  });
});
