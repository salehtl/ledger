import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
  it("pads its content by default", () => {
    render(<Card>content</Card>);
    expect(screen.getByText("content")).toHaveClass("p-4");
  });

  it('drops padding entirely with padding="none", for full-bleed row lists', () => {
    render(<Card padding="none">content</Card>);
    const el = screen.getByText("content");
    expect(el).not.toHaveClass("p-4");
    expect(el.className).not.toMatch(/\bp-4\b/);
  });

  it('lets padding="none" callers add their own padding utilities', () => {
    // The bug this prop exists to prevent: `className="!p-0 px-4"` sets
    // padding:0 !important, which outranks the px-4 sitting right next to it,
    // so the horizontal padding silently never applied and content rendered
    // flush against the card border.
    render(
      <Card padding="none" className="px-4">
        content
      </Card>,
    );
    const el = screen.getByText("content");
    expect(el).toHaveClass("px-4");
    expect(el.className).not.toMatch(/!p-0/);
  });

  it("still merges caller classes", () => {
    render(<Card className="mt-2">content</Card>);
    expect(screen.getByText("content")).toHaveClass("mt-2");
  });
});
