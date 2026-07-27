#!/usr/bin/env node
// frontend/scripts/generate-pixel-icons.mjs
//
// Regenerates `src/components/ui/pixelIcons.ts` from the raw SVGs shipped by
// the `pixelarticons` devDependency (frontend/node_modules/pixelarticons/svg).
//
// Run it after bumping the pixelarticons version, or after adding a new alias
// to the ICONS map below:
//
//   cd frontend && bun run generate:icons
//
// Each key of ICONS is a pixelarticons source icon (its .svg filename, minus
// the extension); each value is every app-facing export name backed by that
// glyph (usually the lucide-react name it replaces — see
// docs/superpowers/sdd/2026-07-27-ui-overhaul-two-color-press/task-icons-report.md
// for the full mapping and every substitution's reasoning). Multiple aliases
// on one source icon are deliberate (e.g. AlertTriangle + TriangleAlert both
// read as warning-diamond in lucide too).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SVG_DIR = join(__dirname, "../node_modules/pixelarticons/svg");
const OUT_FILE = join(__dirname, "../src/components/ui/pixelIcons.ts");
const PKG = JSON.parse(
  readFileSync(join(__dirname, "../node_modules/pixelarticons/package.json"), "utf8"),
);

const ICONS = {
  "home": ["Home"],
  "search": ["Search"],
  "plus": ["Plus"],
  "close": ["X"],
  "check": ["Check"],
  "check-double": ["CheckCircle2", "CheckCircle"],
  "trash": ["Trash2"],
  "download": ["Download"],
  "archive": ["Archive"],
  "undo": ["ArchiveRestore"],
  "inbox": ["Inbox"],
  "folder": ["FolderKanban"],
  "link": ["Link2"],
  "unlink": ["Link2Off"],
  // settings-cog has a <defs>/<clipPath id="a"> pair; settings-cog-2 draws the
  // same gear with plain paths, so it's the safe pick for a component that may
  // render more than once per page (duplicate SVG ids are invalid HTML).
  "settings-cog-2": ["Settings"],
  "filter": ["SlidersHorizontal"],
  "bookmark": ["Tag"],
  "list-box": ["ListOrdered"],
  "analytics": ["PieChart"],
  // No trending-up glyph in the pack. TrendingUp's one call site (Home.tsx's
  // VERDICT_ICON) sits beside Check/AlertTriangle as a plain direction cue, so
  // it shares arrow-up with ArrowUp rather than chart-bar-big.
  "arrow-up": ["ArrowUp", "TrendingUp"],
  "arrow-down": ["ArrowDown"],
  "arrow-left": ["ArrowLeft"],
  // ArrowRight has no lucide call site today, but SwipePage's four direction
  // glyphs need all four arrows, and the app had been rendering "→" as text.
  "arrow-right": ["ArrowRight"],
  "arrows-horizontal": ["ArrowLeftRight"],
  "chevron-left": ["ChevronLeft"],
  "chevron-right": ["ChevronRight"],
  "chevron-down": ["ChevronDown"],
  "eye-off": ["EyeOff"],
  "warning-diamond": ["AlertTriangle", "TriangleAlert"],
  "loader": ["Loader2"],
  // Not in the brief's table (lucide names beyond the 32 originally audited),
  // found while migrating the swipe deck's category glyphs.
  "heart": ["Heart"],
  // No piggy-bank glyph in the pack; `save` (a floppy disk) reads as "this
  // action is Save", which matches the swipe bucket's own label.
  "save": ["PiggyBank"],
};

function extractInner(svg) {
  const match = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!match) throw new Error("could not parse svg wrapper");
  return match[1].trim().replace(/\s+/g, " ");
}

const entries = [];
for (const [iconFile, aliases] of Object.entries(ICONS)) {
  const raw = readFileSync(join(SVG_DIR, `${iconFile}.svg`), "utf8");
  const inner = extractInner(raw);
  for (const alias of aliases) entries.push([alias, inner]);
}
entries.sort(([a], [b]) => a.localeCompare(b));

const header = `// GENERATED FILE — do not hand-edit.
// Produced by \`node scripts/generate-pixel-icons.mjs\` from
// pixelarticons@${PKG.version} (frontend/node_modules/pixelarticons/svg/*.svg).
// To add, rename, or re-point an icon: edit the ICONS map in that script, then
// re-run it — don't add entries here by hand, they'll be clobbered.
//
// Each value is the inner <path>/<g> markup of the source SVG (paths only).
// The 24×24 viewBox, \`fill="currentColor"\`, and sizing wrapper live in
// PixelIcon.tsx, not here.
`;

const body =
  `export const PIXEL_ICON_PATHS = {\n` +
  entries.map(([name, inner]) => `  ${name}: ${JSON.stringify(inner)},`).join("\n") +
  `\n} as const;\n\nexport type PixelIconName = keyof typeof PIXEL_ICON_PATHS;\n`;

writeFileSync(OUT_FILE, header + "\n" + body);
console.log(`Wrote ${entries.length} icon exports (from ${Object.keys(ICONS).length} source glyphs) to ${OUT_FILE}`);
