import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Taskbar } from "./Taskbar";

describe("Taskbar", () => {
  it("shows a review badge when count > 0 and fires onMenu", () => {
    const onMenu = vi.fn();
    render(<Taskbar active="dashboard" reviewCount={3} onMenu={onMenu} onNavigate={() => {}} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    screen.getByRole("button", { name: /menu/i }).click();
    expect(onMenu).toHaveBeenCalled();
  });

  it("hides the badge when count is 0", () => {
    render(<Taskbar active="review" reviewCount={0} onMenu={() => {}} onNavigate={() => {}} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders an icon and label for each tab", () => {
    render(<Taskbar active="dashboard" reviewCount={0} onMenu={() => {}} onNavigate={() => {}} />);
    expect(screen.getByRole("button", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /history/i })).toBeInTheDocument();
    // four nav buttons total: settings + 3 tabs
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });
});
