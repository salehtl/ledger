/**
 * The three lanes, and the one distinction that has already cost this project a
 * laundered attack.
 *
 * The tests that matter most here are the negative ones: that a benign `I11`
 * cannot borrow the adversarial one's screen, that the adversarial one cannot
 * borrow the benign one's escape, and that neither can be reached by a hard stop
 * with no lane at all.
 */

import { expect, test } from "bun:test";
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
import {
  HALT_CHAIN_WITHHELD,
  HALT_INCONSISTENT,
  HALT_NOT_VOUCHED_FOR,
  HALT_ORDER,
  HALT_TAMPERED,
  HALT_UNCERTIFIED,
  HALT_UPDATE_REQUIRED,
  escapableDuringPush,
  haltKindOf,
  surface,
} from "./surface";

const stop = (id: string, kind?: string): Violation => ({
  id,
  severity: "hard_stop",
  detail: `${id} broke`,
  ...(kind === undefined ? {} : { kind }),
});
const notice = (id: string, kind?: string, detail = "something"): Violation => ({
  id,
  severity: "notice",
  detail,
  ...(kind === undefined ? {} : { kind }),
});

const ROSTER = "I11_roster_checkpoint";

// ---------------------------------------------------------------------------
// I11 has a surface, and its two conditions do not share one
// ---------------------------------------------------------------------------

test("I11's coverage stop reaches a halt screen at all", () => {
  // The defect this task was dispatched to fix: Task 12's first table filed
  // `I11` under "everything else", i.e. the notice lane, while Task 11 makes it
  // a hard stop — so a user reached a full stop with no screen behind it.
  const s = surface({ violations: [stop(ROSTER, VIOLATION_ROSTER_COVERAGE)] });
  expect(s.halt).not.toBeNull();
  expect(s.halt!.kind).toBe(HALT_NOT_VOUCHED_FOR);
  expect(s.halt!.dismissable).toBe(false);
  expect(s.halt!.syncStopped).toBe(true);
  expect(s.halt!.title.length).toBeGreaterThan(0);
  expect(s.halt!.action).not.toBeNull();
});

test("the benign and the adversarial I11 get different words, not one message", () => {
  const benign = surface({ violations: [stop(ROSTER, VIOLATION_ROSTER_COVERAGE)] }).halt!;
  const attack = surface({ violations: [stop(ROSTER, VIOLATION_CHAIN_WITHHELD)] }).halt!;
  expect(benign.kind).not.toBe(attack.kind);
  expect(benign.title).not.toBe(attack.title);
  expect(benign.body).not.toBe(attack.body);
  expect(benign.action).not.toBe(attack.action);
  // And they say the two things the plan requires them to say.
  expect(`${benign.title} ${benign.body} ${benign.action}`.toLowerCase()).toContain("device");
  expect(benign.action!.toLowerCase()).toContain("already");
  expect(`${attack.title} ${attack.body}`.toLowerCase()).toContain("withhe");
});

test("when both I11 conditions fire, the user is told about the WITHHOLDING", () => {
  // Ranking the benign one first would launder the attack one screen higher than
  // the escape hatch does: the user would be told to go and open another device
  // while a truncation went unmentioned.
  const s = surface({
    violations: [stop(ROSTER, VIOLATION_ROSTER_COVERAGE), stop(ROSTER, VIOLATION_CHAIN_WITHHELD)],
  });
  expect(s.halt!.kind).toBe(HALT_CHAIN_WITHHELD);
  // Both are still listed; the ranking chooses what is SHOWN, never what is kept.
  expect(s.halts.map((h) => h.kind)).toEqual([HALT_CHAIN_WITHHELD, HALT_NOT_VOUCHED_FOR]);
});

test("a checkpoint that names an enrolled-but-silent writer at counter 0 is not an error to suppress", () => {
  // Two contracts of Task 11 that LOOK like bugs and are not: a checkpoint names
  // every roster writer including one that has authored nothing, and a
  // multi-device account hard-stops until the first checkpoint lands. Neither
  // has a surface of its own — the first produces no violation at all, and the
  // second produces exactly the coverage halt above.
  expect(surface({ violations: [] }).halt).toBeNull();
  expect(surface({ violations: [] }).badge).toBe(0);
});

