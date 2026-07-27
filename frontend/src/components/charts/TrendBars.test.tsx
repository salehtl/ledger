import { render, screen } from "@testing-library/react";
import { TrendBars } from "./TrendBars";
import { bandCenters } from "../../lib/trendBars";
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

  it("exposes exactly one accessible chart role", () => {
    // dither-kit hardcodes role="img" on its own inner SVG; the BarChart
    // wrapper must be aria-hidden or this resolves to two elements instead
    // of the one labelled role="img" the component intends. getByRole
    // throws on more than one match, so this fails loudly if the wrapper
    // ever loses its aria-hidden treatment.
    render(<TrendBars points={points} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
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

  it("aligns each label with its bar's band center", () => {
    // Regression test for a bug where the label row's flex layout drifted
    // from the bars' d3 band-scale centers, worst at the first/last month.
    // Pins the component's wiring to lib/trendBars.ts's bandCenters — the
    // single source of truth the chart's own bars are laid out from.
    render(<TrendBars points={points} />);
    const centers = bandCenters(points.length);
    expect(screen.getByTestId("trend-label-2026-05").style.left).toBe(`${centers[0].center * 100}%`);
    expect(screen.getByTestId("trend-label-2026-06").style.left).toBe(`${centers[1].center * 100}%`);
  });

  it("highlights the active month's band behind the bars", () => {
    render(<TrendBars points={points} activePeriod="2026-06" />);
    const centers = bandCenters(points.length);
    const el = screen.getByTestId("active-band-highlight");
    expect(el.style.left).toBe(`${(centers[1].center - centers[1].width / 2) * 100}%`);
    expect(el.style.width).toBe(`${centers[1].width * 100}%`);
  });

  it("renders no highlight when no month is active", () => {
    render(<TrendBars points={points} />);
    expect(screen.queryByTestId("active-band-highlight")).not.toBeInTheDocument();
  });

  it("renders no highlight for a period absent from the series", () => {
    render(<TrendBars points={points} activePeriod="2099-01" />);
    expect(screen.queryByTestId("active-band-highlight")).not.toBeInTheDocument();
  });
});
