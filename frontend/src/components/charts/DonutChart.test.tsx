import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DonutChart } from "./DonutChart";
import type { DonutSlice } from "../../lib/insights";

const slices: DonutSlice[] = [
  { name: "Rent", value: 3500, color: "color-mix(in srgb, var(--color-need) 100%, white)" },
  { name: "Groceries", value: 2000, color: "color-mix(in srgb, var(--color-need) 84%, white)" },
  { name: "Other", value: 500, color: "var(--color-muted)" },
];

describe("DonutChart", () => {
  it("renders a legend mapping each slice to its name and share", () => {
    render(<DonutChart slices={slices} centerLabel="Spent" centerValue={6000} />);
    expect(screen.getByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
    // shares: 3500/6000=58%, 2000/6000=33%, 500/6000=8%
    expect(screen.getByText("58%")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText("8%")).toBeInTheDocument();
  });

  it("shows 0% shares when the total is zero", () => {
    render(<DonutChart slices={[{ name: "Rent", value: 0, color: "x" }]} centerLabel="Spent" centerValue={0} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});

const slices2 = [
  { name: "Dining", value: 600, color: "#1373d9" },
  { name: "Other", value: 400, color: "var(--color-muted)" },
];

describe("DonutChart onSelect", () => {
  it("fires onSelect for a named slice but not for Other", () => {
    const onSelect = vi.fn();
    render(<DonutChart slices={slices2} centerLabel="Spent" centerValue={1000} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Dining/ }));
    expect(onSelect).toHaveBeenCalledWith("Dining");
    // "Other" is not a button
    expect(screen.queryByRole("button", { name: /Other/ })).not.toBeInTheDocument();
  });

  it("renders no buttons when onSelect is absent", () => {
    render(<DonutChart slices={slices2} centerLabel="Spent" centerValue={1000} />);
    expect(screen.queryByRole("button", { name: /Dining/ })).toBeNull();
  });
});
