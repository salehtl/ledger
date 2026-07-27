import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PullToRefreshIndicator } from "./PullToRefreshIndicator";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";

describe("PullToRefreshIndicator", () => {
  it("shows an animating loader while refreshing", () => {
    render(<PullToRefreshIndicator pullDistance={0} refreshing={true} />);
    const status = screen.getByRole("status", { name: /refreshing/i });
    expect(status).toBeInTheDocument();
    // Every block carries the travelling-trail animation. The previous spinner
    // rotated a four-fold symmetric glyph in 90° steps, which is a no-op — it
    // animated and looked frozen — so assert the cells are actually animating
    // rather than that some class is present.
    expect(status.querySelectorAll(".pixel-spinner-cell")).toHaveLength(8);
  });

  it("staggers each block a step apart, which is what makes the trail travel", () => {
    render(<PullToRefreshIndicator pullDistance={0} refreshing={true} />);
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

  it("grows the overlay with pull distance and does not run the trail", () => {
    render(<PullToRefreshIndicator pullDistance={32} refreshing={false} />);
    const overlay = screen.getByTestId("ptr-indicator");
    expect(overlay).toHaveStyle({ height: "32px" });
    // The pull gauge is determinate — it fills, it does not spin.
    expect(overlay.querySelector(".pixel-spinner-cell")).toBeNull();
  });

  it("fills the gauge in proportion to the pull", () => {
    const { container, rerender } = render(
      <PullToRefreshIndicator pullDistance={PULL_THRESHOLD / 2} refreshing={false} />,
    );
    const litCount = () =>
      [...container.querySelectorAll<SVGRectElement>("rect")].filter(
        (r) => r.getAttribute("opacity") === "1",
      ).length;
    expect(litCount()).toBe(4); // half pulled -> half the ring

    rerender(<PullToRefreshIndicator pullDistance={PULL_THRESHOLD} refreshing={false} />);
    expect(litCount()).toBe(8); // at the threshold the ring is complete

    rerender(<PullToRefreshIndicator pullDistance={PULL_THRESHOLD * 3} refreshing={false} />);
    expect(litCount()).toBe(8); // over-pull cannot overfill it
  });

  it("uses the threshold height while refreshing", () => {
    render(<PullToRefreshIndicator pullDistance={0} refreshing={true} />);
    expect(screen.getByTestId("ptr-indicator")).toHaveStyle({ height: `${PULL_THRESHOLD}px` });
  });

  it("is hidden at rest", () => {
    render(<PullToRefreshIndicator pullDistance={0} refreshing={false} />);
    expect(screen.getByTestId("ptr-indicator")).toHaveAttribute("aria-hidden", "true");
  });

  it("animates height while collapsing at rest", () => {
    render(<PullToRefreshIndicator pullDistance={0} refreshing={false} />);
    expect(screen.getByTestId("ptr-indicator")).toHaveStyle({ transition: "height 0.2s ease-out" });
  });

  it("does not animate height during an active pull", () => {
    render(<PullToRefreshIndicator pullDistance={32} refreshing={false} />);
    expect(screen.getByTestId("ptr-indicator")).toHaveStyle({ transition: "none" });
  });
});
