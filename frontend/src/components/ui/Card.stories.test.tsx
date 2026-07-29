import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Card.stories";

const { Default, ListCard } = composeStories(stories);

describe("Card stories", () => {
  it("is bounded by a hairline, never a shadow", () => {
    const { container } = render(<Default />);
    const card = container.querySelector(".border-border");
    expect(card).not.toBeNull();
    expect(card!.className).not.toContain("shadow");
  });
  it("list-card idiom: !p-0 with an inner divided list", () => {
    render(<ListCard />);
    expect(screen.getByText("CARREFOUR")).toBeInTheDocument();
    expect(screen.getByText("CAREEM")).toBeInTheDocument();
  });
});
