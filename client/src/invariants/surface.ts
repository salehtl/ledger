/**
 * The halt surfaces: what a USER is shown when the invariant checker finds
 * something, and what they are shown instead of the product.
 *
 * Spec §3.4: on a key-history mismatch or a writer-chain break the client
 * **halts sync and shows a non-dismissable warning**. Spec §3.3:74: an
 * unreadable blob does **not** hard-stop — it is set aside with a visible
 * warning. Those are two different UI states and conflating them is the failure
 * mode this file exists to prevent, so there are three lanes and a violation
 * lands in exactly one:
 *
 * | lane | trigger | UI |
 * |---|---|---|
 * | {@link Halt} | any `hard_stop` — chain break, `UnknownNewerVersionError`, `VIOLATION_CHAIN_WITHHELD`, **and `VIOLATION_ROSTER_COVERAGE`** | full-screen, non-dismissable, sync stopped, no "continue anyway"; data already on the device stays readable |
 * | {@link NoticeGroup} | every other finding | a row on the Integrity screen, reachable from Settings, with a count badge — never a modal |
 * | {@link UnreadableNotice} | `state.unreadable` is non-empty | a persistent but DISMISSABLE banner naming the count, plus rows on the Integrity screen |
 *
 * # Why this is a pure module and not a component
 *
 * Everything here is framework-free and returns data. `app/` renders it (see
 * "The component contract" below); `client/src` may not import React, and the
 * decisions — which halt wins, what it says, what is routine — are exactly the
 * part that has to be unit-testable without a renderer. It follows the v1
 * convention `CLAUDE.md` states for `frontend/src/lib`: extract the decision out
 * of the component into a pure function and test it there.
 *
 * # I11 is a hard stop, and its two conditions must never share a screen
 *
 * An earlier draft of Task 12's table filed `I11_roster_checkpoint` under
 * "everything else", i.e. the notice lane — while Task 11 establishes it as a
 * hard stop. A user would have reached a full stop with **no screen behind it**.
 * It is in the halt lane here, and it is the invariant that makes an ingest-chain
 * truncation detectable at all.
 *
 * Its two conditions get DIFFERENT copy, and that is not cosmetic. Phase 1
 * records that collapsing them into one id laundered a withholding attack into a
 * notice: `push` proceeded over the benign case, matched on the id alone, and so
 * proceeded over the adversarial one too — after which a third device's
 * checkpoint replaced the honest attestation and nothing forced repair. The
 * split survives here in three places, and all three are tested:
 *
 *   1. {@link haltKindOf} maps `VIOLATION_ROSTER_COVERAGE` to
 *      {@link HALT_NOT_VOUCHED_FOR} and `VIOLATION_CHAIN_WITHHELD` to
 *      {@link HALT_CHAIN_WITHHELD} — two different messages.
 *   2. {@link HALT_ORDER} ranks `not_vouched_for` LAST, so when both fire the
 *      user is told about the withholding. Showing the benign copy over a
 *      co-occurring adversarial stop is the same laundering, one layer up.
 *   3. {@link escapableDuringPush} is an ALLOW-list of exactly one kind, and it
 *      is the predicate `Client.syncForAttestation` uses — not a second copy of
 *      it.
 */

import {
  INVARIANT_IDS,
  NOTICE_COUNTS,
  NOTICE_NO_CHECKPOINT_YET,
  NOTICE_OTHER_STREAM,
  NOTICE_SET_ASIDE,
  VIOLATION_CHAIN_WITHHELD,
  VIOLATION_CHECK_FAILED,
  VIOLATION_NEWER_VERSION,
  VIOLATION_ROSTER_COVERAGE,
  type Violation,
} from "./check";
import type { State } from "../replay/state";

// ---------------------------------------------------------------------------
// The halt lane
// ---------------------------------------------------------------------------

