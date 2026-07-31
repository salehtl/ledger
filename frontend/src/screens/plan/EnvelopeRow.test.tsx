import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { EnvelopeRow } from "./EnvelopeRow";
import type { Envelope } from "../../lib/envelope";

function env(over: Partial<Envelope> = {}): Envelope {
  return {
    category_id: 5,
    category_name: "Groceries",
    bucket: "need",
    carryover_fils: 0,
    assigned_fils: 0,
    activity_fils: 0,
    available_fils: 0,
    overspent: false,
    overspend_debt_fils: 0,
    ...over,
  };
}

// EnvelopeRow renders a Pressable, which is m.button under the hood — every
// render here must go through MotionProvider, or the button renders with no
// motion features loaded and the test would prove nothing about it (see
// MotionProvider's own doc comment).
describe("EnvelopeRow", () => {
  it("falls back to the neutral dot when PlanScreen's colorById lookup misses", () => {
    // No `color` prop at all — the shape of a lookup miss (colorById.get
    // returns undefined). This is the wiring the coordinator flagged: a
    // regression in PlanScreen's colorById map, or in categoryColor's
    // fallback, would leave this silently uncaught without this test.
    const { container } = render(
      <MotionProvider>
        <EnvelopeRow envelope={env()} onOpen={() => {}} />
      </MotionProvider>,
    );
    const dot = container.querySelector("p span[aria-hidden]") as HTMLElement | null;
    expect(dot).toBeTruthy();
    expect(dot!.style.backgroundColor).toBe("var(--color-slate)");
  });
});
