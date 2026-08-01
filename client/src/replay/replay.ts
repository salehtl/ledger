/**
 * The replay engine: causality, fork resolution and ingest-id supersede
 * (spec §3.3), plus the positional rate heads FX snapshots are computed against
 * (spec §3.7).
 *
 * # The one claim this file has to earn
 *
 * **Every replica folding the same log reaches the same state.** There is no
 * arbiter — two of the user's own devices converge or they silently disagree
 * about the user's money. Four rules do all the work, and each is one call site
 * away from being wrong:
 *
 *   1. **`seq` is the order.** The server assigns it at append, gap-free per
 *      user, so it is a total order every replica sees identically. Everything
 *      folds by `seq` and nothing folds by wall clock. {@link applyOp} refuses
 *      to go backwards rather than trusting its caller, because "the fold is in
 *      seq order" is a precondition no test can check after the fact.
 *   2. **`authored_at` decides forks and nothing else.** It is the user's later
 *      intent, which is the right answer *when two ops name the same parent* and
 *      the wrong answer everywhere else — an offline device's op is authored
 *      early and sequenced late, and applying it late is correct.
 *   3. **A version is a function of the total order.** A fork advances the head
 *      version whichever side wins, so version numbering never depends on which
 *      device's op happened to be uploaded first.
 *   4. **Nothing is silently dropped.** Every refusal lands in `state.anomalies`
 *      or `state.forks` with its `seq`. Neither ever stops a sync: spec §3.3:68
 *      reserves hard stops for chain breaks and unknown-newer schema versions.
 *
 * # Why `writer_id` is a parameter and not a field
 *
 * Fork ties break on `writer_id` (spec §3.3:66), and an {@link Op} does not
 * carry one — writer identity lives on the blob, bound into its AAD, and is
 * therefore something the server cannot reassign and a client cannot claim.
 * Replay takes it alongside `seq` as {@link LogEntry}. Reading it from a payload
 * field instead would let any writer author ops "as" the ingest writer and win
 * every tie against it. (The plan's `applyOp(state, op, seq)` signature omits
 * it; see the task report.)
 *
 * # What this file deliberately does NOT do
 *
 * **The FX arithmetic.** `rate_set` / `rate_unset` / `home_currency_set` are
 * folded here — they are parent-free, append-only, positional facts, and getting
 * their *heads* right, along with which ops are refused, is replay's job — but
 * `convert()` and the freeze/backfill of `amount_home_minor` live in `fx.ts`.
 * The seam is `markPending`/`clearPending` (in `state.ts`, with the field they
 * maintain): this file keeps `state.pendingByCurrency` exact — every live,
 * unfrozen transaction, filed under its own currency, removed the moment it is
 * superseded — and `fx.ts` drains it. None of the FX hooks takes a `seq`,
 * because the position they act at is the position this fold has reached; see
 * the note in `fx.ts` on why that is the point rather than an omission.
 */

import {
  SCHEMA_VERSION,
  UnknownNewerVersionError,
  authoredAtMs,
  canonicalTime,
  compareUTF8,
  decodeBlobOps,
  decodeCheckpointPayload,
  parseDecimal,
  parseInstantMs,
  validateOp,
  type Op,
  type OpType,
} from "../wire/op";
import { freezeIfPossible, onHomeCurrencySet, onRateSet, onRateUnset } from "./fx";
import {
  clearPending,
  emptyState,
  entityKey,
  fingerprint,
  markPending,
  type ParseTier,
  type Split,
  type State,
  type Txn,
} from "./state";

export { emptyState, fingerprint } from "./state";

/**
 * The writer id the server's own ingest pipeline writes under. Mirrors
 * `oplog.IngestWriterID`; it is a reserved id (`auth.IngestWriterID`), which is
 * what makes it usable as the provenance signal.
 */
export const INGEST_WRITER_ID = "ingest";

/**
 * One op at its position in the log.
 *
 * `seq` is the server-assigned total order and `writer_id` is the blob's writer.
 * Both are row/AAD metadata rather than op fields, which is the point: they are
 * the parts of a position an author cannot choose.
 *
 * A blob is one `op_log` row, so **every op in a blob shares one `seq`**; the
 * full order is `(seq, index within the blob)`, which for a flattened array is
 * `(seq, array index)`. That is why {@link applyOp} requires `seq` to be
 * non-decreasing rather than strictly increasing.
 */
export interface LogEntry {
  op: Op;
  seq: bigint;
  writer_id: string;
}

/** One opened (plaintext) blob body at its position, for {@link foldBlobs}. */
export interface PositionedBlob {
  pos: { writer_id: string; stream: string; writer_counter: bigint; seq: bigint };
  body: Uint8Array;
}

/**
 * The caller supplied a position the fold cannot use: a `seq` behind the folded
 * prefix, or a blob with no writer. A programming error in the sync layer, not a
 * data condition — and a loud one, because a fold that silently accepted a
 * reordered prefix, or resolved a fork against an unattributed op, would produce
 * a state no other replica can reproduce. That is the one failure this engine
 * exists to prevent, so it is never downgraded to an anomaly.
 */
export class ReplayOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayOrderError";
  }
}

/** An op whose payload cannot be read as its type requires. Becomes an anomaly. */
class PayloadError extends Error {}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Folds entries in ascending `seq` into `s` (mutating it) and returns it. */
export function fold(entries: LogEntry[], s: State = emptyState()): State {
  for (const e of entries) applyOp(s, e);
  return s;
}

/**
 * Decodes and folds opened blob bodies, setting aside the ones that will not
 * decode (spec §3.3:68).
 *
 * The two error classes are handled in opposite ways on purpose:
 * {@link UnknownNewerVersionError} propagates — the client must stop syncing and
 * demand an upgrade rather than fold a half-understood log into money — while
 * anything else lands in `state.unreadable` with a reason and the fold carries
 * on. One bad blob must never strand a device.
 *
 * Bodies are the PLAINTEXT bodies, i.e. what `openBlob` returns. Chain
 * verification, AAD checks and bucket checks happen before this, in the sync
 * layer; this function's only claim is about decode and fold.
 */
