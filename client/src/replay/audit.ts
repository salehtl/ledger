/**
 * The periodic integrity re-fold: the thing that notices a snapshot has gone
 * wrong in a way nothing cheap can see.
 *
 * # Why this exists
 *
 * `snapshot.ts` binds a cached fold to the log it folded, and rejects it on a
 * version change, a fold-semantics change, a missing or substituted tip row, or
 * a damaged payload. What none of those catch is a prefix that changed *below*
 * the tip on a writer chain the tip does not cover, or a fold bug on a path the
 * canary does not walk. Both leave a snapshot that loads cleanly and is wrong,
 * and a wrong snapshot is worse than none: every screen then shows confident
 * wrong numbers with no symptom until a user compares a total against a bank
 * statement.
 *
 * So the cache is verified the only way a cache of a pure function can be:
 * recompute the function and compare. That recomputation is the 58-second
 * operation. This module is what makes running it a *budgeted, observable,
 * refusable* thing rather than a background job on somebody's phone.
 *
 * # The plan said "once per 20 launches, in the background". Two changes.
 *
 * **A launch counter is the wrong clock, and on its own it is a clock that can
 * stop.** It measures neither how much log has arrived since the last
 * verification nor how long ago that was. Worse, it is combined with an
 * eligibility gate — mains power AND foreground AND nominal thermal AND not
 * busy — that is rarely all true at once, so the realistic failure is not the
 * one the plan feared. It is not a surprise 58-second battery burn; it is that
 * **the audit never runs at all**, on a schedule nobody can see, and the
 * integrity guarantee quietly becomes a comment. That is this project's second
 * recurring defect shape wearing a different hat: written, tested green, never
 * actually executed in production.
 *
 * The cadence here is therefore four triggers, whichever fires first — never
 * audited, {@link AUDIT_EVERY_SEQS} of new log, {@link AUDIT_MAX_AGE_MS} of
 * wall time, or {@link AUDIT_EVERY_LAUNCHES} launches — and, crucially, a
 * **deadline**: once an audit has been due for {@link AUDIT_OVERDUE_MS} without
 * the conditions ever allowing it, {@link auditOverdue} goes true and Task 12's
 * Integrity screen says so. A device that can never run its own integrity check
 * is a fact the user is entitled to, not a silence.
 *
 * **And it is budgeted rather than "background".** {@link AUDIT_BUDGET_MS}
 * bounds the whole run; the conditions are re-polled at every chunk boundary,
 * not just at the start, so unplugging the phone or opening another app
 * abandons it within one chunk; and every run — including every refusal and
 * every abandon — writes a row to `fold_event`. The question "why is this app
 * using CPU" has an answer on screen, and the question "has this device ever
 * verified itself" has an answer in the log.
 *
 * # What it does on a mismatch
 *
 * A mismatch is a hard finding, never a silent repair. It is recorded with both
 * digests, the stale snapshot is dropped, the re-folded state is saved in its
 * place and returned so the caller can re-project — and the event stays in the
 * history for the Integrity screen. Repairing without recording would destroy
 * the only evidence that the fold, the store or the snapshot has a bug.
 *
 * # Host imports
 *
 * None. It folds nothing itself: {@link AuditOptions.refold} is supplied by the
 * caller, which is what keeps this module free of `net/` and of `bun:sqlite`.
 */

import { serializeState, type State } from "./state";
import {
  clearSnapshot,
  ensureSnapshot,
  readSnapshotPayload,
  recordEvent,
  saveSnapshot,
  serializeAppliedAtCursor,
  type LogBinding,
} from "./snapshot";
import { platform } from "../platform";
import type { SqlDriver, SqlStatement } from "../store/driver";

/**
 * The plan's constant, kept — as a **floor**, not as the only trigger.
 *
 * Twenty launches at a plausible five a day is about four days. It is a
 * reasonable upper bound on "how many times may a user open this app before it
 * has checked itself once", and a poor proxy for anything else: it does not
 * move when a month of transactions arrives while the app sits closed, and it
 * does not move at all for a user who leaves the app resident. The other three
 * triggers exist because of those two gaps.
 */
export const AUDIT_EVERY_LAUNCHES = 20;

/**
 * New hot log positions since the last successful audit that make one due.
 *
 * This is the trigger that tracks *risk* rather than habit: the chance that a
 * snapshot disagrees with the log grows with how much log it has folded since
 * anyone last checked. 2,000 is roughly half the operator's three-year corpus,
 * so a fresh install's backfill is audited once shortly after it lands.
 */
