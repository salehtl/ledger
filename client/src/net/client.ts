/**
 * The headless sync client: the instrument spec §5 names as Phase 1's exit
 * test ("a minimal headless client that authenticates, pulls, replays, runs the
 * invariant checker, and round-trips client-authored ops").
 *
 * It is a TEST INSTRUMENT, not a product. It re-folds its whole log on every
 * command, keeps its writer key in a plain file, and has no UI. What it does
 * have is the property the exit criterion actually needs: every claim it makes
 * about the log is derived from bytes it verified itself.
 *
 * # The five rules this file exists to keep
 *
 *  1. **Verify before you apply.** {@link Client.pull} runs `verifyChain` over
 *     every page BEFORE a single blob is opened, and persists the new pinned
 *     heads and cursor only after {@link checkAll} reports no `hard_stop`. A
 *     hard stop leaves the store exactly as it was — the cursor does not move
 *     over a page that could not be certified.
 *  2. **Ops come from the blobs, never from a parallel source.** The `ops` list
 *     handed to the checker is decoded from the same bytes `verifyChain`
 *     accepted (see {@link applyRows}). If it came from anywhere else, the
 *     checker's guarantees would be about that other thing.
 *  3. **Per-stream cursors, per-stream chains.** `pull` with no `--stream` is
 *     HOT ONLY, because that is the mode the product ships (spec §3.3:70). Hot
 *     bodies are verified against their own chain; cold bodies are verified
 *     against hashes a previous `pull-cold-hashes` pinned, because the cold
 *     stream is a lazily-synced window and its rows are legitimately sparse.
 *  4. **A blob that will not decode is set aside, and the cursor still moves.**
 *     One bad blob must not strand a device (spec §3.3:68). The two conditions
 *     that DO stop a sync are a chain break and an unknown newer schema version,
 *     and nothing else is ever promoted to them.
 *  5. **A checkpoint names the ROSTER.** See {@link Client.checkpoint}.
 *
 * # What this client cannot tell you, in Phase 1
 *
 * Blobs are plaintext with a zero tag and no DEK exists, so "the server cannot
 * forge a client writer's chain" is a property of the finished system and not of
 * what runs today. A green `check` here is evidence about mistakes — dropped
 * rows, reordering, a bad merge, a broken fold — and not about an adversary.
 * `wire/chain.ts` states this at length; do not quote a clean run as more.
 */

import { ulid } from "ulid";

import { platform } from "../platform";

import {
  VIOLATION_ROSTER_COVERAGE,
  checkAll,
  checkAllStream,
  type CheckInput,
  type SyncRow,
  type Violation,
  type Writer,
} from "../invariants/check";
import { discardingOps, storedOps, storedRows } from "../invariants/source";
import { escapableDuringPush } from "../invariants/surface";
import { fold, foldBlobs, type LogEntry } from "../replay/replay";
import { emptyState, type State } from "../replay/state";
import { MAX_BUCKET, STREAM_COLD, STREAM_HOT, openBlob, sealBlob, type Envelope, type Stream } from "../wire/blob";
import {
  ChainBreakError,
  chainHash,
  chainKey,
  headAfter,
  verifyChain,
  verifyFetchedRange,
  verifyHashList,
  type ChainKey,
  type Head,
  type HashRow,
} from "../wire/chain";
import {
  SCHEMA_VERSION,
  compareUTF8,
  decodeBlobOps,
  encodeBlobOps,
  encodeCheckpointPayload,
  isOpType,
  parseDecimal,
  validateOp,
  type CheckpointHead,
  type EntityRef,
  type Op,
  type OpType,
} from "../wire/op";
import {
  ROW_CHUNK,
  eachRowChunk,
  genesisHead,
  type ClientState,
  type InflightBlob,
  type RowStore,
  type Store,
  type WireRow,
  type WriterKey,
} from "../store/store";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The server answered with a non-2xx status. `code`/`detail` are its own. */
/**
 * The request never reached a server, or its answer never came back.
 *
 * Distinct from {@link ApiError}, which means an HTTP status DID arrive: one is
 * "try again when there is a network", the other is "the server has an opinion
 * about this and it is not going to change on a retry".
 */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The response was not the shape this protocol defines — a counter that is not
 * decimal, a hash that is not hex, a blob that is not base64.
 *
 * Deliberately NOT a set-aside: a set-aside is "one blob's CONTENT is
 * unreadable", which presupposes we could read the row that carried it. A row
 * whose framing is malformed means we are not talking to the API we think we
 * are, and nothing in the response can be trusted enough to fold.
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * The invariant checker reported at least one `hard_stop`, so the sync session
 * is over and nothing from the offending page was persisted (spec §3.3:68).
 */
export class HardStopError extends Error {
  constructor(readonly violations: Violation[], chainBreak?: ChainBreakError) {
    // The chain break, when there was one, is carried in the MESSAGE as well as
    // in `cause`: it is the only part of the report that names the remedy (a
    // cold body with no pinned hash is fixed by running `pull-cold-hashes`, not
    // by staring at I3b), and a caller printing `err.message` must not have to
    // know to unwrap a cause to see it.
    const found = violations
      .filter((v) => v.severity === "hard_stop")
      .map((v) => `${v.id}: ${v.detail}`)
      .join("; ");
    super(`sync stopped: ${found}${chainBreak === undefined ? "" : ` (chain check: ${chainBreak.message})`}`);
    this.name = "HardStopError";
    if (chainBreak !== undefined) this.cause = chainBreak;
  }
}

// ---------------------------------------------------------------------------
// Wire shapes (mirroring internal/v2/api)
// ---------------------------------------------------------------------------

interface PullResponse {
  stream: string;
  rows: WireRow[];
  next: string;
  complete: boolean;
}

interface HashEntry {
  seq: string;
  writer_id: string;
  writer_counter: string;
  blob_hash: string;
  prev_hash: string;
}

interface HashesResponse {
  stream: string;
  hashes: HashEntry[];
  next: string;
  complete: boolean;
}

interface UploadBlob {
  writer_counter: string;
  prev_hash: string;
  blob_hash: string;
  type_flag: string;
  size_bucket: number;
  blob: string;
}

/** The `RegistrationMessage` domain prefix, mirroring `auth.registrationDomain`. */
const REGISTRATION_DOMAIN = "ledger-v2-writer-registration\u0000";

/**
 * Mirrors `api.maxUploadBlobs`: one request may claim at most this many
 * positions. A batch longer than this is PAGED, not refused — see
 * {@link Client.push}'s `remaining`.
 */
export const MAX_UPLOAD_BLOBS = 8;

/**
 * Mirrors `api.maxUploadBytes`: the cap on the whole request body.
 *
 * The client pages on the BLOB count alone and never measures bytes, because
 * `api/sync_test.go`'s `TestUploadCapsAreConsistent` pins that a batch
 * satisfying `maxUploadBlobs` always fits `maxUploadBytes` — the ladder's top
 * rung is 1 MiB, and eight of those base64'd plus framing is under 12 MiB.
 * `outbox.test.ts` re-measures that here rather than trusting the Go test,
 * by building eight top-bucket blobs and weighing the actual request body.
 */
export const MAX_UPLOAD_BYTES = 12 << 20;

/** `oplog.TypeFlagEdit` — the only type flag a device may submit. */
const TYPE_FLAG_EDIT = "edit";

/**
 * The one invariant id this file names, because it is the one hard stop a push
 * must be able to proceed over (see {@link Client.push}).
 *
 * `check.ts` keeps its ids private and exports only {@link INVARIANT_IDS}, so
 * this is a literal — and `client.test.ts` asserts it is in that list, because a
 * literal that silently stopped matching would turn the deadlock escape back off
 * with every test still green.
 */
export const ROSTER_CHECKPOINT = "I11_roster_checkpoint";

// ---------------------------------------------------------------------------
// Row decoding
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array): string => platform().toHex(b);

function unhex32(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || !/^[0-9a-f]{64}$/.test(s)) {
    throw new ProtocolError(`${what} must be 64 lower-case hex characters, got ${JSON.stringify(s)}`);
  }
  return platform().fromHex(s);
}

/**
 * Decodes standard base64 STRICTLY. `Buffer.from(s, "base64")` ignores anything
 * outside the alphabet, so a corrupted body would come back short and plausible
 * — and a short blob is not a size bucket, which would be reported as a bucket
 * violation rather than as the transport problem it is.
 *
 * The guard is kept even though `platform().fromBase64` enforces the same rule:
 * this one raises a `ProtocolError` naming the field, and the seam's `TypeError`
 * would not.
 */
export function unbase64(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new ProtocolError(`${what} is not standard base64`);
  }
  return platform().fromBase64(s);
}

function decodeStream(s: unknown, what: string): Stream {
  if (s !== STREAM_HOT && s !== STREAM_COLD) throw new ProtocolError(`${what} is ${JSON.stringify(s)}, want "hot" or "cold"`);
  return s;
}

/** Turns one wire row into the {@link SyncRow} the chain and the checker read. */
export function decodeWireRow(r: WireRow): SyncRow {
  if (typeof r !== "object" || r === null) throw new ProtocolError("a sync row is not an object");
  if (typeof r.writer_id !== "string" || r.writer_id === "") throw new ProtocolError("a sync row names no writer");
  return {
    seq: parseDecimal(r.seq),
    stream: decodeStream(r.stream, "row stream"),
    writer_id: r.writer_id,
    writer_counter: parseDecimal(r.writer_counter),
    size_bucket: typeof r.size_bucket === "number" ? r.size_bucket : -1,
    blob_hash: unhex32(r.blob_hash, "blob_hash"),
    prev_hash: unhex32(r.prev_hash, "prev_hash"),
    blob: unbase64(r.blob, "blob"),
  };
}

function decodeHashEntry(h: HashEntry): HashRow {
  if (typeof h !== "object" || h === null) throw new ProtocolError("a hash list entry is not an object");
  if (typeof h.writer_id !== "string" || h.writer_id === "") throw new ProtocolError("a hash list entry names no writer");
  return {
    seq: parseDecimal(h.seq),
    writer_id: h.writer_id,
    writer_counter: parseDecimal(h.writer_counter),
    blob_hash: unhex32(h.blob_hash, "blob_hash"),
    prev_hash: unhex32(h.prev_hash, "prev_hash"),
  };
}

