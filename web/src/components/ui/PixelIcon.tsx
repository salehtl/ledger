// frontend/src/components/ui/PixelIcon.tsx
//
// Vendored pixel-art icons — mirrors how `components/dither-kit/` is vendored:
// source we own, generated from a devDependency, not a runtime import. See
// `pixelIcons.ts` for provenance and `scripts/generate-pixel-icons.mjs` for
// how to regenerate it.
//
// Native grid: every pixelarticons glyph is drawn in a 24×24 SVG viewBox on a
// 2-unit cell, i.e. an effective 12×12 pixel-art grid. Pass `size` as a whole
// multiple of 12 (12, 24, 36, 48, …) wherever the call site can — anything
// else lands a grid line on a fractional device pixel and blurs the pixel
// edges that are the entire point of this pack.
//
// Colour is `currentColor` only — never pass `fill`/`color`/a `style.color`
// override. Every call site relies on `text-fg` / `text-muted` /
// `text-accent-fg` cascading in from an ancestor.
import type { ReactElement, SVGProps } from "react";
import { PIXEL_ICON_PATHS, type PixelIconName } from "./pixelIcons";

export interface PixelIconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
}

/** A rendered pixel icon component — the drop-in replacement for lucide-react's `LucideIcon` type. */
export type PixelIconType = (props: PixelIconProps) => ReactElement;

/**
 * Mirrors lucide-react's own default: an icon is `aria-hidden` unless the
 * caller already gave it an accessible identity (an `aria-*` prop, `role`, or
 * `title`) — e.g. `PullToRefreshIndicator`'s `role="status" aria-label="Refreshing"`
 * spinner, which must stay in the accessibility tree, not be hidden from it.
 */
function hasA11yProp(props: Record<string, unknown>): boolean {
  for (const key in props) {
    if (key.startsWith("aria-") || key === "role" || key === "title") return true;
  }
  return false;
}

function makeIcon(name: PixelIconName): PixelIconType {
  const markup = PIXEL_ICON_PATHS[name];
  function Icon({ size = 24, style, ...rest }: PixelIconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ imageRendering: "pixelated", ...style }}
        {...(!hasA11yProp(rest) && { "aria-hidden": true })}
        {...rest}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    );
  }
  Icon.displayName = `PixelIcon(${name})`;
  return Icon;
}

export const Home = makeIcon("Home");
export const Search = makeIcon("Search");
export const Plus = makeIcon("Plus");
export const X = makeIcon("X");
export const Check = makeIcon("Check");
export const CheckCircle2 = makeIcon("CheckCircle2");
export const CheckCircle = makeIcon("CheckCircle");
export const Trash2 = makeIcon("Trash2");
export const Download = makeIcon("Download");
export const Archive = makeIcon("Archive");
export const ArchiveRestore = makeIcon("ArchiveRestore");
export const Inbox = makeIcon("Inbox");
export const FolderKanban = makeIcon("FolderKanban");
export const Link2 = makeIcon("Link2");
export const Link2Off = makeIcon("Link2Off");
export const Settings = makeIcon("Settings");
export const SlidersHorizontal = makeIcon("SlidersHorizontal");
export const Tag = makeIcon("Tag");
export const ListOrdered = makeIcon("ListOrdered");
export const PieChart = makeIcon("PieChart");
export const TrendingUp = makeIcon("TrendingUp");
export const ArrowLeftRight = makeIcon("ArrowLeftRight");
export const ArrowUp = makeIcon("ArrowUp");
export const ArrowDown = makeIcon("ArrowDown");
export const ArrowLeft = makeIcon("ArrowLeft");
export const ArrowRight = makeIcon("ArrowRight");
export const ChevronLeft = makeIcon("ChevronLeft");
export const ChevronRight = makeIcon("ChevronRight");
export const ChevronDown = makeIcon("ChevronDown");
export const EyeOff = makeIcon("EyeOff");
export const AlertTriangle = makeIcon("AlertTriangle");
export const TriangleAlert = makeIcon("TriangleAlert");
export const Loader2 = makeIcon("Loader2");
export const Heart = makeIcon("Heart");
export const PiggyBank = makeIcon("PiggyBank");