export const AUDIT_EVERY_SEQS = 2_000n;

/** Wall time since the last successful audit that makes one due. Seven days. */
export const AUDIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an audit may remain *due but blocked* before the device says so.
 *
 * Three weeks. This is the constant that turns "the conditions were never met"
 * from an invisible non-event into a line on the Integrity screen. Without it
 * the eligibility gate below is unfalsifiable: a build in which the audit never
 * ran once would look exactly like a build in which it ran and passed.
 */
export const AUDIT_OVERDUE_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * The whole run's budget.
 *
 * Phase 0 measured the full-corpus restore at 58 s. Three minutes is that with
 * enough headroom that an abandon means something is genuinely wrong — a device
 * far slower than the P2, a log far larger than the corpus, a store that has
 * started thrashing — rather than being a threshold normal variance trips. A
 * budget that fires routinely trains its reader to ignore it; this one is a
 * ceiling, and `fold_event` records the duration of every run so the *typical*
 * cost is visible without needing the ceiling to move.
 */
export const AUDIT_BUDGET_MS = 180_000;

/** Rows per chunk, and per yield. The same 250 as everywhere else in this pipeline. */
export const AUDIT_CHUNK = 250;

/** `expo-battery` / `expo-device` thermal levels, narrowed to what this needs. */
export type ThermalState = "nominal" | "fair" | "serious" | "critical";

/**
 * What the device is doing right now. Re-read at **every chunk boundary**, not
 * once at the start: a 58-second job that checked its preconditions only on
 * entry would keep running on battery for 57 of those seconds.
 */
export interface DeviceConditions {
  /** On mains power. Not "charging" — a phone on a weak charger is still draining. */
  mainsPower: boolean;
  /** The app is foregrounded. A background re-fold is a battery complaint with no explanation. */
  foreground: boolean;
  thermal: ThermalState;
  /**
   * A sync, a push, or a user gesture is in flight.
   *
   * The audit must never be the reason a tap feels slow. It yields between
   * chunks, but Phase 0 is explicit that the yields buy almost no event-loop
   * time (1.9-4.2 ms across a 58 s restore) — so "it yields" is not a defence.
   * Standing down entirely is.
   */
  busy: boolean;
}

/** Why the audit may not run right now. `null` means it may. */
export type AuditBlock = "on_battery" | "backgrounded" | "thermal" | "busy";

/**
 * The eligibility gate, as a pure function so it can be tested one condition at
 * a time and read at a glance.
 *
 * Order is deliberate: the reported reason is the most *actionable* one first,
 * so a user who is told "plug in to run this" is not then told "and also close
 * the other thing".
 */
export function auditBlocked(c: DeviceConditions): AuditBlock | null {
  if (!c.mainsPower) return "on_battery";
  if (!c.foreground) return "backgrounded";
  if (c.thermal !== "nominal") return "thermal";
  if (c.busy) return "busy";
  return null;
}

