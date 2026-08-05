/**
 * The Phase 2 gate's decision rule.
 *
 * # A PASS is not reachable, and that is an input rather than a result
 *
 * Decision 11: *"The oldest target device is a hard input, not a nice-to-have.
 * If the benchmark cannot be run on it, Task 1 cannot return PASS — only
 * CONDITIONAL or FAIL."* The rationale is that Phase 0's single largest caveat is
 * that its numbers came from the newest device in the house, and repeating that
 * mistake would make Task 1 a second provisional pass dressed as a real one.
 *
 * There is no floor device. The operator has one iPhone, their daily driver —
 * the same class of device Phase 0 used. So the ceiling on this gate is
 * CONDITIONAL before a single measurement is taken, and {@link decide} encodes
 * that as a floor on the verdict rather than as a branch someone can forget.
 * {@link PASS_IS_REACHABLE} is `false` and `verdict.test.ts` asserts that no
 * combination of inputs — not even zero milliseconds everywhere — produces PASS.
 *
 * Two consequences follow, and they are decisions, not opinions:
 *
 *  - **Fallback F1 (progressive, newest-window-first restore) is MANDATORY in
 *    Task 8**, not contingent on the numbers.
 *  - **Task 28's Gate B is a HARD STOP**, not a confirmation.
 *
 * Both are stated in {@link Verdict.consequences} so they travel with the number
 * instead of living in a plan file nobody re-reads.
 *
 * # The ordering is load-bearing
 *
 * FAIL wins over CONDITIONAL wins over PASS. An earlier draft of the plan listed
 * the branches without an order, so `T_crypto + T_rest = 12,000 ms` with
 * `T_paint = 1,500 ms` satisfied both FAIL and CONDITIONAL and the gate was not
 * decidable. {@link decide} evaluates in that order and stops at the first match.
 *
 * # Why 6 s and not the spec's 10 s
 *
 * `T_rest` here deliberately excludes everything RESULTS.md Caveat 9 lists as
 * unmeasured: causality and supersede resolution, per-entity version heads,
 * writer-chain verification over every blob, the quarantine lane, and §3.7's FX
 * conversion during replay. The 4 s difference is a reserve for those plus
 * device-to-device variance — and it is a judgement, not a measurement, which is
 * exactly why Task 1b exists. {@link substituteFold} folds Task 1b's measured
 * figure back in and re-runs this table, so a reserve that turns out to be wrong
 * changes the verdict instead of being quietly kept.
 */

/** No floor device exists, so the gate cannot return PASS. See the header. */
export const PASS_IS_REACHABLE = false;

export const FAIL_TOTAL_MS = 10_000;
export const FAIL_PAINT_MS = 2_000;
export const CONDITIONAL_TOTAL_MS = 6_000;
export const CONDITIONAL_PAINT_MS = 1_200;

/** Phase 0's per-blob control figure, for the implied-minimum-R line. */
export const PHASE0_NOBLE_MS_PER_BLOB = 14.86;

export type Branch = "FAIL" | "CONDITIONAL" | "PASS";

export interface GateInputs {
  /** ms per blob, control arm (`@noble`), on THIS device in THIS session. */
  cNobleMs: number;
  /** ms per blob, best native arm. */
  cNativeMs: number;
  /** Corpus record count. */
  n: number;
  /** fetch + decode + insert + aggregate + db-open, in ms. */
  tRestMs: number;
  /**
   * First paint against the RECORDING clock — a 240 fps screen recording,
   * tap-to-first-legible-number. NOT the `launchUptime`→`useLayoutEffect`
   * instrument, which starts after exec and dyld and ends before the GPU has
   * painted a pixel and therefore systematically under-reads.
   */
  tPaintRecordedMs: number;
  /** The instrument's reading, reported alongside as a decomposition only. */
  tPaintInstrumentMs: number | null;
  /** Was the run taken on the P2 floor device? There is none, so: false. */
  onFloorDevice: boolean;
  /** Did any pass end at `.serious` or `.critical`? */
  thermallyCompromised: boolean;
  /** If the control arm was subsampled after a jetsam kill, the sample size. */
  nobleSubsampleSize: number | null;
}

export interface Verdict {
  branch: Branch;
  /** The first matching rule's own words. */
  reason: string;
  /** Every rule that fired, in order, so nothing is hidden by the stop-at-first. */
  allTriggered: string[];
  tCryptoMs: number;
  tTotalMs: number;
  /** C_noble / C_native, within-device. */
  speedup: number;
  consequences: string[];
  caveats: string[];
}

/** ms per blob the native arm must reach for a given branch's total budget. */
export function impliedNativeMsPerBlob(budgetMs: number, tRestMs: number, n: number): number {
  return Math.max(0, (budgetMs - tRestMs) / n);
}

/**
 * The line the bench screen prints BEFORE the arms run, so the gate is legible
 * while it is happening rather than only afterwards.
 */
