import { render, screen } from "@testing-library/react";
import { TrendBars } from "./TrendBars";
import type { TrendPoint } from "../../lib/insights";

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", spent: 5000, income: 0 },
  { period: "2026-06", label: "Jun", spent: 10000, income: 0 },
];

describe("TrendBars", () => {
  it("renders a bar per point, scaled to the tallest month", () => {
    render(<TrendBars points={points} />);
    expect(screen.getByTestId("trend-bar-2026-05").style.height).toBe("50%");
    expect(screen.getByTestId("trend-bar-2026-06").style.height).toBe("100%");
    expect(screen.getByText("May")).toBeInTheDocument();
    expect(screen.getByText("Jun")).toBeInTheDocument();
  });

  it("highlights only the active period", () => {
    render(<TrendBars points={points} activePeriod="2026-06" />);
    expect(screen.getByTestId("trend-bar-2026-06").className).toContain("--color-accent");
    expect(screen.getByTestId("trend-bar-2026-05").className).toContain("--color-surface-2");
  });

  it("renders flat (0%) bars when every month is zero", () => {
    render(
      <TrendBars points={[{ period: "2026-05", label: "May", spent: 0, income: 0 }]} />,
    );
    expect(screen.getByTestId("trend-bar-2026-05").style.height).toBe("0%");
  });

  it("keeps the accessible chart role", () => {
    render(<TrendBars points={points} />);
    expect(screen.getByRole("img", { name: "Monthly spending trend" })).toBeInTheDocument();
  });
});
