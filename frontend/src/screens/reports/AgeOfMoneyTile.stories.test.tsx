import "@/test/storybook";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./AgeOfMoneyTile.stories";

const { Healthy, SingleSpend, NotComputable } = composeStories(stories);

describe("AgeOfMoneyTile stories", () => {
  it("headline days, sample size, sparkline, and the one-line explainer", () => {
    const { container } = render(<Healthy />);
    expect(screen.getByText("24 days")).toBeInTheDocument();
    expect(screen.getByText(/last 10 spends/)).toBeInTheDocument();
    expect(screen.getByText(/between arriving and being spent/)).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="aom-spark"] > div')).toHaveLength(10);
  });

  it("tapping the tile drills to the sampled spends", () => {
    const onDrill = vi.fn();
    render(<Healthy onDrill={onDrill} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onDrill).toHaveBeenCalled();
  });

  it("singular copy for a single sampled spend", () => {
    render(<SingleSpend />);
    expect(screen.getByText("3 days")).toBeInTheDocument();
    expect(screen.getByText(/last 1 spend/)).toBeInTheDocument();
  });

  it("not computable: an honest dash with the expectation, not a zero", () => {
    render(<NotComputable />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText(/Not enough history yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
