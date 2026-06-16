import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "./TopBar";

describe("TopBar", () => {
  it("renders the page title", () => {
    render(<TopBar title="Transactions" scope={{ kind: "month", period: "2026-06" }} onScopeChange={() => {}} showScope />);
    expect(screen.getByRole("heading", { name: "Transactions" })).toBeInTheDocument();
  });

  it("shows the period label and steps months with the chevrons", () => {
    const onScopeChange = vi.fn();
    render(<TopBar title="Home" scope={{ kind: "month", period: "2026-06" }} onScopeChange={onScopeChange} showScope />);
    expect(screen.getByRole("button", { name: /jun 2026/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(onScopeChange).toHaveBeenCalledWith({ kind: "month", period: "2026-05" });
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(onScopeChange).toHaveBeenCalledWith({ kind: "month", period: "2026-07" });
  });

  it("hides the period control when showScope is false", () => {
    render(<TopBar title="Settings" scope={{ kind: "all" }} onScopeChange={() => {}} showScope={false} />);
    expect(screen.queryByRole("button", { name: /all time/i })).not.toBeInTheDocument();
  });

  it("opens the period sheet when the label is tapped", () => {
    render(<TopBar title="Home" scope={{ kind: "month", period: "2026-06" }} onScopeChange={() => {}} showScope />);
    fireEvent.click(screen.getByRole("button", { name: /jun 2026/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/choose period/i)).toBeInTheDocument();
  });
});
