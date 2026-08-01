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

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { ulid } from "ulid";

import { checkAll, type CheckInput, type SyncRow, type Violation, type Writer } from "../invariants/check";
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
import { genesisHead, type ClientState, type Store, type WireRow, type WriterKey } from "../store/store";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The server answered with a non-2xx status. `code`/`detail` are its own. */
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

/** Mirrors `api.maxUploadBlobs`: one request may claim at most this many positions. */
const MAX_UPLOAD_BLOBS = 8;

/** `oplog.TypeFlagEdit` — the only type flag a device may submit. */
const TYPE_FLAG_EDIT = "edit";

// ---------------------------------------------------------------------------
// Row decoding
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function unhex32(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || !/^[0-9a-f]{64}$/.test(s)) {
    throw new ProtocolError(`${what} must be 64 lower-case hex characters, got ${JSON.stringify(s)}`);
  }
  return new Uint8Array(Buffer.from(s, "hex"));
}

/**
 * Decodes standard base64 STRICTLY. `Buffer.from(s, "base64")` ignores anything
 * outside the alphabet, so a corrupted body would come back short and plausible
 * — and a short blob is not a size bucket, which would be reported as a bucket
 * violation rather than as the transport problem it is.
 */
function unbase64(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new ProtocolError(`${what} is not standard base64`);
  }
  return new Uint8Array(Buffer.from(s, "base64"));
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
  ops: number;
  seqs: bigint[];
  checkpointed: boolean;
}

export class Client {
  private readonly store: Store;
  private readonly doFetch: typeof fetch;
  private st: ClientState;

