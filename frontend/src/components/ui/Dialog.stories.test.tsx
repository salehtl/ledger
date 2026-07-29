import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Dialog.stories";

const { Sheet, WithFooter } = composeStories(stories);

describe("Dialog stories", () => {
  it("renders an accessible sheet with its title", () => {
    render(<Sheet />);
    expect(screen.getByText("Categorize")).toBeInTheDocument();
  });
  it("footer sticks with the primary action inside", () => {
    render(<WithFooter />);
    expect(document.querySelector("[data-dialog-footer]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
