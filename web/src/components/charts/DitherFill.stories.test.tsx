import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./DitherFill.stories";

const { BucketSplit, OverBudgetSolid } = composeStories(stories);

describe("DitherFill stories", () => {
  it("renders one lane per segment", () => {
    const { container } = render(<BucketSplit />);
    expect(container.querySelectorAll(".dither-mask").length).toBe(3);
  });
  it("an over-budget segment goes solid (loses the mask)", () => {
    const { container } = render(<OverBudgetSolid />);
    expect(container.querySelectorAll(".dither-mask").length).toBe(2);
    expect(container.querySelectorAll('[data-fill="solid"]').length).toBe(1);
  });
});
