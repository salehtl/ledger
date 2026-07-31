// jsdom has no layout, so Framer's tween scheduler needs real timers to
// settle; LazyMotion's feature bundle is also a genuine async import, so the
// very first synchronous render still has no features loaded (m.* renders
// but animate is inert). Tests that assert on `style.transform` must
// `waitFor` the roll to actually start, same pattern as Dialog.test.tsx.
import { describe, it, expect } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { MotionProvider } from "../app/MotionProvider";
import { numberCells } from "../lib/rollingNumber";
import { formatFils } from "../lib/money";
import { RollingNumber, ROLL_MS, ROLL_STAGGER_MS, ROLL_STAGGER_MAX } from "./RollingNumber";

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

  it("snaps a revision to its target near-instantly, rather than tweening through it", async () => {
    // "Retargets" above only proves the final transform differs from before —
    // a full ROLL_MS+stagger re-roll to the same endpoint would satisfy that
    // too. This test distinguishes a snap (transition: { duration: 0 }) from
    // a roll (transition: { duration: ROLL_MS, ... }) structurally: a snap
    // reaches its target within a couple of frames, a roll cannot possibly
    // be there yet at that point — it's still 400+ms from done.
    const { container, rerender } = render(<MotionProvider><RollingNumber value="93" /></MotionProvider>);
    const [nine] = tracks(container);
    // Let the mount roll settle first, so "did it snap" isn't conflated with
    // "did the mount roll finish yet".
    await waitFor(() => expect(nine.style.transform).toContain("-90"), { timeout: 2000 });

    act(() => rerender(<MotionProvider><RollingNumber value="41" /></MotionProvider>));
    // Poll well under ROLL_MS (450ms): a snap lands almost immediately, a
    // reintroduced roll would still be mid-tween (and, per EASE_OUT's
    // interpolation, not sitting on the exact target percentage) at 150ms.
    await waitFor(() => expect(nine.style.transform).toContain("-40%"), { timeout: 150 });

    // Coverage note: this asserts the snap half. It does not separately
    // assert "the mount roll is NOT at its endpoint on the first frame" —
    // LazyMotion's feature bundle is a genuine async import, so the very
    // first synchronous sample after mount reads "none" regardless of
    // duration, which would pass trivially and prove nothing about
    // tween-vs-snap timing. The mount roll's shape (a real multi-frame
    // tween, not an instant jump) is covered by the settle-time
    // measurement recorded in the task report.
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

  it("stays inside the UI budget once the stagger is included, for the widest figure the app actually renders", () => {
    // Derived from real output, not hardcoded constants — a test that only
    // sums ROLL_MS/ROLL_STAGGER_MS against a literal digit count can't fail
    // no matter what numberCells or the component actually produce.
    // "AED 9,999,999.99" is the widest string formatFils emits (see
    // harness/README.md's fixture notes) — 9 digit wheels (7 before the
    // decimal + 2 after); commas/the decimal point don't consume a stagger
    // step (ROLL_STAGGER_MS's own doc comment).
    const widest = formatFils(999_999_999); // "9,999,999.99"
    const digitCount = numberCells(widest).filter((c) => c.digit !== null).length;
    expect(digitCount).toBe(9);
    const worstDelay = Math.min((digitCount - 1) * ROLL_STAGGER_MS, ROLL_STAGGER_MAX);
    expect(ROLL_MS + worstDelay).toBeLessThanOrEqual(0.6);
  });

  it("renders the zero placeholder without any wheels", () => {
    const { container } = render(<MotionProvider><RollingNumber value="—" /></MotionProvider>);
    expect(container.querySelectorAll(".rolling-wheel").length).toBe(0);
    expect(container.querySelector(".sr-only")).toHaveTextContent("—");
  });
});