/** This build is older than the data. Nothing is wrong; the app is behind. */
export const HALT_UPDATE_REQUIRED = "update_required";
/** A peer device attested rows this server will not serve. Adversarial. */
export const HALT_CHAIN_WITHHELD = "chain_withheld";
/** The bytes served do not match what the server itself said about them. */
export const HALT_TAMPERED = "tampered";
/** The state on this device disagrees with its own op log. */
export const HALT_INCONSISTENT = "inconsistent";
/** A check could not run. The state is unknown, not known-bad. */
export const HALT_UNCERTIFIED = "uncertified";
/** No checkpoint vouches for this device's chain yet. Benign, and repairable. */
export const HALT_NOT_VOUCHED_FOR = "not_vouched_for";

export type HaltKind =
  | typeof HALT_UPDATE_REQUIRED
  | typeof HALT_CHAIN_WITHHELD
  | typeof HALT_TAMPERED
  | typeof HALT_INCONSISTENT
  | typeof HALT_UNCERTIFIED
  | typeof HALT_NOT_VOUCHED_FOR;

/**
 * Which halt is SHOWN when several fire, most urgent first.
 *
 * `update_required` leads because a build that cannot read the newer half of the
 * log may be producing every other stop as a side effect — telling that user
 * their data has been tampered with would be wrong as well as frightening.
 *
 * `not_vouched_for` is last, deliberately: see this file's header.
 */
export const HALT_ORDER: readonly HaltKind[] = [
  HALT_UPDATE_REQUIRED,
  HALT_CHAIN_WITHHELD,
  HALT_TAMPERED,
  HALT_INCONSISTENT,
  HALT_UNCERTIFIED,
  HALT_NOT_VOUCHED_FOR,
];

/**
 * A full-screen, non-dismissable stop.
 *
 * `dismissable` and `syncStopped` are literal types rather than booleans so that
 * a screen cannot render a halt as dismissable by passing the wrong flag: there
 * is no value of `Halt` for which "continue anyway" typechecks.
 */
export interface Halt {
  kind: HaltKind;
  /** One short line. Names what happened, never jargon. */
  title: string;
  /** Two or three sentences: what it means, and what is still true. */
  body: string;
  /** The one thing the user can do, or null when there is nothing to do here. */
  action: string | null;
  dismissable: false;
  syncStopped: true;
  /** Every hard stop of this kind, for the Integrity screen's detail view. */
  violations: readonly Violation[];
}

interface Copy {
  title: string;
  body: string;
  action: string | null;
}

/**
 * The words. Plain language, no invariant ids, and no "contact support" — the
 * user IS the operator on this product.
 *
 * Every one of them ends by saying what is still true, because the thing a
 * person needs first from a full-screen stop is whether their money is gone.
 * It is not: a halt stops SYNC, and everything already on the device stays
 * readable (spec §3.4, and `Client.pull` persists nothing over a hard stop, so
 * the last certified state is what is on screen behind this).
 */
const COPY: Record<HaltKind, Copy> = {
  [HALT_UPDATE_REQUIRED]: {
    title: "Update ledger to keep syncing",
    body:
      "Your other device is writing in a newer format than this copy of the app understands. " +
      "Syncing has stopped so that a half-understood record is never folded into your balances. " +
      "Nothing is wrong with your data, and everything already on this device is still readable.",
    action: "Update ledger from the App Store, then open it again.",
  },
  [HALT_CHAIN_WITHHELD]: {
    title: "Some of your data is being withheld",
    body:
      "Another of your devices has already seen entries that the server is now refusing to send this one. " +
      "That should never happen, so syncing has stopped rather than accept a shortened history. " +
      "Everything already on this device is still readable, and nothing has been deleted here.",
    action: "Open ledger on the device that has the missing entries and leave it running, then try again.",
  },
  [HALT_NOT_VOUCHED_FOR]: {
    title: "This device hasn't been vouched for yet",
    body:
      "Your devices check each other's records, and no other device has confirmed this one's yet. " +
      "Until one does, there is nothing to check a shortened history against, so syncing has stopped. " +
      "Everything already on this device is still readable.",
    action: "Open ledger on a device you have already been using, let it finish syncing, then come back here.",
  },
  [HALT_TAMPERED]: {
    title: "The data received doesn't match its own record",
    body:
      "What the server sent does not match the fingerprints it published for it. That means an entry was " +
      "changed, dropped or repeated in transit, so syncing has stopped instead of storing it. " +
      "Everything already on this device is still readable, and nothing unverified has been saved.",
    action: "Try again later. If it keeps happening, the server's copy needs restoring from backup.",
  },
  [HALT_INCONSISTENT]: {
    title: "This device's records don't add up",
    body:
      "Re-reading this device's own history produces a different answer from what it is showing, so syncing " +
      "has stopped rather than build on a total that cannot be reproduced. " +
      "Nothing has been lost: the history itself is intact and can be re-read from the start.",
    action: "Try again after restarting the app; if it persists, this device can rebuild from the server.",
  },
  [HALT_UNCERTIFIED]: {
    title: "ledger couldn't finish checking your data",
    body:
      "One of the safety checks could not run, so this sync cannot be certified either way. " +
      "Syncing has stopped because unchecked is treated exactly like unsafe here. " +
      "Everything already on this device is still readable.",
    action: "Try again. If it keeps happening, this is a bug in the app rather than in your data.",
  },
};

