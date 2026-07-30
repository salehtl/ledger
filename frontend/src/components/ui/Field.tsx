import { useState, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";
import type { PixelIconType } from "./PixelIcon";
import {
  clampNumber,
  formatNumericValue,
  parseNumericDraft,
  sanitizeNumericText,
} from "../../lib/numericDraft";

// text-base (16px) is load-bearing: iOS Safari zooms the viewport onto any
// focused control whose font-size is below 16px. Never swap it for text-sm.
// `inset` (bg-surface-2) is for fields inside a Dialog, whose panel is
// already bg-surface; the default bg-surface is for fields on the page (bg-bg).
const BASE = "w-full min-h-11 py-2 pr-3 rounded-[var(--radius)] border border-border text-base";
const bg = (inset: boolean) => (inset ? "bg-surface-2" : "bg-surface");

export function Input({ inset = false, icon: Icon, className = "", ...rest }:
  { inset?: boolean; icon?: PixelIconType; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const control = (
    <input className={`${BASE} ${Icon ? "pl-9" : "pl-3"} ${bg(inset)} ${className}`} {...rest} />
  );
  if (!Icon) return control;
  return (
    <div className="relative">
      <Icon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
      {control}
    </div>
  );
}

/**
 * The numeric input. Use this for every amount, percentage and count —
 * never a bare `<Input type="number" value={n} onChange={e => f(Number(e.target.value))} />`.
 *
 * That shape has a bug users hit immediately: `Number("")` is `0`, so the
 * moment you select-all and delete, a `0` is written to state and rendered
 * straight back into the field. You cannot empty it to type a fresh amount,
 * and the app silently persists a zero you never meant.
 *
 * So this keeps the typed text and the committed number apart. While the field
 * is focused it shows exactly what you typed — including the empty string and
 * half-finished states like `12.` — and reports `null` for those instead of
 * inventing a zero. On blur the draft is dropped and the field re-renders from
 * whatever value the parent actually holds, so it can never sit there showing
 * a number that was never saved.
 *
 * That leaves the caller one decision, made by what it does with `null`:
 *
 *   required field — ignore it, and the last good number is kept and restored
 *     on blur:            `onValueChange={(n) => n !== null && setAmount(n)}`
 *   optional field — store it, and the field stays empty. Pass `allowEmpty`
 *     so blur commits the null too:   `onValueChange={setBudget}`
 *
 * It is `type="text"` with `inputMode`, not `type="number"`: a number input
 * reports `""` for invalid text like `"1e"`, which makes the difference between
 * "empty" and "nonsense" impossible to see. `inputMode` still gets the numeric
 * keypad on iOS and Android.
 */
export function NumberField({
  value,
  onValueChange,
  min,
  max,
  decimals,
  allowNegative = false,
  allowDecimal = true,
  allowEmpty = false,
  inset = false,
  className = "",
  ...rest
}: {
  value: number | null | undefined;
  /** Fires with `null` when the field is empty or mid-keystroke — never a stand-in 0. */
  onValueChange: (next: number | null) => void;
  min?: number;
  max?: number;
  /** Round to this many decimals when the field loses focus. */
  decimals?: number;
  allowNegative?: boolean;
  allowDecimal?: boolean;
  /** Let the field stay empty on blur (commits `null`) instead of restoring the last value. */
  allowEmpty?: boolean;
  inset?: boolean;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max">) {
  // `null` means "not being edited" — show the committed value.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? formatNumericValue(value, decimals);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = sanitizeNumericText(e.target.value, { allowNegative, allowDecimal });
    setDraft(text);
    // Commit only a genuine number. Clamping waits for blur so that typing the
    // "1" of "100" into a 0–100 field isn't yanked around mid-keystroke.
    onValueChange(parseNumericDraft(text));
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const parsed = parseNumericDraft(draft ?? "");
    if (parsed !== null) {
      const settled = clampNumber(parsed, min, max);
      if (settled !== parsed) onValueChange(settled);
    } else if (draft !== null && allowEmpty) {
      onValueChange(null);
    }
    // Drop the draft either way: the field now mirrors what was actually
    // committed, so it can't sit there showing an unsaved number.
    setDraft(null);
    rest.onBlur?.(e);
  };

  return (
    <input
      {...rest}
      type="text"
      inputMode={rest.inputMode ?? (allowDecimal ? "decimal" : "numeric")}
      value={shown}
      onChange={handleChange}
      onBlur={handleBlur}
      className={`${BASE} pl-3 ${bg(inset)} tnum ${className}`}
    />
  );
}

export function Select({ inset = false, className = "", children, ...rest }:
  { inset?: boolean; className?: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${BASE} pl-3 ${bg(inset)} ${className}`} {...rest}>
      {children}
    </select>
  );
}
