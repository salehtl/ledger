// Pure, framework-free UI-sound recipes. No Web Audio calls live here — each
// entry is a plain data description of how to synthesize one gentle, semantic
// sound. lib/sound.ts reads these and schedules the actual oscillator nodes.
//
// Keeping the recipes as data makes them unit-testable (pitch, timing, timbre)
// and makes the "sound design" a single place to tune by ear.

export type FeedbackKind =
  | "selection"
  | "light"
  | "toggle"
  | "navigation"
  | "success"
  | "warning"
  | "error"
  | "milestone";

/** One synthesized voice: an oscillator with a gain envelope, offset in time. */
export interface Voice {
  type: OscillatorType;
  /** Start frequency in Hz. */
  freq: number;
  /** Optional end frequency — linearly ramps freq→endFreq over the voice. */
  endFreq?: number;
  /** Seconds after trigger before this voice begins. */
  start: number;
  /** Peak gain (0..1), pre master-gain. */
  gain: number;
  /** Envelope attack (s) to peak, then decay (s) back to silence. */
  attack: number;
  decay: number;
}

export interface SoundSpec {
  voices: Voice[];
}

/** Total wall-clock duration of a spec, for scheduling / cleanup. */
export function specDuration(spec: SoundSpec): number {
  return spec.voices.reduce(
    (max, v) => Math.max(max, v.start + v.attack + v.decay),
    0,
  );
}

const tick = (freq: number, gain = 0.9): Voice => ({
  type: "triangle",
  freq,
  start: 0,
  gain,
  attack: 0.002,
  decay: 0.045,
});

const note = (freq: number, start: number, gain = 0.7, decay = 0.14): Voice => ({
  type: "sine",
  freq,
  start,
  gain,
  attack: 0.004,
  decay,
});

export const SOUND_SPECS: Record<FeedbackKind, SoundSpec> = {
  // A crisp, gentle tap.
  selection: { voices: [tick(1800)] },
  // Softer, lower — for lightweight touches.
  light: { voices: [tick(1200, 0.7)] },
  // Tick with a lower "tock" partner an instant later.
  toggle: {
    voices: [tick(1700, 0.8), { ...tick(900, 0.6), start: 0.028 }],
  },
  // Short rising sweep — motion between screens.
  navigation: {
    voices: [
      { type: "sine", freq: 600, endFreq: 1200, start: 0, gain: 0.55, attack: 0.006, decay: 0.09 },
    ],
  },
  // Two ascending notes — pleasant confirmation.
  success: { voices: [note(660, 0), note(990, 0.09)] },
  // Two dull, low pulses — attention without alarm.
  warning: {
    voices: [
      { type: "triangle", freq: 400, start: 0, gain: 0.7, attack: 0.004, decay: 0.11 },
      { type: "triangle", freq: 400, start: 0.16, gain: 0.7, attack: 0.004, decay: 0.11 },
    ],
  },
  // Descending, slightly buzzy — something went wrong.
  error: {
    voices: [
      { type: "sawtooth", freq: 400, endFreq: 200, start: 0, gain: 0.45, attack: 0.004, decay: 0.22 },
    ],
  },
  // Ascending C–E–G bell arpeggio with a longer tail — a milestone.
  milestone: {
    voices: [
      note(523.25, 0, 0.6, 0.4),
      note(659.25, 0.1, 0.6, 0.4),
      note(783.99, 0.2, 0.6, 0.5),
    ],
  },
};

export const FEEDBACK_KINDS = Object.keys(SOUND_SPECS) as FeedbackKind[];