/**
 * Which halt a hard stop belongs to.
 *
 * `kind` wins where the checker set one, because a kind is a statement the check
 * made about ITSELF; the id table is the fallback. Nothing here matches on the
 * detail string — a classifier that read prose would silently change meaning
 * every time a message was reworded.
 */
export function haltKindOf(v: Violation): HaltKind {
  switch (v.kind) {
    case VIOLATION_ROSTER_COVERAGE:
      return HALT_NOT_VOUCHED_FOR;
    case VIOLATION_CHAIN_WITHHELD:
      return HALT_CHAIN_WITHHELD;
    case VIOLATION_NEWER_VERSION:
      return HALT_UPDATE_REQUIRED;
    case VIOLATION_CHECK_FAILED:
      return HALT_UNCERTIFIED;
    default:
      break;
  }
  return BY_ID[v.id] ?? HALT_UNCERTIFIED;
}

/**
 * The id → halt table.
 *
 * The split is "did the server serve something that does not match what it
 * claimed" (tampered) versus "does this device's own state disagree with its own
 * log" (inconsistent). They are different sentences to a user: the first is
 * about a machine they do not control, the second about one they do.
 *
 * An id NOT in this table falls through to `uncertified`, which is the safe
 * default for an invariant added later: a stop nobody has written copy for is
 * still a stop, and it says so, rather than being dropped or mislabelled.
 */
const BY_ID: Record<string, HaltKind> = {
  I1_stream_cursor_monotone: HALT_TAMPERED,
  I2_writer_counters: HALT_TAMPERED,
  I3_chain: HALT_TAMPERED,
  I3b_cold_hash_list: HALT_TAMPERED,
  I4_aad: HALT_TAMPERED,
  I5_bucket: HALT_TAMPERED,
  I6_schema_version: HALT_UPDATE_REQUIRED,
  I7_one_live_per_ingest: HALT_INCONSISTENT,
  I8_split_sum: HALT_INCONSISTENT,
  I9_version_contiguity: HALT_INCONSISTENT,
  I10_fx_prefix_monotone: HALT_INCONSISTENT,
  I11_roster_checkpoint: HALT_NOT_VOUCHED_FOR,
  I12_money_shape: HALT_INCONSISTENT,
  I13_supersede_has_origin: HALT_INCONSISTENT,
  I14_forks_surfaced: HALT_INCONSISTENT,
  I15_unreadable_set_aside: HALT_INCONSISTENT,
  I16_cold_carries_no_ops: HALT_TAMPERED,
};

// ---------------------------------------------------------------------------
// The notice lane
// ---------------------------------------------------------------------------

/**
 * One row on the Integrity screen: a category, a count, and the details behind
 * it.
 *
 * Grouped rather than listed because Phase 1's exit run produced, per device per
 * stream, several routine `I11` notices plus eighteen `possible_duplicate`
 * anomalies from a thin corpus — and its own record says a notice list nobody
 * reads is the same as no invariants. So the screen shows categories with counts
 * and expands to detail.
 */
