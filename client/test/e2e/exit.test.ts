/**
 * The Phase 1 EXIT TEST — spec §5, executed.
 *
 * > *headless client replays cleanly with invariants green across two
 * > concurrent writers, including a supersede-after-template-fix round-trip;
 * > ≥95% of alphas' genuine transaction mail parses over two consecutive weeks;
 * > zero drops without notice (every inbound email accounted for in diagnostics
 * > or quarantine).*
 *
 * One `test()` per numbered step of the plan, in order, against ONE stack: a
 * real `ledgerd`, a real Postgres, real mail over a real socket, real DKIM
 * against recorded DNS. The steps share state deliberately — this is one
 * scenario, not thirteen — so a failure in an early step cascades, and that is
 * the correct shape for a criterion that is a claim about the whole system.
 *
 * # What this file does NOT prove, stated up front
 *
 *   - **The two-week parse rate is not testable here.** It needs live alpha
 *     traffic and an operator's adjudication of every `tier='none'` arrival
 *     (Task 36). Step 15 asserts the INSTRUMENT — `ledgerd parse-rate` runs,
 *     refuses to print a rate it cannot justify, and names what it is waiting
 *     on. The criterion itself is Task D6's.
 *   - **"0 pushes" for held mail is proven in Go, not here.** Push is disabled
 *     in this stack, so an e2e assertion would be vacuous;
 *     `TestQuarantineHasNoPathToPush` parses every non-test file in
 *     internal/v2/quarantine and fails on any import path containing "push",
 *     which is strictly stronger. What is asserted here is the observable half:
 *     a held message appends NO op.
 *
 * # Two places the plan's numbers were wrong, and what is asserted instead
 *
 *  1. **An origin cannot be allowlisted before a message from it has been
 *     held.** `quarantine.Confirm` answers `ErrOriginUnproven` for a domain no
 *     held message carries a verified signature from — deliberately, so naming
 *     a domain is not a way to pre-trust it. So the plan's "deliver 20 messages
 *     from an allowlisted origin" has a precondition it does not name: the
 *     FIRST message of any origin is always quarantined and then promoted. The
 *     step-14 split is therefore 19 `arrival.appended` + 1 `arrival.quarantined`
 *     for ENBD, not 20 + 0. `inbound_total` is still exactly 23 and
 *     `unaccounted` is still exactly 0, which is the criterion.
 *  2. **The committed corpus holds TWO distinct ENBD messages, not 62**, so 20
 *     messages are 10 byte-distinct copies of each (Task 37 §8.1). A template
 *     fix therefore changes 10 transactions at once, not one — so step 10
 *     reprocesses a one-message WINDOW (`?from=&to=` on the admin route, which
 *     is a real operator control) rather than the whole template. That keeps
 *     `reprocess.superseded == 1` exact and honest.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Client, HardStopError, decodeWireRow } from "../../src/net/client";
import { openStore } from "../../src/store/open";
import { STREAM_COLD, STREAM_HOT } from "../../src/wire/blob";
import type { Violation } from "../../src/invariants/check";
import { clientFor, corpusFixtures, sendMail, startStack, stopStack, type Stack } from "./harness";

const ADMIN_DSN = process.env["LEDGER_TEST_POSTGRES_URL"] ?? "";

/** `go build` + a cold cluster + 23 SMTP transactions. */
const TIMEOUT = 300_000;

/** Both devices are the same account, so both log in as this subject. */
const SUBJECT = "dev:phase1-exit";

// ---------------------------------------------------------------------------
// The scenario's shared state
// ---------------------------------------------------------------------------

let s: Stack;
let a: Client; // dev-a
let b: Client; // dev-b
let inbox = "";

/** The 20 ENBD messages, in the order they are delivered. */
let enbd: Uint8Array[] = [];
/** The 3 forwarded (unknown-origin) messages. */
let fwd: Uint8Array[] = [];