export function foldBlobs(blobs: PositionedBlob[], s: State = emptyState()): State {
  for (const b of blobs) {
    // Strictly increasing, and checked against the STATE rather than a local, so
    // the guard holds across successive calls too: one blob is one op_log row,
    // so two blobs can never share a seq the way two ops inside one blob do.
    if (b.pos.seq <= s.cursors.hot) {
      throw new ReplayOrderError(
        `blob at seq ${b.pos.seq} does not follow ${s.cursors.hot}: one blob is one row, one seq`,
      );
    }
    // Advanced BEFORE the decode, so a blob that will not decode still consumes
    // its position. Leaving the cursor behind on the set-aside path would let
    // the same seq be re-delivered later with different content and folded as if
    // it were new — which is rule 8's own path, so it is the one place the guard
    // most has to hold.
    s.cursors.hot = b.pos.seq;
    s.appliedAtCursor.clear();
    let ops: Op[];
    try {
      ops = decodeBlobOps(b.body);
    } catch (err) {
      if (err instanceof UnknownNewerVersionError) throw err;
      s.unreadable.push({
        writer_id: b.pos.writer_id,
        stream: b.pos.stream,
        writer_counter: b.pos.writer_counter,
        seq: b.pos.seq,
        reason: (err as Error).message,
      });
      continue;
    }
    for (const op of ops) applyOp(s, { op, seq: b.pos.seq, writer_id: b.pos.writer_id });
  }
  return s;
}

/**
 * Applies one op at its position. Mutates `s`.
 *
 * Throws only for the two hard stops — an unknown newer schema version, and a
 * caller folding out of order. Everything else that can go wrong with an op is
 * recorded in `s.anomalies` and the fold continues.
 */
export function applyOp(s: State, e: LogEntry): void {
  const { op, seq, writer_id } = e;
  if (typeof seq !== "bigint" || seq < 1n) {
    throw new ReplayOrderError(`seq must be a positive bigint, got ${String(seq)}`);
  }
  if (seq < s.cursors.hot) {
    throw new ReplayOrderError(
      `op ${op.op_id} arrives at seq ${seq}, behind the folded prefix at ${s.cursors.hot}: replay folds by seq`,
    );
  }
  if (typeof writer_id !== "string" || writer_id === "") {
    throw new ReplayOrderError(`op ${op.op_id} at seq ${seq} names no writer, so no fork involving it can be resolved`);
  }
  // Checked before validateOp so an op that is BOTH newer and malformed still
  // hard-stops rather than being set aside as an anomaly.
  if (typeof op.v === "number" && op.v > SCHEMA_VERSION) {
    throw new UnknownNewerVersionError(`op ${op.op_id} is v${op.v}, this build supports v${SCHEMA_VERSION}`);
  }

  if (seq > s.cursors.hot) {
    s.cursors.hot = seq;
    s.appliedAtCursor.clear();
  } else if (s.appliedAtCursor.has(op.op_id)) {
    // The ordering guard has to admit `seq === cursors.hot`, because every op in
    // a blob shares one seq — so it cannot, by itself, tell a second op in the
    // same blob from the same page delivered twice. Without this, re-folding a
    // page takes the entity to a version nothing authored and forks it against
    // ITSELF, complete with a notice naming one op as both winner and loser.
    // A well-behaved caller resumes from `seq > cursor` and never sees this.
    anomaly(s, seq, "duplicate_delivery", `${op.op_id} was already applied at seq ${seq}`);
    return;
  }
  s.appliedAtCursor.add(op.op_id);

  // decodeBlobOps validates already; this catches an op assembled in code and
  // costs nothing on the decode path. It is an anomaly rather than a throw
  // because a malformed op is a data condition, and data conditions never stop
  // a sync.
  try {
    validateOp(op);
  } catch (err) {
    if (err instanceof UnknownNewerVersionError) throw err;
    anomaly(s, seq, "invalid_op", `${op.type} ${op.op_id}: ${(err as Error).message}`);
    return;
  }

  try {
    dispatch(s, e);
  } catch (err) {
    if (err instanceof PayloadError) {
      anomaly(s, seq, "invalid_payload", `${op.type} ${op.op_id}: ${err.message}`);
      return;
    }
    throw err;
  }
}

function dispatch(s: State, e: LogEntry): void {
  switch (e.op.type) {
    case "rate_set":
      return applyRateSet(s, e);
    case "rate_unset":
      return applyRateUnset(s, e);
    case "home_currency_set":
      return applyHomeCurrencySet(s, e);
    case "writer_checkpoint":
      return applyCheckpoint(s, e);
    default:
      return applyCausal(s, e);
  }
}

// ---------------------------------------------------------------------------
// Parent-free ops (spec §3.7:126): append-only positional facts, no forks
// ---------------------------------------------------------------------------

/**
 * `home_currency_set` is one-shot and immutable (spec §3.7:122): changing it
 * later would re-denominate every already-frozen snapshot in the log, which the
 * beta does not solve. A second one is therefore an anomaly, not an instruction.
 */
