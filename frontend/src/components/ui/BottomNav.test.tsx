import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TABS } from "../../app/nav";
import { BottomNav } from "./BottomNav";

describe("BottomNav", () => {
  it("renders five tabs including Review", () => {
    render(<BottomNav active="home" reviewCount={0} onNavigate={() => {}} />);
    for (const name of [/home/i, /transactions/i, /review/i, /insights/i, /settings/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("shows the count badge on the Review tab, not Transactions", () => {
    render(<BottomNav active="home" reviewCount={3} onNavigate={() => {}} />);
    const review = screen.getByRole("button", { name: /review, 3 need review/i });
    expect(review).toHaveTextContent("3");
    const txns = screen.getByRole("button", { name: /^transactions$/i });
    expect(txns).not.toHaveTextContent("3");
  });

  it("fires onNavigate with the tab id", () => {
    const onNavigate = vi.fn();
    render(<BottomNav active="home" reviewCount={0} onNavigate={onNavigate} />);
    screen.getByRole("button", { name: /review/i }).click();
    expect(onNavigate).toHaveBeenCalledWith("review");
  });

  it("marks the active tab with a spot tick, not a filled pill", () => {
    render(<BottomNav active={TABS[0].id} reviewCount={0} onNavigate={() => {}} />);
    const active = screen.getByRole("button", { current: "page" });
    expect(active.querySelector("[data-active-tick]")).not.toBeNull();
    expect(active.innerHTML).not.toContain("bg-accent/10");
    expect(active.className).not.toContain("text-accent");
  });

  it("the review badge spends the spot ink", () => {
    render(<BottomNav active={TABS[0].id} reviewCount={3} onNavigate={() => {}} />);
    expect(screen.getByText("3").className).toContain("bg-accent");
  });
});
