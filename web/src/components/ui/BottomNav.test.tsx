import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { TABS } from "../../app/nav";
import { BottomNav } from "./BottomNav";

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

describe("BottomNav", () => {
  it("renders exactly the projection-backed tabs", () => {
    wrap(<BottomNav active="home" reviewCount={0} onNavigate={() => {}} />);
    for (const name of [/home/i, /transactions/i, /^insights$/i, /review/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // Settings left the bar for the TopBar gear in v3. Plan left it in v2 and
    // stayed off: no op authors a target or an envelope. Insights came back in
    // Task 4 — every figure on it is a sum over `txn_*` ops.
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^plan$/i })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(TABS.length);
  });

  it("lays out one column per tab, so trimming the nav does not strand empty cells", () => {
    const { container } = wrap(<BottomNav active="home" reviewCount={0} onNavigate={() => {}} />);
    const nav = container.querySelector("nav");
    expect(nav?.style.gridTemplateColumns).toBe(`repeat(${TABS.length}, minmax(0, 1fr))`);
  });

  it("shows the count badge on the Review tab, not Transactions", () => {
    wrap(<BottomNav active="home" reviewCount={3} onNavigate={() => {}} />);
    const review = screen.getByRole("button", { name: /review, 3 need review/i });
    expect(review).toHaveTextContent("3");
    const txns = screen.getByRole("button", { name: /^transactions$/i });
    expect(txns).not.toHaveTextContent("3");
  });

  it("fires onNavigate with the tab id", () => {
    const onNavigate = vi.fn();
    wrap(<BottomNav active="home" reviewCount={0} onNavigate={onNavigate} />);
    screen.getByRole("button", { name: /review/i }).click();
    expect(onNavigate).toHaveBeenCalledWith("review");
  });

  it("marks the active tab with a spot tick, not a filled pill", () => {
    wrap(<BottomNav active={TABS[0].id} reviewCount={0} onNavigate={() => {}} />);
    const active = screen.getByRole("button", { current: "page" });
    expect(active.querySelector("[data-active-tick]")).not.toBeNull();
    expect(active.innerHTML).not.toContain("bg-accent/10");
    expect(active.className).toContain("text-fg");
  });

  it("the review badge spends the spot ink", () => {
    wrap(<BottomNav active={TABS[0].id} reviewCount={3} onNavigate={() => {}} />);
    expect(screen.getByText("3").className).toContain("bg-accent");
  });
});