function applyHomeCurrencySet(s: State, e: LogEntry): void {
  const ccy = currencyOf(payloadObject(e.op), "currency");
  if (s.homeCurrency !== null) {
    anomaly(s, e.seq, "home_currency_reset", `home currency is already ${s.homeCurrency}; ${e.op.op_id} says ${ccy}`);
    return;
  }
  if (s.rates.has(ccy)) {
    // `rate_set_for_home_currency` read from the other side of onboarding, and
    // the same hazard: this currency already has a rate history, so any row of
    // it frozen before this position used a NON-IDENTITY basis and — per §3.7,
    // which never rewrites a frozen snapshot — keeps it. The log therefore holds
    // two home-currency bases, which is the silent re-denomination the forward
    // guard exists to prevent, so it is surfaced here too.
    //
    // The onboarding op still wins: the identity rate is what the home currency
    // means (§3.7:124), and refusing the adoption instead would leave a log with
    // no home currency at all, which no later op could repair. A notice, never a
    // refusal, exactly like every other anomaly here.
    //
    // Keyed on "a rate head exists", not on "a non-null rate head exists": a
    // `rate_set` later cancelled by a `rate_unset` leaves a null head and rows
    // frozen at the old basis, so the null case is not the safe one.
    const head = s.rates.get(ccy);
    anomaly(
      s,
      e.seq,
      "rate_set_before_home_currency",
      `${ccy} already carries a rate head (${head === null ? "unset" : head}) where ${e.op.op_id} adopts it as the ` +
        `home currency; rows frozen before this position keep that basis, not the identity`,
    );
  }
  onHomeCurrencySet(s, ccy);
}

function applyRateSet(s: State, e: LogEntry): void {
  const p = payloadObject(e.op);
  const ccy = currencyOf(p, "currency");
  const micro = positiveMoney(p["rate_micro"], "rate_micro");
  if (s.homeCurrency !== null && ccy === s.homeCurrency) {
    // Applying it would silently re-denominate every later home-currency
    // snapshot — invisibly, with no user-facing signal. Refuse and say so.
    anomaly(s, e.seq, "rate_set_for_home_currency", `${e.op.op_id} sets a rate for the home currency ${ccy}`);
    return;
  }
  onRateSet(s, ccy, micro);
}

function applyRateUnset(s: State, e: LogEntry): void {
  const ccy = currencyOf(payloadObject(e.op), "currency");
  if (s.homeCurrency !== null && ccy === s.homeCurrency) {
    // The home currency's rate is IMPLICIT — 1.000000 by construction (spec
    // §3.7:124) — so there is nothing to unset, and unsetting it is not a
    // recoverable mistake: `rate_set(H)` is refused by the guard above and
    // `home_currency_set` is one-shot, so no op in the vocabulary can put the
    // identity back. Every home-currency transaction from that position on would
    // snapshot null forever, which is exactly what §3.7:133 forbids. Same
    // argument as `rate_set_for_home_currency`; it applies symmetrically and the
    // first draft only guarded one side.
    anomaly(s, e.seq, "rate_unset_for_home_currency", `${e.op.op_id} unsets the implicit identity rate of ${ccy}`);
    return;
  }
  // Present-and-null, not deleted: "unset" is a live fact at this position, and
  // transactions frozen before it stay frozen (spec §3.7:127).
  onRateUnset(s, ccy);
}

function applyCheckpoint(s: State, e: LogEntry): void {
  let heads;
  try {
    heads = decodeCheckpointPayload(e.op.payload);
  } catch (err) {
    throw new PayloadError((err as Error).message);
  }
  s.checkpoints = heads.map((h) => ({
    writer_id: h.writer_id,
    stream: h.stream,
    counter: parseDecimal(h.counter),
    hash: h.hash,
  }));
}

// ---------------------------------------------------------------------------
// Causality (spec §3.3:66)
// ---------------------------------------------------------------------------

/** Op types that may create an entity (`parent_version === null`). */
const CREATES: ReadonlySet<OpType> = new Set<OpType>(["txn_ingested", "txn_superseded", "rule_added"]);
/** Op types that may edit one (`parent_version !== null`). */
const EDITS: ReadonlySet<OpType> = new Set<OpType>(["txn_categorized", "txn_split", "txn_edited", "rule_added"]);

/**
 * The entity kind each op type is allowed to name.
 *
 * `validateOp` checks only that a kind is present, so without this a
 * `txn_categorized` naming `{kind: "rule", id: "t1"}` would file its head under
 * the rule keyspace while editing the transaction called `t1` — two entities
 * sharing one materialized record, with versions that drift apart. The keyspace
 * is per-(kind, id) precisely so the two cannot collide; this is what keeps the
 * materialized maps lined up with it.
 */
const ENTITY_KIND: Partial<Record<OpType, string>> = {
  txn_ingested: "txn",
  txn_superseded: "txn",
  txn_categorized: "txn",
  txn_split: "txn",
  txn_edited: "txn",
  rule_added: "rule",
};

