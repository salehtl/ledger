/** Whether a need/want/saving split (as fractions) allocates exactly 100%. */
export function pctsValid(need: number, want: number, saving: number): boolean {
  return Math.abs(need + want + saving - 1.0) < 0.001;
}

/** Geometry for the budget split bar. */
export interface SplitSegments {
  needPct: number;
  wantPct: number;
  savingPct: number;
  /** The raw allocation as a whole percentage (100 = fully allocated). */
  totalPct: number;
  ok: boolean;
}

/**
 * Bar-segment widths (percent of the bar) for a need/want/saving split of
 * income fractions. When the split totals ≤ 100% the widths are absolute, so
 * unallocated income reads as a literal gap; when it overshoots, segments are
 * normalized so the bar stays full and only the total flags the problem.
 */
export function splitSegments(need: number, want: number, saving: number): SplitSegments {
  const clamp = (f: number) => Math.max(0, f);
  const total = clamp(need) + clamp(want) + clamp(saving);
  const scale = total > 1 ? 1 / total : 1;
  const pct = (f: number) => clamp(f) * scale * 100;
  return {
    needPct: pct(need),
    wantPct: pct(want),
    savingPct: pct(saving),
    totalPct: Math.round(total * 100),
    ok: Math.abs(total - 1.0) < 0.001,
  };
}
