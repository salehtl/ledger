/**
 * What the user means to spend in a month, as an amount of money.
 *
 * One control, used by the onboarding budget step and by Settings, for the same
 * reason {@link BudgetSplitPicker} is: the two surfaces have to agree on what a
 * total is and on when it is refused.
 *
 * # It is deliberately NOT a `NumberField`
 *
 * `NumberField` commits a `number` and clamps it on blur. Both are correct for a
 * percentage and wrong for money:
 *
 *   - a `number` corrupts past 2^53, and this codebase's whole money rule is
 *     that an amount is a `bigint` in minor units — so the value this reports is
 *     text, parsed by `lib/minorMoney.parseMinorDraft` into a `bigint`;
 *   - a clamp REWRITES what was typed without saying so. With
 *     `allowDecimal={false}` a typed `33.3` arrives as `333` and is then pulled
 *     to the field's maximum, which for a percentage is harmless and for a
 *     budget means the number saved is not the number typed.
 *
 * So there is no ceiling, nothing is stripped from the text, and the field never
 * rewrites itself on blur. What cannot be read is REFUSED IN WORDS in the
 * `role="status"` line — the same rule the split follows: say it before saving,
 * never repair it afterwards.
 *
 * # The value is the TEXT, not the amount
 *
 * The parent holds the draft string and reads it with `parseMinorDraft` when it
 * saves. That is what keeps "" ("no total") distinguishable from "0" ("I plan to
 * spend nothing") and from "12.345" ("that is not an amount"), which a
 * `bigint | null` prop would collapse.
 */

import { Input } from "./ui/Field";
import { monthlyTotalAdvice } from "../lib/minorMoney";

export interface MonthlyTotalFieldProps {
  /** The draft text, exactly as typed. Never a parsed amount. */
  value: string;
  onChange: (next: string) => void;
  /** The home currency, for the sentence under the field. `null` prints bare. */
  currency: string | null;
  /** Prefixes the field id, so two of these can coexist in one document. */
  idPrefix?: string;
}

export function MonthlyTotalField({ value, onChange, currency, idPrefix = "monthly-total" }: MonthlyTotalFieldProps) {
  const id = `${idPrefix}-amount`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-sm font-medium">Monthly budget</span>
        <span className="block text-xs text-muted">what you mean to spend in a month{currency === null ? "" : `, in ${currency}`}</span>
      </label>
      <Input
        id={id}
        // `type="text"` with `inputMode="decimal"`: a real number input reports
        // "" for text it dislikes, which would make "empty" and "not an amount"
        // the same thing to read — and those are the two states this field's
        // status line exists to tell apart.
        type="text"
        inputMode="decimal"
        enterKeyHint="done"
        autoComplete="off"
        placeholder="Leave empty for none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="tnum"
      />
      {/* role="status" so the reading is announced as it changes — the point is
          that the user learns what will be saved before they commit to it. */}
      <p role="status" className="text-xs text-muted">
        {monthlyTotalAdvice(value, currency)}
      </p>
    </div>
  );
}