function applyCausal(s: State, e: LogEntry): void {
  const { op, seq, writer_id } = e;
  // validateOp guarantees a non-parent-free op names an entity.
  const ref = op.entity!;
  const wantKind = ENTITY_KIND[op.type];
  if (wantKind !== undefined && ref.kind !== wantKind) {
    anomaly(s, seq, "entity_kind_mismatch", `${op.type} ${op.op_id} names a ${ref.kind}, but it can only address a ${wantKind}`);
    return;
  }
  const key = entityKey(ref.kind, ref.id);
  const head = s.heads.get(key);
  const parent = op.parent_version;

  // The payload is read BEFORE any causal decision, so an unreadable payload
  // never advances a version or resolves a fork.
  const payload = decodePayload(op);

  if (parent === null) {
    if (!CREATES.has(op.type)) {
      anomaly(s, seq, "invalid_parent", `${op.type} ${op.op_id} names no parent, but only a create may`);
      return;
    }
    if (head !== undefined) {
      anomaly(s, seq, "duplicate_create", `${op.op_id} re-creates ${ref.kind} ${ref.id}, already at version ${head.version}`);
      return;
    }
    if (!create(s, e, payload)) return;
    s.heads.set(key, {
      kind: ref.kind,
      id: ref.id,
      version: 1,
      op_id: op.op_id,
      writer_id,
      authored_at_ms: authoredAtMs(op),
    });
    return;
  }

  if (!EDITS.has(op.type)) {
    anomaly(s, seq, "invalid_parent", `${op.type} ${op.op_id} names parent ${parent}, but it can only create`);
    return;
  }
  if (parent === 0) {
    // Version numbering starts at 1 (a create), so version 0 never existed. This
    // is the structural mirror of `future_parent`, and it has to be refused for
    // the same reason: left alone it reads as `parent < head.version`, i.e. a
    // fork — so an op authored against a version that never existed could WIN,
    // apply its payload, bump the head and emit a notice, with nothing anywhere
    // saying the parent was fictional.
    anomaly(s, seq, "nonexistent_parent", `${op.op_id} names parent version 0 of ${ref.kind} ${ref.id}, which never existed`);
    return;
  }
  if (head === undefined) {
    // The create's blob was probably set aside. Replay must not invent the
    // entity from an edit to it.
    anomaly(s, seq, "unknown_entity", `${op.op_id} edits ${ref.kind} ${ref.id}, which no create introduced`);
    return;
  }
  if (parent > head.version) {
    // The plan calls this "impossible in a gap-free prefix". It is not: it is
    // reachable through EVERY refusal that returns before the version bump —
    // `invalid_op`, `entity_kind_mismatch`, `invalid_parent`, `nonexistent_parent`,
    // `invalid_payload` and `split_sum` — because each leaves the head where it
    // was while the author believed it had moved. So this stays an
    // anomaly-and-skip and must never become an assertion (Task 13).
    anomaly(s, seq, "future_parent", `${op.op_id} names parent ${parent} of ${ref.kind} ${ref.id}, whose head is ${head.version}`);
    return;
  }
  // A payload-level refusal (a split that does not sum) is not a causal event:
  // it consumes no version, so the corrected op applies cleanly instead of
  // forking against a phantom.
  //
  // Consequence worth stating, because it is not obvious and a checker could
  // wrongly assume otherwise: a STALE-PARENT op that is refused here produces no
  // ForkNotice at all. "Every op naming a stale parent yields a notice" is
  // therefore not an invariant — "every RESOLVED fork yields one" is.
  if (!precheck(s, e, payload)) return;

  if (parent === head.version) {
    head.version += 1;
    head.op_id = op.op_id;
    head.writer_id = writer_id;
    head.authored_at_ms = authoredAtMs(op);
    edit(s, e, payload, head.version);
    return;
  }

  // parent < head.version — a true concurrent fork. Both ops were authored
  // against the same head; only the total order tells us that.
  //
  // The comparison is STRICT, so a full tie — same millisecond AND same
  // writer_id — leaves the incumbent in place, which means such a fork is
  // resolved by `seq`, i.e. by upload order. That is deterministic and it is the
  // only answer available once both named tiebreaks are exhausted, but it is
  // worth naming because it is reachable in practice (one offline device
  // authoring two ops against the same head inside one millisecond) and its
  // outcome is that the user's LATER op is the one discarded. Spec §3.3:66 gives
  // no third tiebreak; adding one (op_id, say) would be inventing rule.
  const challengerAt = authoredAtMs(op);
  const challengerWins =
    challengerAt > head.authored_at_ms ||
    (challengerAt === head.authored_at_ms && compareUTF8(writer_id, head.writer_id) > 0);
  // Unconditional, so the version is a function of the total order and not of
  // which side won.
  head.version += 1;
  s.forks.push({
    entity: { kind: ref.kind, id: ref.id },
    winner_op: challengerWins ? op.op_id : head.op_id,
    loser_op: challengerWins ? head.op_id : op.op_id,
    at_seq: seq,
  });
  if (challengerWins) {
    head.op_id = op.op_id;
    head.writer_id = writer_id;
    head.authored_at_ms = challengerAt;
    edit(s, e, payload, head.version);
    return;
  }
  // The head's own op won: its payload is already in effect and nothing at an
  // earlier position is rewritten. Only the version moves.
  setVersion(s, ref.kind, ref.id, head.version);
}

/**
 * Mirrors the head version onto the materialized entity. Needed on the branch
 * where the fork's LOSER arrived second: nothing about the entity changes except
 * its version, and the version has to move because it is a function of the total
 * order, not of who won.
 */
function setVersion(s: State, kind: string, id: string, version: number): void {
  if (kind === "txn") {
    const t = s.txns.get(id);
    if (t !== undefined) t.version = version;
    return;
  }
  const r = s.rules.get(id);
  if (r !== undefined) r.version = version;
}

// ---------------------------------------------------------------------------
// Creates
// ---------------------------------------------------------------------------

/** Returns false when the create was refused, so no head is registered. */
function create(s: State, e: LogEntry, payload: Payload): boolean {
  if (e.op.type === "rule_added") {
    const p = payload as RulePayload;
    s.rules.set(e.op.entity!.id, { pattern: p.pattern, match: p.match, category: p.category, priority: p.priority, version: 1 });
    return true;
  }
  return createTxn(s, e, payload as TxnPayload, e.op.type === "txn_superseded");
}

function createTxn(s: State, e: LogEntry, p: TxnPayload, superseding: boolean): boolean {
  const { op, seq } = e;
  const id = op.entity!.id;
  const ingestID = op.ingest_id!; // validateOp requires it on both txn creates
  const previous = s.liveByIngestID.get(ingestID);

  if (!superseding) {
    if (previous !== undefined) {
      // Dedup is by INGEST IDENTITY, not by parse output (spec §3.3:67). A
      // second ingest of the same email should have been a supersede.
      anomaly(s, seq, "duplicate_ingest", `${op.op_id} re-ingests ${ingestID.slice(0, 12)}…, live as ${previous}`);
      return false;
    }
  } else if (previous === undefined) {
    anomaly(s, seq, "supersede_without_origin", `${op.op_id} supersedes ${ingestID.slice(0, 12)}…, which no ingest introduced`);
  } else {
    retire(s, previous, op.op_id);
  }

  const t: Txn = {
    id,
    ingest_id: ingestID,
    amount_minor: p.amount_minor,
    currency: p.currency,
    direction: p.direction,
    posted_at: p.posted_at,
    merchant_raw: p.merchant_raw,
    last4: p.last4,
    category: p.category,
    needs_review: p.needs_review,
    unparsed: p.unparsed,
    tier: p.tier,
    parse_error: p.parse_error,
    provenance: e.writer_id === INGEST_WRITER_ID ? "ingest" : "user",
    // NEVER inherited from the row this supersedes (spec §3.7:129): a template
    // fix can change the amount or even the detected currency, so the snapshot
    // is computed fresh at THIS log position.
    amount_home_minor: null,
    splits: [],
    superseded_by: null,
    possible_duplicate_of: null,
    version: 1,
  };
  s.txns.set(id, t);
  s.liveByIngestID.set(ingestID, id);
  // Against the rate head live at THIS position — which is what makes a
  // supersede recompute rather than inherit, since it arrives here too.
  freezeIfPossible(s, t);
  indexFingerprint(s, t, seq);
  return true;
}

