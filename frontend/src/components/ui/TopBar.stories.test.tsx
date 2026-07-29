import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./TopBar.stories";

const { WithScope, TitleOnly } = composeStories(stories);

describe("TopBar stories", () => {
  it("renders the sans screen title", () => {
    render(<WithScope />);
    expect(screen.getByRole("heading", { name: "Insights" })).toBeInTheDocument();
  });
  it("showScope=false hides the period stepper", () => {
    render(<TitleOnly />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});