export function impliedMinimumLine(tRestMs: number, n: number, cNobleMs = PHASE0_NOBLE_MS_PER_BLOB): string {
  const condPer = impliedNativeMsPerBlob(CONDITIONAL_TOTAL_MS, tRestMs, n);
  const failPer = impliedNativeMsPerBlob(FAIL_TOTAL_MS, tRestMs, n);
  const r = (per: number) => (per <= 0 ? "unreachable" : `${(cNobleMs / per).toFixed(1)}x`);
  return (
    `T_rest ${Math.round(tRestMs)} ms over N=${n}: staying under the ${CONDITIONAL_TOTAL_MS} ms ` +
    `CONDITIONAL ceiling needs <= ${condPer.toFixed(3)} ms/blob (R ~ ${r(condPer)}); staying out of FAIL needs ` +
    `<= ${failPer.toFixed(3)} ms/blob (R ~ ${r(failPer)}). PASS is not reachable: no floor device (Decision 11).`
  );
}

export function decide(i: GateInputs): Verdict {
  const tCryptoMs = i.cNativeMs * i.n;
  const tTotalMs = tCryptoMs + i.tRestMs;
  const speedup = i.cNativeMs > 0 ? i.cNobleMs / i.cNativeMs : Number.POSITIVE_INFINITY;

  const failReasons: string[] = [];
  if (tTotalMs > FAIL_TOTAL_MS) {
    failReasons.push(
      `T_crypto + T_rest = ${Math.round(tTotalMs)} ms, over the ${FAIL_TOTAL_MS} ms gate`,
    );
  }
  if (i.tPaintRecordedMs > FAIL_PAINT_MS) {
    failReasons.push(`T_paint (recording clock) = ${Math.round(i.tPaintRecordedMs)} ms, over ${FAIL_PAINT_MS} ms`);
  }

  const condReasons: string[] = [];
  if (tTotalMs > CONDITIONAL_TOTAL_MS) {
    condReasons.push(`T_crypto + T_rest = ${Math.round(tTotalMs)} ms, over the ${CONDITIONAL_TOTAL_MS} ms budget`);
  }
  if (i.tPaintRecordedMs > CONDITIONAL_PAINT_MS) {
    condReasons.push(`T_paint (recording clock) = ${Math.round(i.tPaintRecordedMs)} ms, over ${CONDITIONAL_PAINT_MS} ms`);
  }
  if (!i.onFloorDevice) {
    condReasons.push(
      "the P2 floor device was unavailable — there is none; the run is on the operator's daily iPhone, " +
        "which is Phase 0's Caveat 1 unresolved (Decision 11)",
    );
  }
  if (i.thermallyCompromised) {
    condReasons.push("at least one pass ended at .serious or .critical, so the medians are throttling artifacts");
  }
  if (i.nobleSubsampleSize !== null) {
    condReasons.push(
      `the control arm was extrapolated from a ${i.nobleSubsampleSize}-record subsample after a jetsam kill, ` +
        "so R is a scaled estimate rather than a full-corpus measurement",
    );
  }

  const allTriggered = [...failReasons.map((r) => `FAIL: ${r}`), ...condReasons.map((r) => `CONDITIONAL: ${r}`)];

  if (failReasons.length > 0) {
    return {
      branch: "FAIL",
      reason: failReasons.join("; "),
      allTriggered,
      tCryptoMs,
      tTotalMs,
      speedup,
      consequences: failConsequences(),
      caveats: caveatsFor(i),
    };
  }
  if (condReasons.length > 0 || !PASS_IS_REACHABLE) {
    return {
      branch: "CONDITIONAL",
      reason:
        condReasons.length > 0
          ? condReasons.join("; ")
          : "every threshold was met, but PASS is unreachable without the floor device (Decision 11)",
      allTriggered,
      tCryptoMs,
      tTotalMs,
      speedup,
      consequences: conditionalConsequences(),
      caveats: caveatsFor(i),
    };
  }
  /* c8 ignore next 11 -- unreachable while PASS_IS_REACHABLE is false; kept so
     the branch exists the day a floor device does. verdict.test.ts asserts it
     really is unreachable rather than trusting this comment. */
  return {
    branch: "PASS",
    reason: "every threshold met on the floor device",
    allTriggered,
    tCryptoMs,
    tTotalMs,
    speedup,
    consequences: ["Proceed with Phase 2 as written."],
    caveats: caveatsFor(i),
  };
}

function conditionalConsequences(): string[] {
  return [
    "F1 (progressive, newest-window-first restore) is MANDATORY in Task 8, not optional. Note its real cost: " +
      "§3.3's prefix-monotonicity is over ascending seq, so an op whose parent has not arrived must become " +
      "PENDING rather than refused — a change to applyOp's contract and to I9_version_contiguity.",
    "Task 28's Gate B is a HARD STOP, not a check.",
    "The fallback ladder (F1-F5) is COSTED, not built, before Task 8 starts.",
    "Tasks 3+ proceed.",
  ];
}

