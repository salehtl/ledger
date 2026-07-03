// Device-local text scale. Persisted per browser (localStorage, like the swipe
// config) and applied as a root font-size percentage, so every rem-based
// Tailwind size scales with it. Fixed-pixel outliers (chart tick labels)
// deliberately stay put.

const STORAGE_KEY = "ledger-font-scale";

export const FONT_SCALE_OPTIONS = [80, 85, 90, 95, 100] as const;
export type FontScale = (typeof FONT_SCALE_OPTIONS)[number];
export const DEFAULT_FONT_SCALE: FontScale = 100;

export function isFontScale(n: unknown): n is FontScale {
  return typeof n === "number" && (FONT_SCALE_OPTIONS as readonly number[]).includes(n);
}

export function loadFontScale(): FontScale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_FONT_SCALE;
    const n = Number(raw);
    return isFontScale(n) ? n : DEFAULT_FONT_SCALE;
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}

export function saveFontScale(scale: FontScale) {
  try {
    localStorage.setItem(STORAGE_KEY, String(scale));
  } catch {
    // Storage unavailable (e.g. private mode): the scale still applies this session.
  }
}

/** Sets the root font-size override; the default scale restores browser sizing. */
export function applyFontScale(scale: FontScale) {
  if (typeof document === "undefined") return;
  if (scale === DEFAULT_FONT_SCALE) document.documentElement.style.removeProperty("font-size");
  else document.documentElement.style.fontSize = `${scale}%`;
}