/** sha256 hex of a raw message — the same identity `ingest.IngestID` computes. */
function ingestID(raw: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

const hard = (v: readonly Violation[]): Violation[] => v.filter((x) => x.severity === "hard_stop");
const ids = (v: readonly Violation[]): string[] => v.map((x) => x.id);

/**
 * An authenticated call that returns the STATUS rather than throwing.
 *
 * `Stack.json` throws on a non-2xx, which is right for every step that expects
 * success and wrong for step 8, whose whole assertion is a 409.
 */
async function raw(c: Client, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${s.httpURL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.sessionToken ?? ""}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// The ENBD template, and its correction
//
// The seed ENBD templates are deliberately NOT published in this scenario: v1
// below is a template that reads the WRONG number and declares the WRONG
// default currency, which is the state of the world step 10 exists to repair.
// Its patterns are otherwise the seed's, so the fix is one field's worth of
// change rather than a different template wearing the same id.
//
// v1's first amount pattern matches only the `AED 4,100.00` layout and captures
// `100.00` out of it; the second is the general one, so the other committed
// ENBD message still parses. Neither names a `ccy` group, so both take
// `default_currency` — USD. v2 restores the currency group and the whole
// number: `USD 100.00` -> `AED 4,100.00`, which changes the amount AND the
// currency, which is what makes the FX snapshot assertion in step 10 mean
// something.
//
// Measured, not assumed: mutating v2's `default_currency` to "USD" leaves every
// assertion green, because the AED comes from the CAPTURE and the default is
// unreachable once a `ccy` group matches. Mutating v2's pattern back to v1's
// turns step 10 red. The correction under test is the pattern.
// ---------------------------------------------------------------------------

const ENBD_TEMPLATE_ID = "e2e.enbd.transfer";

const enbdCommon = {
  id: ENBD_TEMPLATE_ID,
  bank: "enbd",
  normalizer_version: 1,
  match: { sender_domain: ["emiratesnbd.com"] },
  date_from: "body",
};

const enbdTail = [
  {
    field: "date",
    type: "date",
    source: "body",
    flags: ["i"],
    layouts: ["DD/Mon/YYYY hh:mm A", "DD/Mon/YYYY"],
    patterns: ["Transaction Date:\\n(?P<d>[^\\n]+)"],
  },
  {
    field: "merchant",
    type: "text",
    source: "body",
    flags: ["i"],
    patterns: ["Beneficiary Name:\\n(?P<v>[^\\n]+)"],
  },
  { field: "direction", type: "const", source: "body", value: "debit" },
];

const ENBD_V1 = {
  ...enbdCommon,
  version: 1,
  default_currency: "USD",
  extract: [
    {
      field: "amount",
      type: "amount",
      source: "body",
      flags: ["i"],
      patterns: [
        "Debit Amount:\\n[A-Z]{3} [0-9],(?P<amt>[0-9]{3}\\.[0-9]{2})",
        "Debit Amount:\\n[A-Z]{3} (?P<amt>[0-9][0-9,]{0,24}\\.[0-9]{2})",
      ],
    },
    ...enbdTail,
  ],
  required: ["amount", "direction", "date"],
};

const ENBD_V2 = {
  ...enbdCommon,
  version: 2,
  default_currency: "AED",
  extract: [
    {
      field: "amount",
      type: "amount",
      source: "body",
      flags: ["i"],
      patterns: ["Debit Amount:\\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\\.[0-9]{2})"],
    },
    ...enbdTail,
  ],
  required: ["amount", "direction", "date"],
};

/**
 * Asserts the server seeded a shipped bank template itself.
 *
 * This used to publish the file through the admin console, because nothing
 * seeded it: `internal/v2/tmpl/seed` had no production caller, so a fresh
 * `ledgerd` served with an empty templates table and this scenario had to
 * hand-install the parsers it needed. `runServe` now applies the seed right
 * after the migrations, so publishing here is a 409 (versions are immutable) —
 * and, more to the point, hand-installing would go on hiding the defect. What
 * this scenario needs from the DIB parsers is that they are LIVE, so that is
 * what it now checks.
 */
async function expectSeeded(id: string): Promise<void> {
  const { templates } = await s.admin<{
    templates: { id: string; version: number; status: string }[];
  }>("GET", "/admin/templates");
  const live = templates.find((t) => t.id === id && t.status === "published");
  expect(live, `${id} is not published; the server did not seed itself`).toBeDefined();
  expect(live!.version).toBe(1);
}

async function publish(def: any): Promise<void> {
  await s.admin("POST", "/admin/templates", { definition: def });
  await s.admin("POST", `/admin/templates/${def.id}/${def.version}/publish`);
}

// ---------------------------------------------------------------------------
// Diagnostics helpers
// ---------------------------------------------------------------------------

interface DiagRow {
  event: string;
  ingest_id: string;
  received_at: string;
  outcome: string;
  template_id: string;
  tier: string;
  sender_domain: string;
}

async function diagnostics(query = ""): Promise<DiagRow[]> {
  const out = await s.admin<{ rows: DiagRow[]; complete: boolean }>(
    "GET",
    `/admin/diagnostics?from=${encodeURIComponent(windowFrom)}&to=${encodeURIComponent(windowTo())}&limit=500${query}`,
  );
  expect(out.complete).toBe(true);
  return out.rows;
}

/** The accounting/diagnostics window: opened before the first delivery. */
let windowFrom = "";
const windowTo = (): string => new Date(Date.now() + 60_000).toISOString();

describe.skipIf(ADMIN_DSN === "")("Phase 1 exit criterion (spec §5)", () => {
  // ------------------------------------------------------------------
  // Step 1 — the stack
  // ------------------------------------------------------------------
  test("step 1: a fresh migrated database, ledgerd, and offline DKIM", async () => {
    s = await startStack();
    const health = await fetch(`${s.httpURL}/api/v1/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", db: "ok" });
    // --dns-fixtures is startStack's default; the assertion that it is IN USE
    // is every DKIM `pass` below, which no resolver on this box could produce
    // for a message signed years ago.
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 2 — one account, two writers, the second signed by the first
  // ------------------------------------------------------------------
  test("step 2: dev-b is enrolled by dev-a's key, not by a session token", async () => {
    a = clientFor(s, "dev-a");
    // The account does not exist yet, so this sign-in is the one that needs an
    // invite code; every later login on SUBJECT is a returning user and passes
    // nothing.
    await a.login("apple", SUBJECT, s.mintInvite("phase1-exit"));
    await a.enroll("dev-a");

    b = clientFor(s, "dev-b");
    expect(await b.login("apple", SUBJECT)).toBe(a.userId);

    // dev-b generates its own key and never exports the private half. dev-a
    // signs RegistrationMessage(nonce, "dev-b", pubB); a session alone cannot.
    const pubB = b.ensureWriterKey("dev-b");
    await a.enroll("dev-b", { signWith: "dev-a", publicKey: pubB });
    b.useWriter("dev-b");

    const roster = await a.roster();
    expect(roster.filter((w) => w.kind === "device").map((w) => w.writer_id).sort()).toEqual(["dev-a", "dev-b"]);

    // And the SERVER's own writer, before a single email has arrived. It is on
    // the roster from the account's first sign-in, not from its first delivery,
    // because a checkpoint names one head per roster writer and the first
    // checkpoint has to be able to name `ingest` at counter 0 / genesis. While
    // this was missing, no checkpoint said anything about the chain the user's
    // mail lands on — see step 16.
    const ingest = roster.find((w) => w.writer_id === "ingest");
    expect(ingest?.kind).toBe("ingest");
    expect(ingest?.revoked_at).toBeNull();
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 3 — the home currency and a rate, authored by dev-a
  // ------------------------------------------------------------------
  test("step 3: dev-a sets AED and a USD rate; dev-b pulls them", async () => {
    a.emit({ type: "home_currency_set", payload: { currency: "AED" } });
    a.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    const pushed = await a.push();
    expect(pushed.ops).toBeGreaterThanOrEqual(2);

    // dev-b was enrolled BEFORE this push, so the checkpoint the push carries
    // already names it — which is why this pull succeeds where roundtrip's
    // (enrol AFTER the first push) hard-stops. Both orders are correct; only
    // this one lets step 4 be about the checkpoint's CONTENT.
    const pulled = await b.pull();
    expect(hard(pulled.violations)).toHaveLength(0);
    expect(b.state().homeCurrency).toBe("AED");
    expect(b.state().rates.get("USD")).toBe(3672500n);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 4 — an explicit writer checkpoint, and what it must name
  // ------------------------------------------------------------------
  test("step 4: the checkpoint names every (roster writer x stream) pair", async () => {
    await a.checkpoint();
    await a.push();
    const pulled = await b.pull();
    expect(hard(pulled.violations)).toHaveLength(0);

    const roster = await a.roster();
    const want = roster
      .flatMap((w) => [`${w.writer_id}|hot`, `${w.writer_id}|cold`])
      .sort();
    const heads = b.state().checkpoints;
    expect(heads.map((h) => `${h.writer_id}|${h.stream}`).sort()).toEqual(want);
    // eslint-disable-next-line no-console
    console.log("step 4 checkpoint:", heads.map((h) => `${h.writer_id}|${h.stream}=${h.counter}/${h.hash.slice(0, 8)}`).join(" "));

    // Six pairs, not four: `ingest` is a roster writer like any other.
    expect(want).toEqual([
      "dev-a|cold", "dev-a|hot", "dev-b|cold", "dev-b|hot", "ingest|cold", "ingest|hot",
    ]);
    // Its chain is empty on a brand-new account — the COMMON case, not an edge
    // one — so it is named at counter 0 with the genesis hash and asserts
    // nothing false. This is what makes step 16's detection possible at all.
    for (const h of heads.filter((x) => x.writer_id === "ingest")) {
      expect(h.counter).toBe(0n);
      expect(h.hash).toBe("0".repeat(64));
    }

    // CHECKPOINT_NAMES_THE_ROSTER: dev-b has authored nothing, so it is named
    // at counter 0 with the genesis hash. A checkpoint built from OBSERVED
    // heads could not name it at all, and I11 would then hard-stop forever with
    // no checkpoint any device could emit able to clear it.
    for (const h of heads.filter((x) => x.writer_id === "dev-b")) {
      expect(h.counter).toBe(0n);
      expect(h.hash).toBe("0".repeat(64));
    }

    // The plan predicted "0 hard stops, 1 notice". The count is wrong and
    // cannot be right: I11 emits one notice per checkpoint head on the stream
    // this pull did NOT cover, so a hot check carries one per writer. What the
    // step is actually about is asserted instead — no I11 hard stop, and the
    // "no checkpoint yet" notice is gone because a checkpoint now exists.
    const v = await b.checkOnline();
    expect(hard(v)).toHaveLength(0);
    expect(v.filter((x) => x.id === "I11_roster_checkpoint" && x.severity === "hard_stop")).toHaveLength(0);
    expect(v.filter((x) => /no checkpoint yet/.test(x.detail))).toHaveLength(0);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 5 — 20 real corpus messages over SMTP
  // ------------------------------------------------------------------
  test("step 5: 20 messages append 20 hot and 20 cold ops on contiguous chains", async () => {
    windowFrom = new Date(Date.now() - 60_000).toISOString();

    // The parsers this scenario runs on. The ENBD one is deliberately drifted
    // (see the block comment) and is published here under its own id; the two
    // DIB seeds are the shipped files the SERVER installs at startup, and they
    // are what makes step 7's forwarded mail parse.
    //
    // Startup seeding also publishes the real enbd.transfer.v1 and
    // enbd.alert.v1. That does not undo the drift this scenario depends on:
    // the cascade takes templates in id order and `e2e.enbd.transfer` sorts
    // before both, so the drifted parser still wins the ENBD messages and step
    // 10's correction still has something to correct.
    await publish(ENBD_V1);
    await expectSeeded("dib.card.v1");
    await expectSeeded("dib.account.v1");

    inbox = await s.address(a);
    expect(inbox.endsWith(s.inboundSuffix)).toBe(true);

    enbd = corpusFixtures("enbd-stable", 20);

    // --- the bootstrap, which the plan does not name ---------------------
    //
    // No origin can be confirmed until a message from it is HELD: Confirm
    // answers `origin_unproven` otherwise, on purpose, so that naming a domain
    // is not a way to pre-trust it. So the first ENBD message quarantines, is
    // confirmed, and is re-ingested — and only then is the origin allowlisted
    // for the other nineteen.
    expect((await sendMail(s, inbox, enbd[0]!)).code).toBe(250);
    const held = await s.json<{ items: { ingest_id: string; outer_domain: string; dkim: string }[] }>(
      a, "GET", "/api/v1/quarantine",
    );
    expect(held.items).toHaveLength(1);
    expect(held.items[0]!.outer_domain).toBe("emiratesnbd.com");
    expect(held.items[0]!.dkim).toBe("pass");
    expect(held.items[0]!.ingest_id).toBe(ingestID(enbd[0]!));

    const confirmed = await s.json<{ ingest_ids: string[]; reingest?: { appended: number } }>(
      a, "POST", "/api/v1/quarantine/confirm", { domain: "emiratesnbd.com", scope: "outer" },
    );
    expect(confirmed.ingest_ids).toEqual([ingestID(enbd[0]!)]);
    // THE SEAM: confirming a sender must also re-ingest what it releases.
    // Without it the mail the user just vouched for sits held until it expires.
    expect(confirmed.reingest?.appended).toBe(1);

    // --- the other nineteen, straight down the trusted lane --------------
    for (let i = 1; i < enbd.length; i++) {
      // A deliberate gap around the message step 10 reprocesses, so its
      // one-message window cannot share a millisecond with a neighbour.
      if (i === 2 || i === 3) await Bun.sleep(25);
      expect((await sendMail(s, inbox, enbd[i]!)).code).toBe(250);
    }

    const after = await s.json<{ items: unknown[]; action_needed: number }>(a, "GET", "/api/v1/quarantine");
    expect(after.items).toHaveLength(0);
    expect(after.action_needed).toBe(0);

    // Hot: 20 rows on the ingest chain, counters 1..20, no gaps.
    await a.pull();
    const hot = a
      .rowsFor(STREAM_HOT)
      .map(decodeWireRow)
      .filter((r) => r.writer_id === "ingest");
    expect(hot).toHaveLength(20);
    expect(hot.map((r) => r.writer_counter)).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i + 1)));

    // Cold: an independent chain of its own, also 1..20 (Decision 13).
    // `pullColdHashes` verifies the list is contiguous from the pinned head
    // before it pins anything, so the head landing on 20 IS the 1..20 claim.
    await a.pullColdHashes();
    expect(a.pinnedHead("ingest", STREAM_COLD).counter).toBe(20n);

    // Every one of them parsed at the template tier, so step 10 has something
    // to correct rather than something to invent.
    const rows = await diagnostics("&event=arrival&outcome=appended");
    expect(rows).toHaveLength(19); // + the bootstrap, whose append is a reprocess
    expect(rows.every((r) => r.template_id === ENBD_TEMPLATE_ID && r.tier === "template")).toBe(true);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 6 — the hot-only pull (spec §3.3:70)
  // ------------------------------------------------------------------
  test("step 6: a hot-only pull is complete, gapped, and invariant-clean", async () => {
    const before = b.cursor(STREAM_HOT);
    const pulled = await b.pull(); // no --stream: hot only
    expect(pulled.stream).toBe(STREAM_HOT);
    expect(pulled.rows).toBe(20);
    expect(pulled.complete).toBe(true);

    // Not one cold byte.
    expect(b.cursor(STREAM_COLD)).toBe(0n);
    expect(b.rowsFor(STREAM_COLD)).toHaveLength(0);

    // Strictly increasing, and NOT contiguous: the cold rows occupy the gaps.
    // A design in which hot-only sync were impossible would fail here; a design
    // that pulled both streams could not see the property at all.
    const seqs = b.rowsFor(STREAM_HOT).map((r) => decodeWireRow(r).seq).filter((q) => q > before);
    expect(seqs).toHaveLength(20);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! > seqs[i - 1]!).toBe(true);
    expect(seqs[seqs.length - 1]! - seqs[0]! + 1n).toBeGreaterThan(BigInt(seqs.length));

    const v = await b.checkOnline();
    expect(hard(v)).toHaveLength(0);
    expect(ids(v.filter((x) => x.severity === "hard_stop"))).not.toContain("I1_stream_cursor_monotone");
    expect(ids(v.filter((x) => x.severity === "hard_stop"))).not.toContain("I2_writer_counters");

    // Nothing about the cold chain has been pinned yet — step 11 is where that
    // advances, and it can only be seen as an advance from here.
    expect(b.pinnedHead("ingest", STREAM_COLD).counter).toBe(0n);

    // All twenty transactions, one live per ingest id.
    const state = b.state();
    expect(state.txns.size).toBe(20);
    expect(state.liveByIngestID.size).toBe(20);
    for (const raw_ of enbd) expect(state.liveByIngestID.has(ingestID(raw_))).toBe(true);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 7 — quarantine, confirmation, re-ingest
  // ------------------------------------------------------------------
  test("step 7: 3 unknown-origin messages are held, then confirmed into the chains", async () => {
    fwd = corpusFixtures("unknown-origin", 3);
    const opsBefore = b.rowsFor(STREAM_HOT).length;

    for (const raw_ of fwd) expect((await sendMail(s, inbox, raw_)).code).toBe(250);

    const held = await s.json<{ items: { ingest_id: string; inner_domain: string; attested: boolean }[]; action_needed: number }>(
      a, "GET", "/api/v1/quarantine",
    );
    expect(held.items).toHaveLength(3);
    expect(held.action_needed).toBe(3);
    expect(held.items.map((i) => i.ingest_id).sort()).toEqual(fwd.map(ingestID).sort());
    // The outer origin is a forwarder; only the surviving inner signature names
    // the bank, which is exactly why these can only be confirmed as `inner`.
    expect(held.items.every((i) => i.attested && i.inner_domain === "dib.ae")).toBe(true);

    // Held mail appends NOTHING: no op, and therefore nothing to sync.
    expect((await b.pull()).rows).toBe(0);
    expect(b.rowsFor(STREAM_HOT)).toHaveLength(opsBefore);

    const confirmed = await s.json<{ ingest_ids: string[]; reingest?: { examined: number; appended: number } }>(
      a, "POST", "/api/v1/quarantine/confirm", { domain: "dib.ae", scope: "inner" },
    );
    expect(confirmed.ingest_ids.sort()).toEqual(fwd.map(ingestID).sort());
    expect(confirmed.reingest?.examined).toBe(3);
    expect(confirmed.reingest?.appended).toBe(3);

    const empty = await s.json<{ items: unknown[] }>(a, "GET", "/api/v1/quarantine");
    expect(empty.items).toHaveLength(0);

    // Three `event='reprocess'` rows with `outcome='appended'` — plus the one
    // the step-5 bootstrap produced, which is the same mechanism.
    const re = await diagnostics("&event=reprocess&outcome=appended");
    expect(re.map((r) => r.ingest_id).sort()).toEqual([...fwd.map(ingestID), ingestID(enbd[0]!)].sort());

    // And they are ops now.
    expect((await b.pull()).rows).toBe(3);
    const state = b.state();
    expect(state.txns.size).toBe(23);
    for (const raw_ of fwd) expect(state.liveByIngestID.has(ingestID(raw_))).toBe(true);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 8 — the forwarder refusal (§3.2:51)
  // ------------------------------------------------------------------
  test("step 8: a forwarder cannot be confirmed as an outer origin", async () => {
    const res = await raw(a, "POST", "/api/v1/quarantine/confirm", { domain: "gmail.com", scope: "outer" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("forwarder_domain");
    // The refusal teaches: it names the inner scope as the route to take.
    expect(res.body.detail).toMatch(/inner origin/);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 9 — two concurrent writers
  // ------------------------------------------------------------------
  let forkTxn = "";
  let winner = "";
  test("step 9: a same-parent fork resolves identically on both devices, and is surfaced", async () => {
    await a.pull();
    // The shared prefix: both devices see the same transaction at version 1.
    forkTxn = b.state().liveByIngestID.get(ingestID(enbd[1]!))!;
    expect(forkTxn).toBeDefined();
    expect(a.state().txns.get(forkTxn)!.version).toBe(1);
    expect(b.state().txns.get(forkTxn)!.version).toBe(1);

    // Both offline, both naming parent version 1.
    const opB = b.emit({
      type: "txn_categorized",
      payload: { category: "dining", needs_review: false },
      entity: { kind: "txn", id: forkTxn },
      parentVersion: 1,
    });
    // authored_at is the tiebreak and it has millisecond resolution, so the two
    // ops are separated deliberately: a tie would be resolved by writer_id and
    // the test would assert a different winner on a fast machine.
    await Bun.sleep(5);
    const opA = a.emit({
      type: "txn_categorized",
      payload: { category: "groceries", needs_review: false },
      entity: { kind: "txn", id: forkTxn },
      parentVersion: 1,
    });
    expect(opA.authored_at > opB.authored_at).toBe(true);
    winner = "groceries"; // dev-a's, by the later authored_at

    await b.push();
    await a.push();
    await a.pull();
    await b.pull();

    // Same log, same fold, same answer.
    expect(a.state().txns.get(forkTxn)!.category).toBe(winner);
    expect(b.state().txns.get(forkTxn)!.category).toBe(winner);
    expect(a.state().txns.get(forkTxn)!.version).toBe(3);
    expect(b.state().txns.get(forkTxn)!.version).toBe(3);

    // Surfaced, not silent — exactly once, on both devices.
    for (const c of [a, b]) {
      const forks = c.state().forks.filter((f) => f.entity.id === forkTxn);
      expect(forks).toHaveLength(1);
      expect(forks[0]!.winner_op).toBe(opA.op_id);
      expect(forks[0]!.loser_op).toBe(opB.op_id);
    }
    // eslint-disable-next-line no-console
    console.log("step 9 fork notice:", JSON.stringify(a.state().forks, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 10 — supersede after a template fix
  // ------------------------------------------------------------------
  test("step 10: a corrected template supersedes one transaction, recomputed at its own position", async () => {
    const target = ingestID(enbd[2]!);
    const arrivals = (await diagnostics("&event=arrival")).filter((r) => r.outcome === "appended" || r.outcome === "quarantined");
    const mine = arrivals.find((r) => r.ingest_id === target);
    expect(mine).toBeDefined();

    // The one-message window. The next arrival's own instant is the exclusive
    // upper bound, so the reprocess covers exactly this message.
    const later = arrivals
      .map((r) => r.received_at)
      .filter((t) => Date.parse(t) > Date.parse(mine!.received_at))
      .sort()[0];
    expect(later).toBeDefined();

    const oldTxnID = b.state().liveByIngestID.get(target)!;
    const old = b.state().txns.get(oldTxnID)!;
    expect(old.currency).toBe("USD");
    expect(old.amount_minor).toBe(10_000n); // "100.00", read out of "AED 4,100.00"
    const beforeHome = old.amount_home_minor!;
    expect(beforeHome).toBe(36_725n); // 100.00 USD at 3.6725

    await publish(ENBD_V2);
    const rep = await s.admin<{ messages: number; examined: number; superseded: number; unchanged: number; failed: number }>(
      "POST",
      `/admin/templates/${ENBD_TEMPLATE_ID}/2/reprocess` +
        `?from=${encodeURIComponent(mine!.received_at)}&to=${encodeURIComponent(later!)}`,
    );
    expect(rep.messages).toBe(1);
    expect(rep.examined).toBe(1);
    expect(rep.superseded).toBe(1);
    expect(rep.failed).toBe(0);

    await a.pull();
    await b.pull();

    for (const c of [a, b]) {
      const state = c.state();
      // Exactly one LIVE transaction for that ingest id, on both devices.
      const liveID = state.liveByIngestID.get(target)!;
      expect(liveID).not.toBe(oldTxnID);
      expect(state.txns.get(oldTxnID)!.superseded_by).not.toBeNull();
      const live = state.txns.get(liveID)!;
      expect(live.currency).toBe("AED");
      expect(live.amount_minor).toBe(410_000n);
      // The FX snapshot was computed FRESH at the supersede's own log position:
      // AED is the home currency, so the identity value. Inheriting the
      // predecessor's would give 36,725.
      expect(live.amount_home_minor).toBe(410_000n);
      expect(live.amount_home_minor).not.toBe(beforeHome);
    }
    // eslint-disable-next-line no-console
    console.log(
      `step 10 snapshot: ${old.currency} ${old.amount_minor} home ${beforeHome} -> ` +
        `AED 410000 home ${b.state().txns.get(b.state().liveByIngestID.get(target)!)!.amount_home_minor}`,
    );
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 11 — cold verification
  // ------------------------------------------------------------------
  test("step 11: cold hashes pin the chain, an honest range verifies, a corrupted one does not", async () => {
    // The pinned head advanced from genesis (asserted at step 6) to the whole
    // cold chain. dev-b reached it through `push`, which pins the cold hashes
    // before it attests them — the CHECKPOINT contract, not a convenience.
    expect(b.pinnedHead("ingest", STREAM_COLD).counter).toBe(23n);
    await b.pullColdHashes(); // idempotent: an existing pin is never overwritten
    expect(b.pinnedHead("ingest", STREAM_COLD).counter).toBe(23n);

    // The honest fetch: every body hashes to the entry that was pinned for it,
    // which is what `verifyFetchedRange` accepts a range on.
    const cold = await b.pull({ stream: STREAM_COLD });
    expect(cold.rows).toBe(23);
    expect(hard(cold.violations)).toHaveLength(0);
    // A cold blob carries no ops (I16): the fold is unchanged by a cold pull.
    expect(b.state().txns.size).toBe(24); // 23 live + the retired predecessor
    expect(b.state().liveByIngestID.size).toBe(23);

    // The corrupted re-fetch, on a third profile of the same account so the
    // corruption lands on a range nothing has accepted yet.
    const corrupt = { on: false };
    const c = new Client({
      store: openStore(join(s.dir, "state"), "dev-c"),
      server: s.httpURL,
      fetch: (async (input: any, init?: any) => {
        const res = await fetch(input, init);
        const url = typeof input === "string" ? input : String(input?.url ?? "");
        if (!corrupt.on || !url.includes("/api/v1/sync?") || !url.includes("stream=cold")) return res;
        const body = (await res.json()) as { rows?: { blob: string }[] };
        const row = body.rows?.[0];
        if (row !== undefined) {
          const bytes = Buffer.from(row.blob, "base64");
          bytes[0] = bytes[0]! ^ 0xff; // one flipped byte, nothing else
          row.blob = bytes.toString("base64");
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    expect(await c.login("apple", SUBJECT)).toBe(a.userId);
    await c.pull();
    expect(c.pinnedHead("ingest", STREAM_COLD).counter).toBe(0n);
    const pins = await c.pullColdHashes();
    expect(pins.pinned).toBe(23);
    expect(c.pinnedHead("ingest", STREAM_COLD).counter).toBe(23n);

    corrupt.on = true;
    await expect(c.pull({ stream: STREAM_COLD })).rejects.toThrow(/I3b_cold_hash_list/);
    // And nothing was kept: a refused page persists no row and no cursor.
    expect(c.cursor(STREAM_COLD)).toBe(0n);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 12 — every invariant, on both devices
  // ------------------------------------------------------------------
  test("step 12: checkAll reports zero hard stops on both devices", async () => {
    for (const [name, c] of [["dev-a", a], ["dev-b", b]] as const) {
      for (const stream of [STREAM_HOT, STREAM_COLD] as const) {
        const v = c.check(stream, await c.roster());
        // eslint-disable-next-line no-console
        console.log(`step 12 ${name} ${stream}: ${v.length} finding(s)`);
        for (const x of v) console.log(`  [${x.severity}] ${x.id}: ${x.detail}`);
        expect(hard(v)).toHaveLength(0);
      }
    }
    // I14 reports unconditionally, so a green run is never an empty list.
    const v = await a.checkOnline();
    expect(ids(v)).toContain("I14_forks_surfaced");

    // The gap the first run of this test found, now closed and pinned from the
    // other side: the roster lists the server's own writer, so every device's
    // checkpoint covers the ingest chain and NOTHING reports an unlisted
    // writer. Step 16 is the positive proof that the coverage does work.
    expect(v.some((x) => /roster does not list/.test(x.detail))).toBe(false);
    expect((await a.roster()).some((w) => w.writer_id === "ingest")).toBe(true);

    // The corpus is 10 byte-distinct copies of each of 2 real messages
    // (Task 37 §8.1), so the fingerprint heuristic fires 18 times. Notices,
    // and both rows stay live — asserted rather than tolerated, because a
    // hard stop here would be the wrong answer to a genuine duplicate.
    expect(a.state().anomalies.every((x) => x.kind === "possible_duplicate")).toBe(true);
    expect(a.state().liveByIngestID.size).toBe(23);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 13 — the server's own verifier
  // ------------------------------------------------------------------
  test("step 13: ledgerd verify reports zero findings", async () => {
    const out = s.run(["verify", "--json"]);
    // eslint-disable-next-line no-console
    if (out.exitCode !== 0) console.log("ledgerd verify:", out.stdout, out.stderr);
    expect(out.exitCode).toBe(0);
    // `findings` is a Go nil slice when there are none, so it marshals to null
    // rather than []. The claim is "nothing was found", not "the field is an
    // array".
    const report = JSON.parse(out.stdout) as { ok: boolean; findings: unknown[] | null };
    expect(report.findings ?? []).toEqual([]);
    expect(report.ok).toBe(true);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 14 — the accounting equation
  // ------------------------------------------------------------------
  test("step 14: every inbound email is accounted for", async () => {
    const acc = await s.admin<{
      inbound_total: number;
      arrival: Record<string, number>;
      reprocess: Record<string, number>;
      unaccounted: number;
      balanced: boolean;
      ok: boolean;
      discarded: number;
      findings: unknown[] | null;
    }>("GET", `/admin/accounting?from=${encodeURIComponent(windowFrom)}&to=${encodeURIComponent(windowTo())}`);

    // eslint-disable-next-line no-console
    console.log("step 14 accounting:", JSON.stringify(acc));

    // 20 ENBD + 3 forwarded. ARRIVALS ONLY: the four re-ingests are counted in
    // the reprocess split beside it, never folded in.
    expect(acc.inbound_total).toBe(23);

    // The plan expected 20/3. It cannot be: an origin cannot be allowlisted
    // before a message from it has been held, so ENBD's first message is
    // quarantined and promoted like any other unknown sender. See the header.
    expect(acc.arrival["appended"]).toBe(19);
    expect(acc.arrival["quarantined"]).toBe(4);
    expect(acc.arrival["rejected"]).toBe(0);
    expect(acc.arrival["duplicate"]).toBe(0);

    expect(acc.reprocess["appended"]).toBe(4); // 3 forwarded + the ENBD bootstrap
    expect(acc.reprocess["superseded"]).toBe(1);

    expect(acc.unaccounted).toBe(0);
    expect(acc.discarded).toBe(0);
    expect(acc.balanced).toBe(true);
    expect(acc.ok).toBe(true);
    expect(acc.findings ?? []).toEqual([]);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 15 — the instrument for the one criterion a test cannot meet
  // ------------------------------------------------------------------
  test("step 15: parse-rate refuses to print a rate it cannot justify, and names what it needs", async () => {
    const out = s.run(["parse-rate", "--from", windowFrom, "--to", windowTo()]);
    // eslint-disable-next-line no-console
    console.log("step 15 parse-rate:\n" + out.stdout + out.stderr);
    // Every message in this scenario parsed, so there is nothing to adjudicate.
    // What is asserted is that the instrument RUNS against a real database AND
    // that it REFUSES to certify the criterion off this scenario: the window is
    // about two minutes and holds 23 messages, which cannot evidence "≥95% over
    // two consecutive weeks" however well those 23 parsed.
    //
    // This assertion used to be `exitCode === 0` with the tool printing
    // `exit gate (>= 95%) true`. That was the instrument overclaiming, and a
    // release checklist reading the status code would have been told the ship
    // criterion was met by a two-minute test run.
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout).toMatch(/exit gate \(>= 95%\)\s+false/);
    expect(out.stdout).toMatch(/NOT MET: the window is/);
    expect(out.stdout).toMatch(/NOT MET: 23 message\(s\)/);
    // And it still names what it cannot see, on every run.
    expect(out.stdout).toMatch(/what this number CANNOT see/);
  }, TIMEOUT);

  // ------------------------------------------------------------------
  // Step 16 — the ingest chain is tamper-evident, positively
  // ------------------------------------------------------------------
  //
  // Every DEVICE chain is covered because the device that owns it re-signs its
  // own head. The ingest chain is written by the server and is the one chain a
  // user cannot re-derive from any device they hold — and it is where their
  // bank mail lands. Covering it is the whole point of putting `ingest` on the
  // roster; this step proves the cover actually catches something.
  //
  // The threat is deliberately the quiet one: not a corrupted blob, but a
  // server that serves FEWER rows than it has. A truncated tail leaves a chain
  // that is still dense from 1, so I2 (row contiguity) and I3 (hash chain) are
  // both satisfied by what was served, and the materialized state looks
  // entirely plausible — here it is 23 transactions with the step-10 supersede
  // simply absent, which reads as "that correction never happened".
  test("step 16: a truncated ingest chain behind a signed checkpoint is DETECTED", async () => {
    // A fresh checkpoint, so the attestation names the head as it is now.
    await a.checkpoint();
    await a.push();
    const attested = a.state().checkpoints.find((c) => c.writer_id === "ingest" && c.stream === STREAM_HOT)!;
    expect(attested.counter).toBeGreaterThan(0n);

    /** A client on this account whose server withholds ingest rows at/above `from`. */
    const withholding = (profile: string, from: bigint | null): Client =>
      new Client({
        store: openStore(join(s.dir, "state"), profile),
        server: s.httpURL,
        fetch: (async (input: any, init?: any) => {
          const res = await fetch(input, init);
          const url = typeof input === "string" ? input : String(input?.url ?? "");
          if (from === null || !url.includes("/api/v1/sync?") || !url.includes("stream=hot")) return res;
          const body = (await res.json()) as { rows?: { writer_id: string; writer_counter: string }[] };
          body.rows = (body.rows ?? []).filter(
            (r) => !(r.writer_id === "ingest" && BigInt(r.writer_counter) >= from),
          );
          return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        }) as typeof fetch,
      });

    // The control, first: an honest server and the same code path. Without it a
    // hard stop below could be anything about a fresh profile.
    const honest = withholding("dev-e-honest", null);
    expect(await honest.login("apple", SUBJECT)).toBe(a.userId);
    const clean = await honest.pull();
    expect(hard(clean.violations)).toHaveLength(0);
    expect(honest.pinnedHead("ingest", STREAM_HOT).counter).toBe(attested.counter);

    // Now the same pull against a server withholding exactly the attested head.
    const victim = withholding("dev-f-truncated", attested.counter);
    expect(await victim.login("apple", SUBJECT)).toBe(a.userId);

    let caught: HardStopError | undefined;
    try {
      await victim.pull();
    } catch (err) {
      caught = err as HardStopError;
    }
    expect(caught).toBeInstanceOf(HardStopError);

    const stops = caught!.violations.filter((x) => x.severity === "hard_stop");
    // eslint-disable-next-line no-console
    console.log("step 16 detection:", stops.map((x) => `${x.id}/${x.kind ?? "-"}: ${x.detail}`).join(" | "));

    const withheld = stops.find((x) => x.id === "I11_roster_checkpoint");
    expect(withheld).toBeDefined();
    expect(withheld!.kind).toBe("chain_withheld");
    expect(withheld!.detail).toContain("ingest|hot");
    expect(withheld!.detail).toContain(`claims counter ${attested.counter}`);

    // I11 is the ONLY thing that saw it, which is the point: a truncated tail
    // is dense, so row contiguity, the hash chain and the fold all accept it.
    expect(stops.map((x) => x.id)).toEqual(["I11_roster_checkpoint"]);

    // And a refused pull persists nothing: the victim keeps no half-truth.
    expect(victim.cursor(STREAM_HOT)).toBe(0n);
  }, TIMEOUT);

  test("teardown: nothing is left running", async () => {
    await stopStack(s);
  }, TIMEOUT);
});
