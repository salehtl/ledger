import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { TopBar } from "./TopBar";

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

describe("TopBar", () => {
  it("renders the page title", () => {
    wrap(<TopBar title="Transactions" scope={{ kind: "month", period: "2026-06" }} onScopeChange={() => {}} showScope />);
    expect(screen.getByRole("heading", { name: "Transactions" })).toBeInTheDocument();
  });

  it("shows the period label and steps months with the chevrons", () => {
    const onScopeChange = vi.fn();
    wrap(<TopBar title="Home" scope={{ kind: "month", period: "2026-06" }} onScopeChange={onScopeChange} showScope />);
    expect(screen.getByRole("button", { name: /jun 2026/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(onScopeChange).toHaveBeenCalledWith({ kind: "month", period: "2026-05" });
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(onScopeChange).toHaveBeenCalledWith({ kind: "month", period: "2026-07" });
  });

  it("hides the period control when showScope is false", () => {
    wrap(<TopBar title="Settings" scope={{ kind: "all" }} onScopeChange={() => {}} showScope={false} />);
    expect(screen.queryByRole("button", { name: /all time/i })).not.toBeInTheDocument();
  });

  it("opens the period sheet when the label is tapped", () => {
    wrap(<TopBar title="Home" scope={{ kind: "month", period: "2026-06" }} onScopeChange={() => {}} showScope />);
    fireEvent.click(screen.getByRole("button", { name: /jun 2026/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/choose period/i)).toBeInTheDocument();
  });
});
