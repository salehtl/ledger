/**
 * Text-editing rules for numeric fields.
 *
 * A number input has two different values at once: the string the user is
 * currently typing, and the number it means. They are not the same, and
 * collapsing them is what produces the classic bug — bind `value={n}` with
 * `onChange={e => setN(Number(e.target.value))}` and clearing the field runs
 * `Number("")`, which is `0`, so a `0` is written straight back and the user
 * can never empty the field to type a fresh amount.
 *
 * `""`, `"-"`, `"12."` and `"0."` are all legitimate things to be holding
 * mid-keystroke. Each means "no number yet" — not zero — so the helpers below
 * keep the text and report `null` rather than inventing a value.
 */

/** Strip anything that can't appear in the number being typed. */
export function sanitizeNumericText(
  raw: string,
  { allowNegative = false, allowDecimal = true }: { allowNegative?: boolean; allowDecimal?: boolean } = {},
): string {
  let out = "";
  let seenDot = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch >= "0" && ch <= "9") {
      out += ch;
      continue;
    }
    // A minus sign is only meaningful as the very first character.
    if (ch === "-" && allowNegative && out.length === 0) {
      out += ch;
      continue;
    }
    // Accept a comma as a decimal separator — some locales' keypads emit it —
    // but keep only the first separator.
    if ((ch === "." || ch === ",") && allowDecimal && !seenDot) {
      out += ".";
      seenDot = true;
      continue;
    }
  }
  return out;
}

/** True while the text is a plausible prefix of a number but isn't one yet. */
export function isIncompleteNumericText(text: string): boolean {
  return text === "" || text === "-" || text === "." || text === "-." || /^-?\d*\.$/.test(text);
}

/**
 * The number this text means, or `null` when it doesn't mean one yet.
 *
 * Returns `null` — never `0` — for empty and partial input, so a caller can
 * tell "the user cleared the field" apart from "the user typed zero".
 */
export function parseNumericDraft(text: string): number | null {
  const t = text.trim();
  if (isIncompleteNumericText(t)) return null;
  // Deliberately stricter than Number(): no exponents, no hex, no whitespace
  // padding, no Infinity.
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Clamp to a range, ignoring bounds that weren't supplied. */
export function clampNumber(n: number, min?: number, max?: number): number {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/**
 * How a committed number is shown when the field isn't being edited.
 * `null` shows as empty, and integers never grow a trailing `.0`.
 */
export function formatNumericValue(value: number | null | undefined, decimals?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  if (decimals === undefined) return String(value);
  return String(Number(value.toFixed(decimals)));
}
