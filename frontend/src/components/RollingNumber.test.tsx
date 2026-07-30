import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { RollingNumber } from "./RollingNumber";

function tracks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".rolling-wheel-track"));
}

function wheelTransforms(container: HTMLElement): string[] {
  return tracks(container).map((el) => el.style.transform);
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

  it("leaves the mount spin-up to the CSS transition", () => {
    const { container } = render(<RollingNumber value="93" />);
    for (const t of tracks(container)) expect(t.style.transition).toBe("");
  });

  it("snaps — never rolls — when the value is revised", () => {
    // The figures around a rolling hero (budget, remaining, projection) are
    // plain text and update in the same commit. A 650ms roll therefore leaves
    // the hero contradicting its own card, and rolls each wheel independently
    // through amounts that were never real. So a revision snaps.
    const { container, rerender } = render(<RollingNumber value="93" />);
    act(() => rerender(<RollingNumber value="41" />));
    for (const t of tracks(container)) expect(t.style.transition).toBe("none");
  });

  it("keeps snapping on every later revision", () => {
    const { container, rerender } = render(<RollingNumber value="93" />);
    act(() => rerender(<RollingNumber value="41" />));
    act(() => rerender(<RollingNumber value="77" />));
    expect(wheelTransforms(container)).toEqual(["translateY(-70%)", "translateY(-70%)"]);
    for (const t of tracks(container)) expect(t.style.transition).toBe("none");
  });

  it("renders the zero placeholder without any wheels", () => {
    const { container } = render(<RollingNumber value="—" />);
    expect(container.querySelectorAll(".rolling-wheel").length).toBe(0);
    expect(container.querySelector(".sr-only")).toHaveTextContent("—");
  });
});
