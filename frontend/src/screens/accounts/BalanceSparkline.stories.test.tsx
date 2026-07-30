import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./BalanceSparkline.stories";

const { Rising, Flat, SinglePoint } = composeStories(stories);

function barHeights(container: HTMLElement): number[] {
  return [...container.querySelectorAll("[data-spark] > div")].map((el) =>
    parseInt((el as HTMLElement).style.height, 10),
  );
}

describe("BalanceSparkline stories", () => {
  it("rising: one bar per point, newest (rightmost) is the tallest", () => {
    const { container } = render(<Rising />);
    const spark = container.querySelector("[data-spark]")!;
    expect(spark.getAttribute("data-spark")).toBe("6");
    expect(spark.getAttribute("aria-hidden")).toBe("true");
    const heights = barHeights(container);
    expect(heights.length).toBe(6);
    expect(heights[heights.length - 1]).toBe(Math.max(...heights));
    expect(heights[0]).toBe(Math.min(...heights));
  });

  it("flat: every bar sits mid-height, none vanish", () => {
    const { container } = render(<Flat />);
    const heights = barHeights(container);
    expect(heights.length).toBe(4);
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBeGreaterThan(0);
  });

  it("single point: one mid-height bar, same treatment as flat", () => {
    const { container } = render(<SinglePoint />);
    const heights = barHeights(container);
    expect(heights.length).toBe(1);
    expect(heights[0]).toBe(54); // 8 + round(0.5 * 92)
  });

  it("bars are the app's one dither texture in ink, sharp radius", () => {
    const { container } = render(<Rising />);
    const bar = container.querySelector("[data-spark] > div")!;
    expect(bar.className).toContain("dither-mask");
    expect(bar.className).toContain("bg-fg");
    expect(bar.className).toContain("rounded-[var(--radius)]");
  });
});
