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
 * # It does not normalise
 *
 * `Save plan` is inert until the three percentages add up to 100, and the
 * sentence under the fields says the sum as it is typed. Quietly rewriting
 * 60/30/20 to 55/27/18 would change the user's plan without telling them.
 */

import { useCallback, useState } from "react";

import { Button } from "../../components/ui/Button";
import { BudgetSplitPicker, completeSplit, type BudgetSplitDraft } from "../../components/BudgetSplitPicker";
import { budgetSplitOps, DEFAULT_BUDGET_SPLIT, type BudgetSplit } from "../../v2/sources/budget";
import type { OpSpec } from "../../v2/onboarding";

export interface BudgetSplitStepProps {
  /** Authors the op. Throwing leaves the control usable and says so. */
  commit: (ops: readonly OpSpec[]) => Promise<void> | void;
  /** Called with the saved plan, for a parent that wants to know. */
  onSaved?: (split: BudgetSplit) => void;
}

export function BudgetSplitStep({ commit, onSaved }: BudgetSplitStepProps) {
  const [draft, setDraft] = useState<BudgetSplitDraft>(DEFAULT_BUDGET_SPLIT);
  const [saved, setSaved] = useState<BudgetSplit | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const plan = completeSplit(draft);

  const save = useCallback(async (): Promise<void> => {
    if (plan === null) return;
    setBusy(true);
    setFailed(false);
    try {
      await commit(budgetSplitOps(plan));
      setSaved(plan);
      onSaved?.(plan);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [plan, commit, onSaved]);

  return (
    <section data-testid="onboarding-budget-split" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">Your plan, if you want one</h2>
        <p className="text-sm leading-relaxed text-muted">
          Needs are rent, bills and groceries; wants are everything you choose; savings is what you put aside or pay
          off. Leave this alone and ledger uses 50 / 30 / 20 — you can change it in Settings whenever.
        </p>
      </div>
      <BudgetSplitPicker value={draft} onChange={setDraft} idPrefix="onboarding-split" />
      <Button variant="secondary" disabled={plan === null || busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save plan"}
      </Button>
      {saved !== null && (
        <p role="status" className="text-sm text-muted">
          Saved. Needs {saved.need}%, wants {saved.want}%, savings {saved.saving}%.
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
