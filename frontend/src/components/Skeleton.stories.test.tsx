import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Skeleton.stories";

const { ListLoad } = composeStories(stories);

describe("Skeleton stories", () => {
  it("announces busy and renders the requested rows", () => {
    const { container } = render(<ListLoad />);
    expect(screen.getByLabelText("Loading")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll(".animate-pulse").length).toBe(5);
  });
});
