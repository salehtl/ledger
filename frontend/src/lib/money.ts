/** Format int64 fils as accounting-style AED (no symbol): 1,234.56 / (500.00) / —. */
export function formatFils(fils: number): string {
  if (fils === 0) return "—";
  const neg = fils < 0;
  const abs = Math.abs(fils);
  const s = (abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return neg ? `(${s})` : s;
}

export function moneyClass(fils: number): string {
  if (fils < 0) return "money money-neg";
  if (fils === 0) return "money money-zero";
  return "money";
}

export type Flow = "in" | "out";

/** Format a transaction amount with an explicit flow sign: −24.50 out, +5,000.00 in.
 *  Direction rides on the sign glyph (not color alone), so it stays legible without
 *  color. `transactions.amount` is always positive; the magnitude is used regardless. */
export function flowAmount(direction: string, amountFils: number): { text: string; flow: Flow } {
  const formatted = (Math.abs(amountFils) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const inbound = direction === "credit";
  return { text: `${inbound ? "+" : "−"}${formatted}`, flow: inbound ? "in" : "out" };
}

export interface FXAmount {
  AmountFils: number;
  Currency: string;
  AmountAedFils: number | null;
}

/** Budget-effective AED fils for a transaction. AED rows are their own amount;
 *  foreign rows use the stored snapshot; null = foreign with no rate configured
 *  yet (excluded from every sum until a rate is added in Settings). */
export function aedFils(t: FXAmount): number | null {
  if (!t.Currency || t.Currency === "AED") return t.AmountFils;
  return t.AmountAedFils;
}

/** "USD 10.09" annotation for foreign-currency rows; null for AED rows. */
export function nativeAmountTag(t: FXAmount): string | null {
  if (!t.Currency || t.Currency === "AED") return null;
  const n = (t.AmountFils / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${t.Currency} ${n}`;
}
