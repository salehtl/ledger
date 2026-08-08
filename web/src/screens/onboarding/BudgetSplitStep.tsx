/**
 * Choosing the needs / wants / savings plan, during setup.
 *
 * # Why it is not a step in the machine
 *
 * `v2/onboarding.ts` derives the position from FACTS — a step exists because a
 * milestone is not met yet, and the walk refuses to skip a gap. This choice has
 * no milestone: it is optional by design, an account with no `budget_split_set`
 * op behaves exactly as it always has, and inventing a "saw the plan step" fact
 * would put a UI preference into the table the machine reasons about. So it
 * rides on the finish screen, where the primary action is "Open ledger" and
 * ignoring this entirely is a complete answer.
 *
 * # It is skippable, and the copy has to make that true
 *
 * Nothing here blocks. There is no "skip" button because there is nothing to
 * skip past — the step's own control is optional and the line above it says
 * what happens if it is left alone, which is the honest version of the same
 * affordance.
 *
 * That line says "the plan shown below" and NOT "50 / 30 / 20", which it used
 * to. Once the fields can hold the plan the account already set, naming the
 * default is a claim about what happens next that is false for exactly the
 * users the seeding was added for.
 *
 * # It does not normalise
 *
 * `Save plan` is inert until the three percentages add up to 100, and the
 * sentence under the fields says the sum as it is typed. Quietly rewriting
 * 60/30/20 to 55/27/18 would change the user's plan without telling them.
 *
 * # It reads the plan the account already holds, and that is a data-loss fix
 *
 * This used to open on {@link DEFAULT_BUDGET_SPLIT} and an empty total and
 * never read the log at all. `budget_split_set` REPLACES the plan, so pressing
 * "Save plan" with an untouched, empty total wiped a monthly total set on
 * another device — and the finish screen this rides on is reached by any device
 * that had to secure keys, which is every second phone, every cleared browser
 * and every failing `GET /api/v1/keys`.
 *
 * `v2/onboarding.ts`'s `accountSetupComplete` closed that route. This is the
 * second gate, and it is the one that holds if a third route ever appears: **a
 * screen that has not read the existing plan must never author over it.** So
 * the fields seed from {@link usablePlan} and stay disabled until they have,
 * exactly as `V2Settings` does — the accessor rather than a presence check on
 * `snapshot.split`, because the unusable snapshot's placeholder is not
 * `undefined` and this exact shape has now reached review three times.
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { BudgetSplitPicker, completeSplit, type BudgetSplitDraft } from "../../components/BudgetSplitPicker";
import { MonthlyTotalField } from "../../components/MonthlyTotalField";
import { formatMoney, minorToDraft, parseMinorDraft } from "../../lib/minorMoney";
import { useBudgetSnapshot, useBudgetSource } from "../../v2/queries";
import { budgetSplitOps, DEFAULT_BUDGET_SPLIT, usablePlan, type BudgetSource, type BudgetSplit } from "../../v2/sources/budget";
import type { OpSpec } from "../../v2/onboarding";

export interface BudgetSplitStepProps {
  /** Authors the op. Throwing leaves the control usable and says so. */
  commit: (ops: readonly OpSpec[]) => Promise<void> | void;
  /** The home currency, for the total's sentence. `null` prints the amount bare. */
  currency?: string | null;
  /**
   * Where the account's existing plan is read from.
   *
   * Passed in rather than taken from {@link useBudgetSource}'s context, because
   * onboarding renders OUTSIDE `V2Provider` — the gate has not reached `ready`
   * yet — so the context read is `null` here and the fields would never seed.
   */
  source?: BudgetSource;
  /** Called with the saved plan, for a parent that wants to know. */
  onSaved?: (split: BudgetSplit) => void;
}

export function BudgetSplitStep({ commit, currency = null, source, onSaved }: BudgetSplitStepProps) {
  const [draft, setDraft] = useState<BudgetSplitDraft>(DEFAULT_BUDGET_SPLIT);
  // The TEXT of the total, not an amount: "" ("no total"), "0" ("nothing") and
  // "12.345" ("not an amount") are three different things to say, and a parsed
  // value would collapse them. Empty until the plan is read, so an account with
  // no total authors exactly the op it authored before the field existed.
  const [totalText, setTotalText] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [saved, setSaved] = useState<{ split: BudgetSplit; total: bigint | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const budget = useBudgetSnapshot(useBudgetSource(source));
  const heldPlan = usablePlan(budget.data);
  useEffect(() => {
    if (seeded || heldPlan === undefined) return;
    setDraft(heldPlan.split);
    // `minorToDraft` and not `formatMinor`: the field's own parser refuses a
    // grouping comma, so a seeded "12,000.00" would be a value this screen
    // calls unreadable the moment it is displayed.
    setTotalText(minorToDraft(heldPlan.monthlyTotal));
    setSeeded(true);
  }, [seeded, heldPlan]);
  const plan = completeSplit(draft);
  const total = parseMinorDraft(totalText);

  const save = useCallback(async (): Promise<void> => {
    // `seeded` is a GUARD here, not bookkeeping: until the plan has been read,
    // these fields hold defaults nobody chose, and authoring them would replace
    // the account's plan with them.
    if (!seeded || plan === null || total.state === "refused") return;
    const minor = total.state === "amount" ? total.minor : null;
    setBusy(true);
    setFailed(false);
    try {
      await commit(budgetSplitOps(plan, minor));
      setSaved({ split: plan, total: minor });
      onSaved?.(plan);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [seeded, plan, total, commit, onSaved]);

  return (
    <section data-testid="onboarding-budget-split" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">Your plan, if you want one</h2>
        <p className="text-sm leading-relaxed text-muted">
          Needs are rent, bills and groceries; wants are everything you choose; savings is what you put aside or pay
          off. Leave this alone and ledger uses the plan shown below. You can change it in Settings whenever.
        </p>
        <p className="text-sm leading-relaxed text-muted">
          You can also say what you mean to spend in a month. Leave the budget empty and ledger just shows what you
          spend, with nothing to fall short of.
        </p>
      </div>
      <BudgetSplitPicker value={draft} onChange={setDraft} idPrefix="onboarding-split" disabled={!seeded} />
      <MonthlyTotalField
        value={totalText}
        onChange={setTotalText}
        currency={currency}
        idPrefix="onboarding-total"
        disabled={!seeded}
      />
      {!seeded && (
        <p data-testid="onboarding-plan-warming" role="status" className="text-sm text-muted">
          Reading your plan from this device. It will be ready in a moment — nothing is wrong.
        </p>
      )}
      <Button
        variant="secondary"
        disabled={!seeded || plan === null || total.state === "refused" || busy}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Save plan"}
      </Button>
      {saved !== null && (
        <p role="status" className="text-sm text-muted">
          Saved. Needs {saved.split.need}%, wants {saved.split.want}%, savings {saved.split.saving}%
          {saved.total === null ? ", and no monthly budget" : `, on ${formatMoney(saved.total, currency ?? "")} a month`}.
        </p>
      )}
      {failed && (
        <p role="status" className="text-sm text-bad">
          ledger could not save that just now. Nothing is lost — you can try again, or set it later in Settings.
        </p>
      )}
    </section>
  );
}
