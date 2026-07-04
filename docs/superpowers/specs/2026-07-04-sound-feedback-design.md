# Sound feedback — design

**Date:** 2026-07-04
**Status:** approved (decisions delegated by user), pending user's ear-review of the synthesized sounds

## Goal

Add procedurally-synthesized UI sounds to the PWA, mimicking
[sensory-ui.com](https://www.sensory-ui.com/#showcase): gentle, semantic audio
generated in real time via the Web Audio API. **No audio files** — this keeps
the `embed.FS` bundle clean and matches how `lib/haptics.ts` already works
(zero assets, pure runtime synthesis).

## Decisions

| Question | Answer |
|---|---|
| Scope | **Full palette** — taps, toggles, navigation, notification states, milestone |
| Relationship to haptics | **Unified feedback layer** — one `fire(kind)` drives both haptic + sound, each independently toggleable |
| Synthesis | **Web Audio API, procedural.** No files, no latency (matches sensory-ui) |
| Default state | **Off.** Unexpected audio is jarring; user opts in. (Haptics stays default-on.) |
| Preference gating | Own Settings toggle next to Haptics + own `localStorage` key. Not gated on `prefers-reduced-motion` (sound has its own explicit opt-in). |

## Architecture

Three pure/thin layers under `frontend/src/lib/`, mirroring the existing
`haptics.ts` convention (pure decision logic extracted, thin runtime wrapper):

```
components / hooks / screens
        │  fire(kind)
        ▼
  lib/feedback.ts        ← orchestrator: kind → haptic + sound, per-channel enable
        ├──────────────► lib/haptics.ts   (existing haptic engine, unchanged API)
        └──────────────► lib/sound.ts      (new Web Audio player + on/off + persistence)
                                │  reads
                                ▼
                         lib/soundSpec.ts   (new PURE synth recipes — unit-tested)
```

- **`lib/soundSpec.ts`** — pure, framework-free. Exports `FEEDBACK_KINDS` and
  `SOUND_SPECS: Record<Kind, SoundSpec>`. A `SoundSpec` is a plain data
  description of one or more *voices* (oscillator type, start/end frequency,
  gain-envelope attack/decay, start offset, duration). No Web Audio calls — so
  every recipe is unit-testable (assert timbre, pitch, timing, structure). This
  is where the "sound design" lives and where we'll tune after listening.
- **`lib/sound.ts`** — the player. Lazily creates one shared `AudioContext` on
  first use (autoplay policy: first call happens inside a user gesture), reads a
  `SoundSpec`, and schedules `OscillatorNode → GainNode → master` per voice.
  Owns `loadSoundEnabled()/isSoundEnabled()/setSoundEnabled()` against
  `localStorage["ledger-sound"]` (default off), exactly parallel to haptics.
  A low master gain (~0.18) keeps everything gentle. No-op when disabled or when
  `AudioContext` is unavailable (SSR/tests).
- **`lib/feedback.ts`** — the single public entry point call sites use.
  `fire(kind)` fires the mapped haptic (if haptics on) and the sound (if sound
  on), both synchronously so the iOS haptic trick still works. Re-exports the
  enable/disable/hydrate functions for both channels.

### Feedback kinds & mapping

Superset of today's four haptic kinds. Haptics only covers the tactile subset;
sound covers all. `feedback.fire` maps each kind to a `Haptic` (or none):

| Kind | Sound (character) | Haptic |
|---|---|---|
| `selection` | soft tick (~1.8 kHz, ~30 ms) | `selection` |
| `light` | softer tap (~1.2 kHz) | `light` |
| `toggle` | tick with a lower "tock" partner | `selection` |
| `navigation` | short rising sweep (600→1200 Hz) | `light` |
| `success` | two ascending notes (pleasant) | `success` |
| `warning` | two dull pulses (~400 Hz) | `warning` |
| `error` | descending 400→200 Hz, slightly buzzy | `warning` |
| `milestone` | ascending C–E–G bell arpeggio, longer decay | `success` |

Exact frequencies/envelopes are the tunable part — subject to the ear-review.

## Call-site changes

Swap `import { fire } from ".../lib/haptics"` → `.../lib/feedback` at the seven
existing sites (Button, Fab, SegmentedControl, BottomNav, SwipeDeck,
usePullToRefresh, SettingsHub). Existing kinds keep working unchanged. Two
opportunistic upgrades to use the richer palette:

- `BottomNav` tab tap: `selection` → `navigation`.
- `SwipeDeck` confirm (currently `success`): keep `success`; reserve `milestone`
  for a genuine milestone moment later (out of scope now).

`main.tsx` hydrates the sound flag alongside haptics: `loadSoundEnabled()`.

## Settings UI

Add a "Sound" `ToggleRow` under the **Device** group in `SettingsHub`,
immediately after "Haptics", using the same pattern. Turning it on fires a
confirming `fire("selection")` so the user hears the result immediately.

## Testing

- `lib/soundSpec.test.ts` — assert each kind has a spec, voices have valid
  frequencies/durations, envelopes are well-formed, timings are positive.
- `lib/feedback.test.ts` — kind→haptic mapping; verify `fire` respects each
  channel's enabled flag independently (mock haptics + sound modules); enable/
  hydrate/persist round-trips against a mocked `localStorage`.
- `lib/sound.ts` player is thin and Web-Audio-bound; not unit-tested directly
  (guarded no-op without `AudioContext`). Behavior verified by ear in-app.

## Out of scope (YAGNI)

- Per-category sound volume/mix controls (single global toggle for now).
- A distinct milestone trigger (kind exists; no caller yet).
- Sound theme/pack selection.
