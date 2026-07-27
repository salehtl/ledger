import { render, screen } from "@testing-library/react";
import { FlowBars } from "./FlowBars";
import { bandCenters } from "../../lib/trendBars";
import type { TrendPoint } from "../../lib/insights";

// dither-kit's canvas paints markerIndex with no DOM footprint, so the only
// way to pin the wiring (and catch a regression like the one this test was
// added for — the active-month highlight silently dropping when the bars
// moved to canvas) is to capture the prop BarChart actually receives.
type BarChartModule = typeof import("../dither-kit/bar-chart");
vi.mock("../dither-kit/bar-chart", async (importOriginal) => {
  const actual = await importOriginal<BarChartModule>();
  const MockBarChart: BarChartModule["BarChart"] = (props) => (
    <div data-testid="bar-chart-marker" data-marker-index={String(props.markerIndex ?? "null")}>
      <actual.BarChart {...props} />
    </div>
  );
  return { ...actual, BarChart: MockBarChart };
});

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", income: 200000, spent: 100000 },
  { period: "2026-06", label: "Jun", income: 50000, spent: 100000 },
];

describe("FlowBars", () => {
  it("renders a dithered bar canvas for the series", () => {
    const { container } = render(<FlowBars points={points} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
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

  it("aligns each net dot with its bar's band center", () => {
    // Regression test for the alignment bug Task 3 hit on TrendBars: a dither
    // BarChart lays bars out on d3's padded band scale, not evenly-spaced
    // centers. The net dots must sit at the same fractional centers
    // lib/trendBars.ts's bandCenters() derives from the chart's own scale,
    // or the net lane drifts off the bars it describes.
    render(<FlowBars points={points} />);
    const centers = bandCenters(points.length);
    expect(screen.getByTestId("net-dot-2026-05").style.left).toBe(`${centers[0].center * 100}%`);
    expect(screen.getByTestId("net-dot-2026-06").style.left).toBe(`${centers[1].center * 100}%`);
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<FlowBars points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("wires the active month to the bar chart's marker index", () => {
    render(<FlowBars points={points} activePeriod="2026-06" />);
    expect(screen.getByTestId("bar-chart-marker").dataset.markerIndex).toBe("1");
  });

  it("passes no marker index when no month is active", () => {
    render(<FlowBars points={points} />);
    expect(screen.getByTestId("bar-chart-marker").dataset.markerIndex).toBe("null");
  });
});