// ---------------------------------------------------------------------------
// The other halts
// ---------------------------------------------------------------------------

test("an unknown newer version says update the app, and never says tampering", () => {
  const s = surface({ violations: [stop("I6_schema_version", VIOLATION_NEWER_VERSION)] });
  expect(s.halt!.kind).toBe(HALT_UPDATE_REQUIRED);
  expect(s.halt!.body.toLowerCase()).not.toContain("tamper");
  expect(s.halt!.action!.toLowerCase()).toContain("update");
  // Distinct from the tamper message in every field a screen renders.
  const tampered = surface({ violations: [stop("I3_chain")] }).halt!;
  expect(tampered.kind).toBe(HALT_TAMPERED);
  expect(tampered.title).not.toBe(s.halt!.title);
  expect(tampered.body).not.toBe(s.halt!.body);
});

test("an update-required stop outranks every other halt it co-occurs with", () => {
  const s = surface({
    violations: [stop("I3_chain"), stop("I10_fx_prefix_monotone"), stop("I6_schema_version", VIOLATION_NEWER_VERSION)],
  });
  expect(s.halt!.kind).toBe(HALT_UPDATE_REQUIRED);
});

test("a check that could not run is UNCERTIFIED, not known-bad", () => {
  const s = surface({ violations: [stop("I9_version_contiguity", VIOLATION_CHECK_FAILED)] });
  expect(s.halt!.kind).toBe(HALT_UNCERTIFIED);
  expect(s.halt!.body.toLowerCase()).toContain("could not");
});

test("every invariant id and every exported kind lands in a lane that has copy", () => {
  // The totality check, measured rather than defended at runtime. A hard stop
  // with no lane would be a stop with no screen — this task's whole subject — so
  // an eighteenth invariant, or a new kind, fails here.
  const kinds = [
    undefined,
    VIOLATION_ROSTER_COVERAGE,
    VIOLATION_CHAIN_WITHHELD,
    VIOLATION_NEWER_VERSION,
    VIOLATION_CHECK_FAILED,
  ];
  for (const id of [...INVARIANT_IDS, "REITERABLE_SOURCE", "an_id_nobody_has_written_yet"]) {
    for (const kind of kinds) {
      const v = stop(id, kind);
      expect(HALT_ORDER).toContain(haltKindOf(v));
      const s = surface({ violations: [v] });
      expect(s.halt).not.toBeNull();
      expect(s.halt!.violations).toContain(v);
      expect(s.halt!.body.length).toBeGreaterThan(40);
    }
  }
});

test("every hard stop handed in reaches exactly one halt", () => {
  const stops = INVARIANT_IDS.map((id) => stop(id));
  const s = surface({ violations: [...stops, notice("I14_forks_surfaced", NOTICE_COUNTS)] });
  expect(s.halts.reduce((n, h) => n + h.violations.length, 0)).toBe(stops.length);
});

test("a thrown error surfaces as a halt rather than as silence", () => {
  // A `ChainBreakError` is raised BEFORE any blob is opened, so there may be no
  // violations at all to classify — and a sync that ends in a throw with no
  // screen is the same defect as a stop with no screen.
  const chainBreak = { name: "ChainBreakError", message: "counter 4 where 3 is due" };
  expect(surface({ violations: [], error: chainBreak }).halt!.kind).toBe(HALT_TAMPERED);

  const newer = { name: "UnknownNewerVersionError", message: "op v2, this build supports v1" };
  expect(surface({ violations: [], error: newer }).halt!.kind).toBe(HALT_UPDATE_REQUIRED);

  // A `HardStopError` carries the violations it stopped on; they are used, not
  // flattened into one generic message.
  const hardStop = { name: "HardStopError", message: "…", violations: [stop(ROSTER, VIOLATION_CHAIN_WITHHELD)] };
  expect(surface({ violations: [], error: hardStop }).halt!.kind).toBe(HALT_CHAIN_WITHHELD);

  // Anything else still stops, as uncertified rather than as a claim.
  expect(surface({ violations: [], error: new Error("socket closed") }).halt!.kind).toBe(HALT_UNCERTIFIED);
});

