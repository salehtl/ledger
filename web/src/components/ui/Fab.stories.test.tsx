import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Fab.stories";

const { Default } = composeStories(stories);

describe("Fab stories", () => {
  it("is the vermilion create plate with an accessible name", () => {
    render(<Default />);
    const btn = screen.getByRole("button", { name: "Add transaction" });
    expect(btn.className).toContain("bg-accent");
  });
});