export interface NoticeGroup {
  /** The invariant id, so the detail view can link to what it means. */
  id: string;
  /** The condition under that id, where the checker named one. */
  kind: string | null;
  title: string;
  count: number;
  /**
   * Routine notices are collapsed by default and excluded from the badge: they
   * fire on a healthy account on every sync (a hot-only pull cannot cross-check
   * a cold checkpoint head; a single-device user has no peer to be vouched for
   * by; `I14` prints its counts unconditionally BECAUSE a report that appears
   * only when it is interesting cannot be told from a broken one).
   *
   * They are collapsed, never dropped. Suppressing them would re-create exactly
   * the blind spot `I14`'s unconditional line exists to remove.
   */
  routine: boolean;
  details: readonly string[];
}

/** The kinds that are routine on a HEALTHY account, and therefore collapsed. */
const ROUTINE_KINDS: ReadonlySet<string> = new Set([NOTICE_NO_CHECKPOINT_YET, NOTICE_OTHER_STREAM, NOTICE_COUNTS]);

/** Plain-language row titles. Falls back to the id, which is never wrong, only terse. */
const NOTICE_TITLES: Record<string, string> = {
  [NOTICE_NO_CHECKPOINT_YET]: "No other device has been enrolled yet",
  [NOTICE_OTHER_STREAM]: "Older mail wasn't cross-checked in this sync",
  [NOTICE_COUNTS]: "Conflicts and skipped entries",
  [NOTICE_SET_ASIDE]: "Entries ledger couldn't read",
  I11_roster_checkpoint: "A device's records need re-confirming",
  I13_supersede_has_origin: "A replacement with no original",
  I14_forks_surfaced: "Something needed resolving",
  I15_unreadable_set_aside: "Entries ledger couldn't read",
};

/** At most this many detail lines are kept per group; the count is always exact. */
export const DETAILS_PER_GROUP = 20;

// ---------------------------------------------------------------------------
// The unreadable lane
// ---------------------------------------------------------------------------

/**
 * The third state: blobs that were set aside.
 *
 * Dismissable — the cursor advanced, the sync completed, and nothing is lost
 * (spec §3.3:74). It is `persistent` in that dismissing it is per-appearance and
 * the count reappears on the Integrity screen, which is where the positions
 * live.
 */
export interface UnreadableNotice {
  count: number;
  /** `(writer, stream, counter) at seq N`, one per set-aside blob, for the detail view. */
  positions: readonly string[];
  dismissable: true;
}

// ---------------------------------------------------------------------------
// The whole surface
// ---------------------------------------------------------------------------

export interface Surface {
  /** The one halt to render full-screen, or null when sync may proceed. */
  halt: Halt | null;
  /** Every halt, most urgent first. The Integrity screen lists all of them. */
  halts: readonly Halt[];
  notices: readonly NoticeGroup[];
  unreadable: UnreadableNotice | null;
  /**
   * The count badge on the Settings → Integrity row.
   *
   * Non-routine notice GROUPS plus one for the unreadable banner. Groups rather
   * than findings so that eighteen `possible_duplicate` rows read as one thing
   * to look at rather than as eighteen alarms — and routine ones are excluded
   * because a badge that is never zero is a badge nobody reads.
   */
  badge: number;
}

export interface SurfaceInput {
  violations: readonly Violation[];
  /**
   * `state.unreadable`. Passed rather than derived from the violations because
   * the banner must appear for a sync that produced NO findings at all: a blob
   * set aside on an earlier sync is still set aside.
   */
  unreadable?: State["unreadable"];
  /**
   * A throw from the sync layer, if the session ended in one — a
   * `ChainBreakError`, an `UnknownNewerVersionError`, or a `HardStopError`
   * carrying its own violations.
   *
   * It is duck-typed rather than `instanceof`-ed against `HardStopError`,
   * because that class lives in `net/client.ts`, which imports this package; an
   * import back would be a cycle. The two error classes that do NOT live
   * downstream are matched by name, which is set explicitly in both.
   */
  error?: unknown;
}

/**
 * Classifies a check result into the three lanes.
 *
 * Pure, total, and never throws: it is the last thing between a broken sync and
 * a blank screen, and a classifier that threw would leave the user with neither
 * the product nor the explanation.
 */
