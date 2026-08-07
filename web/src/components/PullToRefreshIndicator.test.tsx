import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MotionProvider } from "../app/MotionProvider";
import { PullToRefreshIndicator } from "./PullToRefreshIndicator";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";

// Every render goes through MotionProvider: the gauge is an m.div driven by a
// motion value, and an unwrapped m.* renders with no features loaded, so the
// translate this file is implicitly exercising would be silently inert.
const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

describe("PullToRefreshIndicator", () => {
  it("shows an animating loader while refreshing", () => {
    wrap(<PullToRefreshIndicator pullDistance={0} refreshing={true} />);
    const status = screen.getByRole("status", { name: /refreshing/i });
    expect(status).toBeInTheDocument();
    // Every block carries the travelling-trail animation. The previous spinner
    // rotated a four-fold symmetric glyph in 90° steps, which is a no-op — it
    // animated and looked frozen — so assert the cells are actually animating
    // rather than that some class is present.
    expect(status.querySelectorAll(".pixel-spinner-cell")).toHaveLength(8);
  });

  it("staggers each block a step apart, which is what makes the trail travel", () => {
    wrap(<PullToRefreshIndicator pullDistance={0} refreshing={true} />);
    const cells = [...screen.getByRole("status", { name: /refreshing/i }).querySelectorAll<SVGRectElement>(".pixel-spinner-cell")];
    // Identical delays would pulse all eight in unison instead of rotating.
    const delays = cells.map((c) => c.style.animationDelay);
    expect(new Set(delays).size).toBe(cells.length);
    // Delays run backwards round the ring so the trail travels clockwise;
    // `-i * step` ascending would spin it the wrong way.
    expect(delays[0]).toBe("-0ms");
    expect(delays[1]).toBe("-700ms");
    expect(delays[7]).toBe("-100ms");
  });

  it("does not run the trail spinner during a determinate pull", () => {
    wrap(<PullToRefreshIndicator pullDistance={32} refreshing={false} />);
    // The pull gauge is determinate — it fills, it does not spin.
    expect(screen.getByTestId("ptr-indicator").querySelector(".pixel-spinner-cell")).toBeNull();
  });

  it("keeps the container height fixed regardless of pull distance — the gauge translates inside a clipper rather than resizing it", () => {
    wrap(<PullToRefreshIndicator pullDistance={32} refreshing={false} />);
    expect(screen.getByTestId("ptr-indicator")).toHaveStyle({ height: `${PULL_THRESHOLD}px` });
  });

  it("fills the gauge in proportion to the pull", () => {
    const { container, rerender } = render(
      <MotionProvider><PullToRefreshIndicator pullDistance={PULL_THRESHOLD / 2} refreshing={false} /></MotionProvider>,
    );
    const litCount = () =>
      [...container.querySelectorAll<SVGRectElement>("rect")].filter(
        (r) => r.getAttribute("opacity") === "1",
      ).length;
    expect(litCount()).toBe(4); // half pulled -> half the ring

    rerender(<MotionProvider><PullToRefreshIndicator pullDistance={PULL_THRESHOLD} refreshing={false} /></MotionProvider>);
    expect(litCount()).toBe(8); // at the threshold the ring is complete

    rerender(<MotionProvider><PullToRefreshIndicator pullDistance={PULL_THRESHOLD * 3} refreshing={false} /></MotionProvider>);
    expect(litCount()).toBe(8); // over-pull cannot overfill it
  });

  it("uses the threshold height while refreshing", () => {
    wrap(<PullToRefreshIndicator pullDistance={0} refreshing={true} />);
    expect(screen.getByTestId("ptr-indicator")).toHaveStyle({ height: `${PULL_THRESHOLD}px` });
  });

  it("clips to a fixed height so nothing animates layout", () => {
    render(<MotionProvider><PullToRefreshIndicator pullDistance={0} refreshing={false} /></MotionProvider>);
    expect(screen.getByTestId("ptr-indicator")).toHaveStyle({ height: `${PULL_THRESHOLD}px` });
  });

  it("marks itself hidden from assistive tech when idle", () => {
    render(<MotionProvider><PullToRefreshIndicator pullDistance={0} refreshing={false} /></MotionProvider>);
    expect(screen.getByTestId("ptr-indicator")).toHaveAttribute("aria-hidden", "true");
  });
});