/** Takes a transaction out of the live indexes. It stays in `txns`, visible. */
function retire(s: State, id: string, bySupersedeOp: string): void {
  const prev = s.txns.get(id);
  if (prev === undefined) return;
  prev.superseded_by = bySupersedeOp;
  s.liveByIngestID.delete(prev.ingest_id);
  unindexFingerprint(s, prev);
  // A retired row is not a live transaction: leaving it pending would let a
  // later rate_set freeze a snapshot onto a row nothing displays (spec §3.7:129).
  clearPending(s, prev);
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * Payload-level validity that has to be decided before causality, because a
 * refusal must consume no version. Returns false to refuse the op outright.
 */
function precheck(s: State, e: LogEntry, payload: Payload): boolean {
  if (e.op.type !== "txn_split") return true;
  const t = s.txns.get(e.op.entity!.id);
  if (t === undefined) {
    anomaly(s, e.seq, "unknown_entity", `${e.op.op_id} splits ${e.op.entity!.id}, which is not a transaction`);
    return false;
  }
  const parts = (payload as SplitPayload).parts;
  const sum = parts.reduce((acc, p) => acc + p.amount_minor, 0n);
  if (sum !== t.amount_minor) {
    anomaly(s, e.seq, "split_sum", `${e.op.op_id} splits ${t.id} into ${sum}, but it is ${t.amount_minor}`);
    return false;
  }
  return true;
}

function edit(s: State, e: LogEntry, payload: Payload, version: number): void {
  const { op, seq } = e;
  const id = op.entity!.id;

  if (op.type === "rule_added") {
    const p = payload as RulePayload;
    const r = s.rules.get(id);
    if (r === undefined) {
      anomaly(s, seq, "unknown_entity", `${op.op_id} edits rule ${id}, which is not materialized`);
      return;
    }
    r.pattern = p.pattern;
    r.match = p.match;
    r.category = p.category;
    r.priority = p.priority;
    r.version = version;
    return;
  }

  const t = s.txns.get(id);
  if (t === undefined) {
    anomaly(s, seq, "unknown_entity", `${op.op_id} edits ${id}, which is not a transaction`);
    return;
  }
  if (t.superseded_by !== null) {
    // The edit still lands — the row is retained and inspectable — but a
    // categorization the user made on one device while another device
    // reprocessed the same email is a real loss, and it is never silent.
    anomaly(s, seq, "edit_of_superseded", `${op.op_id} edits ${id}, superseded by ${t.superseded_by}`);
  }
  t.version = version;

  switch (op.type) {
    case "txn_categorized": {
      const p = payload as CategorizePayload;
      t.category = p.category;
      t.needs_review = p.needs_review;
      return;
    }
    case "txn_split": {
      // Wholesale replacement; the sum was checked in `precheck`.
      t.splits = (payload as SplitPayload).parts.map((x) => ({ category: x.category, amount_minor: x.amount_minor }));
      return;
    }
    case "txn_edited": {
      applyTxnEdit(s, t, payload as EditPayload, seq);
      return;
    }
    default:
      // Unreachable: EDITS gates entry and rule_added returned above. Recorded
      // rather than thrown, because a fold that crashes strands a device.
      anomaly(s, seq, "unhandled_op", `${op.type} ${op.op_id} reached the edit path with no handler`);
  }
}

function applyTxnEdit(s: State, t: Txn, p: EditPayload, seq: bigint): void {
  if (p.rejected.length > 0) {
    // amount_minor / currency / direction come from the PARSE. Correcting them
    // is what reprocessing and `txn_superseded` are for, and only a supersede
    // recomputes the FX snapshot at its own position; an edit that changed them
    // would leave a snapshot based on a number that no longer exists.
    anomaly(s, seq, "unsupported_edit_field", `${t.id}: ${p.rejected.join(", ")} may only change via txn_superseded`);
  }
  const before = fingerprint(t);
  if (p.merchant_raw !== undefined) t.merchant_raw = p.merchant_raw;
  if (p.last4 !== undefined) t.last4 = p.last4;
  if (p.posted_at !== undefined) t.posted_at = p.posted_at;
  if (p.category !== undefined) t.category = p.category;
  if (p.needs_review !== undefined) t.needs_review = p.needs_review;
  if (p.amount_home_minor !== undefined) {
    if (t.unparsed) {
      // §3.7:137's explicit recompute is a user's decision about a conversion,
      // and there is no amount here to have converted. Applying it would leave a
      // home-currency figure attached to a row that carries no native amount and
      // no currency — a number in a total whose provenance is nothing — and it
      // is the one way `unparsed ⟹ amount_home_minor === null` becomes false, so
      // `I12_money_shape` would then report a hard stop for a legal user op.
      anomaly(s, seq, "unsupported_edit_field", `${t.id}: amount_home_minor cannot be set on an unparsed transaction, which has no amount to convert`);
    } else {
      // Carried explicitly, never a "recompute later" instruction (spec §3.7:137),
      // so replay stays a pure function of logged data.
      t.amount_home_minor = p.amount_home_minor;
      if (t.superseded_by === null) {
        if (t.amount_home_minor === null) markPending(s, t);
        else clearPending(s, t);
      }
    }
  }
  if (fingerprint(t) !== before && t.superseded_by === null) {
    unindexFingerprintAt(s, before, t.id);
    t.possible_duplicate_of = null;
    indexFingerprint(s, t, seq);
  }
}

// ---------------------------------------------------------------------------
// Fingerprint index (spec §3.3:67) — a NOTICE, never a drop
// ---------------------------------------------------------------------------

function indexFingerprint(s: State, t: Txn, seq: bigint): void {
  const fp = fingerprint(t);
  const bucket = s.byFingerprint.get(fp);
  if (bucket === undefined) {
    s.byFingerprint.set(fp, [t.id]);
    return;
  }
  // The FIRST live match, i.e. the earliest by fold order — not "some match".
  // Which one it names has to be a function of the log, or two replicas show
  // the user two different "possible duplicate of" answers for the same data.
  //
  // This is the ONE place in the engine where an answer depends on the order of
  // a collection, which is why `byFingerprint` holds an explicit ARRAY built in
  // fold order rather than a Set. A second executor must mirror that: Go
  // randomizes map iteration, so a Go port that ranged a map here would diverge
  // from itself run to run, and `serializeState` would report a match anyway
  // (see its doc — the witness compares values, not iteration order).
  const other = bucket[0];
  if (other !== undefined && other !== t.id) {
    // Both stay live and fully visible: genuine same-card same-day duplicate
    // purchases exist, so this can only ever be a review item.
    t.possible_duplicate_of = other;
    anomaly(s, seq, "possible_duplicate", `${t.id} matches ${other} on ${fp}`);
  }
  bucket.push(t.id);
}

function unindexFingerprint(s: State, t: Txn): void {
  unindexFingerprintAt(s, fingerprint(t), t.id);
}

function unindexFingerprintAt(s: State, fp: string, id: string): void {
  const bucket = s.byFingerprint.get(fp);
  if (bucket === undefined) return;
  const i = bucket.indexOf(id);
  if (i >= 0) bucket.splice(i, 1);
  // Empty buckets are deleted rather than kept: a state's canonical form must
  // not depend on which keys happen to have been touched.
  if (bucket.length === 0) s.byFingerprint.delete(fp);
}

// ---------------------------------------------------------------------------
// Payloads
//
// Money is a decimal STRING on the wire and a bigint here — a JSON number is a
// float64 and therefore a rounding bug waiting for a large enough value. Every
// failure below throws PayloadError, which becomes an anomaly rather than a
// hard stop: an op whose payload cannot be read is a data condition.
// ---------------------------------------------------------------------------

interface TxnPayload {
  amount_minor: bigint;
  currency: string;
  direction: "debit" | "credit" | "";
  posted_at: string;
  merchant_raw: string;
  last4: string;
  category: string | null;
  needs_review: boolean;
  unparsed: boolean;
  tier: ParseTier;
  parse_error: string | null;
}
interface CategorizePayload {
  category: string | null;
  needs_review: boolean;
}
interface SplitPayload {
  parts: Split[];
}
interface EditPayload {
  merchant_raw?: string;
  last4?: string;
  posted_at?: string;
  category?: string | null;
  needs_review?: boolean;
  amount_home_minor?: bigint | null;
  rejected: string[];
}
interface RulePayload {
  pattern: string;
  match: string;
  category: string;
  priority: number;
}
type Payload = TxnPayload | CategorizePayload | SplitPayload | EditPayload | RulePayload;

function decodePayload(op: Op): Payload {
  const p = payloadObject(op);
  switch (op.type) {
    case "txn_ingested":
    case "txn_superseded":
      return decodeTxnPayload(p);
    case "txn_categorized":
      return { category: optionalCategory(p["category"]), needs_review: bool(p["needs_review"], false) };
    case "txn_split":
      return { parts: decodeParts(p["parts"]) };
    case "txn_edited":
      return decodeEditPayload(p);
    case "rule_added":
      return {
        pattern: requiredString(p["pattern"], "pattern"),
        match: matchType(p["match"]),
        category: requiredString(p["category"], "category"),
        priority: intField(p["priority"], "priority"),
      };
    default:
      // Unreachable: dispatch routes the parent-free types elsewhere and the
      // six causal types are all above. Fails closed if a type is ever added.
      throw new PayloadError(`no payload decoder for ${op.type}`);
  }
}

/**
 * Decodes a `txn_ingested` / `txn_superseded` payload, in either of its two
 * shapes: a transaction, or a message no tier could read.
 *
 * # The unparsed shape, and why it is checked rather than tolerated
 *
 * `internal/v2/ingest/pipeline.go` appends an op for every accepted message,
 * resolved or not, and an unresolved one carries `amount_minor: "0"`,
 * `currency: ""`, `direction: ""`, `tier: "none"`, `unparsed: true`. Every one of
 * those three money fields is refused by the strict decoders below, so before
 * this task the whole op became an `invalid_payload` anomaly and the message was
 * invisible — which is the review queue's entire input, missing.
 *
 * The flag is what selects the shape, and the two are then held to each other:
 *
 *   - **`unparsed: true` requires the empty money shape.** A writer that flagged
 *     a row unparsed while carrying a real amount would hide a transaction the
 *     user paid for from every total on the device — {@link countsTowardMoney}
 *     excludes it — with no signal anywhere. Refused.
 *   - **A parsed row still requires a positive amount.** Zero is not money
 *     movement, and Go refuses it upstream for exactly this reason
 *     (`carriesMoney` in `pipeline.go`: it "turns an undecodable *trusted* op
 *     into an honest unparsed one"). Admitting it here would make a real row and
 *     an empty one indistinguishable by amount, which is how a consumer ends up
 *     inferring `unparsed` from `amount_minor === 0n` and getting it wrong.
 *   - **`unparsed: true` requires `tier: "none"`.** No cascade both produces a
 *     transaction and reports nothing extracted.
 *   - **`needs_review` may not be false on an unparsed row.** It is the only
 *     surface such a row has; one that opted out of review would be a message
 *     retained, per §2, and then shown to nobody.
 *
 * The converse of the third rule does **not** hold and must not be enforced:
 * `tier: "none"` with `unparsed: false` is every client-authored op — a CSV
 * import (Decision 9), a manual entry — and those carry real money. An absent
 * `tier` reads as `"none"` for the same reason.
 *
 * `merchant_raw`, `last4` and `category` are left free on an unparsed row. Today
 * the pipeline sends them empty, but a future tier that recovered a merchant and
 * no amount would be telling the truth, and refusing it would cost the review
 * queue the one useful thing it had.
 */
function decodeTxnPayload(p: Record<string, unknown>): TxnPayload {
  const category = optionalCategory(p["category"]);
  const tier = tierOf(p["tier"]);
  // Absent means PARSED. A writer that omits the flag is claiming money, which
  // is the right default: every op authored before this field existed, and every
  // op a client authors, carries a real amount.
  const unparsed = bool(p["unparsed"], false);
  const parse_error = parseErrorOf(p["parse_error"]);
  const common = {
    posted_at: instant(p["posted_at"], "posted_at"),
    merchant_raw: optionalString(p["merchant_raw"], "merchant_raw") ?? "",
    last4: optionalString(p["last4"], "last4") ?? "",
    category,
    unparsed,
    tier,
    parse_error,
  };

  if (unparsed) {
    if (tier !== "none") {
      throw new PayloadError(`unparsed is true but tier is ${JSON.stringify(tier)}: nothing was extracted, so no tier produced it`);
    }
    const amount = parseMoney(p["amount_minor"] ?? "0", "amount_minor");
    if (amount !== 0n) {
      throw new PayloadError(`unparsed is true but amount_minor is ${amount}: an unparsed message carries no amount`);
    }
    const ccy = p["currency"];
    if (ccy !== undefined && ccy !== "") {
      throw new PayloadError(`unparsed is true but currency is ${JSON.stringify(ccy)}: an unparsed message carries no currency`);
    }
    const dir = p["direction"];
    if (dir !== undefined && dir !== "") {
      throw new PayloadError(`unparsed is true but direction is ${JSON.stringify(dir)}: an unparsed message carries no direction`);
    }
    if (bool(p["needs_review"], true) !== true) {
      throw new PayloadError("unparsed is true but needs_review is false: an unparsed message is a review item");
    }
    return { ...common, amount_minor: 0n, currency: "", direction: "", needs_review: true };
  }

  if (parse_error !== null) {
    throw new PayloadError(`parse_error is ${JSON.stringify(parse_error)} on a row that is not unparsed`);
  }
  return {
    ...common,
    amount_minor: positiveMoney(p["amount_minor"], "amount_minor"),
    currency: currencyOf(p, "currency"),
    direction: direction(p["direction"]),
    // A transaction with no category is a review item by construction; an
    // explicit flag in the payload still wins.
    needs_review: bool(p["needs_review"], category === null),
  };
}

const TIERS: ReadonlySet<string> = new Set(["template", "heuristic", "none"]);

/** The tier that produced a row. Absent reads as `"none"`: no tier did. */
function tierOf(v: unknown): ParseTier {
  if (v === undefined) return "none";
  if (typeof v !== "string" || !TIERS.has(v)) {
    throw new PayloadError(`tier must be template|heuristic|none, got ${JSON.stringify(v)}`);
  }
  return v as ParseTier;
}

/**
 * The reason the cascade gave up, as a short lower-snake token.
 *
 * # Shape, not membership, and the gap that leaves
 *
 * The plan calls for a value "from a closed set; never body text". The set is the
 * *pipeline's* to define and it does not define one yet — `txnPayload` in
 * `pipeline.go` has no `parse_error` field at all, so every op in existence
 * omits this and reads as null. Enumerating four plausible reasons here would be
 * inventing protocol for a writer that emits none, and would then refuse the
 * fifth reason Go eventually adds.
 *
 * So what is enforced is the half that is this executor's to enforce, and it is
 * the half that carries the risk: a token cannot be body text. No spaces, no
 * punctuation, 64 characters at most. This op rides in the HOT stream — the one
 * the cold/hot split exists to keep email bodies out of — so a free-text reason
 * would put a fragment of a message into the lane that is not supposed to hold
 * one, and in Phase 3 into a differently-keyed one. The gap is recorded in the
 * task report: when the pipeline gains reasons, the set belongs here.
 */
const PARSE_ERROR_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;

function parseErrorOf(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new PayloadError(`parse_error must be a string or null, got ${JSON.stringify(v)}`);
  if (!PARSE_ERROR_TOKEN.test(v)) {
    throw new PayloadError(`parse_error ${JSON.stringify(v)} is not a lower-snake token: a reason is a code, never message text`);
  }
  return v;
}

/**
 * Fields an edit may not touch: they come from the parse (spec §3.7:129).
 *
 * `unparsed`, `tier` and `parse_error` are on this list for the same reason the
 * money fields are — re-reading a message is what `txn_superseded` is for, and
 * it is the only op that recomputes the FX snapshot at its own position. Being
 * on the list matters even though {@link applyTxnEdit} never assigns them: a
 * decoder that simply does not read a key ignores it *silently*, and a client
 * correcting a row would watch its op land, consume a version and change
 * nothing, with no anomaly anywhere. §2 says nothing is ever silently dropped.
 */
const PARSE_OWNED = ["amount_minor", "currency", "direction", "unparsed", "tier", "parse_error"];

function decodeEditPayload(p: Record<string, unknown>): EditPayload {
  const out: EditPayload = { rejected: PARSE_OWNED.filter((k) => p[k] !== undefined) };
  const merchant = optionalString(p["merchant_raw"], "merchant_raw");
  if (merchant !== undefined) out.merchant_raw = merchant;
  const last4 = optionalString(p["last4"], "last4");
  if (last4 !== undefined) out.last4 = last4;
  if (p["posted_at"] !== undefined) out.posted_at = instant(p["posted_at"], "posted_at");
  if (p["category"] !== undefined) out.category = optionalCategory(p["category"]);
  if (p["needs_review"] !== undefined) out.needs_review = bool(p["needs_review"], false);
  if (p["amount_home_minor"] !== undefined) {
    out.amount_home_minor = p["amount_home_minor"] === null ? null : positiveMoney(p["amount_home_minor"], "amount_home_minor");
  }
  return out;
}

function decodeParts(raw: unknown): Split[] {
  if (!Array.isArray(raw)) throw new PayloadError("parts is not an array");
  return raw.map((x, i) => {
    if (typeof x !== "object" || x === null) throw new PayloadError(`part ${i} is not an object`);
    const o = x as Record<string, unknown>;
    return {
      category: requiredString(o["category"], `part ${i} category`),
      amount_minor: positiveMoney(o["amount_minor"], `part ${i} amount_minor`),
    };
  });
}

function payloadObject(op: Op): Record<string, unknown> {
  const p = op.payload;
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw new PayloadError("payload is not a JSON object");
  return p as Record<string, unknown>;
}

function positiveMoney(v: unknown, what: string): bigint {
  const n = parseMoney(v, what);
  if (n <= 0n) throw new PayloadError(`${what} is ${n}, and amounts are always positive`);
  return n;
}

function parseMoney(v: unknown, what: string): bigint {
  if (typeof v !== "string") {
    // The decimal-string rule, enforced rather than documented: JSON.parse of a
    // number is a float64, so accepting one here would silently round.
    throw new PayloadError(`${what} must be a decimal-integer string, got ${JSON.stringify(v)}`);
  }
  try {
    return parseDecimal(v);
  } catch (err) {
    throw new PayloadError(`${what}: ${(err as Error).message}`);
  }
}

/**
 * ISO 4217 alpha-3, **normalised to upper case**.
 *
 * The normalisation matters more than it looks: rates are keyed by this string,
 * so accepting `aed` alongside `AED` would put a transaction in a currency
 * bucket the user's `rate_set` never reaches, and it would do so invisibly.
 * Normalising rather than refusing keeps a case-sloppy writer's transaction
 * visible instead of turning it into an anomaly nobody can act on.
 */
function currencyOf(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !/^[A-Za-z]{3}$/.test(v)) {
    throw new PayloadError(`${key} must be a three-letter currency code, got ${JSON.stringify(v)}`);
  }
  return v.toUpperCase();
}

