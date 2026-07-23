// Pure geometry for the RollingNumber (odometer) display: a formatted number
// split into per-character cells, wheel offsets for digit columns, and the
// scale-down-to-fit factor for oversized values.

export type NumberCell = {
  /** React key, counted from the RIGHT end of the string. */
  key: number;
  char: string;
  /** 0–9 for digit cells (rendered as a rolling wheel); null for static chars. */
  digit: number | null;
};

// Cells are keyed from the right so trailing digits keep identity when the
// integer part grows ("999.99" → "1,000.00" rolls the cents wheels instead of
// remounting them).
export function numberCells(text: string): NumberCell[] {
  const chars = [...text];
  return chars.map((char, i) => ({
    key: chars.length - i,
    char,
    digit: char >= "0" && char <= "9" ? Number(char) : null,
  }));
}

// The wheel track stacks digits 0–9, each 1/10 of the track's height, so the
// offset is a percentage of the track itself — no pixel measurement needed.
export function wheelOffsetPct(digit: number): number {
  return digit * -10;
}

// Shrink (never grow) so contentPx fits containerPx, floored at minScale so a
// pathological value stays legible and clips rather than vanishing. Zero-sized
// inputs mean layout hasn't happened yet — leave the scale alone.
export function fitScale(containerPx: number, contentPx: number, minScale = 0.5): number {
  if (containerPx <= 0 || contentPx <= 0) return 1;
  return Math.max(minScale, Math.min(1, containerPx / contentPx));
}
