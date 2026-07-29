import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./IconButton.stories";

const { Muted, Danger, DenseSmall } = composeStories(stories);

describe("IconButton stories", () => {
  it("carries a required accessible name", () => {
    render(<Muted />);
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });
  it("small size is the 36px dense-row exception", () => {
    render(<DenseSmall />);
    expect(screen.getByRole("button", { name: "Delete category" }).className).toContain("w-9");
  });
  it("danger tone reveals red on interaction, not at rest", () => {
    render(<Danger />);
    const btn = screen.getByRole("button", { name: "Delete rule" });
    expect(btn.className).toContain("text-muted");
    expect(btn.className).toContain("hover:text-bad");
  });
});
