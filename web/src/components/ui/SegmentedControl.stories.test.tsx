import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./SegmentedControl.stories";

const { StatusFilter } = composeStories(stories);

describe("SegmentedControl stories", () => {
  it("marks the active segment with aria-pressed and moves it on tap", () => {
    render(<StatusFilter />);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(screen.getByRole("button", { name: /Review/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });
  it("renders the count badge", () => {
    render(<StatusFilter />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