// ---------------------------------------------------------------------------
// The notice lane
// ---------------------------------------------------------------------------

test("notices are grouped with counts, and routine ones sort last and do not badge", () => {
  // Phase 1's exit run produced several routine I11 notices per device per
  // stream plus eighteen possible_duplicate anomalies from a thin corpus, and
  // its own record says a notice list nobody reads is the same as no invariants.
  const violations: Violation[] = [
    notice("I11_roster_checkpoint", NOTICE_OTHER_STREAM, "cold head not cross-checked"),
    notice("I11_roster_checkpoint", NOTICE_OTHER_STREAM, "another cold head"),
    notice("I14_forks_surfaced", NOTICE_COUNTS, "0 forks, 18 anomalies (possible_duplicate 18)"),
    notice("I13_supersede_has_origin", undefined, "op-9 supersedes an ingest nothing introduced"),
  ];
  const s = surface({ violations });
  expect(s.notices.map((n) => [n.kind, n.count])).toEqual([
    [null, 1],
    [NOTICE_OTHER_STREAM, 2],
    [NOTICE_COUNTS, 1],
  ]);
  expect(s.notices[0]!.routine).toBe(false);
  expect(s.notices.slice(1).every((n) => n.routine)).toBe(true);
  expect(s.badge).toBe(1);
  // Collapsed, never dropped: the detail is still there to expand.
  expect(s.notices[1]!.details).toHaveLength(2);
});

test("a routine notice on its own leaves the badge at zero and raises no halt", () => {
  const s = surface({
    violations: [
      notice("I11_roster_checkpoint", NOTICE_NO_CHECKPOINT_YET, "no checkpoint yet (single writer)"),
      notice("I14_forks_surfaced", NOTICE_COUNTS, "0 forks, 0 anomalies"),
    ],
  });
  expect(s.halt).toBeNull();
  expect(s.badge).toBe(0);
  expect(s.notices).toHaveLength(2);
});

test("a group keeps a bounded number of details but an exact count", () => {
  const many = Array.from({ length: 200 }, (_, n) => notice("I13_supersede_has_origin", undefined, `orphan ${n}`));
  const g = surface({ violations: many }).notices[0]!;
  expect(g.count).toBe(200);
  expect(g.details.length).toBeLessThanOrEqual(20);
});

// ---------------------------------------------------------------------------
// The unreadable lane — a warning, never a wall
// ---------------------------------------------------------------------------

const setAside = (n: number): { writer_id: string; stream: string; writer_counter: bigint; seq: bigint; reason: string }[] =>
  Array.from({ length: n }, (_, k) => ({
    writer_id: "ingest",
    stream: "hot",
    writer_counter: BigInt(k + 1),
    seq: BigInt(k + 1),
    reason: "not an op blob",
  }));

test("an unreadable blob is a dismissable banner and stops nothing", () => {
  // Spec §3.3:74. Conflating this with a hard stop is the failure mode Task 12
  // names in its first sentence.
  const s = surface({
    violations: [notice("I15_unreadable_set_aside", NOTICE_SET_ASIDE, "1 blob(s) set aside and not folded: …")],
    unreadable: setAside(1),
  });
  expect(s.halt).toBeNull();
  expect(s.unreadable).not.toBeNull();
  expect(s.unreadable!.dismissable).toBe(true);
  expect(s.unreadable!.count).toBe(1);
  expect(s.unreadable!.positions[0]).toContain("counter 1");
  // And a row on the Integrity screen too, which survives dismissing the banner.
  expect(s.notices.some((n) => n.kind === NOTICE_SET_ASIDE)).toBe(true);
  expect(s.badge).toBe(2);
});

test("the banner appears for a sync that produced no findings at all", () => {
  // A blob set aside on an earlier sync is still set aside; the banner is driven
  // by the state, not by this run's violations.
  const s = surface({ violations: [], unreadable: setAside(3) });
  expect(s.unreadable!.count).toBe(3);
  expect(s.halt).toBeNull();
});

