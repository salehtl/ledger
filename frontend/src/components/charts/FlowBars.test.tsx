import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FlowBars } from "./FlowBars";
import { bandCenters } from "../../lib/trendBars";
import { rgb, seedOfColor } from "../dither-kit/palette";
import type { TrendPoint } from "../../lib/insights";

// jsdom rewrites `rgba(r,g,b,1)` to `rgb(r,g,b)`, so compare the channels.
const channels = (css: string) => (css.match(/\d+/g) ?? []).slice(0, 3).join(",");
const swatch = (testId: string) => channels(screen.getByTestId(testId).style.background);

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", income: 200000, spent: 100000 },
  { period: "2026-06", label: "Jun", income: 50000, spent: 100000 },
];

describe("FlowBars", () => {
  // Touch scrubbing. Without these the browser claims a finger-drag for native
  // text selection: the labels and net figures highlight, the gesture is
  // cancelled, and the detail box never appears.
  it("claims horizontal drags for scrubbing and blocks text selection", () => {
    const { container } = render(<FlowBars points={points} />);
    const chart = container.firstElementChild as HTMLElement;
    // pan-y, not none: a vertical drag must still scroll the page. jsdom's
    // cssstyle has no touch-action property, so it never reaches the style
    // attribute and toHaveStyle can't see it — read it off the style object,
    // which does record what React assigned.
    expect(chart.style.touchAction).toBe("pan-y");
    expect(chart).toHaveStyle({ userSelect: "none" });
  });

  it("shows the detail box while scrubbing and hides it when the browser takes the gesture", async () => {
    const { container } = render(<FlowBars points={points} />);
    const surface = container.querySelector<HTMLElement>("[aria-hidden] .relative");
    if (!surface) throw new Error("chart pointer surface not found");

    fireEvent.pointerEnter(surface);
    fireEvent.pointerMove(surface, { clientX: 160 });
    expect(container.querySelector(".dither-tooltip")).toBeInTheDocument();

    // A vertical scroll makes the browser cancel the pointer stream without
    // ever firing pointerleave; without a pointercancel handler the detail box
    // stays stuck on screen while the page moves under it. It fades before
    // unmounting, so assert the fade starts, then that it leaves.
    fireEvent.pointerCancel(surface);
    expect(container.querySelector<HTMLElement>(".dither-tooltip")?.style.opacity).toBe("0");
    await waitFor(() => expect(container.querySelector(".dither-tooltip")).not.toBeInTheDocument());
  });

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

  it("paints each legend swatch in the seed its series actually paints", () => {
    // The chips were hand-picked CSS vars and drifted: "In" was --color-good
    // while the income series paints the "green" seed (--color-save), and "Out"
    // was --color-fg/40% while the spent series paints "grey" (--color-muted).
    // Both now resolve from the same palette seeds the bars use.
    render(<FlowBars points={points} />);
    expect(swatch("flow-legend-income")).toBe(channels(rgb(seedOfColor("green").fill)));
    expect(swatch("flow-legend-spent")).toBe(channels(rgb(seedOfColor("grey").fill)));
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<FlowBars points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("highlights the active month's band behind the bars", () => {
    render(<FlowBars points={points} activePeriod="2026-06" />);
    const centers = bandCenters(points.length);
    const el = screen.getByTestId("active-band-highlight");
    expect(el.style.left).toBe(`${(centers[1].center - centers[1].width / 2) * 100}%`);
    expect(el.style.width).toBe(`${centers[1].width * 100}%`);
  });

  it("renders no highlight when no month is active", () => {
    render(<FlowBars points={points} />);
    expect(screen.queryByTestId("active-band-highlight")).not.toBeInTheDocument();
  });

  it("renders no highlight for a period absent from the series", () => {
    render(<FlowBars points={points} activePeriod="2099-01" />);
    expect(screen.queryByTestId("active-band-highlight")).not.toBeInTheDocument();
  });
});