/** Groups rows by their chain, preserving order within each chain. */
function byChain<T extends { writer_id: string; stream: Stream }>(rows: readonly T[]): Map<ChainKey, T[]> {
  const out = new Map<ChainKey, T[]>();
  for (const r of rows) {
    const key = chainKey(r.writer_id, r.stream);
    const list = out.get(key);
    if (list === undefined) out.set(key, [r]);
    else list.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/**
 * Opens, decodes and folds one run of rows, appending the ops it folded to
 * `ops` in fold order.
 *
 * # Why the ops are decoded a second time
 *
 * `foldBlobs` decodes internally and does not hand the ops back, and the
 * checker needs them (its `ops` list is what I9 and I10 re-fold). Decoding
 * again from the SAME bytes is what keeps rule 2 true: `decodeBlobOps` is a
 * pure function of its input, so the second call cannot produce a different op
 * list from the one that was folded. Reading the ops from anywhere else — a
 * parallel response field, a cached parse — would mean the checker was
 * certifying a list nothing verified.
 *
 * A blob that will not OPEN never reaches `foldBlobs` at all, so its set-aside
 * record and its cursor advance are made here, in the same shape `foldBlobs`
 * would have made them. Both paths must exist: `openBlob` fails on a mismatched
 * AAD or a corrupt frame, `decodeBlobOps` on a body that is not an op list, and
 * neither may abort the session.
 */
function applyRows(state: State, ops: LogEntry[], userId: string, rows: readonly SyncRow[]): void {
  for (const r of rows) {
    // Cold blobs are raw email bodies and never ops (invariant I16), which is
    // what licenses a hot-only sync to be a complete materialization. Replay
    // never sees one.
    if (r.stream !== STREAM_HOT) continue;
    const pos = { writer_id: r.writer_id, stream: r.stream, writer_counter: r.writer_counter, seq: r.seq };
    let body: Uint8Array;
    try {
      body = openBlob(envelopeFor(userId, r), r.blob);
    } catch (err) {
      if (r.seq <= state.cursors.hot) {
        throw new ProtocolError(`row at seq ${r.seq} does not follow the folded prefix at ${state.cursors.hot}`);
      }
      state.cursors.hot = r.seq;
      state.appliedAtCursor.clear();
      state.unreadable.push({ ...pos, reason: (err as Error).message });
      continue;
    }
    const before = state.unreadable.length;
    foldBlobs([{ pos, body }], state);
    if (state.unreadable.length !== before) continue; // foldBlobs set it aside
    for (const op of decodeBlobOps(body)) ops.push({ op, seq: r.seq, writer_id: r.writer_id });
  }
}

function envelopeFor(userId: string, r: { stream: Stream; writer_id: string; writer_counter: bigint }): Envelope {
  return { userId, stream: r.stream, writerId: r.writer_id, writerCounter: r.writer_counter };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  store: Store;
  /** Overrides the persisted base URL. Required on a profile's first use. */
  server?: string;
  /** Overrides the persisted writer id. */
  writerId?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** What one `pull` did, for the CLI to print and a test to assert on. */
export interface PullReport {
  stream: Stream;
  pages: number;
  rows: number;
  cursor: bigint;
  complete: boolean;
  /**
   * The LAST page's violations, not every page's concatenated.
   *
   * That is not a shortcut: every notice worth reading is cumulative in the
   * state the last page was checked against — `I14`'s fork and anomaly counts,
   * `I15`'s set-aside list and `I11`'s checkpoint findings are all derived from
   * the whole folded log — so concatenating would repeat each of them once per
   * page and say nothing new. The per-page findings that are NOT cumulative are
   * the ones that end the loop by throwing.
   */
  violations: Violation[];
}

export interface PushReport {
  blobs: number;
  /** Ops in the blobs this call uploaded, not ops the outbox holds. */
  ops: number;
  seqs: bigint[];
  /** A `writer_checkpoint` was among the ops this call uploaded. */
  checkpointed: boolean;
  /**
   * Ops still queued after this call — nonzero when the batch was longer than
   * {@link MAX_UPLOAD_BLOBS} blobs and got paged.
   *
   * The caller loops until it is 0; `Outbox.flush` is that loop. It is reported
   * rather than hidden inside a loop here because a push that pages is a push
   * whose later pages can fail separately, and a caller that cannot see the
   * boundary cannot report progress or stop at one.
   */
  remaining: number;
}

/**
 * Where a chunked fold has got to, handed to
 * {@link Client.materializeChunked}'s `between` at each chunk boundary.
 *
 * `rows` and `ops` are different counts and a progress bar must not swap them:
 * one blob is one row and carries one *or more* ops, so `ops` is what a "12,904
 * applied" line means and `rows / total` is the only honest fraction.
 */
export interface FoldProgress {
  /** Chunks completed, 1-based. */
  chunk: number;
  rows: number;
  ops: number;
  /** Rows the store holds for this stream, read once before the walk. */
  total: number;
}

export class Client {
  private readonly store: Store;
  /**
   * The verified log, which the state no longer carries.
   *
   * Read ONLY through {@link eachRowChunk}: there is no `all()` on a
   * {@link RowStore}, so every full pass below is a chunked loop and the
   * memory ceiling is a property of that loop.
   */
  private readonly rowStore: RowStore;
  private readonly doFetch: typeof fetch;
  private st: ClientState;

  constructor(opts: ClientOptions) {
    this.store = opts.store;
    this.rowStore = opts.store.rows();
    this.doFetch = opts.fetch ?? fetch;
    this.st = opts.store.load();
    if (opts.server !== undefined && opts.server !== "") this.st.server = opts.server;
    if (opts.writerId !== undefined && opts.writerId !== "") this.st.writerId = opts.writerId;
  }

  // -- accessors ----------------------------------------------------------

  get server(): string {
    if (this.st.server === "") throw new Error("no server configured: pass --server");
    return this.st.server;
  }

  get userId(): string {
    if (this.st.userId === null) throw new Error("not signed in: run `cli login` first");
    return this.st.userId;
  }

  get writerId(): string {
    if (this.st.writerId === null) throw new Error("no writer selected: run `cli enroll --writer <id>`");
    return this.st.writerId;
  }

  get pending(): readonly Op[] {
    return this.st.pending;
  }

  get location(): string {
    return this.store.location;
  }

  /**
   * The bearer token this client would send, or `null` when it is signed out.
   *
   * For a test driving one of the routes {@link Client} does not wrap. It used
   * to be read by re-parsing the state file, which was store-specific — under
   * `LEDGER_CLIENT_STORE=sqlite` the location is a database and the token is
   * not in it at all (it belongs in the keystore, see `SecretStore`). Reading
   * it from the client that would send it is what the file read was
   * approximating anyway.
   */
  get sessionToken(): string | null {
    return this.st.sessionToken;
  }

  cursor(stream: Stream): bigint {
    return this.st.cursors[stream];
  }

  pinnedHead(writerId: string, stream: Stream): Head {
    return this.st.pinnedHeads.get(chainKey(writerId, stream)) ?? genesisHead();
  }

  /**
   * Every row this client has verified and kept, ascending by seq.
   *
   * **A test accessor, not a product call.** It is the one place that builds an
   * array of the whole log, which is what {@link RowStore} deliberately offers
   * no method for; the assertions that read it are counting rows, not folding
   * them. Product code walks {@link eachRowChunk}, as the two methods below do.
   */
  rowsFor(stream: Stream): readonly WireRow[] {
    const out: WireRow[] = [];
    eachRowChunk(this.rowStore, stream, (chunk) => {
      for (const r of chunk) out.push(r);
    });
    return out;
  }

  /**
   * The materialized state, re-folded from every stored row.
   *
   * Recomputed rather than cached: a cached state would make I9's and I10's
   * "the state agrees with a re-fold of its own op log" a comparison of the
   * fold against itself.
   *
   * The fold runs a CHUNK at a time and keeps none of them. Decoding is where
   * the memory goes — every row in a chunk is opened, inflated and parsed — so
   * an implementation that read the whole log first and decoded afterwards
   * would hold 3,683 inflated blobs at once, which is the >500 MB shape Phase 0
   * froze on. `store.test.ts` pins the ordering with a row store that poisons
   * each chunk when the next is asked for.
   */
  materialize(): { state: State; ops: LogEntry[] } {
    const state = emptyState();
    const ops: LogEntry[] = [];
    eachRowChunk(this.rowStore, STREAM_HOT, (chunk) => {
      applyRows(state, ops, this.userId, chunk.map(decodeWireRow));
    });
    state.cursors.cold = this.st.cursors.cold;
    return { state, ops };
  }

  /**
   * {@link materialize}, a chunk at a time, awaiting `between` after each chunk
   * that is not the last.
   *
   * # Why this exists next to a method that already chunks
   *
   * `materialize()` already reads the log a chunk at a time, so its MEMORY is
   * bounded. What it cannot do is give the runtime a turn: it is synchronous,
   * so a 3,683-row fold is one uninterrupted slab of JS. Phase 0's post-mortem
   * is explicit that the fix which shipped was chunking **with yields** and that
   * the yield was the load-bearing half — it is what lets the collector run
   * between chunks, and a synchronous `Store` (Decision 3) cannot express one.
   *
   * So this is the async twin, and it is a twin rather than a reimplementation:
   * it walks the same {@link RowStore.range}, decodes with the same
   * {@link decodeWireRow} and folds with the same `applyRows` as
   * {@link materialize}. The only difference is the `await` between chunks.
   *
   * `between` is called exactly `ceil(rows / chunkSize) - 1` times, which is
   * decided from {@link RowStore.count} rather than from "did the last chunk
   * come back short" — a log whose length is an exact multiple of the chunk size
   * would otherwise need one extra empty probe to discover it had finished, and
   * would yield once more than there were gaps.
   *
   * # `keepOps` defaults to FALSE, and that is the memory fix
   *
   * `materialize()` returns every decoded op, because {@link checkAll} needs
   * them — I9 and I10 re-fold from that list. It is therefore O(log) in decoded
   * *payload* bytes, and a payload is the biggest thing a blob carries: keeping
   * the list means keeping every inflated body's contents alive for the whole
   * fold, which is precisely the shape Phase 0 froze on. Chunking the READ does
   * not help if the decode's output is accumulated anyway.
   *
   * The engine does not need the list — it needs a state and a count — so the
   * default here is to keep only the chunk in flight and return `ops: null`
   * with `opsApplied` counted. A caller that genuinely needs the ops (the
   * checker) asks for them and pays for them, at the call site, visibly.
   *
   * Nothing here retains a chunk otherwise. `store/store.test.ts`'s poisoning
   * row store pins that for the synchronous path and `net/engine.test.ts` pins
   * it for this one; the async version needs its own proof because an
   * implementation that collected the chunks into one array and folded them
   * after the loop would satisfy every count in this signature.
   */
  async materializeChunked(
    opts: { between?: (p: FoldProgress) => Promise<void> | void; chunkSize?: number; keepOps?: boolean } = {},
  ): Promise<{ state: State; ops: LogEntry[] | null; opsApplied: number; chunks: number; rows: number }> {
    const limit = opts.chunkSize ?? ROW_CHUNK;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`materializeChunked needs a positive integer chunk size, got ${String(limit)}`);
    }
    const keep = opts.keepOps === true;
    const state = emptyState();
    // One array either way, so the fold path is identical in both modes and the
    // only difference is whether it is truncated between chunks. A second code
    // path would be a second thing to be wrong.
    const ops: LogEntry[] = [];
    const total = this.rowStore.count(STREAM_HOT);
    let after = 0n;
    let chunks = 0;
    let rows = 0;
    let opsApplied = 0;
    for (;;) {
      const chunk = this.rowStore.range(STREAM_HOT, after, limit);
      if (chunk.length === 0) break;
      const last = chunk[chunk.length - 1];
      if (last === undefined) break;
      const next = parseDecimal(last.seq);
      // The same progress guarantee `eachRowChunk` makes, for the same reason: a
      // store answering with rows at or below the cursor it was given would spin
      // here forever, and a hang on a phone is indistinguishable from the freeze
      // this whole task exists to prevent.
      if (next <= after) {
        throw new Error(`${STREAM_HOT} rows: range() did not advance past seq ${after.toString(10)}`);
      }
      const before = ops.length;
      applyRows(state, ops, this.userId, chunk.map(decodeWireRow));
      opsApplied += ops.length - before;
      if (!keep) ops.length = 0;
      chunks++;
      rows += chunk.length;
      after = next;
      if (rows >= total || chunk.length < limit) break;
      await opts.between?.({ chunk: chunks, rows, ops: opsApplied, total });
    }
    state.cursors.cold = this.st.cursors.cold;
    return { state, ops: keep ? ops : null, opsApplied, chunks, rows };
  }

  state(): State {
    return this.materialize().state;
  }

  /**
   * Heals a store holding verified rows ABOVE its persisted cursor, and returns
   * what it healed.
   *
   * # The state this repairs, and why it is reachable at all
   *
   * {@link pull} step 4 persists a page's rows, the cursor and the pinned heads
   * inside one {@link Store.transaction}. `sqliteStore` makes that genuinely
   * atomic, so a device cannot reach this state. `fileStore` cannot — two files
   * have no journal — so it keeps the *ordering* (rows first) and its residual
   * crash window lands on the recoverable side: rows on disk, cursor behind
   * them.
   *
   * "Recoverable" was, until this method, aspirational. What actually happened
   * on the next run was that the fold consumed the stored rows (so the folded
   * cursor sat at the last one), `pull` asked the server for everything after
   * the *saved* cursor, and the same page came back — which the fold refuses:
   *
   *     ReplayOrderError: blob at seq 1 does not follow 3: one blob is one row, one seq
   *
   * That is Task 5's own recorded output, and its report names automatic
   * reconciliation as Task 8's job. This is it.
   *
   * # It VERIFIES and it PINS — neither is optional
   *
   * Advancing the cursor alone would be worse than the break it fixes: the next
   * page arrives at counter N+k+1 while the pinned head is still at N, which is
   * a chain break this client can never clear. So the orphan rows are put back
   * through exactly what {@link pull} puts a fetched page through — `verifyChain`
   * against the pinned head for hot, the pinned per-blob hashes for cold — and
   * the head is advanced with {@link headAfter} in the same transaction as the
   * cursor. This is the `pin` step of `pull → verify → pin → fold → attest →
   * push`, applied to rows that are already local.
   *
   * A chain break here is NOT swallowed: it means the rows on disk do not follow
   * the head this client pinned, which no amount of resuming can repair.
   *
   * The walk is chunked and the head is threaded through each chunk, so a store
   * whose cursor was lost entirely re-verifies the whole log at one chunk of
   * memory rather than in one array.
   */
  reconcile(stream: Stream = STREAM_HOT): { rows: number; cursor: bigint } {
    const start = this.st.cursors[stream];
    let after = start;
    let healed = 0;
    for (;;) {
      const raw = this.rowStore.range(stream, after, ROW_CHUNK);
      if (raw.length === 0) break;
      const rows = raw.map(decodeWireRow);
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      if (last.seq <= after) {
        throw new Error(`${stream} rows: range() did not advance past seq ${after.toString(10)}`);
      }
      const groups = byChain(rows);
      const pinnedBefore = new Map(this.st.pinnedHeads);
      if (stream === STREAM_HOT) {
        for (const [key, run] of groups) verifyChain(key, run, pinnedBefore.get(key) ?? genesisHead());
      } else {
        for (const [key, run] of groups) {
          const pins = this.st.pinnedBlobHashes.get(key);
          if (pins === undefined) {
            throw new ChainBreakError(
              `no cold hashes are pinned for (${key}), so the ${run.length} cold bod${run.length === 1 ? "y" : "ies"} ` +
                `already on disk cannot be verified — run \`cli pull-cold-hashes\``,
            );
          }
          verifyFetchedRange(pins, run);
        }
      }
      // Pin and advance together, per chunk: an interrupted reconcile has to
      // leave a state the next one can carry on from, and a cursor that ran
      // ahead of the heads is the break this method exists to prevent.
      this.store.transaction(() => {
        this.st.cursors[stream] = last.seq;
        if (stream === STREAM_HOT) {
          for (const [key, run] of groups) {
            this.st.pinnedHeads.set(key, headAfter(run, pinnedBefore.get(key) ?? genesisHead()));
          }
        }
        this.commit();
      });
      healed += rows.length;
      after = last.seq;
      if (raw.length < ROW_CHUNK) break;
    }
    return { rows: healed, cursor: this.st.cursors[stream] };
  }

  /**
   * Runs every invariant over the WHOLE stored log, from genesis.
   *
   * Not over the last page: a standalone `check` has no page, and re-verifying
   * from genesis is the stronger claim anyway — every chain, every AAD and
   * every bucket is re-derived from the stored bytes with no pinned head to
   * lean on. The pinned heads are therefore deliberately NOT passed; passing
   * them would make I2 expect counters to continue from the head while the
   * rows it is handed start at 1.
   */
  check(stream: Stream = STREAM_HOT, roster: readonly Writer[] = []): Violation[] {
    // Nothing here builds an array of the log. `checkAllStream` takes the rows
    // and the ops as re-iterable chunk sources, so a whole-log check holds one
    // chunk of blobs at a time instead of all 3,683 — which at up to 1 MiB a
    // blob is the >500 MB shape the Phase 0 device build froze on. Task 5 left
    // this as the one remaining O(log) hold and named Task 12 as its owner.
    const rows = storedRows(this.rowStore, stream, decodeWireRow);
    const ops = storedOps(this.rowStore, this.userId, decodeWireRow);

    // The state is folded a chunk at a time and the ops each chunk produced are
    // DISCARDED — `applyRows` needs somewhere to put them, and that somewhere
    // keeps nothing. `materialize()` returns them instead, which is what makes
    // it the array this method no longer builds.
    //
    // {@link discardingOps} rather than an array truncated between chunks. Both
    // hold one chunk at a time, but the truncating version puts the property in
    // a LINE inside a sync function — deletable, and invisible to every
    // instrument, because the array dies at return either way and nothing can
    // reach a sync function's locals mid-run. Deleting `spent.length = 0` was
    // this task's one surviving mutant for exactly that reason. A named sink
    // moves the property somewhere a test can hold it: `stream.test.ts` pins
    // that this thing keeps nothing.
    const state = emptyState();
    const spent = discardingOps();
    eachRowChunk(this.rowStore, STREAM_HOT, (chunk) => {
      applyRows(state, spent, this.userId, chunk.map(decodeWireRow));
    });
    state.cursors.cold = this.st.cursors.cold;

    // The last row's seq, without decoding a blob to get it: I1 compares `next`
    // against it, and a whole-log check resumes from 0, so the last row IS the
    // cursor this pass would persist.
    let next = 0n;
    eachRowChunk(this.rowStore, stream, (chunk) => {
      const last = chunk[chunk.length - 1];
      if (last !== undefined) next = parseDecimal(last.seq);
    });

    return checkAllStream({
      userId: this.userId,
      stream,
      rows,
      hashList: [],
      ops,
      state,
      roster: [...roster],
      pinnedHeads: new Map(),
      pinnedBlobHashes: this.st.pinnedBlobHashes,
      cursorBefore: 0n,
      next,
    });
  }

  /**
   * {@link check} against a roster fetched from the server.
   *
   * This is what `cli check` runs, and the distinction is not cosmetic: I11's
   * whole job is to cross-check the roster against the checkpoint, and with an
   * empty roster it has nothing to compare — a second device enrolled but never
   * checkpointed would pass. An offline `check` is still worth having (every
   * other invariant is local), so both exist and only one of them is the
   * command.
   */
  async checkOnline(stream: Stream = STREAM_HOT): Promise<Violation[]> {
    return this.check(stream, await this.roster());
  }

  // -- HTTP ---------------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown, authed = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authed) {
      if (this.st.sessionToken === null) throw new Error("not signed in: run `cli login` first");
      headers["Authorization"] = `Bearer ${this.st.sessionToken}`;
    }
    let res: Response;
    try {
      res = await this.doFetch(`${this.server}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      // No HTTP answer at all: airport wifi, a dropped LTE hop, the server
      // down. Named as its own class so callers can allow-list it — the outbox
      // treats exactly this as "not right now" and everything else as a real
      // failure, and a caller that had to recognise it by matching on
      // `TypeError` would quietly swallow the client's own consistency errors,
      // which are also plain `Error`s.
      throw new NetworkError(`${method} ${path}: ${err instanceof Error ? err.message : String(err)}`, err);
    }
    const text = await res.text();
    if (!res.ok) {
      let code = "";
      let detail = "";
      try {
        const e = JSON.parse(text) as { error?: string; detail?: string };
        code = e.error ?? "";
        detail = e.detail ?? "";
      } catch {
        detail = text.slice(0, 200);
      }
      throw new ApiError(res.status, code, detail, `${method} ${path}: ${res.status} ${code}${detail === "" ? "" : `: ${detail}`}`);
    }
    if (res.status === 204 || text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProtocolError(`${method} ${path}: response is not JSON`);
    }
  }

  // -- sign-in and enrolment ---------------------------------------------

  /**
   * Trades a provider ID token for a session.
   *
   * It refuses to bind a profile to a second account. Two accounts sharing one
   * state file would mix their pinned heads and their cursors, and the AAD
   * check (I4) would then fail on every row of whichever one lost — a confusing
   * report of a problem that is entirely local.
   *
   * `inviteCode` is the closed beta's gate. It is required to CREATE an
   * account and ignored entirely for one that already exists, so a caller may
   * pass it on every sign-in without spending it and an existing user may
   * always omit it. A server that requires one and did not get one answers
   * `403 not_invited`, which surfaces here as an `ApiError` with that code —
   * distinguishable from a credential failure on purpose, because re-entering
   * an Apple password will never fix it.
   */
  async login(idp: string, idToken: string, inviteCode?: string): Promise<string> {
    const out = await this.request<{ session_token: string; user_id: string }>(
      "POST",
      "/api/v1/auth/exchange",
      inviteCode === undefined
        ? { idp, id_token: idToken }
        : { idp, id_token: idToken, invite_code: inviteCode },
      false,
    );
    if (this.st.userId !== null && this.st.userId !== out.user_id) {
      throw new Error(
        `this profile is bound to user ${this.st.userId} and the server returned ${out.user_id}; ` +
          `use a different --profile rather than mixing two accounts in one state file`,
      );
    }
    this.st.userId = out.user_id;
    this.st.sessionToken = out.session_token;
    this.commit();
    return out.user_id;
  }

  /**
   * Creates this writer's identity key if it does not have one, and returns its
   * PUBLIC half.
   *
   * Persisted before it is returned: a key generated, used and then lost to a
   * crashed process is a writer the server knows and this device can never sign
   * for again.
   */
  ensureWriterKey(writerId: string): Uint8Array {
    requireWriterID(writerId);
    let key = this.st.writers.get(writerId);
    if (key === undefined) {
      key = newWriterKey();
      this.st.writers.set(writerId, key);
      this.commit();
    }
    return publicKeyBytes(key);
  }

  /** Authors as `writerId` from now on. Refuses a writer whose key is not here. */
  useWriter(writerId: string): void {
    if (!this.st.writers.has(writerId)) {
      throw new Error(`no key for writer ${JSON.stringify(writerId)} in ${this.store.location}`);
    }
    this.st.writerId = writerId;
    this.commit();
  }

  /**
   * Enrols a writer.
   *
   * The session names the ACCOUNT and authorizes nothing else: the enrolment is
   * authorized by an Ed25519 signature over a server-issued single-use nonce,
   * so a stolen session token alone cannot add a writer (spec §3.4). Without
   * `signWith` the new key signs for itself, and the server accepts that exactly
   * once per account — the TOFU bootstrap.
   *
   * # Enrolling a PEER, which is how the second device actually joins
   *
   * `publicKey` enrols a writer whose private key this device does not hold and
   * never sees. The second device generates its own key
   * ({@link ensureWriterKey}), hands over the public half — a QR code in the
   * product, an in-process value in the test rig — and the FIRST device signs
   * the registration for it. That is the flow spec §3.4 describes, and the
   * reason this takes a public key rather than a way to move a private one: a
   * private key that can be exported is a private key that will be.
   *
   * A peer enrolment must be signed by an enrolled writer: self-signing a key
   * you do not hold is not possible, and the TOFU bootstrap is spent.
   */
  async enroll(writerId: string, opts: { signWith?: string; publicKey?: Uint8Array } = {}): Promise<void> {
    requireWriterID(writerId);
    const peer = opts.publicKey !== undefined;
    if (peer && opts.signWith === undefined) {
      throw new Error(`enrolling ${JSON.stringify(writerId)} from its public key needs an already-enrolled signer`);
    }
    const pub = peer ? opts.publicKey! : this.ensureWriterKey(writerId);
    if (pub.length !== 32) {
      // `auth.checkPublicKey` refuses this too, but a 403 from the server names
      // no reason (every registration rejection is the same answer, on purpose),
      // so a mistyped key would present as "registration rejected" with nothing
      // to act on. An Ed25519 public key is 32 bytes; anything else is a typo.
      throw new Error(`the public key for ${JSON.stringify(writerId)} is ${pub.length} bytes, and Ed25519 keys are 32`);
    }
    const signerID = opts.signWith ?? writerId;
    const signer = this.st.writers.get(signerID);
    if (signer === undefined) {
      throw new Error(`no key for writer ${JSON.stringify(signerID)} in ${this.store.location}`);
    }
    const { nonce } = await this.request<{ nonce: string }>("POST", "/api/v1/writers/challenge", {});
    const nonceBytes = unbase64(nonce, "challenge nonce");
    const sig = signBytes(signer, registrationMessage(nonceBytes, writerId, pub));
    await this.request<void>("POST", "/api/v1/writers/register", {
      writer_id: writerId,
      pubkey: platform().toBase64(pub),
      nonce,
      sig: platform().toBase64(sig),
    });
    // A device adopts a writer only when it holds that writer's key. Adopting a
    // peer's id would make this device author blobs it cannot sign for — and,
    // worse, would fork the peer's chain by reusing its counters.
    if (!peer) this.st.writerId = writerId;
    this.commit();
  }

  async roster(): Promise<Writer[]> {
    const out = await this.request<{ writers: Writer[] }>("GET", "/api/v1/writers");
    return out.writers ?? [];
  }

  // -- pull ---------------------------------------------------------------

  /**
   * Pulls one stream to its head, verifying every page before applying it.
   *
   * **The default is hot only.** Spec §3.3:70 makes the cold stream lazily
   * synced behind a rolling window, so hot-only is the mode the product ships
   * and therefore the mode the default must exercise: a default that pulled
   * both would let a design in which hot-only sync is impossible pass unnoticed.
   *
   * The order within a page is fixed and none of it is optional:
   *
   *  1. **Verify the chain** (hot) or the pinned per-blob hashes (cold), before
   *     any blob is opened. `verifyChain` throws {@link ChainBreakError}, which
   *     is a hard stop and leaves the store untouched.
   *  2. **Fold**, setting aside anything that will not open or decode.
   *  3. **Check**, over the ops just decoded plus every op folded before them.
   *  4. **Persist** the rows, the cursor and the new pinned heads together, and
   *     only if step 3 found no `hard_stop`.
   *
   * Steps 3 and 4 in that order are the whole contract: a cursor persisted over
   * an uncertified page can never be walked back, because the client would
   * never ask for those rows again.
   */
  async pull(opts: { stream?: Stream; limit?: number } = {}): Promise<PullReport> {
    const stream = opts.stream ?? STREAM_HOT;
    const roster = await this.roster();
    const report: PullReport = { stream, pages: 0, rows: 0, cursor: this.st.cursors[stream], complete: false, violations: [] };

    // The running fold, carried across pages so a multi-page pull is O(log)
    // rather than O(pages x log). It is discarded wholesale on a hard stop; the
    // committed truth is the store, which the next command reloads.
    const { state, ops } = this.materialize();

    for (;;) {
      const cursorBefore = this.st.cursors[stream];
      const q = new URLSearchParams({ stream, after: cursorBefore.toString(10) });
      if (opts.limit !== undefined) q.set("limit", String(opts.limit));
      const res = await this.request<PullResponse>("GET", `/api/v1/sync?${q.toString()}`);
      if (decodeStream(res.stream, "response stream") !== stream) {
        throw new ProtocolError(`asked for the ${stream} stream and the server answered ${res.stream}`);
      }
      const rows = (res.rows ?? []).map(decodeWireRow);
      const next = parseDecimal(res.next);
      report.pages++;

      const pinnedBefore = new Map(this.st.pinnedHeads);
      const groups = byChain(rows);
      const asInput = (): CheckInput => ({
        userId: this.userId,
        stream,
        rows,
        hashList: [],
        ops,
        state,
        roster,
        pinnedHeads: pinnedBefore,
        pinnedBlobHashes: this.st.pinnedBlobHashes,
        cursorBefore,
        next,
      });

      // 1. Verify, before anything is opened.
      try {
        if (stream === STREAM_HOT) {
          for (const [key, run] of groups) verifyChain(key, run, pinnedBefore.get(key) ?? genesisHead());
        } else {
          // Cold bodies are a WINDOW, not a run: their counters are legitimately
          // sparse, so there is no chain to walk. They are checked against the
          // per-blob hashes `pull-cold-hashes` pinned, which is the whole of
          // spec §3.3:72 that a body fetch can lean on.
          for (const [key, run] of groups) {
            const pins = this.st.pinnedBlobHashes.get(key);
            if (pins === undefined) {
              throw new ChainBreakError(
                `no cold hashes are pinned for (${key}), so none of its bodies can be verified — ` +
                  `run \`cli pull-cold-hashes\` before pulling cold bodies`,
              );
            }
            verifyFetchedRange(pins, run);
          }
        }
      } catch (err) {
        if (!(err instanceof ChainBreakError)) throw err;
        // The chain refused, so NOTHING was opened and nothing folded — which is
        // the point of verifying first. But a bare "row 2 has counter 4, want 3"
        // names no invariant, and the operator's next question is always "which
        // one, and how bad". So the checker is run over the same page, on the
        // unfolded state, purely to ATTRIBUTE the refusal: a dropped row is
        // I2's finding, a substituted blob is I3's, a swapped cold body is
        // I3b's. The ChainBreakError is kept as the cause so the raw detail is
        // not lost.
        const attributed = checkAll(asInput());
        report.violations = attributed;
        if (attributed.some((v) => v.severity === "hard_stop")) throw new HardStopError(attributed, err);
        // The chain check is strictly stronger than the checker on one point —
        // a run spliced together from two chains — so a refusal the checker
        // cannot name is surfaced as itself rather than swallowed.
        throw err;
      }

      // 2. Fold.
      applyRows(state, ops, this.userId, rows);

      // 3. Check.
      const violations = checkAll(asInput());
      report.violations = violations;
      if (violations.some((v) => v.severity === "hard_stop")) throw new HardStopError(violations);

      // 4. Persist: rows, cursor and heads together — in ONE transaction.
      //
      // They used to be one write, because the rows lived inside the state.
      // Splitting the log out split the write, and a page of rows and the
      // cursor that says they were taken must still land together: a cursor
      // ahead of the rows claims rows nothing will ever ask for again, and rows
      // ahead of the cursor make the next pull re-serve rows the fold has
      // already consumed, which the replay ordering guard refuses. `Store`
      // makes the pair atomic where it can (SQLite, i.e. the phone) and orders
      // it onto the recoverable side where it cannot (the file store).
      this.store.transaction(() => {
        this.rowStore.append(stream, res.rows ?? []);
        this.st.cursors[stream] = next;
        if (stream === STREAM_HOT) {
          for (const [key, run] of groups) {
            this.st.pinnedHeads.set(key, headAfter(run, pinnedBefore.get(key) ?? genesisHead()));
          }
        }
        this.commit();
      });

      report.rows += rows.length;
      report.cursor = next;
      report.complete = res.complete === true;
      if (res.complete === true || rows.length === 0) break;
    }
    return report;
  }

  /**
   * Refreshes the pinned per-blob hash list for the COLD stream (spec §3.3:72).
   *
   * This is how a client pins a chain whose bodies it has not downloaded. The
   * list alone proves nothing about those bodies — they are not here to hash —
   * but it commits the server to a sequence of hashes it cannot afterwards
   * change its mind about, and every later body fetch is checked against it by
   * `verifyFetchedRange`. That is what makes a swapped cold body detectable.
   *
   * The pinned entries are ADDITIVE and an existing pin is never overwritten:
   * if the server re-serves a counter with a different hash, the old pin stands
   * and the disagreement is surfaced (I3b) rather than resolved in the server's
   * favour.
   *
   * # Cold only, and not by accident
   *
   * The endpoint serves `hot` as well, and this deliberately refuses to use it.
   * A hot head pinned from the hash list runs AHEAD of the hot bodies, and
   * {@link pull} verifies hot bodies with `verifyChain` against the pinned head
   * — so the next hot pull would arrive at counter N with the head already at
   * M > N, raise a chain break, and the client would be permanently stuck with
   * no way to clear it. Cold is safe from the same move only because its bodies
   * are a lazily-synced window verified by `verifyFetchedRange` against these
   * pins rather than against the head.
   *
   * A future client that PRUNES hot blobs would want hot hash lists, and it
   * cannot simply pass a stream here: it owes a separate pinned-head-for-hot
   * that `pull` does not treat as the body chain's head, exactly as cold has.
   */
  async pullColdHashes(opts: { limit?: number } = {}): Promise<{ pinned: number; heads: Map<ChainKey, Head> }> {
    const stream = STREAM_COLD;
    let pinned = 0;
    for (;;) {
      const before = this.st.hashCursors[stream];
      const q = new URLSearchParams({ stream, after: before.toString(10) });
      if (opts.limit !== undefined) q.set("limit", String(opts.limit));
      const res = await this.request<HashesResponse>("GET", `/api/v1/sync/hashes?${q.toString()}`);
      if (decodeStream(res.stream, "response stream") !== stream) {
        throw new ProtocolError(`asked for ${stream} hashes and the server answered ${res.stream}`);
      }
      const list = (res.hashes ?? []).map(decodeHashEntry);
      const next = parseDecimal(res.next);
      // The loop's progress guarantee, and it has to be explicit here: unlike
      // `pull`, nothing downstream re-checks this cursor, so a server answering
      // `{hashes: [...], next: <unchanged>, complete: false}` would spin
      // forever. `pull` is covered by I1, which refuses a `next` that is not the
      // last row delivered.
      if (list.length > 0 && next <= before) {
        throw new ProtocolError(
          `the hash list returned ${list.length} entr${list.length === 1 ? "y" : "ies"} but its next cursor ` +
            `${next} does not advance past ${before}`,
        );
      }

      const heads = new Map<ChainKey, Head>();
      for (const [writerID, run] of groupHashes(list)) {
        const key = chainKey(writerID, stream);
        heads.set(key, verifyHashList(key, run, this.st.pinnedHeads.get(key) ?? genesisHead()));
      }
      // Only after every chain in the page verified: a throw above leaves the
      // cursor and the pins exactly where they were.
      for (const [key, head] of heads) this.st.pinnedHeads.set(key, head);
      for (const h of list) {
        const key = chainKey(h.writer_id, stream);
        let m = this.st.pinnedBlobHashes.get(key);
        if (m === undefined) {
          m = new Map();
          this.st.pinnedBlobHashes.set(key, m);
        }
        if (!m.has(h.writer_counter)) {
          m.set(h.writer_counter, h.blob_hash);
          pinned++;
        }
      }
      this.st.hashCursors[stream] = next;
      this.commit();
      if (res.complete === true || list.length === 0) break;
    }
    return { pinned, heads: new Map(this.st.pinnedHeads) };
  }

  // -- authoring ----------------------------------------------------------

  /**
   * Appends a locally-authored op to the pending batch. It is validated here,
   * not at upload: the log is append-only, so an invalid op that reaches it is
   * permanent.
   */
  emit(spec: { type: string; payload: unknown; entity?: EntityRef; parentVersion?: number | null; ingestId?: string }): Op {
    if (!isOpType(spec.type)) throw new Error(`unknown op type ${JSON.stringify(spec.type)}`);
    const op: Op = {
      v: SCHEMA_VERSION,
      type: spec.type as OpType,
      op_id: ulid(),
      // The one wall-clock reading in this file. It is the fork tiebreak and
      // nothing else reads it; replay orders by `seq`.
      authored_at: new Date().toISOString(),
      parent_version: spec.parentVersion ?? null,
      payload: spec.payload,
    };
    if (spec.entity !== undefined) op.entity = spec.entity;
    if (spec.ingestId !== undefined && spec.ingestId !== "") op.ingest_id = spec.ingestId;
    validateOp(op);
    this.st.pending.push(op);
    this.commit();
    return op;
  }

  /**
   * Syncs far enough to know every chain's real head, then emits a
   * `writer_checkpoint` naming one head for EVERY (roster writer x stream) pair.
   *
   * # CHECKPOINT_NAMES_THE_ROSTER
   *
   * A checkpoint built from the chains its author happens to have OBSERVED can
   * never name an enrolled writer that has authored nothing — there is no head
   * to observe — so such a writer would hard-stop `I11_roster_checkpoint` on
   * every sync forever, and no checkpoint any device could emit would clear it.
   * That is not hypothetical: it is the exit test's own configuration, where
   * `dev-b` is enrolled and silent when the first checkpoint is written. So a
   * chain that holds no blobs is named at counter 0 with the genesis hash,
   * which asserts nothing false — `0 > observed` is never true, so a zero entry
   * can hide no withheld rows.
   *
   * # Counter 0 must mean EMPTY, not merely UNKNOWN — and that is why this syncs
   *
   * The contract says counter 0 for a chain that **holds no blobs**. The first
   * implementation used counter 0 for a chain **this device had not pinned**,
   * which is a strictly wider set, and the difference is the whole value of the
   * mechanism: a device that had only ever pulled hot would attest
   * `ingest|cold: 0/genesis` while the cold chain held twenty raw email bodies,
   * and a peer would then have NO trusted head for the stream the mail lives on.
   * A truncation of it would verify. The checkpoint satisfied I11's coverage
   * requirement while asserting nothing at all.
   *
   * So this learns the heads before it claims them, and each stream is learned
   * by the mechanism that stream is verified with:
   *
   *   - **hot** by {@link pull}, which verifies the blobs themselves;
   *   - **cold** by {@link pullColdHashes}, which verifies the per-blob hash
   *     list from the pinned head — the cold bodies are a lazily-synced window
   *     (spec §3.3:70) and the hash list is the only evidence there is.
   *
   * **Do not "optimise" this by pinning the HOT head from the hash list too.**
   * `pull` verifies hot bodies with `verifyChain` against the pinned head, so a
   * hot head pinned ahead of the bodies makes the next hot pull a chain break
   * this client can never clear. `pullColdHashes` documents the same hazard.
   *
   * # What is still, unavoidably, a snapshot
   *
   * A checkpoint attests what its author had verified when it wrote it. Rows
   * appended after that are legitimately absent from it, so a peer reading
   * "claims 0, I see 20" cannot separate a stale checkpoint from a withheld
   * chain — `CheckpointEntry` carries no position. Task 13 measured that and
   * landed it as a NOTICE rather than a hard stop. Syncing first is what keeps
   * that notice rare and meaningful instead of the normal case.
   */
  async checkpoint(): Promise<Op> {
    await this.pull();
    await this.pullColdHashes();
    return this.buildCheckpoint(await this.roster());
  }

  /**
   * Builds the checkpoint from the heads this device has already verified.
   *
   * Split from {@link checkpoint} so {@link push} can do its own syncing once
   * rather than twice; every caller owes it a preceding `pull` +
   * `pullColdHashes`, or it will attest genesis for chains it simply has not
   * looked at — which is the defect this split exists to make visible at the
   * call site rather than hidden inside one method.
   */
  private buildCheckpoint(roster: readonly Writer[]): Op {
    return this.emit({ type: "writer_checkpoint", payload: encodeCheckpointPayload(this.attestableHeads(roster)) });
  }

  /**
   * The heads this device would attest right now: one per (roster writer x
   * stream), from the pinned heads, genesis where a chain has none.
   */
  private attestableHeads(roster: readonly Writer[]): CheckpointHead[] {
    const heads: CheckpointHead[] = [];
    for (const w of roster) {
      for (const stream of [STREAM_HOT, STREAM_COLD] as const) {
        const h = this.pinnedHead(w.writer_id, stream);
        heads.push({ writer_id: w.writer_id, stream, counter: h.counter.toString(10), hash: hex(h.hash) });
      }
    }
    return heads;
  }

  /**
   * Batches the pending ops into padded blobs, chains them onto this writer's
   * hot head, uploads them, and then syncs so they are folded at the positions
   * the server assigned.
   *
   * # It SYNCS FIRST, and that ordering is the fix for a real defect
   *
   * `pull` + `pullColdHashes` run before anything is built, so the checkpoint
   * this push may carry attests heads that were verified moments ago rather
   * than genesis-because-nobody-looked. The first implementation built the
   * checkpoint *before* the self-sync and therefore attested `dev-a|hot: 0`
   * while its own next blob was counter 1, and `ingest|cold: 0` while the cold
   * chain held every raw email on the account. See {@link checkpoint}.
   *
   * Syncing first also means the writer's own chain head is current, so a push
   * that follows an interrupted one does not build a straddling batch in the
   * first place.
   *
   * # The ONE hard stop the pre-sync must not obey
   *
   * `I11_roster_checkpoint` fires when a live device writer has no head in the
   * latest checkpoint — and writing that checkpoint is precisely what this push
   * is about to do. Obeying it would deadlock the whole account: every device
   * needs a checkpoint before it can sync, and none can sync in order to write
   * one. So {@link syncForAttestation} proceeds over that ONE CONDITION —
   * `VIOLATION_ROSTER_COVERAGE` — and over nothing else. Not even over I11's
   * other hard stop: a checkpoint claiming a head this client has never seen
   * means rows are being WITHHELD, and a device in that position has nothing
   * trustworthy to attest.
   *
   * The cost is honest and bounded: a pre-sync that was refused persisted
   * nothing, so the healing checkpoint attests whatever heads this device had
   * already verified. The upload clears I11, the self-sync then succeeds, and
   * the heads-changed gate makes the NEXT push attest the fresh ones.
   *
   * # The checkpoint it emits without being asked
   *
   * A `writer_checkpoint` is appended whenever the heads this device would
   * attest DIFFER from the ones it last attested — which covers a new writer on
   * the roster, a peer's chain advancing, and its own. Gating on the roster
   * alone (the first implementation) meant exactly one checkpoint was ever
   * written per account: the roster string stopped changing, and the log's only
   * checkpoint went on claiming `dev-a|hot: 0` while the real head climbed.
   *
   * A roster change additionally forces a checkpoint even with nothing pending,
   * because that is the case a newly enrolled device is BLOCKED on — it cannot
   * sync until some device attests it — and waiting for that device to happen
   * to have something to say is not a mechanism.
   *
   * # Why this does not churn
   *
   * After a successful upload the recorded attestation is updated to include
   * the blob just written, so a second `push` with nothing pending sees no
   * difference and uploads nothing. Without that, every no-op push would attest
   * the previous push's checkpoint and grow the log forever.
   *
   * # The self-sync at the end
   *
   * An upload leaves this client holding bytes the server has and it has not
   * verified. Pulling immediately closes that: the ops become part of the
   * folded state at their real `seq`, and the pinned head catches up with the
   * authored one. Without it, `cli push && cli check` would report on a log
   * missing everything just written — including the checkpoint, which is
   * exactly what `I11` is looking for.
   */
  async push(): Promise<PushReport> {
    // Every head this push may attest is learned HERE, by the mechanism that
    // verifies its stream, before a single byte is built.
    const blocked = await this.syncForAttestation();

    // Settle any batch a previous push left in the air, BEFORE anything reads
    // `pending` or the authoring head — both of them lie until it is settled,
    // and acting on them is what appends an op twice.
    this.reconcileInflight();

    const roster = await this.roster();
    const ids = roster.map((w) => w.writer_id).sort(compareUTF8);
    const rosterChanged = this.st.checkpointRoster === null || !sameStrings(ids, this.st.checkpointRoster);
    const attested = headsKey(this.attestableHeads(roster));
    const headsChanged = this.st.checkpointHeads === null || this.st.checkpointHeads !== attested;
    // Skipped when the caller already asked for one: `cli checkpoint && cli
    // push` must not upload two identical checkpoints.
    const already = this.st.pending.some((o) => o.type === "writer_checkpoint");
    let checkpointed = false;
    if ((headsChanged || blocked) && !already && (this.st.pending.length > 0 || rosterChanged || blocked)) {
      this.buildCheckpoint(roster);
      checkpointed = true;
    }
    if (this.st.pending.length === 0) {
      return { blobs: 0, ops: 0, seqs: [], checkpointed: false, remaining: 0 };
    }

    // An unsettled batch is RESENT in the grouping it was recorded with, never
    // rebuilt from whatever `pending` holds now. The packer is greedy, so an op
    // emitted since would join the first blob and change its bytes — and the
    // server answers a changed blob at an applied counter with
    // `409 chain_break`, which no later push can clear.
    const flight = this.st.inflight;
    let blobs = flight !== null && flight.length > 0 ? this.rebuildInflight(flight) : this.pageOfPending();
    /** Blobs the server was already holding when it refused the straddle. */
    let alreadyHeld: BuiltBlob[] = [];
    let seqs: bigint[];
    try {
      seqs = await this.upload(blobs);
    } catch (err) {
      // `409 chain_break` is `oplog.ErrChainBreak` coming back: the bytes this
      // device claims for a position are not the bytes stored there. It is the
      // same condition as a break found while pulling, so it becomes the same
      // error class — one class per meaning is what lets the halt surface and
      // the outbox's no-blind-retry latch key on it without string matching.
      if (err instanceof ApiError && err.status === 409 && err.code === "chain_break") {
        throw new ChainBreakError(`the server refused this device's batch: ${err.detail}`);
      }
      if (!(err instanceof ApiError) || err.status !== 409 || !isPartialResend(err)) throw err;
      // The partial-resend contract, quoted verbatim from `oplog/chain.go`: the
      // server refuses a straddling batch rather than trimming it, and the
      // client reads the chain head and resends ONLY the rows above it. The
      // already-stored rows are byte-identical to ours (we authored them), so
      // the survivors keep their counters and their prev_hash unchanged.
      const actual = await this.readChainHead(this.writerId, STREAM_HOT);
      alreadyHeld = blobs.filter((b) => parseDecimal(b.wire.writer_counter) <= actual.counter);
      blobs = blobs.filter((b) => parseDecimal(b.wire.writer_counter) > actual.counter);
      const first = blobs[0];
      if (first === undefined) {
        throw new ChainBreakError(
          `the server refused a partially-applied batch but its head is already at ${actual.counter}, ` +
            `above every row in it`,
        );
      }
      if (first.wire.prev_hash !== hex(actual.hash)) {
        throw new ChainBreakError(
          `resending from counter ${first.counter}: it links to ${first.wire.prev_hash}, but the server's head ` +
            `is ${hex(actual.hash)}`,
        );
      }
      // The record now covers the SUFFIX, because that is what is in the air.
      // Leaving the wider one would make the next launch try to resend rows the
      // server has already answered for.
      this.recordInflight(blobs);
      seqs = await this.upload(blobs);
    }

    // Only now, with the server's answer in hand, is the flight over.
    //
    // `alreadyHeld` counts as settled on evidence, not on the server's say-so:
    // the `prev_hash` check above establishes that the head the server reported
    // hashes to the blob THIS DEVICE built, and a chain hash covers every blob
    // beneath it. Leaving them queued would re-upload them at fresh counters on
    // the next push, which is the double-append this whole path exists to stop.
    const settled = [...alreadyHeld, ...blobs];
    const sent = new Set(settled.flatMap((b) => b.ops.map((o) => o.op_id)));
    const last = blobs[blobs.length - 1];
    if (last !== undefined) this.st.authoredHead = { counter: last.counter, hash: last.hash };
    this.st.pending = this.st.pending.filter((o) => !sent.has(o.op_id));
    this.st.inflight = null;
    // Both of these say "this device has attested those heads", so both are
    // owed a checkpoint that actually went. A paged push whose checkpoint fell
    // into a later page must not record the attestation of a blob still sitting
    // in the outbox.
    const checkpointLanded = checkpointed && settled.some((b) => b.ops.some((o) => o.type === "writer_checkpoint"));
    if (checkpointLanded) {
      this.st.checkpointRoster = ids;
      // What was ACTUALLY attested, not what the log will look like afterwards.
      // Recording the predicted post-upload heads instead — which an earlier
      // draft did, to suppress churn — makes the gate compare against a fiction:
      // the checkpoint in the log still says 0 for this device's own chain, the
      // next push sees "no change", and the 0 is never upgraded. Churn is bounded
      // by the `pending.length > 0` condition above, not by this.
      this.st.checkpointHeads = attested;
    }
    this.commit();

    await this.pull();
    return {
      blobs: blobs.length,
      ops: sent.size,
      seqs,
      checkpointed: checkpointLanded,
      remaining: this.st.pending.length,
    };
  }

  /**
   * Turns the head of the outbox into one upload's worth of blobs and records
   * the intent before returning it.
   *
   * The record is written here rather than at the call site so that no path can
   * build a batch and reach {@link upload} without one: the thing that makes the
   * ambiguous commit survivable is that the record exists BEFORE the request,
   * and a guard that a future edit can step around is not a guard.
   */
  private pageOfPending(): BuiltBlob[] {
    const blobs = this.buildBlobs(this.st.pending, this.authoringHead());
    this.recordInflight(blobs);
    return blobs;
  }

  /** Writes down what is about to be sent, durably, before it is sent. */
  private recordInflight(blobs: readonly BuiltBlob[]): void {
    this.st.inflight = blobs.map((b) => ({ counter: b.counter, hash: b.hash, opIds: b.ops.map((o) => o.op_id) }));
    this.commit();
  }

  /**
   * Decides what happened to the batch that was in the air when this device
   * last stopped, and clears it from the outbox if it landed.
   *
   * # It is a measurement, not a flag
   *
   * The evidence is the PINNED head — a head this device pulled back and
   * verified byte by byte, i.e. the server's own bytes re-hashed locally. It is
   * compared against a hash this device wrote down before it sent anything.
   * Those are two independent sources, which is the whole point: `authoredHead`
   * and an emptied `pending` are both written after the request returns, so
   * neither says anything about a request that never returned.
   *
   * Because a chain hash covers every blob before it, agreement at the tip is
   * agreement about the whole prefix. Disagreement is this device's own chain
   * forking — the one break it cannot blame on the server — and it stops here
   * rather than uploading over it.
   *
   * A batch that did NOT land stays recorded, so the resend reproduces the same
   * bytes at the same positions and the server's idempotent-replay contract
   * (`oplog.AppendClient`) answers with the seqs it already assigned.
   */
  private reconcileInflight(): void {
    const flight = this.st.inflight;
    if (flight === null || flight.length === 0) {
      if (flight !== null) {
        this.st.inflight = null;
        this.commit();
      }
      return;
    }
    const pinned = this.pinnedHead(this.writerId, STREAM_HOT);
    const tail = flight[flight.length - 1]!;
    if (pinned.counter > tail.counter) {
      throw new ChainBreakError(
        `this device's own chain is at counter ${pinned.counter} on the server, above the ${tail.counter} it has ` +
          `ever authored: something else is writing as ${this.writerId}`,
      );
    }
    const landed = flight.filter((b) => b.counter <= pinned.counter);
    const tip = landed[landed.length - 1];
    if (tip !== undefined) {
      if (hex(tip.hash) !== hex(pinned.hash)) {
        throw new ChainBreakError(
          `this device's own chain forked at counter ${tip.counter}: it sent ${hex(tip.hash)} and the server ` +
            `served ${hex(pinned.hash)}`,
        );
      }
      const done = new Set(landed.flatMap((b) => b.opIds));
      this.st.pending = this.st.pending.filter((o) => !done.has(o.op_id));
      this.st.authoredHead = { counter: tip.counter, hash: tip.hash };
    }
    const stillFlying = flight.filter((b) => b.counter > pinned.counter);
    this.st.inflight = stillFlying.length === 0 ? null : stillFlying;
    this.commit();
  }

  /**
   * Rebuilds a recorded batch byte for byte, and refuses to send it if it does
   * not come out byte for byte.
   *
   * Storing the bytes instead would mean up to 8 MiB in a state file rewritten
   * whole on every command, so the record keeps the GROUPING and this re-seals
   * it. That is safe only if sealing is deterministic, which is a property this
   * checks rather than assumes: every rebuilt blob is re-hashed and compared
   * against the hash written down before the original send. If gzip settings,
   * canonical JSON or the padding ladder ever stopped being deterministic, this
   * throws instead of claiming a position with bytes nobody recorded.
   */
  private rebuildInflight(flight: readonly InflightBlob[]): BuiltBlob[] {
    const byId = new Map(this.st.pending.map((o) => [o.op_id, o]));
    const head = this.authoringHead();
    const first = flight[0]!;
    if (first.counter !== head.counter + 1n) {
      throw new ChainBreakError(
        `the batch in flight claims counter ${first.counter}, but this device's chain head is ${head.counter}`,
      );
    }
    const out: BuiltBlob[] = [];
    let prev = head;
    for (const rec of flight) {
      const ops = rec.opIds.map((id) => {
        const op = byId.get(id);
        if (op === undefined) {
          throw new Error(`op ${id} is in the batch this device was uploading, but no longer in its outbox`);
        }
        return op;
      });
      const built = this.sealBatch(ops, rec.counter, prev.hash);
      if (hex(built.hash) !== hex(rec.hash)) {
        throw new Error(
          `re-sealing counter ${rec.counter} produced ${hex(built.hash)}, but this device recorded ${hex(rec.hash)} ` +
            `before it sent it: blob sealing is no longer deterministic`,
        );
      }
      out.push(built);
      prev = { counter: built.counter, hash: built.hash };
    }
    return out;
  }

  /**
   * Syncs both streams so a checkpoint can attest real heads, and reports
   * whether it was blocked by a checkpoint that does not cover the roster.
   *
   * # The allow-list, and why it is an allow-list
   *
   * `true` means EVERY hard stop the pre-sync raised was
   * {@link VIOLATION_ROSTER_COVERAGE} — a live device writer with no attested
   * head — and the caller should write a checkpoint anyway, because that is the
   * repair and refusing deadlocks an account whose every device needs a
   * checkpoint before it can sync.
   *
   * Everything else propagates, and `I11_roster_checkpoint`'s OTHER hard stop is
   * the one that matters: {@link VIOLATION_CHAIN_WITHHELD} means a checkpoint
   * attests a head above anything this client has seen, i.e. the server is
   * withholding rows a peer already witnessed. Matching on the ID alone — which
   * this did — proceeded over that too, and the consequence was built end to
   * end: a truncated peer chain, a third device that pushes over the stop, and
   * a fresh checkpoint claiming genesis for every chain replaces the honest
   * attestation, after which the truncation is only a notice. **A device being
   * withheld from must author no checkpoint at all.**
   *
   * It is an ALLOW-list rather than a deny-list on purpose. A condition added
   * to I11 later carries no kind, so it is un-escapable until someone
   * deliberately marks it benign — the failure mode of forgetting is a refused
   * push, not a laundered attack.
   *
   * `pull` persisted nothing over the refusal, so a `true` return also means
   * the heads about to be attested are only as fresh as the last clean sync.
   */
  private async syncForAttestation(): Promise<boolean> {
    let blocked = false;
    try {
      await this.pull();
    } catch (err) {
      if (!(err instanceof HardStopError)) throw err;
      // The predicate lives in `invariants/surface.ts`, which is also what the
      // halt screens classify with: two copies of an allow-list are two things
      // that can disagree, and the one that disagreed here laundered a
      // withholding attack into a notice.
      if (!escapableDuringPush(err.violations.filter((v) => v.severity === "hard_stop"))) throw err;
      blocked = true;
    }
    // Not inside the try: the cold hash list is verified by `verifyHashList`
    // and never runs the invariant checker, so it has no I11 to forgive and a
    // failure here is a real chain break.
    await this.pullColdHashes();
    return blocked;
  }

  /**
   * The head this writer's next blob chains onto: whichever of the verified
   * head and the last upload is further along.
   *
   * They differ for one window — between a successful upload and the pull that
   * brings those rows back — and taking the maximum is what stops a push that
   * followed a failed pull from reusing a counter the server already holds.
   * When they agree on a counter they must agree on the hash; disagreement
   * there is a fork in this device's own chain and is never papered over.
   */
  private authoringHead(): Head {
    const pinned = this.pinnedHead(this.writerId, STREAM_HOT);
    const authored = this.st.authoredHead;
    if (authored === null || authored.counter < pinned.counter) return pinned;
    if (authored.counter > pinned.counter) return authored;
    if (hex(authored.hash) !== hex(pinned.hash)) {
      throw new ChainBreakError(
        `this device's own chain forked at counter ${pinned.counter}: it uploaded ${hex(authored.hash)} and the ` +
          `server served ${hex(pinned.hash)}`,
      );
    }
    return pinned;
  }

  /**
   * Packs ops into sealed, padded, chained blobs.
   *
   * Greedy: ops accumulate into one blob until the framed result would run past
   * the largest bucket, then a new one starts. **The ingest writer never
   * batches** (that is a server-side rule, so that one email is one row); a
   * client always may, and a batch of small ops that shares one 1 KiB bucket is
   * the point of the ladder.
   *
   * It stops at {@link MAX_UPLOAD_BLOBS} and leaves the rest of `ops` for the
   * next call — it does NOT refuse them. A week offline with a slow connection
   * is the beta's ordinary case, and the earlier behaviour (throw
   * `${n} blobs exceeds the 8 one upload may claim; push more often`) turned it
   * into an outbox nothing could ever drain, since "push more often" is advice
   * for a past that has already happened.
   */
  private buildBlobs(ops: readonly Op[], head: Head): BuiltBlob[] {
    const out: BuiltBlob[] = [];
    let prev = head;
    let batch: Op[] = [];
    const flush = (): void => {
      if (batch.length === 0) return;
      const built = this.sealBatch(batch, prev.counter + 1n, prev.hash);
      out.push(built);
      prev = { counter: built.counter, hash: built.hash };
      batch = [];
    };
    for (const op of ops) {
      batch.push(op);
      const counter = prev.counter + 1n;
      if (framedSize(this.userId, this.writerId, counter, batch) <= MAX_BUCKET) continue;
      batch.pop();
      if (batch.length === 0) {
        throw new RangeError(`op ${op.op_id} does not fit the largest size bucket on its own`);
      }
      flush();
      // The page boundary. `op` was popped and never re-added, so it and
      // everything after it stay in the outbox for the next call.
      if (out.length === MAX_UPLOAD_BLOBS) return out;
      batch.push(op);
      if (framedSize(this.userId, this.writerId, prev.counter + 1n, batch) > MAX_BUCKET) {
        throw new RangeError(`op ${op.op_id} does not fit the largest size bucket on its own`);
      }
    }
    flush();
    return out;
  }

  private sealBatch(ops: readonly Op[], counter: bigint, prevHash: Uint8Array): BuiltBlob {
    const env: Envelope = { userId: this.userId, stream: STREAM_HOT, writerId: this.writerId, writerCounter: counter };
    const bytes = sealBlob(env, encodeBlobOps([...ops]));
    const hash = chainHash(prevHash, bytes);
    return {
      counter,
      hash,
      ops: [...ops],
      wire: {
        writer_counter: counter.toString(10),
        prev_hash: hex(prevHash),
        blob_hash: hex(hash),
        type_flag: TYPE_FLAG_EDIT,
        size_bucket: bytes.length,
        blob: platform().toBase64(bytes),
      },
    };
  }

  private async upload(blobs: readonly BuiltBlob[]): Promise<bigint[]> {
    const out = await this.request<{ seqs: string[] }>("POST", "/api/v1/sync", {
      writer_id: this.writerId,
      stream: STREAM_HOT,
      blobs: blobs.map((b) => b.wire),
    });
    return (out.seqs ?? []).map((s) => parseDecimal(s));
  }

  /**
   * Reads one chain's head from the server's per-blob hash list.
   *
   * This is the "read the chain head" half of the partial-resend contract. The
   * hash list is the right instrument for it: it is per-stream, it carries
   * `prev_hash`, and it costs no blob bytes.
   */
  async readChainHead(writerId: string, stream: Stream): Promise<Head> {
    let head = genesisHead();
    let after = 0n;
    for (;;) {
      const q = new URLSearchParams({ stream, after: after.toString(10) });
      const res = await this.request<HashesResponse>("GET", `/api/v1/sync/hashes?${q.toString()}`);
      const list = (res.hashes ?? []).map(decodeHashEntry);
      for (const h of list) {
        if (h.writer_id === writerId && h.writer_counter > head.counter) {
          head = { counter: h.writer_counter, hash: h.blob_hash };
        }
      }
      const next = parseDecimal(res.next);
      // Same progress guarantee as pullColdHashes, and needed for the same
      // reason: this loop is the recovery path for a failed upload, so a server
      // that stalls it turns a retryable push into a hang.
      if (list.length > 0 && next <= after) {
        throw new ProtocolError(
          `the ${stream} hash list returned ${list.length} entr${list.length === 1 ? "y" : "ies"} but its next ` +
            `cursor ${next} does not advance past ${after}`,
        );
      }
      after = next;
      if (res.complete === true || list.length === 0) return head;
    }
  }

  private commit(): void {
    this.store.save(this.st);
  }
}

