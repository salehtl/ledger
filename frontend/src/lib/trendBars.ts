/** Bar height as a 0-100 percentage of the tallest bar; 0 when there is no data. */
export function barHeightPct(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}
