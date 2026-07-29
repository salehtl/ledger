import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Pill.stories";

const { Default, Muted, Attention } = composeStories(stories);

describe("Pill stories", () => {
  it("default and muted are hairline-bordered, label-carried states", () => {
    render(<Default />);
    expect(screen.getByText("Archived").className).toContain("border-border");
    render(<Muted />);
    expect(screen.getByText("no AED rate").className).toContain("text-muted");
  });
  it("attention is the only tone that spends the spot ink", () => {
    render(<Attention />);
    expect(screen.getByText("Needs review").className).toContain("bg-accent");
  });
});