test("a hard stop and an unreadable blob coexist without either becoming the other", () => {
  const s = surface({ violations: [stop("I3_chain")], unreadable: setAside(2) });
  expect(s.halt!.kind).toBe(HALT_TAMPERED);
  expect(s.unreadable!.count).toBe(2);
  expect(s.unreadable!.dismissable).toBe(true);
});

// ---------------------------------------------------------------------------
// The escape hatch, and the `.every` boundary Phase 1 left unpinned
// ---------------------------------------------------------------------------

test("a push may proceed over a lone coverage stop, because writing the checkpoint IS the repair", () => {
  expect(escapableDuringPush([stop(ROSTER, VIOLATION_ROSTER_COVERAGE)])).toBe(true);
  expect(escapableDuringPush([stop(ROSTER, VIOLATION_ROSTER_COVERAGE), stop(ROSTER, VIOLATION_ROSTER_COVERAGE)])).toBe(true);
});

test("a push may NEVER proceed over withholding, even alongside a coverage stop", () => {
  // The boundary Phase 1's ledger records as asserted but not pinned: no
  // scenario had I11 co-occurring with another hard stop, so mutating `.every`
  // to `.some` was caught by nothing. This is that scenario.
  expect(escapableDuringPush([stop(ROSTER, VIOLATION_CHAIN_WITHHELD)])).toBe(false);
  expect(
    escapableDuringPush([stop(ROSTER, VIOLATION_ROSTER_COVERAGE), stop(ROSTER, VIOLATION_CHAIN_WITHHELD)]),
  ).toBe(false);
  // And alongside a stop from a different invariant entirely.
  expect(escapableDuringPush([stop(ROSTER, VIOLATION_ROSTER_COVERAGE), stop("I3_chain")])).toBe(false);
});

test("the escape is an allow-list: a kind nobody has marked benign is not escapable", () => {
  expect(escapableDuringPush([stop(ROSTER)])).toBe(false);
  expect(escapableDuringPush([stop(ROSTER, "some_condition_added_later")])).toBe(false);
  expect(escapableDuringPush([stop("I11_roster_checkpoint_typo", VIOLATION_ROSTER_COVERAGE)])).toBe(false);
});

test("no hard stops at all is not 'blocked but proceeding'", () => {
  expect(escapableDuringPush([])).toBe(false);
});

test("a NOTICE carrying the coverage kind does not open the escape", () => {
  // Severity is part of the allow-list, so a notice that happens to share the
  // kind cannot be mistaken for the stop the escape exists for.
  expect(escapableDuringPush([{ id: ROSTER, severity: "notice", kind: VIOLATION_ROSTER_COVERAGE, detail: "x" }])).toBe(false);
});

// ---------------------------------------------------------------------------
// Total, and never the cause of a blank screen
// ---------------------------------------------------------------------------

test("surface never throws, whatever it is handed", () => {
  const junk = { violations: [null, 7, {}, { id: "x" }] } as unknown as Parameters<typeof surface>[0];
  expect(() => surface(junk)).not.toThrow();
  expect(() => surface({ violations: [] })).not.toThrow();
  expect(() => surface({ violations: [], unreadable: [] })).not.toThrow();
  expect(() => surface({ violations: [], error: null })).not.toThrow();
  expect(() => surface({ violations: [] } as unknown as Parameters<typeof surface>[0])).not.toThrow();
});

test("a clean run surfaces as nothing at all", () => {
  const s = surface({ violations: [], unreadable: [] });
  expect(s).toEqual({ halt: null, halts: [], notices: [], unreadable: null, badge: 0 });
});

test("an inconsistent state is its own halt, distinct from a tampered one", () => {
  const local = surface({ violations: [stop("I10_fx_prefix_monotone")] }).halt!;
  expect(local.kind).toBe(HALT_INCONSISTENT);
  expect(local.body).not.toBe(surface({ violations: [stop("I3_chain")] }).halt!.body);
});
