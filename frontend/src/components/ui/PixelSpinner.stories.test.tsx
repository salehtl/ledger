import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./PixelSpinner.stories";

const { Indeterminate, DeterminateGauge } = composeStories(stories);

describe("PixelSpinner stories", () => {
  it("renders the eight-block ring", () => {
    const { container } = render(<Indeterminate />);
    expect(container.querySelectorAll("svg rect").length).toBeGreaterThanOrEqual(8);
  });
  it("determinate mode renders with a progress value", () => {
    const { container } = render(<DeterminateGauge />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
