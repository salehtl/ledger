import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Money.stories";

const { Positive, Negative, Zero } = composeStories(stories);

describe("Money stories", () => {
  it("formats fils and never shows a float artifact", () => {
    const { container } = render(<Positive />);
    expect(container.textContent).toContain("18,500.00");
  });
  it("negative money prints in the spot ink's text register", () => {
    const { container } = render(<Negative />);
    expect(container.textContent).toContain("142.75");
    expect(container.querySelector(".money-neg")).not.toBeNull();
  });
  it("zero renders as an em dash, without the negative register", () => {
    const { container } = render(<Zero />);
    expect(container.textContent).toContain("—");
    expect(container.querySelector(".money-neg")).toBeNull();
  });
});
