import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SqlDriver } from "@ledger/client/store/driver";

import { projectionWith } from "../../test/projectionFixture";
import { sqlBudgetSource } from "../../v2/sources/budget";
import { BudgetSplitStep, type BudgetSplitStepProps } from "./BudgetSplitStep";
import type { OpSpec } from "../../v2/onboarding";

let db: SqlDriver;

beforeEach(async () => {
  db = await projectionWith();
});

function wrap(props: Partial<BudgetSplitStepProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BudgetSplitStep commit={() => {}} source={sqlBudgetSource(db)} {...props} />
    </QueryClientProvider>,
  );
}

/**
 * The controls are locked until the account's plan has been read, exactly as in
 * Settings. Every test that edits the plan waits for that, as a person would.
 */
async function planReady(): Promise<HTMLElement> {
  const needs = await screen.findByLabelText(/Needs/);
  await waitFor(() => {
    expect(needs).toBeEnabled();
  });
  return needs;
}

describe("BudgetSplitStep", () => {
  it("opens on 50 / 30 / 20 for an account with no plan, and says what happens if it is left alone", async () => {
    wrap();
    await planReady();
    expect((screen.getByLabelText(/Needs/) as HTMLInputElement).value).toBe("50");
    expect((screen.getByLabelText(/Wants/) as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText(/Savings/) as HTMLInputElement).value).toBe("20");
    // Skippable, and the copy is what makes that true rather than a button that
    // does nothing: leaving it alone is a complete answer.
    expect(screen.getByText(/Leave this alone and ledger uses the plan shown below/)).toBeInTheDocument();
  });

  it("does not claim the default is what happens when the account holds another plan", async () => {
    // "Leave this alone and ledger uses 50 / 30 / 20" was true of a screen that
    // could only ever show the default. It is a false sentence over a field
    // showing 60/20/20, and this account is the case the seeding exists for.
    db.prepare("INSERT INTO budget_split (id,need,want,saving,monthly_total_minor) VALUES (1,60,20,20,'1200000')").run();
    wrap();
    await planReady();
    expect(document.body.textContent).not.toMatch(/50 \/ 30 \/ 20/);
  });

  it("authors nothing at all unless the plan is saved", async () => {
    const commit = vi.fn();
    wrap({ commit });
    const needs = await planReady();
    // Mounting, typing and walking away must leave the log untouched: an
    // account that ignored this step has no `budget_split_set` op, which is
    // exactly what makes the default a no-op for data.
    await userEvent.clear(needs);
    await userEvent.type(needs, "60");
    expect(commit).not.toHaveBeenCalled();
  });

  it("will not save a plan that does not add up, and does not rewrite it", async () => {
    const commit = vi.fn();
    wrap({ commit });
    const needs = await planReady();
    await userEvent.clear(needs);
    await userEvent.type(needs, "60");

    // 60/30/20. The screen says the sum before the save, and the save is inert.
    expect(screen.getByText(/adds up to 110% — it has to be 100%/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save plan/i })).toBeDisabled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("authors one op with the percentages exactly as typed", async () => {
    const specs: OpSpec[] = [];
    wrap({ commit: (ops) => void specs.push(...ops) });
    await planReady();
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

  it("leaves the total empty for an account with none, and saving authors the op it always did", async () => {
    const specs: OpSpec[] = [];
    wrap({ commit: (ops) => void specs.push(...ops), currency: "AED" });
    await planReady();
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
    wrap({ commit: (ops) => void specs.push(...ops), currency: "AED" });
    await planReady();
    await userEvent.type(screen.getByLabelText(/monthly budget/i), "12000");
    await userEvent.click(screen.getByRole("button", { name: /save plan/i }));

    expect(specs).toEqual([
      { type: "budget_split_set", payload: { need: 50, want: 30, saving: 20, monthly_total_minor: "1200000" } },
    ]);
    expect(await screen.findByText(/on AED 12,000\.00 a month\./)).toBeInTheDocument();
  });

  it("refuses an unreadable total visibly, and saves nothing while it stands", async () => {
    const commit = vi.fn();
    wrap({ commit, currency: "AED" });
    await planReady();
    await userEvent.type(screen.getByLabelText(/monthly budget/i), "12.345");

    expect(screen.getByText(/two decimal places/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save plan/i })).toBeDisabled();
    expect(commit).not.toHaveBeenCalled();
    // And the text stays exactly as typed — nothing is rounded behind them.
    expect(screen.getByLabelText(/monthly budget/i)).toHaveValue("12.345");
  });

  it("stays skippable: the copy says an empty total is a complete answer", async () => {
    wrap({ currency: "AED" });
    await planReady();
    expect(screen.getByText(/Leave the budget empty and ledger just shows what you spend/i)).toBeInTheDocument();
  });

  it("says a failed save is not a dead end", async () => {
    wrap({
      commit: () => {
        throw new Error("offline");
      },
    });
    await planReady();
    await userEvent.click(screen.getByRole("button", { name: /save plan/i }));
    expect(await screen.findByText(/could not save that just now/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save plan/i })).toBeEnabled();
  });

  // -- the plan the account already holds ------------------------------------

  /**
   * The one that destroys data.
   *
   * This screen rides on the finish walk, and the finish walk is reached by any
   * device that had to secure keys — a second phone, a browser whose site data
   * was cleared, a failing `GET /api/v1/keys`. It opened on
   * `DEFAULT_BUDGET_SPLIT` and an empty total and never read the log, so
   * pressing "Save plan" authored a whole `budget_split_set` — which REPLACES
   * the plan — and an untouched, empty total field wiped a monthly total set on
   * the first device.
   *
   * `resumeFacts` no longer walks a set-up account here at all. This is the
   * second gate, and it is the one that holds if a third route to this screen
   * ever appears: a screen that has not read the plan cannot author over it.
   */
  it("shows the plan the account already holds instead of an empty picker", async () => {
    db.prepare("INSERT INTO budget_split (id,need,want,saving,monthly_total_minor) VALUES (1,60,20,20,'1200000')").run();
    wrap({ currency: "AED" });

    const needs = (await planReady()) as HTMLInputElement;
    expect(needs.value).toBe("60");
    expect((screen.getByLabelText(/Wants/) as HTMLInputElement).value).toBe("20");
    expect((screen.getByLabelText(/Savings/) as HTMLInputElement).value).toBe("20");
    // Ungrouped, because the field's own parser refuses a comma.
    expect(screen.getByLabelText(/monthly budget/i)).toHaveValue("12000.00");
  });

  it("does not clear a monthly total set on another device when the plan is saved untouched", async () => {
    const specs: OpSpec[] = [];
    db.prepare("INSERT INTO budget_split (id,need,want,saving,monthly_total_minor) VALUES (1,60,20,20,'1200000')").run();
    wrap({ commit: (ops) => void specs.push(...ops), currency: "AED" });
    await planReady();

    await userEvent.click(screen.getByRole("button", { name: /save plan/i }));
    expect(specs).toEqual([
      { type: "budget_split_set", payload: { need: 60, want: 20, saving: 20, monthly_total_minor: "1200000" } },
    ]);
  });

  /**
   * A placeholder is not `undefined`, so every presence check passes on it —
   * the third instance of this shape on this branch. `sqlBudgetSource` answers
   * an unusable projection with `{split: DEFAULT_BUDGET_SPLIT, monthlyTotal:
   * null}`, and a rebuild makes that the ordinary state rather than the
   * unlucky one.
   */
  it("never seeds from an unusable projection, and cannot author while it is unusable", async () => {
    const commit = vi.fn();
    db.prepare("INSERT INTO budget_split (id,need,want,saving,monthly_total_minor) VALUES (1,60,20,20,'1200000')").run();
    // Mid-rebuild: the rows are there, the projection is not readable yet.
    db.prepare("UPDATE projection_meta SET complete = 0 WHERE id = 1").run();
    wrap({ commit, currency: "AED" });

    const needs = await screen.findByLabelText(/Needs/);
    // Not merely unsaveable: DISABLED, so nothing typed is thrown away by the
    // seeding that follows, and 50/30/20 is never presented as this account's
    // answer while its real one is 60/20/20.
    await waitFor(() => {
      expect(needs).toBeDisabled();
    });
    expect(screen.getByLabelText(/monthly budget/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /save plan/i })).toBeDisabled();
    expect(screen.getByTestId("onboarding-plan-warming")).toHaveTextContent(/reading your plan/i);
    expect(commit).not.toHaveBeenCalled();
  });
});
