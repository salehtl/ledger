/**
 * The measurement protocol: thermal gating, arm counterbalancing, and which
 * passes count.
 *
 * All of it is pure decision logic, separated from {@link ../bench/arms.ts} for
 * the reason `client/src`'s `lib/` exists: a rule that lives inside a screen is a
 * rule nothing tests, and every one of these was put here because getting it
 * wrong silently produces a number that looks fine.
 *
 * # Thermal
 *
 * Phase 0 recorded "thermal state: not measured" and named it as a gap. The
 * control arm alone is 5 x 3,683 x ~15 ms ~= 274 SECONDS of continuous BigInt per
 * arm, which guarantees throttling WITHIN the arm, not merely between arms — so
 * the median becomes a throttling artifact rather than a measurement.
 *
 * "Force-quit and relaunch between arms", which an earlier draft of the plan
 * offered as the control, does not cool a phone. A process restart frees memory;
 * it does not move heat. What moves heat is time with the screen off, so:
 *
 *  - {@link shouldDiscardPass}: a pass that STARTS at anything other than
 *    `.nominal` is discarded and re-run.
 *  - {@link cooldownTarget}: between passes and between arms, idle screen-off
 *    until `.nominal`, floor 120 s, and RECORD the wait.
 *  - A pass that ENDS at `.serious` or `.critical` marks the whole run
 *    thermally-compromised (see {@link runIsCompromised}), which caps the verdict
 *    at CONDITIONAL.
 *
 * # Counterbalancing
 *
 * A fixed arm order systematically advantages whichever arm runs first on a cool
 * device. {@link armOrderForPass} alternates the order across passes so the
 * advantage cancels rather than accumulating, and the realised order is recorded
 * in the report so a reader can check it rather than take it on trust.
 */

export type ThermalState = "nominal" | "fair" | "serious" | "critical" | "unknown";

export const THERMAL_ORDER: ThermalState[] = ["nominal", "fair", "serious", "critical"];

/** The floor on cooldown even when the device already reads `.nominal`. */
export const COOLDOWN_FLOOR_MS = 120_000;

/** Timed passes per arm. Pass 1 is reported separately; see {@link medianOf}. */
export const PASSES = 5;

/** Records opened in the discarded warm-up before the timed passes. */
export const WARMUP_RECORDS = 250;

export type ArmName = "noble" | "noopOne" | "noopBatch" | "nativeOne" | "nativeBatch" | "quickCrypto";

/** The arms, in their canonical order. `quickCrypto` is optional (Decision 1). */
export const ARMS: ArmName[] = ["noble", "noopOne", "noopBatch", "nativeOne", "nativeBatch"];

/**
 * A pass that begins above `.nominal` is not a measurement of the code.
 *
 * `unknown` is treated as NOT nominal on purpose. A device whose thermal state
 * cannot be read is a device whose thermal state is unknown, and the whole point
 * of this gate is that Phase 0's unmeasured things stopped being inherited as
 * settled.
 */
export function shouldDiscardPass(startState: ThermalState): boolean {
  return startState !== "nominal";
}

/** A pass ending here or above compromises the whole run. */
export function passCompromisesRun(endState: ThermalState): boolean {
  return endState === "serious" || endState === "critical" || endState === "unknown";
}

export interface PassRecord {
  arm: ArmName;
  pass: number;
  ms: number;
  thermalBefore: ThermalState;
  thermalAfter: ThermalState;
  cooldownMs: number;
  records: number;
  /** Peak phys_footprint during the pass, from the native task_info instrument. */
  peakRssBytes: number | null;
  /** Set when the arm was killed and re-run over a subsample (Step 6b). */
  subsampled: boolean;
}

export function runIsCompromised(passes: PassRecord[]): boolean {
  return passes.some((p) => passCompromisesRun(p.thermalAfter));
}

/**
 * How long to wait before the next pass.
 *
 * The floor is not negotiable even at `.nominal`: `thermalState()` is coarse and
 * a device can read nominal while still shedding heat from the previous 55-second
 * arm. Above nominal, the caller keeps polling — this returns the MINIMUM.
 */
export function cooldownTarget(currentState: ThermalState): { minMs: number; waitForNominal: boolean } {
  return { minMs: COOLDOWN_FLOOR_MS, waitForNominal: currentState !== "nominal" };
}

/**
 * The arm order for a given pass: forward on odd passes, reversed on even ones.
 *
 * With five passes and two orders the split is 3/2 rather than perfectly even.
 * That is stated rather than hidden — a perfectly balanced design needs an even
 * pass count, and the plan specifies five. The residual bias is one pass's worth
 * and it favours the arm listed FIRST, which is the control; biasing against the
 * native arm is the safe direction for a gate.
 */
export function armOrderForPass(pass: number, arms: ArmName[] = ARMS): ArmName[] {
  return pass % 2 === 1 ? [...arms] : [...arms].reverse();
}

/** Every realised order, for the report. */
export function counterbalanceSchedule(passes: number = PASSES, arms: ArmName[] = ARMS): ArmName[][] {
  return Array.from({ length: passes }, (_, i) => armOrderForPass(i + 1, arms));
}

/**
 * The median of a set of passes.
 *
 * Pass 1 is INCLUDED here and reported separately by the caller. Phase 0's Run 1
 * was 12% above its median and the discard its protocol called for never
 * happened; the fix is a discarded warm-up (see {@link WARMUP_RECORDS}) plus
 * visibility, not silently dropping a real reading.
 */
export function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface Spread {
  min: number;
  max: number;
  median: number;
  /** (max - min) / median, the figure Phase 0 should have reported and did not. */
  relativeSpread: number;
}

export function spreadOf(values: number[]): Spread {
  const median = medianOf(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max, median, relativeSpread: median > 0 ? (max - min) / median : NaN };
}

/**
 * The reduced-N fallback ladder for a control arm that gets jetsammed.
 *
 * An iPhone 11 has 4 GB of RAM and Phase 0's pre-fix build was jetsam-adjacent at
 * >500 MB on a NEWER phone. The control arm allocates ~6.7 GB and triggers ~1,643
 * GCs per pass. If `@noble` is killed there is no within-device ratio, which is
 * the entire point of the control — so the degradation is decided here rather
 * than improvised at 11pm.
 *
 * Every 7th record, deterministically, so the subsample is reproducible and is
 * not the first 500 records (which would be a contiguous slice of one date range
 * and one merchant mix).
 */
export const NOBLE_SUBSAMPLE_LADDER = [500, 100];
export const SUBSAMPLE_STRIDE = 7;

export function subsampleIndices(n: number, want: number, stride = SUBSAMPLE_STRIDE): number[] {
  const out: number[] = [];
  for (let i = 0; i < n && out.length < want; i += stride) out.push(i);
  // A stride that does not reach `want` in one sweep continues from an offset
  // rather than giving up short: a subsample smaller than requested would make
  // the linear scale-up wrong by a factor nobody would notice.
  for (let off = 1; off < stride && out.length < want; off++) {
    for (let i = off; i < n && out.length < want; i += stride) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Scales a subsampled control measurement up to the full corpus.
 *
 * Linear is defensible for this workload because per-blob cost is independent —
 * Phase 0's own per-blob figure is a straight division. It is still an
 * EXTRAPOLATION and {@link ../bench/verdict.ts}'s `nobleSubsampleSize` carries
 * that into the verdict as a CONDITIONAL trigger.
 */
export function scaleSubsample(msForSubsample: number, subsampleSize: number): number {
  if (subsampleSize <= 0) throw new Error("subsample size must be positive");
  return msForSubsample / subsampleSize;
}
