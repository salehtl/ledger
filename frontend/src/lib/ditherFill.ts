/**
 * Backing-canvas column boundaries for `DitherFill`'s segments.
 *
 * Each boundary is rounded off the *cumulative* value rather than the segment's
 * own share. Rounding every segment independently and carrying the error
 * forward lets the rounding-down accumulate, so segments that sum to exactly
 * `max` can finish up to a column short of full width — visible as a sliver of
 * track at the end of a bar that is supposed to be full. Rounding cumulative
 * positions pins the last boundary to `cols` whenever the values sum to `max`.
 *
 * Values are clamped at zero (a negative segment can't eat its neighbour) and
 * `max <= 0` is treated as 1 so an all-zero bar renders empty instead of NaN.
 * Returns one `[start, end)` pair per segment, clamped into `0..cols` and
 * non-decreasing.
 */
export function segmentBounds(
  values: number[],
  max: number,
  cols: number,
): [number, number][] {
  const total = max > 0 ? max : 1;
  const out: [number, number][] = [];
  let cumulative = 0;
  let start = 0;
  for (const v of values) {
    cumulative += Math.max(0, v);
    const end = Math.max(start, Math.min(cols, Math.round((cumulative / total) * cols)));
    out.push([start, end]);
    start = end;
  }
  return out;
}
