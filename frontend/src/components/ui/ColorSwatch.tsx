import { projectColor } from "../../lib/paletteColor";

/**
 * The project colour mark: a hairline square in the project's hue, hatched
 * with 45° lines of that same hue.
 *
 * It was an empty outline, which at 10px left the hue as four hairlines and a
 * hole — the box read as "grey box" long before it read as "blue". The hatch
 * roughly triples the inked area so the hue is legible at a glance, while
 * still keeping the mark a *drawn* one rather than a fill: rows elsewhere
 * carry solid bucket dots in the same palette, and form is what tells the two
 * apart at identical hue. Lines rather than a tint because this design has no
 * tints — everything is ink on paper at full strength.
 *
 * `size` follows the two places it appears: `md` beside a project name in a
 * card or list header, `sm` inline in a transaction row's meta line. The
 * hatch pitch tightens with the box so both keep two visible lines.
 *
 * Always `aria-hidden`: every call site prints the project name next to it, so
 * the colour is decoration, never the sole carrier of identity.
 */
export function ColorSwatch({ color, size = "md", className = "" }: {
  /** Stored project colour — a palette name, a legacy hex, or null (→ neutral). */
  color?: string | null;
  /** `md` = 10px (card/header), `sm` = 6px (inline in a row). */
  size?: "sm" | "md";
  className?: string;
}) {
  const hue = projectColor(color);
  const box = size === "sm" ? "w-1.5 h-1.5" : "w-2.5 h-2.5";
  const pitch = size === "sm" ? "2px" : "3px";
  return (
    <span
      aria-hidden
      data-swatch={size}
      className={`inline-block shrink-0 rounded-[var(--radius)] border ${box} ${className}`}
      style={{
        borderColor: hue,
        backgroundImage: `repeating-linear-gradient(45deg, ${hue} 0 1px, transparent 1px ${pitch})`,
      }}
    />
  );
}
