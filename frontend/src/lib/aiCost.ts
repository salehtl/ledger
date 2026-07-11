/** Micro-USD (1e-6 USD) integer money helpers for AI cost display. */
const MU = 1_000_000;

export function muUSDToDollars(musd: number): number {
  return musd / MU;
}

export function dollarsToMuUSD(dollars: number): number {
  return Math.round(dollars * MU);
}

/** Format micro-USD as a dollar string. Values under $0.01 (but > 0) show "< $0.01". */
export function formatMuUSD(musd: number): string {
  if (musd <= 0) return "$0.00";
  const dollars = musd / MU;
  if (dollars < 0.01) return "< $0.01";
  return `$${dollars.toFixed(2)}`;
}