interface BuiltBlob {
  counter: bigint;
  hash: Uint8Array;
  ops: Op[];
  wire: UploadBlob;
}

/** The total framed length a batch would occupy, without keeping the bytes. */
function framedSize(userId: string, writerId: string, counter: bigint, ops: readonly Op[]): number {
  try {
    return sealBlob(
      { userId, stream: STREAM_HOT, writerId, writerCounter: counter },
      encodeBlobOps([...ops]),
    ).length;
  } catch (err) {
    if (err instanceof RangeError) return MAX_BUCKET + 1;
    throw err;
  }
}

/** Groups hash-list entries by writer. The endpoint is already per-stream. */
function groupHashes(list: readonly HashRow[]): Map<string, HashRow[]> {
  const out = new Map<string, HashRow[]>();
  for (const h of list) {
    const run = out.get(h.writer_id);
    if (run === undefined) out.set(h.writer_id, [h]);
    else run.push(h);
  }
  return out;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * A comparable rendering of a set of checkpoint heads.
 *
 * It goes through {@link encodeCheckpointPayload} so the ordering is the
 * canonical one, which is what makes "these are the heads I last attested" a
 * comparison of MEANING rather than of the order they happened to be built in —
 * a roster returned in a different order must not read as a change.
 */
function headsKey(heads: CheckpointHead[]): string {
  return encodeCheckpointPayload(heads)
    .heads.map((h) => `${h.writer_id}|${h.stream}|${h.counter}|${h.hash}`)
    .join(",");
}

/**
 * Recognises the 409 the server answers a straddling batch with, by its
 * documented body: `oplog/chain.go`'s contract text, quoted verbatim through
 * `api.writeAppendErr`. Matched on the DETAIL rather than the code because
 * `conflict` is also what a taken position answers, and the two have different
 * remedies — one resends a suffix, the other is unrepairable by the client.
 */
function isPartialResend(err: ApiError): boolean {
  return err.detail.includes("read the chain head and resend only the rows above it");
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/** Mirrors `auth.validWriterID`, which is also the writers table's CHECK. */
function requireWriterID(id: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    throw new Error(`writer id ${JSON.stringify(id)} must match [A-Za-z0-9._-]{1,64}`);
  }
}

/**
 * A {@link WriterKey} is a JWK pair, so its halves are **base64url** while the
 * seam speaks standard base64. Translating here rather than adding a
 * `fromBase64url` to `Platform` keeps the seam at one encoding, and this is the
 * only place in the client that meets the URL-safe alphabet.
 *
 * The stored form is not changed by the move to the seam: a state file written
 * by the `node:crypto` build still loads, and one written here still loads under
 * that build. `client.test.ts` pins the encoding.
 */
function b64urlToBytes(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  return platform().fromBase64(std + "=".repeat((4 - (std.length % 4)) % 4));
}

function bytesToB64url(b: Uint8Array): string {
  return platform().toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function newWriterKey(): WriterKey {
  const { priv, pub } = platform().ed25519GenerateKey();
  return { x: bytesToB64url(pub), d: bytesToB64url(priv) };
}

export function publicKeyBytes(k: WriterKey): Uint8Array {
  // Read out of `x`, exactly as the `createPublicKey` round-trip this replaced
  // did — it consulted `x` alone and never `d`. Deriving from the private half
  // instead would additionally catch an x/d mismatch, which is a real
  // improvement and a BEHAVIOUR CHANGE, so it does not belong in a seam
  // conversion; a peer's key is stored public-half-only and would break.
  // `createPublicKey` did enforce the 32-byte point, so that check stays.
  const pub = b64urlToBytes(k.x);
  if (pub.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${pub.length}`);
  return pub;
}

function signBytes(k: WriterKey, message: Uint8Array): Uint8Array {
  return platform().ed25519Sign(b64urlToBytes(k.d), message);
}

/**
 * The exact bytes a device signs to enrol a writer, mirroring
 * `auth.RegistrationMessage`:
 *
 *     "ledger-v2-writer-registration\0" || nonce || 0x00 || writer_id || 0x00 || pubkey
 *
 * The domain prefix is what stops a captured revocation signature doubling as
 * an enrolment, and binding all three fields is what stops a captured
 * enrolment signature authorizing a DIFFERENT one.
 */
export function registrationMessage(nonce: Uint8Array, writerId: string, pub: Uint8Array): Uint8Array {
  const p = platform();
  const id = p.utf8Encode(writerId);
  const domain = p.utf8Encode(REGISTRATION_DOMAIN);
  const out = new Uint8Array(domain.length + nonce.length + 1 + id.length + 1 + pub.length);
  let n = 0;
  out.set(domain, n);
  n += domain.length;
  out.set(nonce, n);
  n += nonce.length;
  out[n++] = 0;
  out.set(id, n);
  n += id.length;
  out[n++] = 0;
  out.set(pub, n);
  return out;
}

// ---------------------------------------------------------------------------
// Replay summary, for `cli replay`
// ---------------------------------------------------------------------------

export interface ReplaySummary {
  ops: number;
  txns: number;
  live: number;
  rules: number;
  homeCurrency: string | null;
  rates: number;
  checkpointHeads: number;
  forks: number;
  anomalies: number;
  unreadable: number;
  cursorHot: string;
  cursorCold: string;
}

/**
 * Summarises a fold. `fold(ops)` is called rather than the state being read
 * directly so that `cli replay` reports what the OPS produce, which is the
 * claim the exit criterion cares about.
 */
export function summarize(ops: LogEntry[], cursors: { hot: bigint; cold: bigint }, unreadable: number): ReplaySummary {
  const s = fold(ops);
  return {
    ops: ops.length,
    txns: s.txns.size,
    live: s.liveByIngestID.size,
    rules: s.rules.size,
    homeCurrency: s.homeCurrency,
    rates: s.rates.size,
    checkpointHeads: s.checkpoints.length,
    forks: s.forks.length,
    anomalies: s.anomalies.length,
    unreadable,
    cursorHot: cursors.hot.toString(10),
    cursorCold: cursors.cold.toString(10),
  };
}

/** A stable, JSON-safe rendering of a state, for `cli state --json`. */
export function stateToJSON(s: State): unknown {
  return {
    home_currency: s.homeCurrency,
    rates: [...s.rates].map(([ccy, r]) => ({ currency: ccy, rate_micro: r === null ? null : r.toString(10) })),
    txns: [...s.txns.values()]
      .sort((a, b) => compareUTF8(a.id, b.id))
      .map((t) => ({
        id: t.id,
        ingest_id: t.ingest_id,
        amount_minor: t.amount_minor.toString(10),
        currency: t.currency,
        direction: t.direction,
        posted_at: t.posted_at,
        merchant_raw: t.merchant_raw,
        last4: t.last4,
        category: t.category,
        needs_review: t.needs_review,
        // Without these an unparsed row renders here as an ordinary zero-amount
        // debit, which is the exact confusion Phase 2 Task 7 exists to remove —
        // and this is the surface an operator inspects an alpha's log through.
        unparsed: t.unparsed,
        tier: t.tier,
        parse_error: t.parse_error,
        provenance: t.provenance,
        amount_home_minor: t.amount_home_minor === null ? null : t.amount_home_minor.toString(10),
        splits: t.splits.map((p) => ({ category: p.category, amount_minor: p.amount_minor.toString(10) })),
        superseded_by: t.superseded_by,
        possible_duplicate_of: t.possible_duplicate_of,
        version: t.version,
      })),
    rules: [...s.rules.entries()]
      .sort(([a], [b]) => compareUTF8(a, b))
      .map(([id, r]) => ({ id, ...r })),
    checkpoints: s.checkpoints.map((c) => ({ ...c, counter: c.counter.toString(10) })),
    forks: s.forks.map((f) => ({ ...f, at_seq: f.at_seq.toString(10) })),
    anomalies: s.anomalies.map((a) => ({ ...a, at_seq: a.at_seq.toString(10) })),
    unreadable: s.unreadable.map((u) => ({ ...u, writer_counter: u.writer_counter.toString(10), seq: u.seq.toString(10) })),
    cursors: { hot: s.cursors.hot.toString(10), cold: s.cursors.cold.toString(10) },
  };
}

/** A fresh entity id for `cli emit --entity txn:new`. */
export function newEntityID(): string {
  return platform().randomUUID();
}
