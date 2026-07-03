import { render, screen } from "@testing-library/react";
import { FlowBars } from "./FlowBars";
import type { TrendPoint } from "../../lib/insights";

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", income: 200000, spent: 100000 },
  { period: "2026-06", label: "Jun", income: 50000, spent: 100000 },
];

describe("FlowBars", () => {
  it("scales income and spending against one shared max", () => {
    render(<FlowBars points={points} />);
    expect(screen.getByTestId("flow-in-2026-05").style.height).toBe("100%"); // tallest overall
    expect(screen.getByTestId("flow-out-2026-05").style.height).toBe("50%");
    expect(screen.getByTestId("flow-in-2026-06").style.height).toBe("25%");
    expect(screen.getByTestId("flow-out-2026-06").style.height).toBe("50%");
  });

  it("shows a signed net figure per month", () => {
    render(<FlowBars points={points} />);
    expect(screen.getByText("+1k")).toBeInTheDocument(); // May: 200000 − 100000 = 100000 fils = 1000 AED
    expect(screen.getByText("−500")).toBeInTheDocument(); // Jun: 50000 − 100000 = −50000 fils = −500 AED
  });

  it("emphasizes only the active month's label", () => {
    render(<FlowBars points={points} activePeriod="2026-06" />);
    expect(screen.getByText("Jun").className).toContain("font-medium");
    expect(screen.getByText("May").className).not.toContain("font-medium");
  });

  it("exposes an accessible summary of every month", () => {
    render(<FlowBars points={points} />);
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toMatch(/May: in 2,000\.00, out 1,000\.00, net \+1k/);
    expect(chart.getAttribute("aria-label")).toMatch(/Jun:.*net −500/);
  });

  it("renders a net-lane dot per month", () => {
    render(<FlowBars points={points} />);
    expect(screen.getByTestId("net-dot-2026-05")).toBeInTheDocument();
    expect(screen.getByTestId("net-dot-2026-06")).toBeInTheDocument();
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<FlowBars points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