/** The persisted scheduler state. One row. */
export const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS fold_audit (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  launches     INTEGER NOT NULL,
  last_ok_at   INTEGER NOT NULL,
  last_ok_seq  TEXT    NOT NULL,
  due_since    INTEGER NOT NULL,
  skips        INTEGER NOT NULL,
  last_outcome TEXT    NOT NULL,
  last_detail  TEXT    NOT NULL
);
`;

export interface AuditState {
  /** Launches since the last successful audit. */
  launches: number;
  /** When the last audit passed. `0` means never. */
  lastOkAt: number;
  /** The hot cursor it passed at. */
  lastOkSeq: bigint;
  /** When the audit first became due and could not run. `0` means it is not waiting. */
  dueSince: number;
  /** Consecutive refusals since it became due. The number that makes a silence loud. */
  skips: number;
  lastOutcome: string;
  lastDetail: string;
}

interface Stmts {
  read: SqlStatement;
  write: SqlStatement;
}

const cached = new WeakMap<SqlDriver, Stmts>();

function stmts(db: SqlDriver): Stmts {
  const have = cached.get(db);
  if (have !== undefined) return have;
  ensureSnapshot(db);
  db.exec(AUDIT_SCHEMA);
  const made: Stmts = {
    read: db.prepare("SELECT launches, last_ok_at, last_ok_seq, due_since, skips, last_outcome, last_detail FROM fold_audit WHERE id = 1"),
    write: db.prepare(
      `INSERT INTO fold_audit (id, launches, last_ok_at, last_ok_seq, due_since, skips, last_outcome, last_detail)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET launches = excluded.launches, last_ok_at = excluded.last_ok_at,
         last_ok_seq = excluded.last_ok_seq, due_since = excluded.due_since, skips = excluded.skips,
         last_outcome = excluded.last_outcome, last_detail = excluded.last_detail`,
    ),
  };
  cached.set(db, made);
  return made;
}

const FRESH: AuditState = { launches: 0, lastOkAt: 0, lastOkSeq: 0n, dueSince: 0, skips: 0, lastOutcome: "", lastDetail: "" };

export function readAuditState(db: SqlDriver): AuditState {
  const raw = stmts(db).read.all()[0] as Record<string, unknown> | undefined;
  if (raw === undefined) return { ...FRESH };
  return {
    launches: Number(raw["launches"]),
    lastOkAt: Number(raw["last_ok_at"]),
    lastOkSeq: BigInt(String(raw["last_ok_seq"])),
    dueSince: Number(raw["due_since"]),
    skips: Number(raw["skips"]),
    lastOutcome: String(raw["last_outcome"]),
    lastDetail: String(raw["last_detail"]),
  };
}

function writeAuditState(db: SqlDriver, s: AuditState): void {
  stmts(db).write.run(s.launches, s.lastOkAt, s.lastOkSeq.toString(10), s.dueSince, s.skips, s.lastOutcome, s.lastDetail);
}

/** Counts one cold start. The app calls this once, at launch, before anything else. */
export function noteLaunch(db: SqlDriver): void {
  const s = readAuditState(db);
  writeAuditState(db, { ...s, launches: s.launches + 1 });
}

/** Why an audit is due, or `null` when it is not. */
export type AuditTrigger = "never_audited" | "log_grew" | "too_old" | "launches";

/**
 * Whether an integrity re-fold is due, and which trigger fired.
 *
 * Read-only: it does not record anything, so a screen may call it freely.
 * {@link runAudit} is what moves the scheduler.
 */
export function auditDue(db: SqlDriver, cursorHot: bigint, now: number): AuditTrigger | null {
  const s = readAuditState(db);
  if (s.lastOkAt === 0) return "never_audited";
  if (cursorHot - s.lastOkSeq >= AUDIT_EVERY_SEQS) return "log_grew";
  if (now - s.lastOkAt >= AUDIT_MAX_AGE_MS) return "too_old";
  if (s.launches >= AUDIT_EVERY_LAUNCHES) return "launches";
  return null;
}

/**
 * Whether the audit has been due and blocked for longer than the deadline.
 *
 * The Integrity screen renders this. It is the answer to "the conditions were
 * never met" being otherwise indistinguishable from "it ran and passed".
 */
export function auditOverdue(db: SqlDriver, now: number): boolean {
  const s = readAuditState(db);
  return s.dueSince !== 0 && now - s.dueSince >= AUDIT_OVERDUE_MS;
}

export interface AuditProgress {
  chunk: number;
  rows: number;
  /** Rows the re-fold expects to walk, when the caller knows. */
  total: number | null;
  elapsedMs: number;
}

/** Thrown inside {@link AuditOptions.refold}'s `between` to abandon cleanly. */
export class AuditAbandoned extends Error {
  constructor(readonly why: string) {
    super(`integrity re-fold abandoned: ${why}`);
    this.name = "AuditAbandoned";
  }
}

export interface AuditOptions {
  /**
   * Re-folds the log from genesis **up to and including `upToSeq`**, calling
   * `between` at every chunk boundary and awaiting it.
   *
   * Bounded by the snapshot's cursor rather than by the store's tip, because
   * otherwise the comparison is between two different prefixes and the audit
   * degenerates into "these disagree, as they should" — a check that can only
   * be passed by luck. The caller implements this over `RowStore.range()` in
   * {@link AUDIT_CHUNK} chunks; this module deliberately cannot fold anything
   * itself, so it cannot accidentally become a second fold implementation.
   */
  refold: (upToSeq: bigint, between: (p: AuditProgress) => Promise<void>) => Promise<State>;
  /** Re-read at every chunk boundary. */
  conditions: () => DeviceConditions;
  binding: LogBinding;
  /** A user-facing cancel. Polled at every chunk boundary. */
  cancelled?: () => boolean;
  onProgress?: (p: AuditProgress) => void;
  /** Injected so the budget is testable without a stopwatch in an assertion. */
  now?: () => number;
  budgetMs?: number;
  /** Awaited between chunks. Defaults to `setTimeout(…, 0)` — the Phase 0 fix verbatim. */
  yield?: () => Promise<void>;
}

export interface AuditResult {
  outcome: "ok" | "mismatch" | "abandoned" | "skipped";
  /** A short token, then a sentence: `on_battery`, `log_grew`, `digest_differs`, … */
  reason: string;
  ms: number;
  chunks: number;
  /**
   * The re-folded state, which is the truth on both `ok` and `mismatch`.
   *
   * Returned on a mismatch specifically so the caller re-projects from it: the
   * plan's rule is "fall back to the re-folded state", and a repair that only
   * fixed the snapshot would leave the SQLite projection — the thing every
   * screen actually reads — still showing the wrong numbers.
   */
  state: State | null;
}

/**
 * Runs one integrity re-fold, if it may.
 *
 * Everything that can stop it is checked before any work happens, and again at
 * every chunk boundary. Every outcome writes a `fold_event` row.
 */
export async function runAudit(db: SqlDriver, opts: AuditOptions): Promise<AuditResult> {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? AUDIT_BUDGET_MS;
  const yieldToLoop =
    opts.yield ??
    ((): Promise<void> =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }));
  const started = now();
  const state = readAuditState(db);

  const stop = (outcome: AuditResult["outcome"], reason: string, detail: string, cursorHot: bigint, chunks: number, refolded: State | null): AuditResult => {
    const ms = now() - started;
    recordEvent(db, { at: now(), kind: `audit_${outcome}`, detail: `${reason}: ${detail}`, cursorHot, bytes: 0, ms });
    return { outcome, reason, ms, chunks, state: refolded };
  };

  // 1. Is there anything to check? An audit with no snapshot has nothing to
  //    compare against, and reporting "ok" for it would be the vacuous pass
  //    this whole module exists to prevent.
  const stored = readSnapshotPayload(db);
  if (stored === null) {
    writeAuditState(db, { ...state, lastOutcome: "skipped", lastDetail: "no snapshot" });
    return stop("skipped", "no_snapshot", "there is no cached fold to verify", 0n, 0, null);
  }

  // 2. May it run? Recorded as a refusal, and the `dueSince` clock starts here
  //    so a device that can never satisfy these conditions eventually says so.
  const blocked = auditBlocked(opts.conditions());
  if (blocked !== null) {
    writeAuditState(db, {
      ...state,
      dueSince: state.dueSince === 0 ? started : state.dueSince,
      skips: state.skips + 1,
      lastOutcome: "skipped",
      lastDetail: blocked,
    });
    return stop("skipped", blocked, `refused ${(state.skips + 1).toString(10)} time(s) since it came due`, stored.cursorHot, 0, null);
  }

  // 3. Re-fold, bounded by the snapshot's own cursor.
  let chunks = 0;
  let refolded: State;
  try {
    refolded = await opts.refold(stored.cursorHot, async (p) => {
      chunks = p.chunk;
      const elapsed = now() - started;
      opts.onProgress?.({ ...p, elapsedMs: elapsed });
      if (opts.cancelled?.() === true) throw new AuditAbandoned("cancelled");
      const stillBlocked = auditBlocked(opts.conditions());
      if (stillBlocked !== null) throw new AuditAbandoned(stillBlocked);
      if (elapsed > budget) throw new AuditAbandoned("budget");
      await yieldToLoop();
    });
  } catch (err) {
    if (!(err instanceof AuditAbandoned)) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      writeAuditState(db, {
        ...state,
        dueSince: state.dueSince === 0 ? started : state.dueSince,
        skips: state.skips + 1,
        lastOutcome: "failed",
        lastDetail: detail,
      });
      // A checker failure is itself an integrity finding. Preserve the original
      // exception for the caller while leaving a durable reason for the
      // Integrity screen; swallowing it would turn "not checked" into silence.
      recordEvent(db, {
        at: now(),
        kind: "audit_failed",
        detail,
        cursorHot: stored.cursorHot,
        bytes: 0,
        ms: now() - started,
      });
      throw err;
    }
    // Abandoning costs nothing and repairs nothing: the re-fold is a pure read,
    // so a partial one leaves no trace beyond this row. The snapshot it was
    // checking is untouched and still in use — which is correct, because an
    // abandoned audit found nothing wrong with it.
    writeAuditState(db, {
      ...state,
      dueSince: state.dueSince === 0 ? started : state.dueSince,
      skips: state.skips + 1,
      lastOutcome: "abandoned",
      lastDetail: err.why,
    });
    return stop("abandoned", err.why, `after ${chunks.toString(10)} chunk(s)`, stored.cursorHot, chunks, null);
  }

  // 4. Compare. The re-fold must have reached the snapshot's cursor: if it
  //    stopped short, the log no longer reaches where the snapshot claims to
  //    be, and calling that "ok" would be a pass by construction.
  if (refolded.cursors.hot !== stored.cursorHot) {
    return mismatch(
      db,
      state,
      stored,
      refolded,
      "short_refold",
      `the log re-folds to seq ${refolded.cursors.hot.toString(10)}, the snapshot claims ${stored.cursorHot.toString(10)}`,
      opts,
      started,
      chunks,
      stop,
    );
  }
  const fresh = serializeState(refolded);
  const freshApplied = serializeAppliedAtCursor(refolded.appliedAtCursor);
  const p = platform();
  const storedDigest = p.toHex(
    p.sha256(new TextEncoder().encode(`${stored.stateJSON}\u0000${stored.appliedJSON}`)),
  );
  if (storedDigest !== stored.digest) {
    return mismatch(
      db, state, stored, refolded, "snapshot_corrupt",
      "the cached payload no longer matches its stored digest",
      opts, started, chunks, stop,
    );
  }
  if (fresh !== stored.stateJSON || freshApplied !== stored.appliedJSON) {
    const short = (s: string): string => p.toHex(p.sha256(new TextEncoder().encode(s))).slice(0, 16);
    const detail = fresh !== stored.stateJSON
      ? `cached ${short(stored.stateJSON)}, re-folded ${short(fresh)}`
      : `cached delivery set ${short(stored.appliedJSON)}, re-folded ${short(freshApplied)}`;
    return mismatch(
      db,
      state,
      stored,
      refolded,
      "digest_differs",
      detail,
      opts,
      started,
      chunks,
      stop,
    );
  }

  writeAuditState(db, {
    launches: 0,
    lastOkAt: now(),
    lastOkSeq: stored.cursorHot,
    dueSince: 0,
    skips: 0,
    lastOutcome: "ok",
    lastDetail: `${chunks.toString(10)} chunks`,
  });
  return stop("ok", "verified", `${chunks.toString(10)} chunk(s) re-folded and identical`, stored.cursorHot, chunks, refolded);
}

/**
 * The mismatch path: record it, drop the stale cache, install the re-folded
 * truth in its place, and hand the caller the state to re-project from.
 *
 * `dueSince` is deliberately left alone and `lastOkAt` is NOT advanced — a
 * mismatch is not a successful audit, and the next launch should try again.
 */
function mismatch(
  db: SqlDriver,
  state: AuditState,
  stored: { cursorHot: bigint; cursorCold: bigint },
  refolded: State,
  reason: string,
  detail: string,
  opts: AuditOptions,
  started: number,
  chunks: number,
  stop: (outcome: AuditResult["outcome"], reason: string, detail: string, cursorHot: bigint, chunks: number, refolded: State | null) => AuditResult,
): AuditResult {
  writeAuditState(db, { ...state, launches: 0, skips: 0, lastOutcome: "mismatch", lastDetail: `${reason}: ${detail}` });
  clearSnapshot(db);
  // Saving the re-folded state is the "fall back to the re-folded state" rule.
  // It can itself refuse — a state whose tip row is not in the store cannot be
  // bound — and that refusal must not mask the mismatch, so it is swallowed
  // here and the device simply carries on with no cache until the next sync.
  try {
    saveSnapshot(db, refolded, { hot: refolded.cursors.hot, cold: refolded.cursors.cold }, opts.binding);
  } catch {
    /* the mismatch is the finding; a failed re-save is one more cold start */
  }
  void started;
  return stop("mismatch", reason, detail, stored.cursorHot, chunks, refolded);
}
