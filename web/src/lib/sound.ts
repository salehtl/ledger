// Device-local UI sound, synthesized in real time via the Web Audio API — no
// audio files (keeps the embedded bundle clean, matching lib/haptics.ts).
// Persisted per browser in localStorage, defaulting OFF: unexpected audio is
// jarring, so the user opts in. Fired synchronously from user-gesture handlers.

import { SOUND_SPECS, specDuration, type FeedbackKind } from "./soundSpec";

const STORAGE_KEY = "ledger-sound";
const MASTER_GAIN = 0.18; // gentle overall level

let enabled = false;

export function loadSoundEnabled(): boolean {
  try {
    // Default off: only an explicit "true" enables.
    enabled = localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    enabled = false;
  }
  return enabled;
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, String(on));
  } catch {
    // Storage unavailable (private mode): flag still applies this session.
  }
}

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;

/** Lazily create/resume the shared AudioContext, or null if unsupported. */
function ensureContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx: Ctor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) {
    try {
      ctx = new Ctx();
    } catch {
      return null;
    }
  }
  // First user gesture may be needed to move out of "suspended".
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Play a synthesized sound. No-op when disabled or unsupported. Call synchronously. */
export function play(kind: FeedbackKind) {
  if (!enabled) return;
  const audio = ensureContext();
  if (!audio) return;

  const spec = SOUND_SPECS[kind];
  const t0 = audio.currentTime;

  const master = audio.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(audio.destination);

  for (const v of spec.voices) {
    const start = t0 + v.start;
    const peak = start + v.attack;
    const end = peak + v.decay;

    const osc = audio.createOscillator();
    osc.type = v.type;
    osc.frequency.setValueAtTime(v.freq, start);
    if (v.endFreq !== undefined) {
      osc.frequency.linearRampToValueAtTime(v.endFreq, end);
    }

    const g = audio.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(v.gain, peak);
    g.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(end + 0.02);
  }

  // Let the whole graph fall out of scope after the sound finishes; nodes are
  // one-shot and disconnect themselves once stopped.
  void specDuration(spec);
}
