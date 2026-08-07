import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./ColorSwatch.stories";

const { ProjectMark, InlineSmall } = composeStories(stories);

describe("ColorSwatch stories", () => {
  it("is decorative — aria-hidden, name lives beside it", () => {
    const { container } = render(<ProjectMark />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
  it("small variant renders for inline row use", () => {
    const { container } = render(<InlineSmall />);
    expect(container.firstChild).not.toBeNull();
  });
});
