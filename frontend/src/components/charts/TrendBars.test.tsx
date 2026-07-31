import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TrendBars } from "./TrendBars";
import { bandCenters } from "../../lib/trendBars";
import type { TrendPoint } from "../../lib/insights";
import { MotionProvider } from "../../app/MotionProvider";

// Every render in this file must go through MotionProvider: the chart's
// Tooltip mounts an m.div (AnimatePresence) once hovered, and an unwrapped
// m.* silently renders with no features loaded — the exit fade this file
// exercises would pass without the animation ever actually running.
const renderTrend = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

/**
 * Resolve once LazyMotion's feature bundle is actually live: the tooltip has
 * moved off its seeded `opacity: 0` entrance start. Gating on this is what
 * stops the exit-fade assertion below from being vacuous — with no features
 * loaded the card still mounts and unmounts, but `animate`/`exit` never run
 * and it would just snap, same as the bug this replaced.
 */
async function motionReady(container: HTMLElement) {
  await waitFor(() => {
    expect(container.querySelector<HTMLElement>(".dither-tooltip")?.style.opacity).not.toBe("0");
  });
}

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", spent: 5000, income: 0 },
  { period: "2026-06", label: "Jun", spent: 10000, income: 0 },
];

describe("TrendBars", () => {
  it("keeps the accessible chart role and label", () => {
    renderTrend(<TrendBars points={points} />);
    expect(screen.getByRole("img", { name: /Monthly spending trend/ })).toBeInTheDocument();
  });

  it("exposes exactly one accessible chart role", () => {
    // dither-kit hardcodes role="img" on its own inner SVG; the BarChart
    // wrapper must be aria-hidden or this resolves to two elements instead
    // of the one labelled role="img" the component intends. getByRole
    // throws on more than one match, so this fails loudly if the wrapper
    // ever loses its aria-hidden treatment.
    renderTrend(<TrendBars points={points} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  // Touch scrubbing. Without this the browser claims a finger-drag for native
  // text selection: the labels highlight, the gesture is cancelled, and the
  // detail box never appears.
  it("blocks text selection so a finger-drag scrubs instead of highlighting", () => {
    renderTrend(<TrendBars points={points} />);
    expect(screen.getByRole("img", { name: /Monthly spending trend/ })).toHaveStyle({
      userSelect: "none",
    });
  });

  it("declares no touch-action, or pull-to-refresh dies on this screen", () => {
    // usePullToRefresh owns its gesture by calling preventDefault() on a
    // non-passive touchmove. Declaring a touch-action that permits the pan
    // hands that axis to the compositor, which dispatches touchmove as
    // non-cancelable — preventDefault then silently no-ops and, because <main>
    // is overscroll-contain, a downward drag at the top of the page does
    // nothing at all. This shipped once as `pan-y`; it must not come back.
    renderTrend(<TrendBars points={points} />);
    const chart = screen.getByRole("img", { name: /Monthly spending trend/ });
    // jsdom has no touch-action in cssstyle, so an unset property reads as
    // undefined rather than ""; normalise so this passes either way and still
    // fails loudly if a value is ever assigned.
    expect(chart.style.touchAction ?? "").toBe("");
  });

  it("shows the detail box while scrubbing and hides it when the browser takes the gesture", async () => {
    const { container } = renderTrend(<TrendBars points={points} />);
    const surface = container.querySelector<HTMLElement>("[aria-hidden] .relative");
    if (!surface) throw new Error("chart pointer surface not found");

    fireEvent.pointerEnter(surface);
    fireEvent.pointerMove(surface, { clientX: 160 });
    expect(container.querySelector(".dither-tooltip")).toBeInTheDocument();
    await motionReady(container);

    // A vertical scroll makes the browser cancel the pointer stream without
    // ever firing pointerleave; without a pointercancel handler the detail box
    // stays stuck on screen while the page moves under it. It fades before
    // unmounting, so assert the fade starts, then that it leaves.
    fireEvent.pointerCancel(surface);
    await waitFor(() => {
      const opacity = container.querySelector<HTMLElement>(".dither-tooltip")?.style.opacity;
      expect(opacity !== undefined && Number(opacity) < 1).toBe(true);
    });
    await waitFor(() => expect(container.querySelector(".dither-tooltip")).not.toBeInTheDocument());
  });

  // The scroll-vs-scrub conflict. A chart sits inside a vertically scrolling
  // page, so a finger on it is ambiguous until it moves. Scrubbing on the first
  // touchmove steals the page's scroll; refusing to scrub makes the chart
  // unreadable on touch. The axis lock decides once, past a slop zone.
  const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

  it("scrubs a horizontal finger-drag", () => {
    const { container } = renderTrend(<TrendBars points={points} />);
    const surface = container.querySelector<HTMLElement>("[aria-hidden] .relative")!;

    fireEvent.touchStart(surface, touch(100, 400));
    fireEvent.touchMove(surface, touch(140, 404)); // clearly across
    expect(container.querySelector(".dither-tooltip")).toBeInTheDocument();
  });

  it("leaves a vertical finger-drag to the page, so scrolling and pull-to-refresh still work", () => {
    const { container } = renderTrend(<TrendBars points={points} />);
    const surface = container.querySelector<HTMLElement>("[aria-hidden] .relative")!;

    fireEvent.touchStart(surface, touch(100, 400));
    fireEvent.touchMove(surface, touch(104, 440)); // clearly down
    expect(container.querySelector(".dither-tooltip")).not.toBeInTheDocument();
  });

  it("commits to scrolling for the rest of the touch, even if the finger turns sideways", () => {
    // Without the commit, a drag that starts vertical and drifts across would
    // hand the gesture back mid-scroll and pop the detail box open.
    const { container } = renderTrend(<TrendBars points={points} />);
    const surface = container.querySelector<HTMLElement>("[aria-hidden] .relative")!;

    fireEvent.touchStart(surface, touch(100, 400));
    fireEvent.touchMove(surface, touch(104, 440)); // rejected
    fireEvent.touchMove(surface, touch(200, 445)); // now horizontal — too late
    expect(container.querySelector(".dither-tooltip")).not.toBeInTheDocument();
  });

  it("does nothing inside the slop zone, so a tap never flickers the detail box", () => {
    const { container } = renderTrend(<TrendBars points={points} />);
    const surface = container.querySelector<HTMLElement>("[aria-hidden] .relative")!;

    fireEvent.touchStart(surface, touch(100, 400));
    fireEvent.touchMove(surface, touch(103, 402)); // within slop
    expect(container.querySelector(".dither-tooltip")).not.toBeInTheDocument();
  });

  it("summarizes every month in the accessible label", () => {
    renderTrend(<TrendBars points={points} />);
    const chart = screen.getByRole("img", { name: /Monthly spending trend/ });
    expect(chart.getAttribute("aria-label")).toMatch(/May: 50\.00/);
    expect(chart.getAttribute("aria-label")).toMatch(/Jun: 100\.00/);
  });

  it("emphasizes only the active month's label", () => {
    renderTrend(<TrendBars points={points} activePeriod="2026-06" />);
    expect(screen.getByText("Jun").className).toContain("font-medium");
    expect(screen.getByText("May").className).not.toContain("font-medium");
  });

  it("renders nothing for an empty series", () => {
    const { container } = renderTrend(<TrendBars points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("aligns each label with its bar's band center", () => {
    // Regression test for a bug where the label row's flex layout drifted
    // from the bars' d3 band-scale centers, worst at the first/last month.
    // Pins the component's wiring to lib/trendBars.ts's bandCenters — the
    // single source of truth the chart's own bars are laid out from.
    renderTrend(<TrendBars points={points} />);
    const centers = bandCenters(points.length);
    expect(screen.getByTestId("trend-label-2026-05").style.left).toBe(`${centers[0].center * 100}%`);
    expect(screen.getByTestId("trend-label-2026-06").style.left).toBe(`${centers[1].center * 100}%`);
  });

  it("highlights the active month's band behind the bars", () => {
    renderTrend(<TrendBars points={points} activePeriod="2026-06" />);
    const centers = bandCenters(points.length);
    const el = screen.getByTestId("active-band-highlight");
    expect(el.style.left).toBe(`${(centers[1].center - centers[1].width / 2) * 100}%`);
    expect(el.style.width).toBe(`${centers[1].width * 100}%`);
  });

  it("renders no highlight when no month is active", () => {
    renderTrend(<TrendBars points={points} />);
    expect(screen.queryByTestId("active-band-highlight")).not.toBeInTheDocument();
  });

  it("renders no highlight for a period absent from the series", () => {
    renderTrend(<TrendBars points={points} activePeriod="2099-01" />);
    expect(screen.queryByTestId("active-band-highlight")).not.toBeInTheDocument();
  });
});
