import { render, screen } from "@testing-library/react";
import { TrendBars } from "./TrendBars";
import type { TrendPoint } from "../../lib/insights";

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", spent: 5000, income: 0 },
  { period: "2026-06", label: "Jun", spent: 10000, income: 0 },
];

describe("TrendBars", () => {
  it("keeps the accessible chart role and label", () => {
    render(<TrendBars points={points} />);
    expect(screen.getByRole("img", { name: /Monthly spending trend/ })).toBeInTheDocument();
  });

  it("summarizes every month in the accessible label", () => {
    render(<TrendBars points={points} />);
    const chart = screen.getByRole("img", { name: /Monthly spending trend/ });
    expect(chart.getAttribute("aria-label")).toMatch(/May: 50\.00/);
    expect(chart.getAttribute("aria-label")).toMatch(/Jun: 100\.00/);
  });

  it("emphasizes only the active month's label", () => {
    render(<TrendBars points={points} activePeriod="2026-06" />);
    expect(screen.getByText("Jun").className).toContain("font-medium");
    expect(screen.getByText("May").className).not.toContain("font-medium");
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<TrendBars points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