export function surface(input: SurfaceInput): Surface {
  const violations = [...(Array.isArray(input.violations) ? input.violations : []), ...fromError(input.error)];

  const byKind = new Map<HaltKind, Violation[]>();
  const noticeGroups = new Map<string, NoticeGroup & { details: string[] }>();
  for (const v of violations) {
    if (v === null || typeof v !== "object") continue;
    if (v.severity === "hard_stop") {
      const kind = haltKindOf(v);
      const list = byKind.get(kind);
      if (list === undefined) byKind.set(kind, [v]);
      else list.push(v);
      continue;
    }
    // The set-aside notice appears in BOTH lanes on purpose: a dismissable
    // banner naming the count, and a row on the Integrity screen that survives
    // the dismissal. Task 12's table says "plus rows in the Integrity screen".
    const key = `${v.id}|${v.kind ?? ""}`;
    const group = noticeGroups.get(key);
    if (group === undefined) {
      noticeGroups.set(key, {
        id: v.id,
        kind: v.kind ?? null,
        title: NOTICE_TITLES[v.kind ?? ""] ?? NOTICE_TITLES[v.id] ?? v.id,
        count: 1,
        routine: v.kind !== undefined && ROUTINE_KINDS.has(v.kind),
        details: [String(v.detail)],
      });
      continue;
    }
    group.count++;
    if (group.details.length < DETAILS_PER_GROUP) group.details.push(String(v.detail));
  }

  const halts: Halt[] = [];
  for (const kind of HALT_ORDER) {
    const list = byKind.get(kind);
    if (list === undefined || list.length === 0) continue;
    const copy = COPY[kind];
    halts.push({ kind, ...copy, dismissable: false, syncStopped: true, violations: list });
  }
  // A hard stop that reached no lane would be a stop with no screen — the exact
  // defect this task was dispatched to fix. There is no runtime fallback for it,
  // because a fallback that cannot be reached is a check that cannot fail:
  // `surface.test.ts` asserts instead that every invariant id and every exported
  // kind classifies into a `HALT_ORDER` member, and that the halts account for
  // every hard stop handed in. That test fails the moment someone adds a kind
  // and forgets the order.

  const order = new Map(INVARIANT_IDS.map((id, n) => [id, n]));
  const notices = [...noticeGroups.values()].sort((a, b) => {
    if (a.routine !== b.routine) return a.routine ? 1 : -1;
    return (order.get(a.id) ?? INVARIANT_IDS.length) - (order.get(b.id) ?? INVARIANT_IDS.length);
  });

  const setAside = Array.isArray(input.unreadable) ? input.unreadable : [];
  const unreadable: UnreadableNotice | null =
    setAside.length === 0
      ? null
      : {
          count: setAside.length,
          positions: setAside.map(
            (u) => `(${String(u.writer_id)}, ${String(u.stream)}, counter ${String(u.writer_counter)}) at seq ${String(u.seq)}`,
          ),
          dismissable: true,
        };

  return {
    halt: halts[0] ?? null,
    halts,
    notices,
    unreadable,
    badge: notices.filter((n) => !n.routine).length + (unreadable === null ? 0 : 1),
  };
}

/**
 * The violations carried by a thrown error, so a sync that ended in a throw
 * surfaces the same way as one that returned findings.
 *
 * A `ChainBreakError` reaches here from the pre-fold chain verification, which
 * runs BEFORE any blob is opened and therefore before the checker has anything
 * to attribute the refusal to — `Client.pull` runs the checker over the same
 * page for exactly that reason, but the chain check is strictly stronger on one
 * point (a run spliced together from two chains), so a refusal the checker
 * cannot name must still reach the user as a halt rather than as silence.
 */
function fromError(err: unknown): Violation[] {
  if (err === null || err === undefined) return [];
  const e = err as { name?: unknown; message?: unknown; violations?: unknown };
  if (Array.isArray(e.violations)) return e.violations as Violation[];
  const message = typeof e.message === "string" ? e.message : String(err);
  if (e.name === "UnknownNewerVersionError") {
    return [{ id: "I6_schema_version", severity: "hard_stop", kind: VIOLATION_NEWER_VERSION, detail: message }];
  }
  if (e.name === "ChainBreakError") {
    return [{ id: "I3_chain", severity: "hard_stop", detail: message }];
  }
  return [{ id: "sync_failed", severity: "hard_stop", kind: VIOLATION_CHECK_FAILED, detail: message }];
}