  constructor(opts: ClientOptions) {
    this.store = opts.store;
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

  cursor(stream: Stream): bigint {
    return this.st.cursors[stream];
  }

  pinnedHead(writerId: string, stream: Stream): Head {
    return this.st.pinnedHeads.get(chainKey(writerId, stream)) ?? genesisHead();
  }

  /** Every row this client has verified and kept, in the order it pulled them. */
  rowsFor(stream: Stream): readonly WireRow[] {
    return this.st.rows[stream];
  }

  /**
   * The materialized state, re-folded from every stored row.
   *
   * Recomputed rather than cached: a cached state would make I9's and I10's
   * "the state agrees with a re-fold of its own op log" a comparison of the
   * fold against itself.
   */
  materialize(): { state: State; ops: LogEntry[] } {
    const state = emptyState();
    const ops: LogEntry[] = [];
    applyRows(state, ops, this.userId, this.st.rows.hot.map(decodeWireRow));
    state.cursors.cold = this.st.cursors.cold;
    return { state, ops };
  }

  state(): State {
    return this.materialize().state;
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
    const rows = this.st.rows[stream].map(decodeWireRow);
    const { state, ops } = this.materialize();
    const last = rows[rows.length - 1];
    return checkAll({
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
      next: last === undefined ? 0n : last.seq,
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
    const res = await this.doFetch(`${this.server}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
   */
  async login(idp: string, idToken: string): Promise<string> {
    const out = await this.request<{ session_token: string; user_id: string }>(
      "POST",
      "/api/v1/auth/exchange",
      { idp, id_token: idToken },
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
      pubkey: Buffer.from(pub).toString("base64"),
      nonce,
      sig: Buffer.from(sig).toString("base64"),
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

      // 4. Persist: rows, cursor and heads together.
      this.st.rows[stream].push(...(res.rows ?? []));
      this.st.cursors[stream] = next;
      if (stream === STREAM_HOT) {
        for (const [key, run] of groups) {
          this.st.pinnedHeads.set(key, headAfter(run, pinnedBefore.get(key) ?? genesisHead()));
        }
      }
      this.commit();

      report.rows += rows.length;
      report.cursor = next;
      report.complete = res.complete === true;
      if (res.complete === true || rows.length === 0) break;
    }
    return report;
  }

  /**
   * Refreshes the pinned per-blob hash list for one stream (spec §3.3:72).
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
   */
  async pullColdHashes(opts: { stream?: Stream; limit?: number } = {}): Promise<{ pinned: number; heads: Map<ChainKey, Head> }> {
    const stream = opts.stream ?? STREAM_COLD;
    let pinned = 0;
    for (;;) {
      const q = new URLSearchParams({ stream, after: this.st.hashCursors[stream].toString(10) });
      if (opts.limit !== undefined) q.set("limit", String(opts.limit));
      const res = await this.request<HashesResponse>("GET", `/api/v1/sync/hashes?${q.toString()}`);
      if (decodeStream(res.stream, "response stream") !== stream) {
        throw new ProtocolError(`asked for ${stream} hashes and the server answered ${res.stream}`);
      }
      const list = (res.hashes ?? []).map(decodeHashEntry);
      const next = parseDecimal(res.next);

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
   * Emits a `writer_checkpoint` naming one head for EVERY (roster writer x
   * stream) pair.
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
   * # Only VERIFIED heads are claimed
   *
   * The counters come from the pinned heads — the ones this device verified
   * itself — and never from its own upload record. A checkpoint that claimed a
   * head this device has not pulled back would be true, and would still
   * hard-stop `I11` on the very next `check` here, because the client's own
   * `observedHead` would be lower. Claiming less is free; claiming more costs a
   * false alarm on a correct log.
   */
  checkpoint(roster: readonly Writer[]): Op {
    const heads: CheckpointHead[] = [];
    for (const w of roster) {
      for (const stream of [STREAM_HOT, STREAM_COLD] as const) {
        const h = this.pinnedHead(w.writer_id, stream);
        heads.push({ writer_id: w.writer_id, stream, counter: h.counter.toString(10), hash: hex(h.hash) });
      }
    }
    return this.emit({ type: "writer_checkpoint", payload: encodeCheckpointPayload(heads) });
  }

  /**
   * Batches the pending ops into padded blobs, chains them onto this writer's
   * hot head, uploads them, and then syncs so they are folded at the positions
   * the server assigned.
   *
   * # The checkpoint it emits without being asked
   *
   * Whenever the roster differs from the one this client last checkpointed
   * against — including the first time, when there is no last one — a
   * `writer_checkpoint` is appended to the batch. That is what makes
   * `I11_roster_checkpoint`'s roster-race asymmetry self-healing: a device
   * enrolled after the last checkpoint was written gets checkpointed on its own
   * first push, with nobody having to remember to ask.
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
    const roster = await this.roster();
    const ids = roster.map((w) => w.writer_id).sort(compareUTF8);
    const rosterChanged = this.st.checkpointRoster === null || !sameStrings(ids, this.st.checkpointRoster);
    // Skipped when the caller already asked for one: `cli checkpoint && cli
    // push` must not upload two identical checkpoints.
    const already = this.st.pending.some((o) => o.type === "writer_checkpoint");
    let checkpointed = false;
    if (rosterChanged && !already) {
      this.checkpoint(roster);
      checkpointed = true;
    }
    if (this.st.pending.length === 0) {
      return { blobs: 0, ops: 0, seqs: [], checkpointed: false };
    }

    const ops = [...this.st.pending];
    const head = this.authoringHead();
    let blobs = this.buildBlobs(ops, head);
    let seqs: bigint[];
    try {
      seqs = await this.upload(blobs);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409 || !isPartialResend(err)) throw err;
      // The partial-resend contract, quoted verbatim from `oplog/chain.go`: the
      // server refuses a straddling batch rather than trimming it, and the
      // client reads the chain head and resends ONLY the rows above it. The
      // already-stored rows are byte-identical to ours (we authored them), so
      // the survivors keep their counters and their prev_hash unchanged.
      const actual = await this.readChainHead(this.writerId, STREAM_HOT);
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
      seqs = await this.upload(blobs);
    }

    const last = blobs[blobs.length - 1];
    if (last !== undefined) this.st.authoredHead = { counter: last.counter, hash: last.hash };
    this.st.pending = [];
    if (rosterChanged) this.st.checkpointRoster = ids;
    this.commit();

    await this.pull();
    return { blobs: blobs.length, ops: ops.length, seqs, checkpointed };
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
      batch.push(op);
      if (framedSize(this.userId, this.writerId, prev.counter + 1n, batch) > MAX_BUCKET) {
        throw new RangeError(`op ${op.op_id} does not fit the largest size bucket on its own`);
      }
    }
    flush();
    if (out.length > MAX_UPLOAD_BLOBS) {
      throw new RangeError(
        `${out.length} blobs exceeds the ${MAX_UPLOAD_BLOBS} one upload may claim; push more often`,
      );
    }
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
        blob: Buffer.from(bytes).toString("base64"),
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
      after = parseDecimal(res.next);
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

function newWriterKey(): WriterKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { x?: string; d?: string };
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string") throw new Error("ed25519 key did not export as a JWK");
  return { x: jwk.x, d: jwk.d };
}

export function publicKeyBytes(k: WriterKey): Uint8Array {
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });
  const jwk = pub.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") throw new Error("ed25519 public key did not export as a JWK");
  return new Uint8Array(Buffer.from(jwk.x, "base64url"));
}

function signBytes(k: WriterKey, message: Uint8Array): Uint8Array {
  const priv = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x, d: k.d }, format: "jwk" });
  return new Uint8Array(sign(null, message, priv));
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
  const id = new TextEncoder().encode(writerId);
  const domain = new TextEncoder().encode(REGISTRATION_DOMAIN);
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
  return randomUUID();
}
