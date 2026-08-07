import { isPaletteName } from "./paletteColor";

/**
 * CSS colour for a category's stored colour.
 *
 * A name rather than a hex, for the same reason projects store names: the
 * cascade re-resolves `var(--color-…)` per theme, so a colour that clears
 * contrast on paper also clears it on the dark ground without any consumer
 * subscribing to the theme.
 *
 * Unlike `projectColor` there is no legacy-hex branch — this column is new,
 * so a hex here is as unknown as any other bad value and takes the neutral.
 */
export function categoryColor(color: string | null | undefined): string {
  return isPaletteName(color) ? `var(--color-${color})` : "var(--color-slate)";
}
