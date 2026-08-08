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
    // The confirmation says the total too, and says its absence rather than
    // leaving the user to guess what an untouched field did.
    expect(await screen.findByText(/Saved\. Needs 60%, wants 20%, savings 20%, and no monthly budget\./)).toBeInTheDocument();
  });

  it("leaves the total empty, and saving without one authors the op it always did", async () => {
    const specs: OpSpec[] = [];
    render(<BudgetSplitStep commit={(ops) => void specs.push(...ops)} currency="AED" />);
    expect(screen.getByLabelText(/monthly budget/i)).toHaveValue("");

    await userEvent.click(screen.getByRole("button", { name: /save plan/i }));
    // No `monthly_total_minor` key at all: an account that skips the question
    // authors byte-identical bytes to the build that predates the field.
    // `toStrictEqual` because `toEqual` ignores keys whose value is `undefined`,
    // and "the key is absent" is exactly the claim.
    expect(specs).toStrictEqual([{ type: "budget_split_set", payload: { need: 50, want: 30, saving: 20 } }]);
    expect(JSON.stringify(specs[0]!.payload)).toBe('{"need":50,"want":30,"saving":20}');
  });

  it("authors a typed total as minor units in a string, and says so back", async () => {
    const specs: OpSpec[] = [];
    render(<BudgetSplitStep commit={(ops) => void specs.push(...ops)} currency="AED" />);
    await userEvent.type(screen.getByLabelText(/monthly budget/i), "12000");
    await userEvent.click(screen.getByRole("button", { name: /save plan/i }));

    expect(specs).toEqual([
      { type: "budget_split_set", payload: { need: 50, want: 30, saving: 20, monthly_total_minor: "1200000" } },
    ]);
    expect(await screen.findByText(/on AED 12,000\.00 a month\./)).toBeInTheDocument();
  });

  it("refuses an unreadable total visibly, and saves nothing while it stands", async () => {
    const commit = vi.fn();
    render(<BudgetSplitStep commit={commit} currency="AED" />);
    await userEvent.type(screen.getByLabelText(/monthly budget/i), "12.345");

    expect(screen.getByText(/two decimal places/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save plan/i })).toBeDisabled();
    expect(commit).not.toHaveBeenCalled();
    // And the text stays exactly as typed — nothing is rounded behind them.
    expect(screen.getByLabelText(/monthly budget/i)).toHaveValue("12.345");
  });

  it("stays skippable: the copy says an empty total is a complete answer", () => {
    render(<BudgetSplitStep commit={() => {}} currency="AED" />);
    expect(screen.getByText(/Leave the budget empty and ledger just shows what you spend/i)).toBeInTheDocument();
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
