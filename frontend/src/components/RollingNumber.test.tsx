import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { RollingNumber } from "./RollingNumber";

function wheelTransforms(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".rolling-wheel-track")).map(
    (el) => el.style.transform,
  );
}

describe("RollingNumber", () => {
  it("exposes the full value to screen readers and hides the wheels", () => {
    const { container } = render(<RollingNumber value="1,234.56" />);
    expect(screen.getByText("1,234.56")).toHaveClass("sr-only");
    expect(container.querySelector(".rolling-row")).toHaveAttribute("aria-hidden");
  });

  it("renders a wheel per digit and static cells for separators", () => {
    const { container } = render(<RollingNumber value="1,234.56" />);
    expect(container.querySelectorAll(".rolling-wheel").length).toBe(6);
    expect(container.querySelectorAll(".rolling-cell:not(.rolling-wheel)").length).toBe(2);
  });

  it("rolls from zero on mount: wheels land on their digits after the live flip", () => {
    // Effects run inside render's act, so post-mount state already applies.
    const { container } = render(<RollingNumber value="93" />);
    expect(wheelTransforms(container)).toEqual(["translateY(-90%)", "translateY(-30%)"]);
  });

  it("retargets wheels when the value changes", () => {
    const { container, rerender } = render(<RollingNumber value="93" />);
    act(() => rerender(<RollingNumber value="41" />));
    expect(wheelTransforms(container)).toEqual(["translateY(-40%)", "translateY(-10%)"]);
  });

  it("renders the zero placeholder without any wheels", () => {
    const { container } = render(<RollingNumber value="—" />);
    expect(container.querySelectorAll(".rolling-wheel").length).toBe(0);
    expect(container.querySelector(".sr-only")).toHaveTextContent("—");
  });
});
