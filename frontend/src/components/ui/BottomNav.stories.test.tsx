import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./BottomNav.stories";

const { Default, WithReviewBadge } = composeStories(stories);

describe("BottomNav stories", () => {
  it("marks the active tab with aria-current and the 2px tick", () => {
    render(<Default />);
    const active = screen.getByRole("button", { name: "Home" });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active.querySelector("[data-active-tick]")).not.toBeNull();
  });
  it("review badge announces the count", () => {
    render(<WithReviewBadge />);
    expect(screen.getByRole("button", { name: "Review, 3 need review" })).toBeInTheDocument();
  });
});
