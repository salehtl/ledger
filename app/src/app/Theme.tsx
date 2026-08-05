/**
 * Design tokens, and the mobile conventions every screen is measured against.
 *
 * This is the app's equivalent of `frontend/src/lib/motion.ts` plus the
 * conventions half of `frontend/src/components/README.md`: **one place** for
 * every colour, space, radius, type size and duration, so no component carries
 * a literal. The v1 codebase enforces that with a lint-shaped test; the same
 * rule applies here and `app/src/components/README.md` records it.
 *
 * Light and dark are both first-class. React Native gives us
 * `useColorScheme()` rather than a media query, so the switch is explicit.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";

/**
 * The two numbers that are not taste.
 *
 * `TOUCH_TARGET_MIN` is Apple's 44 pt minimum — a control smaller than this is
 * a bug, not a style. `INPUT_FONT_MIN` is 16 pt because anything smaller makes
 * iOS Safari zoom on focus; React Native does not have that behaviour, but the
 * v1 harness found real legibility problems below it and the convention is kept
 * so the two front ends agree.
 */
export const TOUCH_TARGET_MIN = 44;
export const INPUT_FONT_MIN = 16;

export interface Palette {
  /** Page background. */
  bg: string;
  /** Raised surface — cards, sheets, rows. */
  surface: string;
  /** A hairline between rows; never a full-weight border. */
  hairline: string;
  /** Primary text. */
  text: string;
  /** Secondary text: labels, timestamps, units. */
  textMuted: string;
  /** The one accent. */
  accent: string;
  /** Money leaving. */
  debit: string;
  /** Money arriving. */
  credit: string;
  /** Something is wrong and the user must act. */
  danger: string;
  /** Something is held or unverified — the quarantine lane's colour. */
  warning: string;
}

const light: Palette = {
  bg: "#f6f6f4",
  surface: "#ffffff",
  hairline: "#e4e4e0",
  text: "#16161a",
  textMuted: "#6b6b73",
  accent: "#2f5fd8",
  debit: "#16161a",
  credit: "#1f7a45",
  danger: "#b3261e",
  warning: "#8a5a00",
};

const dark: Palette = {
  bg: "#0f0f11",
  surface: "#1a1a1e",
  hairline: "#2a2a30",
  text: "#f2f2f0",
  textMuted: "#9a9aa3",
  accent: "#7ba0ff",
  debit: "#f2f2f0",
  credit: "#5fd196",
  danger: "#ff8b82",
  warning: "#e0b055",
};

/** A 4 pt grid. Named, so a screen never writes `marginTop: 13`. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

/**
 * Type scale. `body` is the floor for anything a user reads and `input` is
 * pinned to {@link INPUT_FONT_MIN}.
 */
export const type = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "700" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "600" },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 22, fontWeight: "400" },
  input: { fontSize: INPUT_FONT_MIN, lineHeight: 22, fontWeight: "400" },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: "400", fontFamily: "Menlo" },
  /**
   * The inbound address, and nothing else.
   *
   * A 26-character base32 local part is the hardest string in this product to
   * read: no word shapes, no rhythm, and `0`/`O` and `1`/`l` next to each other.
   * {@link type.mono} is 13 pt because it labels things; this is 20 pt because
   * somebody may have to read it aloud or copy it onto a laptop by eye when the
   * QR is not an option. Monospaced so the columns line up while they do.
   */
  address: { fontSize: 20, lineHeight: 28, fontWeight: "500", fontFamily: "Menlo" },
} as const;

/**
 * Motion. **Every duration in the app comes from here** — v1's `lib/motion.ts`
 * exists because durations scattered through components drift into a UI where
 * nothing shares a rhythm, and a 300 ms ceiling is enforced by a test there.
 * The same ceiling applies: nothing a user waits on animates for longer.
 *
 * Reduced motion is honoured globally rather than per component (v1 uses
 * `MotionConfig reducedMotion="user"`; React Native's equivalent is
 * `AccessibilityInfo.isReduceMotionEnabled`, wired when the first real
 * animation lands).
 */
export const motion = {
  /** State change on a control the finger is already on. */
  instant: 120,
  /** The default: a sheet, a row, a fade. */
  base: 200,
  /** A full-screen transition. The ceiling. */
  screen: 300,
} as const;

export interface Theme {
  colors: Palette;
  scheme: "light" | "dark";
  space: typeof space;
  radius: typeof radius;
  type: typeof type;
  motion: typeof motion;
}

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const value = useMemo<Theme>(
    () => ({ colors: scheme === "dark" ? dark : light, scheme, space, radius, type, motion }),
    [scheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Throws outside a provider rather than returning a silent default. */
export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (t === null) throw new Error("useTheme() outside <ThemeProvider> — wrap the tree in app/src/app/Root.tsx");
  return t;
}

/** The palettes, for tests and for `NavigationContainer`'s theme. */
export const palettes = { light, dark } as const;
