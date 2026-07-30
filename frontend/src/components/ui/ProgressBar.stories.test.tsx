import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./ProgressBar.stories";

const { UnderPace, OverPace, OverBudget, HeroOnAccent, NoPace } = composeStories(stories);

describe("ProgressBar stories", () => {
  it("under pace: dithered ink fill with a pace marker", () => {
    const { container } = render(<UnderPace />);
    const fill = container.querySelector("[data-state]")!;
    expect(fill.getAttribute("data-state")).toBe("under");
    expect(fill.getAttribute("data-fill")).toBe("dithered");
    expect(container.querySelector("[data-pace]")).not.toBeNull();
    expect(screen.getByRole("progressbar", { name: "Needs budget used" })).toBeInTheDocument();
  });
  it("over pace: the middle ramp stop", () => {
    const { container } = render(<OverPace />);
    const fill = container.querySelector("[data-state]") as HTMLElement;
    expect(fill.getAttribute("data-state")).toBe("over");
    expect(fill.style.background).toContain("--color-pace-over");
  });
  it("over budget: the exceeded stop, clipped to reveal the full bar", () => {
    const { container } = render(<OverBudget />);
    const fill = container.querySelector("[data-state]") as HTMLElement;
    expect(fill.getAttribute("data-state")).toBe("overbudget");
    expect(fill.style.clipPath).toBe("inset(0 0% 0 0)");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });
  it("hero onAccent over budget: state carried by texture — solid, single colour", () => {
    const { container } = render(<HeroOnAccent />);
    expect(container.querySelector("[data-fill]")!.getAttribute("data-fill")).toBe("solid");
  });
  it("no pace prop → no marker, no amber", () => {
    const { container } = render(<NoPace />);
    expect(container.querySelector("[data-pace]")).toBeNull();
    expect(container.querySelector("[data-state]")!.getAttribute("data-state")).toBe("under");
  });
});
