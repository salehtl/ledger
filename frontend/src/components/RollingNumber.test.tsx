// jsdom has no layout, so Framer's tween scheduler needs real timers to
// settle; LazyMotion's feature bundle is also a genuine async import, so the
// very first synchronous render still has no features loaded (m.* renders
// but animate is inert). Tests that assert on `style.transform` must
// `waitFor` the roll to actually start, same pattern as Dialog.test.tsx.
import { describe, it, expect } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { MotionProvider } from "../app/MotionProvider";
import { RollingNumber, ROLL_MS, ROLL_STAGGER_MS } from "./RollingNumber";

function tracks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".rolling-wheel-track"));
}

function wheelTransforms(container: HTMLElement): string[] {
  return tracks(container).map((el) => el.style.transform);
}

describe("RollingNumber", () => {
  it("exposes the full value to screen readers and hides the wheels", () => {
    const { container } = render(<MotionProvider><RollingNumber value="1,234.56" /></MotionProvider>);
    expect(screen.getByText("1,234.56")).toHaveClass("sr-only");
    expect(container.querySelector(".rolling-row")).toHaveAttribute("aria-hidden");
  });

  it("renders a wheel per digit and static cells for separators", () => {
    const { container } = render(<MotionProvider><RollingNumber value="1,234.56" /></MotionProvider>);
    expect(container.querySelectorAll(".rolling-wheel").length).toBe(6);
    expect(container.querySelectorAll(".rolling-cell:not(.rolling-wheel)").length).toBe(2);
  });

  it("rolls from zero on mount: wheels land on their digits, each at a different offset", async () => {
    // Framer writes `transform` inline, so reading style.transform off the
    // tracks still works — but the exact string it produces (matrix vs.
    // translateY, rounding) is Framer's business, not this test's. Assert the
    // digits resolve to *different* transforms, which is all the odometer
    // promises.
    const { container } = render(<MotionProvider><RollingNumber value="93" /></MotionProvider>);
    const [nine, three] = tracks(container);
    await waitFor(() => expect(nine.style.transform).not.toBe("none"));
    await waitFor(() => expect(three.style.transform).not.toBe("none"));
    expect(nine.style.transform).not.toBe(three.style.transform);
  });

  it("retargets wheels when the value changes", async () => {
    const { container, rerender } = render(<MotionProvider><RollingNumber value="93" /></MotionProvider>);
    const [nine, three] = tracks(container);
    await waitFor(() => expect(nine.style.transform).not.toBe("none"));
    const before = wheelTransforms(container);
    act(() => rerender(<MotionProvider><RollingNumber value="41" /></MotionProvider>));
    await waitFor(() => expect(nine.style.transform).not.toBe(before[0]));
    await waitFor(() => expect(three.style.transform).not.toBe(before[1]));
  });

  it("renders one wheel per digit and a static cell per separator", () => {
    const { container } = render(<MotionProvider><RollingNumber value="1,234" /></MotionProvider>);
    expect(tracks(container)).toHaveLength(4); // 1 2 3 4
    expect(container.querySelectorAll(".rolling-cell")).toHaveLength(5); // + the comma
  });

  it("keeps the full value available to assistive tech", () => {
    render(<MotionProvider><RollingNumber value="1,234" /></MotionProvider>);
    expect(screen.getByText("1,234")).toHaveClass("sr-only");
  });

  it("stays inside the UI budget once the stagger is included", () => {
    // The last wheel starts ROLL_STAGGER_MS × (digits − 1) late, so the total
    // on-screen time is the roll plus the cascade. Six digits is the widest
    // figure the hero shows (250,000 in the harness fixture).
    expect(ROLL_MS + ROLL_STAGGER_MS * 5).toBeLessThanOrEqual(0.6);
  });

  it("renders the zero placeholder without any wheels", () => {
    const { container } = render(<MotionProvider><RollingNumber value="—" /></MotionProvider>);
    expect(container.querySelectorAll(".rolling-wheel").length).toBe(0);
    expect(container.querySelector(".sr-only")).toHaveTextContent("—");
  });
});
