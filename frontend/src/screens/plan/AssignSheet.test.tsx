import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionProvider } from "../../app/MotionProvider";
import { AssignSheet } from "./AssignSheet";
import type { Envelope } from "../../lib/envelope";

const envelope: Envelope = {
  category_id: 5,
  category_name: "Groceries",
  bucket: "need",
  carryover_fils: 0,
  assigned_fils: 0,
  activity_fils: 0,
  available_fils: 0,
  overspent: false,
  overspend_debt_fils: 0,
};

// Dialog is m.div under the hood, so every render goes through MotionProvider.
function wrap(color: string | null | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MotionProvider>
        <AssignSheet
          envelope={envelope}
          month="2026-07"
          canMoveIn={false}
          color={color}
          onClose={() => {}}
          onMoveMoney={() => {}}
          onEditTarget={() => {}}
        />
      </MotionProvider>
    </QueryClientProvider>,
  );
}

const dot = () => screen.getByRole("dialog").querySelector("span[aria-hidden]") as HTMLElement;

describe("AssignSheet's title dot", () => {
  // This dot had no test until the `background:` shorthand became
  // `backgroundColor:`. jsdom does not expand shorthands over a var() —
  // `style.background = "var(--color-teal)"` leaves `.backgroundColor === ""`
  // — so the assertion was simply unwritable. Identical at runtime; the one
  // word buys the coverage back.
  it("carries the category's own colour", () => {
    wrap("teal");
    expect(dot().style.backgroundColor).toBe("var(--color-teal)");
  });

  it("falls back to the neutral on a colorById lookup miss", () => {
    // undefined is the shape of the miss: the envelope wire has no colour of
    // its own, so PlanScreen looks it up against the category inventory and a
    // miss passes undefined down. Neutral, never an interpolated var(--color-)
    // that resolves to nothing.
    wrap(undefined);
    expect(dot().style.backgroundColor).toBe("var(--color-slate)");
  });
});
