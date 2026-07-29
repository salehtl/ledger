import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Button.stories";

const { Primary, Secondary, Ghost, Danger, Disabled } = composeStories(stories);

describe("Button stories", () => {
  it("primary spends the spot ink as a fill", () => {
    render(<Primary />);
    const btn = screen.getByRole("button", { name: "Add transaction" });
    expect(btn.className).toContain("bg-accent");
    expect(btn.className).toContain("text-accent-fg");
  });

  it("secondary is the tonal default", () => {
    render(<Secondary />);
    expect(screen.getByRole("button", { name: "Secondary" }).className).toContain("bg-surface-2");
  });

  it("ghost stays transparent", () => {
    render(<Ghost />);
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("bg-transparent");
  });

  it("danger shares the vermilion plate — the label differentiates", () => {
    render(<Danger />);
    expect(screen.getByRole("button", { name: "Delete rule" }).className).toContain("bg-accent");
  });

  it("disabled renders a real disabled attribute", () => {
    render(<Disabled />);
    expect(screen.getByRole("button", { name: "Add transaction" })).toBeDisabled();
  });
});
