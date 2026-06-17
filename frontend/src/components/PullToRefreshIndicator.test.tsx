import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PullToRefreshIndicator } from "./PullToRefreshIndicator";
import { PULL_THRESHOLD } from "../lib/pullToRefresh";

describe("PullToRefreshIndicator", () => {
  it("shows a spinning loader while refreshing", () => {
    render(<PullToRefreshIndicator pullDistance={0} refreshing={true} />);
    const status = screen.getByRole("status", { name: /refreshing/i });
    expect(status).toBeInTheDocument();
    expect(status.classList.contains("animate-spin")).toBe(true);
  });

  it("grows the overlay with pull distance and does not spin", () => {
    render(<PullToRefreshIndicator pullDistance={32} refreshing={false} />);
    const overlay = screen.getByTestId("ptr-indicator");
    expect(overlay).toHaveStyle({ height: "32px" });
    expect(overlay.querySelector(".animate-spin")).toBeNull();
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
