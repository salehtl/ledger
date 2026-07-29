import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./EmptyState.stories";

const { NoData, QueryError } = composeStories(stories);

describe("EmptyState stories", () => {
  it("renders title and hint", () => {
    render(<NoData />);
    expect(screen.getByText("No recent activity")).toBeInTheDocument();
    expect(screen.getByText("New transactions will appear here.")).toBeInTheDocument();
  });
  it("error state carries an icon chip", () => {
    const { container } = render(<QueryError />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