// ---------------------------------------------------------------------------
// The one escape, and its boundary
// ---------------------------------------------------------------------------

/**
 * Whether a push may proceed over these hard stops.
 *
 * `true` means EVERY hard stop raised was {@link VIOLATION_ROSTER_COVERAGE} — a
 * live writer with no attested head — and the caller should write the checkpoint
 * anyway, because writing it IS the repair and refusing deadlocks an account
 * whose every device needs a checkpoint before it can sync. That deadlock is
 * real: a checkpoint must name every roster writer (counter 0 + genesis hash for
 * a chain never written), and a multi-device account hard-stops until one lands,
 * so enrolment and first checkpoint are strictly ordered.
 *
 * Three properties, each with its own test:
 *
 *   - It is an **allow-list**. A condition added to `I11` later carries no kind
 *     and is therefore un-escapable until someone deliberately marks it benign:
 *     the cost of forgetting is a refused push, not a laundered attack.
 *   - It is **`every`, not `some`**. With `some`, one benign coverage stop would
 *     carry a co-occurring `VIOLATION_CHAIN_WITHHELD` through with it — and a
 *     device being withheld from must author no checkpoint at all, because it
 *     has nothing trustworthy to attest and its checkpoint would replace the
 *     honest one. Phase 1's ledger notes this boundary was asserted but never
 *     pinned, since no scenario had `I11` co-occurring with another hard stop.
 *     `surface.test.ts` has that scenario.
 *   - It is **false for an empty list**, so "no hard stops at all" is never
 *     reported as "blocked but proceeding" — those are different states and the
 *     caller records one of them.
 */
export function escapableDuringPush(stops: readonly Violation[]): boolean {
  return (
    stops.length > 0 &&
    stops.every((v) => v.id === "I11_roster_checkpoint" && v.kind === VIOLATION_ROSTER_COVERAGE && v.severity === "hard_stop")
  );
}

// ---------------------------------------------------------------------------
// The component contract — `app/` does not exist in this tree yet
// ---------------------------------------------------------------------------

/*
 * THE COMPONENT CONTRACT — `app/` does not exist in this tree yet.
 *
 * What `app/src/components/HaltBanner.tsx` and
 * `app/src/screens/settings/IntegrityScreen.tsx` must render, stated here
 * because Task 12's screens live in `app/`, which another task is scaffolding.
 * Writing them blind would be the "written, tested green, never wired" defect
 * this project has already paid for six times, so the contract is written and
 * the components are not.
 *
 * ```tsx
 * const s = surface({ violations, unreadable: state.unreadable, error });
 *
 * // 1. The halt. Rendered INSTEAD of the app, above everything, at the root:
 * if (s.halt !== null) return <HaltBanner halt={s.halt} />;
 * //    - no close button, no back gesture, no "continue anyway";
 * //    - `halt.title`, `halt.body`, and `halt.action` as the only text;
 * //    - a "What exactly happened?" disclosure listing `halt.violations`
 * //      details verbatim — the plain-language copy must never be the ONLY
 * //      record, or an operator cannot diagnose it;
 * //    - the sync engine must already be stopped before this renders: the
 * //      banner reports the halt, it does not cause it.
 *
 * // 2. The unreadable banner. Dismissable, above the list, not a modal:
 * {s.unreadable !== null && <UnreadableBanner n={s.unreadable.count} onDismiss={…} />}
 *
 * // 3. Settings → Integrity, with `s.badge` as the count:
 * <SettingsRow title="Integrity" badge={s.badge} />
 * //    - the screen lists `s.notices`: title + count, tap to expand `details`;
 * //    - routine groups render collapsed and below the rest, never hidden;
 * //    - `s.halts` renders at the top when non-empty, with the same copy.
 * ```
 *
 * Reduced motion, 44 px targets and 16 px inputs apply to all three
 * (`frontend/src/components/README.md`). The halt screen must not animate in:
 * it is not a transition, it is a wall.
 */
