import { describe, expect, it } from "vitest";
import { FEEDBACK_KINDS, SOUND_SPECS, specDuration } from "./soundSpec";

describe("SOUND_SPECS", () => {
  it("has a recipe for every feedback kind", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(SOUND_SPECS[kind].voices.length).toBeGreaterThan(0);
    }
  });

  it("every voice is well-formed and audible", () => {
    for (const kind of FEEDBACK_KINDS) {
      for (const v of SOUND_SPECS[kind].voices) {
        // Frequencies within the audible band.
        expect(v.freq).toBeGreaterThan(20);
        expect(v.freq).toBeLessThan(20000);
        if (v.endFreq !== undefined) {
          expect(v.endFreq).toBeGreaterThan(20);
          expect(v.endFreq).toBeLessThan(20000);
        }
        // Envelope is real: positive gain and non-zero duration.
        expect(v.gain).toBeGreaterThan(0);
        expect(v.gain).toBeLessThanOrEqual(1);
        expect(v.start).toBeGreaterThanOrEqual(0);
        expect(v.attack).toBeGreaterThan(0);
        expect(v.decay).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every UI sound short (<= 1s)", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(specDuration(SOUND_SPECS[kind])).toBeLessThanOrEqual(1);
    }
  });
});

describe("specDuration", () => {
  it("is the latest voice end across start+attack+decay", () => {
    expect(
      specDuration({
        voices: [
          { type: "sine", freq: 440, start: 0, gain: 0.5, attack: 0.01, decay: 0.1 },
          { type: "sine", freq: 660, start: 0.2, gain: 0.5, attack: 0.01, decay: 0.1 },
        ],
      }),
    ).toBeCloseTo(0.31);
  });
});