function direction(v: unknown): "debit" | "credit" {
  if (v !== "debit" && v !== "credit") throw new PayloadError(`direction must be debit or credit, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * Canonicalised on the way in, so the fingerprint day is stable across replicas.
 *
 * # The canonical form has to be readable back, and it is not always
 *
 * The wire grammar admits a four-digit year with a UTC offset of up to ±23:59,
 * so `9999-12-31T23:59:59-23:59` is a legal `posted_at` that lands in year
 * 10000. `canonicalTime` then writes it in ISO *expanded-year* form,
 * `"+010000-01-01T23:58:59.000Z"` — which `parseInstantMs` refuses, because the
 * grammar it enforces (deliberately, to match Go) has exactly four year digits.
 *
 * That combination used to reach the state, and then `fingerprint` re-parsed the
 * stored string and threw `BlobDecodeError` from inside `createTxn`. It is not a
 * `PayloadError`, so it escaped {@link applyOp}'s catch and took down the whole
 * fold: one legal message and the device can never sync again.
 *
 * There is a second, quieter reason to refuse rather than to store it: the two
 * executors do not even *spell* it the same way. Go's `Format(RFC3339)` renders
 * year 10000 as `10000-01-01T…` and JavaScript's `toISOString` as
 * `+010000-01-01T…`, so a payload in this range is one the executors would fold
 * to different bytes. A value neither side can read back is not one to
 * canonicalise; it is one to record as an anomaly, which is a visible refusal
 * that keeps the message in the log and every other op folding.
 *
 * The check is the round trip itself rather than a year-range test, so it cannot
 * drift from whatever `canonicalTime` actually produces.
 */
function instant(v: unknown, what: string): string {
  if (typeof v !== "string") throw new PayloadError(`${what} must be an RFC3339 timestamp, got ${JSON.stringify(v)}`);
  let canonical: string;
  try {
    parseInstantMs(v);
    canonical = canonicalTime(v);
  } catch (err) {
    throw new PayloadError(`${what}: ${(err as Error).message}`);
  }
  try {
    parseInstantMs(canonical);
  } catch {
    throw new PayloadError(`${what} ${JSON.stringify(v)} canonicalises to ${JSON.stringify(canonical)}, which is outside the range this wire format can carry`);
  }
  return canonical;
}

function requiredString(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "") throw new PayloadError(`${what} is ${JSON.stringify(v)}`);
  return v;
}

function optionalString(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new PayloadError(`${what} must be a string, got ${JSON.stringify(v)}`);
  return v;
}

/** `""` and `null` are the same thing: uncategorized. */
function optionalCategory(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new PayloadError(`category must be a string or null, got ${JSON.stringify(v)}`);
  return v;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new PayloadError(`want a boolean, got ${JSON.stringify(v)}`);
  return v;
}

const MATCH_TYPES = new Set(["contains", "exact", "regex"]);

function matchType(v: unknown): string {
  if (typeof v !== "string" || !MATCH_TYPES.has(v)) throw new PayloadError(`match must be contains|exact|regex, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * A small non-negative integer carried as a raw JSON number, like
 * `parent_version`. Not a decimal string: a rule priority is neither money nor a
 * counter that can approach 2^53, and the safe-integer check makes the boundary
 * explicit rather than assumed.
 */
function intField(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new PayloadError(`${what} must be an integer, got ${JSON.stringify(v)}`);
  return v;
}

function anomaly(s: State, seq: bigint, kind: string, detail: string): void {
  s.anomalies.push({ kind, detail, at_seq: seq });
}
