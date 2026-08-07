import "@/test/storybook";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./NetWorthChart.stories";

const { Growing, Underwater, FirstMonth } = composeStories(stories);

describe("NetWorthChart stories", () => {
  it("readout states the latest month's figure, its delta, and the split", () => {
    render(<Growing />);
    // Latest month selected by default; the readout answers "as of when?".
    expect(screen.getByText("as of Jul ’26")).toBeInTheDocument();
    expect(screen.getByText(/vs Jun ’26/)).toBeInTheDocument();
    expect(screen.getByText(/budget .* · tracking /)).toBeInTheDocument();
    // One labelled chart image; the inner svg is decoration.
    expect(screen.getByRole("img", { name: /Net worth over 12 months/ })).toBeInTheDocument();
  });

  it("axis labels mark first and last months", () => {
    render(<Growing />);
    expect(screen.getByText("Aug ’25")).toBeInTheDocument();
    // "Jul ’26" appears in the axis and the readout; at least both exist.
    expect(screen.getAllByText("Jul ’26").length).toBeGreaterThan(0);
  });

  it("the transactions row drills the selected month", () => {
    const onDrillMonth = vi.fn();
    render(<Growing onDrillMonth={onDrillMonth} />);
    fireEvent.click(screen.getByRole("button", { name: /Transactions in Jul ’26/ }));
    expect(onDrillMonth).toHaveBeenCalledWith("2026-07");
  });

  it("negative net worth prints in the negative money register", () => {
    const { container } = render(<Underwater />);
    expect(container.querySelector(".money-neg")).not.toBeNull();
  });

  it("a single point renders without a delta claim", () => {
    render(<FirstMonth />);
    expect(screen.getByText(/first month on record/)).toBeInTheDocument();
  });
});
