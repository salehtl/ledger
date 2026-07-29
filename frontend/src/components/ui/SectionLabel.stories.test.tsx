import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./SectionLabel.stories";

const { Default, AsHeading } = composeStories(stories);

describe("SectionLabel stories", () => {
  it("renders the one eyebrow style", () => {
    render(<Default />);
    expect(screen.getByText("Budget pace")).toBeInTheDocument();
  });
  it("as='h2' renders a real heading", () => {
    render(<AsHeading />);
    expect(screen.getByRole("heading", { level: 2, name: "Projects" })).toBeInTheDocument();
  });
});
