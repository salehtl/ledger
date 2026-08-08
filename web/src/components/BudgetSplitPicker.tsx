/**
 * The needs / wants / savings plan, as three whole percentages.
 *
 * One control, used by the onboarding step and by Settings, because the two
 * have to agree on what a plan is and on when it is valid — two copies of "must
 * add up to 100" is how one screen accepts a plan the other refuses.
 *
 * # It says the sum BEFORE anything is saved, and it never normalises
 *
 * A user who typed 60/30/20 meant something. Quietly rewriting it to 55/27/18
 * changes their plan without telling them, so this reports the arithmetic as it
 * stands ({@link splitSum}) and leaves the correction to the person who typed
 * it. The parent disables its save control while {@link BudgetSplitPickerProps.value}
 * does not sum to 100; the fold refuses such an op as well
 * (`client/src/replay/replay.ts`), so there is no path by which a plan that does
 * not add up reaches the log.
 *
 * # Percentages are integers, and are not money
 *
 * `NumberField` with `allowDecimal={false}`: the money rule is about amounts —
 * an int64 in a JS `number` is the defect this codebase is written against — and
 * a whole percentage is bounded by 100. `allowEmpty` is deliberate: clearing a
 * field to type a fresh figure has to be possible, and a `null` here is "not
 * finished typing", which is not a plan and cannot be saved.
 */

import { NumberField } from "./ui/Field";
import { splitSum, type BudgetSplit } from "../v2/sources/budget";

/** A plan being typed: a field cleared for a fresh figure is `null`, never 0. */
export interface BudgetSplitDraft {
  need: number | null;
  want: number | null;
  saving: number | null;
}

export interface BudgetSplitPickerProps {
  value: BudgetSplitDraft;
  onChange: (next: BudgetSplitDraft) => void;
  /** Prefixes the field ids, so two pickers can coexist in one document. */
  idPrefix?: string;
  /**
   * Locks the fields while the plan they show is not the user's yet.
   *
   * For the window before a screen has read the stored plan: what is on display
   * is a placeholder about to be replaced by the seeding, so an enabled field
   * invites typing that is then silently thrown away. The caller owes an
   * explanation beside it — a locked control with no reason is its own defect.
   */
  disabled?: boolean;
}

const FIELDS = [
  { key: "need", label: "Needs", hint: "rent, bills, groceries" },
  { key: "want", label: "Wants", hint: "eating out, subscriptions" },
  { key: "saving", label: "Savings & debt", hint: "put aside or paid down" },
] as const;

/** The draft as a plan, or `null` while a field is empty or the sum is not 100. */
export function completeSplit(draft: BudgetSplitDraft): BudgetSplit | null {
  const { need, want, saving } = draft;
  if (need === null || want === null || saving === null) return null;
  const split = { need, want, saving };
  return splitSum(split) === 100 ? split : null;
}

/**
 * The sentence under the fields, said while typing rather than after saving.
 *
 * Exported and pure so the words are testable without a DOM, and so a screen
 * that needs the same sentence elsewhere cannot write a second version of it.
 */
export function splitAdvice(draft: BudgetSplitDraft): string {
  const { need, want, saving } = draft;
  if (need === null || want === null || saving === null) return "Fill in all three to save.";
  const sum = splitSum({ need, want, saving });
  if (sum === 100) return "Adds up to 100%.";
  return `Adds up to ${sum}% — it has to be 100%.`;
}

export function BudgetSplitPicker({ value, onChange, idPrefix = "split", disabled = false }: BudgetSplitPickerProps) {
  return (
    <div className="flex flex-col gap-3">
      {FIELDS.map((f) => (
        <div key={f.key} className="flex items-center gap-3">
          <label htmlFor={`${idPrefix}-${f.key}`} className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{f.label}</span>
            <span className="block text-xs text-muted">{f.hint}</span>
          </label>
          <div className="flex items-center gap-1.5 shrink-0">
            <NumberField
              id={`${idPrefix}-${f.key}`}
              className="w-20 text-right"
              value={value[f.key]}
              onValueChange={(n) => onChange({ ...value, [f.key]: n })}
              min={0}
              max={100}
              allowDecimal={false}
              allowEmpty
              disabled={disabled}
              enterKeyHint="done"
            />
            <span aria-hidden className="text-sm text-muted">
              %
            </span>
          </div>
        </div>
      ))}
      {/* role="status" so the arithmetic is announced as it changes — the whole
          point is that the user learns the sum before they commit to it. */}
      <p role="status" className="text-xs text-muted tnum">
        {splitAdvice(value)}
      </p>
    </div>
  );
}