function failConsequences(): string[] {
  return [
    "STOP. Do not build Tasks 3+ as written.",
    "Phase 0's PROVISIONAL PASS is formally REVOKED; spec §5 requires it revisited before proceeding.",
    "Escalate the F1-F5 ladder with costings. F2 does NOT help the case that decides this — Phase 3's " +
      "migration of the operator's three-year history is a cold restore, on device #1, on day one.",
    "F4 (one KEM per epoch) is a security design pass, not an improvisation.",
  ];
}

function caveatsFor(i: GateInputs): string[] {
  const out: string[] = [];
  if (!i.onFloorDevice) {
    out.push("Not the floor device. This is an UPPER-BOUND result, exactly as Phase 0's was (RESULTS.md Caveat 1).");
  }
  if (i.thermallyCompromised) out.push("Thermally compromised: at least one pass ended above .nominal.");
  if (i.nobleSubsampleSize !== null) {
    out.push(`C_noble extrapolated linearly from ${i.nobleSubsampleSize} records.`);
  }
  if (i.tPaintInstrumentMs === null) {
    out.push("The launchUptime instrument produced no reading; only the recording clock is available.");
  } else {
    out.push(
      `T_paint instrument reads ${Math.round(i.tPaintInstrumentMs)} ms against ${Math.round(i.tPaintRecordedMs)} ms ` +
        "recorded. The delta is launch-and-present overhead the instrument cannot see, not an error.",
    );
  }
  return out;
}

/**
 * Task 1b's recomputation.
 *
 * If the measured fold lands in RENEGOTIATES, Task 1's verdict is not quietly
 * kept: the figure is substituted into `T_rest` and the ordered table is re-run.
 * `foldMs` REPLACES the reserve rather than adding to it, because the reserve
 * exists precisely to cover the fold — adding both would double-count.
 */
export function substituteFold(i: GateInputs, foldTotalMs: number): { before: Verdict; after: Verdict } {
  const before = decide(i);
  const after = decide({ ...i, tRestMs: i.tRestMs + foldTotalMs });
  return { before, after };
}

export type FoldBranch = "CONFIRMS" | "RENEGOTIATES" | "BLOCKS";

export interface FoldVerdict {
  branch: FoldBranch;
  totalMs: number;
  linear: boolean;
  reason: string;
}

export const FOLD_CONFIRMS_MS = 2_500;
export const FOLD_BLOCKS_MS = 6_000;

/**
 * Task 1b's own table.
 *
 * "Measurably superlinear" is `linear === false`: the 500/1,500/N probe's
 * per-op cost rising by more than {@link SUPERLINEAR_TOLERANCE} between the
 * smallest and largest prefix. A fold that is superlinear is a DIFFERENT problem
 * from a fold that is slow — the entity-head registry grows with the log
 * (§3.3:81) — so it forces RENEGOTIATES even when the total is comfortable.
 */
export function decideFold(totalMs: number, linear: boolean): FoldVerdict {
  if (totalMs > FOLD_BLOCKS_MS) {
    return {
      branch: "BLOCKS",
      totalMs,
      linear,
      reason:
        `${Math.round(totalMs)} ms is past the ${FOLD_BLOCKS_MS} ms reserve. The architecture, not the crypto ` +
        "library, is the problem — RESULTS.md's central conclusion (\"nothing about the architecture is slow, " +
        "one library is\") is wrong and must be escalated in those words. Profile BigInt vs JSON.parse vs Map " +
        "churn before proposing anything; the three have completely different fixes.",
    };
  }
  if (totalMs > FOLD_CONFIRMS_MS || !linear) {
    return {
      branch: "RENEGOTIATES",
      totalMs,
      linear,
      reason: !linear
        ? `${Math.round(totalMs)} ms and MEASURABLY SUPERLINEAR. Task 1's verdict is recomputed with this figure ` +
          "substituted into T_rest; a superlinear fold is a different problem from a slow one."
        : `${Math.round(totalMs)} ms is over the ${FOLD_CONFIRMS_MS} ms the reserve assumed. Task 1's verdict is ` +
          "recomputed with this figure substituted into T_rest.",
    };
  }
  return {
    branch: "CONFIRMS",
    totalMs,
    linear,
    reason: `${Math.round(totalMs)} ms, linear in N. Task 1's 4 s reserve holds with room for the quarantine lane and per-chunk projection.`,
  };
}

/** How much per-op cost may grow across the linearity probe before it is superlinear. */
export const SUPERLINEAR_TOLERANCE = 1.25;

/**
 * Linearity from the 500 / 1,500 / N probe.
 *
 * Compares PER-OP cost at the smallest and largest prefix. A single ratio, not a
 * curve fit: three points cannot distinguish n log n from n^1.1 and pretending
 * otherwise would be a number with a false precision.
 */
export function isLinear(points: { n: number; ms: number }[]): boolean {
  const usable = points.filter((p) => p.n > 0 && p.ms > 0).sort((a, b) => a.n - b.n);
  if (usable.length < 2) return true;
  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  return last.ms / last.n <= (first.ms / first.n) * SUPERLINEAR_TOLERANCE;
}
