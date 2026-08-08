import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BudgetSplitStep } from "./BudgetSplitStep";
import type { OpSpec } from "../../v2/onboarding";

describe("BudgetSplitStep", () => {
  it("opens on 50 / 30 / 20 and says what happens if it is left alone", () => {
    render(<BudgetSplitStep commit={() => {}} />);
    expect((screen.getByLabelText(/Needs/) as HTMLInputElement).value).toBe("50");
    expect((screen.getByLabelText(/Wants/) as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText(/Savings/) as HTMLInputElement).value).toBe("20");
    // Skippable, and the copy is what makes that true rather than a button that
    // does nothing: leaving it alone is a complete answer.
    expect(screen.getByText(/Leave this alone and ledger uses 50 \/ 30 \/ 20/)).toBeInTheDocument();
  });

  it("authors nothing at all unless the plan is saved", async () => {
    const commit = vi.fn();
    render(<BudgetSplitStep commit={commit} />);
    // Mounting, typing and walking away must leave the log untouched: an
    // account that ignored this step has no `budget_split_set` op, which is
    // exactly what makes the default a no-op for data.
    await userEvent.clear(screen.getByLabelText(/Needs/));
    await userEvent.type(screen.getByLabelText(/Needs/), "60");
    expect(commit).not.toHaveBeenCalled();
  });

  it("will not save a plan that does not add up, and does not rewrite it", async () => {
    const commit = vi.fn();
    render(<BudgetSplitStep commit={commit} />);
    const needs = screen.getByLabelText(/Needs/);
    await userEvent.clear(needs);
    await userEvent.type(needs, "60");

    // 60/30/20. The screen says the sum before the save, and the save is inert.
    expect(screen.getByText(/adds up to 110% — it has to be 100%/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save plan/i })).toBeDisabled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("authors one op with the percentages exactly as typed", async () => {
    const specs: OpSpec[] = [];
    render(<BudgetSplitStep commit={(ops) => void specs.push(...ops)} />);
    const wants = screen.getByLabelText(/Wants/);
    await userEvent.clear(wants);
    await userEvent.type(wants, "20");
    const needs = screen.getByLabelText(/Needs/);
    await userEvent.clear(needs);
    await userEvent.type(needs, "60");

    await userEvent.click(screen.getByRole("button", { name: /save plan/i }));
    expect(specs).toEqual([{ type: "budget_split_set", payload: { need: 60, want: 20, saving: 20 } }]);
    expect(await screen.findByText(/Saved\. Needs 60%, wants 20%, savings 20%\./)).toBeInTheDocument();
  });

  it("says a failed save is not a dead end", async () => {
    render(
      <BudgetSplitStep
        commit={() => {
          throw new Error("offline");
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /save plan/i }));
    expect(await screen.findByText(/could not save that just now/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save plan/i })).toBeEnabled();
  });
});
