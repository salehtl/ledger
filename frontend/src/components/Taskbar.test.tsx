import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Taskbar } from "./Taskbar";

describe("Taskbar", () => {
  it("shows a review badge when count > 0 and fires onMenu", () => {
    const onMenu = vi.fn();
    render(<Taskbar active="dashboard" reviewCount={3} onMenu={onMenu} onNavigate={() => {}} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /menu/i }));
    expect(onMenu).toHaveBeenCalled();
  });

  it("hides the badge when count is 0", () => {
    render(<Taskbar active="review" reviewCount={0} onMenu={() => {}} onNavigate={() => {}} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
