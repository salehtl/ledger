import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Switch.stories";

const { Off, On } = composeStories(stories);

describe("Switch stories", () => {
  it("is a real checkbox underneath", () => {
    render(<Off />);
    const box = screen.getByRole("checkbox");
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(box).toBeChecked();
  });
  it("defaultChecked renders on", () => {
    render(<On />);
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});
