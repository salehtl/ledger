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
