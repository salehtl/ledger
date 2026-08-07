// Unified interaction feedback: one fire(kind) drives both haptic and sound,
// each independently toggleable. Call sites import from here (not haptics/sound
// directly) so the two channels stay in sync and can't drift.

import { fire as fireHaptic, type Haptic } from "./haptics";
import { play as playSound } from "./sound";
import type { FeedbackKind } from "./soundSpec";

export type { FeedbackKind } from "./soundSpec";

// Re-export each channel's on/off + hydrate so Settings/main.tsx have one import.
export {
  loadHapticsEnabled,
  isHapticsEnabled,
  setHapticsEnabled,
} from "./haptics";
export { loadSoundEnabled, isSoundEnabled, setSoundEnabled } from "./sound";

/** Which haptic (if any) a feedback kind maps to. Sound covers all kinds. */
export const HAPTIC_FOR: Record<FeedbackKind, Haptic | null> = {
  selection: "selection",
  light: "light",
  toggle: "selection",
  navigation: "light",
  success: "success",
  warning: "warning",
  error: "warning",
  milestone: "success",
};

/**
 * Fire interaction feedback. Runs both channels synchronously (the iOS haptic
 * trick requires firing before any await) — each is an independent no-op when
 * its channel is disabled or unsupported.
 */
export function fire(kind: FeedbackKind) {
  const haptic = HAPTIC_FOR[kind];
  if (haptic) fireHaptic(haptic);
  playSound(kind);
}
