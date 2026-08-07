import { useSyncExternalStore } from "react";
import { isDarkTheme, subscribeDitherTheme } from "../components/dither-kit/palette";

/**
 * True when the OS is in dark mode. Dither canvases paint raw RGB rather than
 * CSS vars, so they cannot repaint on a theme flip by themselves — components
 * call this and feed the result into a `key` or `replayToken` to force a repaint.
 */
export function useDitherTheme(): boolean {
  return useSyncExternalStore(
    subscribeDitherTheme,
    isDarkTheme,
    () => false, // server / no matchMedia: assume light
  );
}
