import "@/test/storybook";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./TrendCompare.stories";

const { TwoFullYears, PartialPriorYear, FirstYear } = composeStories(stories);

describe("TrendCompare stories", () => {
  it("summary totals the year and names the compare in words", () => {
    render(<TwoFullYears />);
    expect(screen.getByText("spent, last 12 months")).toBeInTheDocument();
    expect(screen.getByText(/vs year before/)).toBeInTheDocument();
    // Both series named in visible text — colour is never the sole carrier.
    expect(screen.getByText("this year")).toBeInTheDocument();
    expect(screen.getByText("year before")).toBeInTheDocument();
  });

  it("renders 12 drillable month rows and reports the tapped period", () => {
    const onDrillMonth = vi.fn();
    render(<TwoFullYears onDrillMonth={onDrillMonth} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: /^Jul ’26:/ }));
    expect(onDrillMonth).toHaveBeenCalledWith("2026-07");
  });

  it("a partial prior year says how many months are comparable", () => {
    render(<PartialPriorYear />);
    expect(screen.getByText(/of 12 months comparable/)).toBeInTheDocument();
    expect(screen.getAllByText("no record").length).toBeGreaterThan(0);
  });

  it("first year on record: no fake prior-year bars, no percent claim", () => {
    const { container } = render(<FirstYear />);
    expect(screen.getByText("no prior year on record")).toBeInTheDocument();
    // Every prior-year lane is empty track — no dithered muted bar drawn.
    const priorBars = container.querySelectorAll("li .dither-mask.bg-muted");
    expect(priorBars).toHaveLength(0);
  });
});
