/**
 * Which banks a person banks with — the multi-select, used by the onboarding
 * step and by Settings.
 *
 * One control, for the same reason `BudgetSplitPicker` is one: the two screens
 * have to agree on what "declared" means and on what a row does. Two copies is
 * how a bank added during setup renders differently from one added afterwards,
 * and how one of the two ends up quietly unable to remove anything.
 *
 * # It renders the union of "supported" and "declared", never just the server's
 * list
 *
 * `GET /api/v1/templates` says what ledger can READ. What the user declared is a
 * different question with a different answer, and the two disagree in both
 * directions: a bank on the waitlist (`other`, or a name typed on the bank step)
 * is declared and unsupported, and a supported bank is on offer whether or not
 * anyone declared it. A picker built off the server's list alone would show a
 * declared bank NOT AT ALL — with no way to remove what it would not draw.
 *
 * # Rows are checkboxes, and they are 44px
 *
 * `role="checkbox"` with `aria-checked` rather than a native input, because the
 * row is the target: the whole row toggles, which is the mobile convention this
 * app uses elsewhere (`components/README.md`), and a 20px tick box would not be.
 *
 * # It authors nothing
 *
 * `onToggle` hands the decision back. The onboarding step turns it into a fact
 * the walk reads and an op; Settings turns it into an op through the writer.
 * A control that emitted for itself would be a second author of `bank_declared`.
 */

import { Check } from "./ui/PixelIcon";
import { Pressable } from "./ui/Pressable";
import { bankDisplayName } from "../v2/bank";

export interface BankPickerProps {
  /** Bank ids the server has templates for, ALREADY collapsed per bank. */
  supported: readonly string[];
  /** The banks declared active right now. */
  selected: readonly string[];
  /** A row was pressed. `next` is what it would become. */
  onToggle: (bank: string, next: boolean) => void;
  /** Prefixes the test ids, so two pickers can coexist in one document. */
  idPrefix?: string;
}

/**
 * The rows to draw: the server's list in its order, then anything declared that
 * is not on it. Declared-but-unsupported is a real state (the waitlist), and it
 * has to be visible to be removable.
 */
export function bankRows(supported: readonly string[], selected: readonly string[]): string[] {
  const extra = selected.filter((b) => !supported.includes(b));
  return [...supported, ...extra];
}

export function BankPicker({ supported, selected, onToggle, idPrefix = "bank" }: BankPickerProps) {
  const rows = bankRows(supported, selected);
  if (rows.length === 0) return null;
  return (
    <div
      className="flex flex-col rounded-[var(--radius)] border border-border bg-surface divide-y divide-border"
      data-testid={`${idPrefix}-picker`}
    >
      {rows.map((bank) => {
        const on = selected.includes(bank);
        return (
          <Pressable
            key={bank}
            role="checkbox"
            aria-checked={on}
            data-testid={`${idPrefix}-row-${bank}`}
            className="min-h-11 px-4 py-3 flex items-center justify-between gap-3 text-left text-sm font-medium hover:bg-surface-2 transition-colors"
            onClick={() => onToggle(bank, !on)}
          >
            <span className="min-w-0 break-words">{bankDisplayName(bank)}</span>
            {/* The tick is drawn only when checked; `aria-checked` carries the
                state for anything that cannot see it. */}
            {on && <Check size={16} className="shrink-0 text-accent" aria-hidden />}
          </Pressable>
        );
      })}
    </div>
  );
}
