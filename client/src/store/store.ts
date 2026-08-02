/**
 * Local persistence for the client: cursors, pinned heads, pinned cold-blob
 * hashes, the writer's key material — and, kept strictly apart from all of
 * those, the rows it has verified.
 *
 * # The state and the log are two different things
 *
 * Until Task 5 they were one: `ClientState` carried `rows`, and `Client.commit()`
 * saved the whole state after every mutation, so **each command rewrote the
 * entire log**. That is O(log) bytes of write per command, which this file's own
 * module doc called "the correct trade for a test instrument and the wrong one
 * for a phone". The split is:
 *
 *  - {@link ClientState} — small, bounded by the number of writers and chains,
 *    saved whole on every command. Cursors, heads, keys, pending ops.
 *  - {@link RowStore} — the verified op-log rows, appended to and never
 *    rewritten. `save()` does not touch it.
 *
 * The rows are still kept, and still re-folded on every command, because that
 * is what makes I9/I10 ("the state agrees with a re-fold of its own op log") a
 * claim about something rather than a tautology. What changed is that a fold
 * now READS the log a chunk at a time ({@link eachRowChunk}) instead of holding
 * it in one array, and a save no longer WRITES it at all.
 *
 * # There is deliberately no `all(stream)`
 *
 * An earlier draft of {@link RowStore} had one, documented as "every row for a
 * stream, ascending — only `check`/`materialize` call this". Those are exactly
 * the on-device callers, and loading 3,683 blobs into one JS array is the shape
 * that took the Phase 0 build past 500 MB RSS and froze it. A method named
 * `all()` makes that look sanctioned. So {@link RowStore.range} is the only
 * read path: a caller that needs a full pass writes the loop, and the memory
 * ceiling is a property of the loop rather than of the callee.
 *
 * # One file per PROFILE, not per user
 *
 * The plan says "one JSON file per user". That is not expressible: the Phase 1
 * exit test runs TWO devices on ONE account, and two devices differ in every
 * field here — their own writer key, their own cursors, their own pinned heads.
 * Keying by user id would make them share a file and immediately corrupt each
 * other's chain state. So the key is a PROFILE (`--profile`, default `default`),
 * which is one device's view of one account; the store records the user id
 * inside and {@link Client} refuses to log a profile into a second account.
 *
 * # Secrets
 *
 * The session bearer token and the Ed25519 PRIVATE key are the two fields that
 * must not be in the database. {@link sqliteStore} takes a {@link SecretStore}
 * and puts them there instead — on a device that is the Keychain, via
 * `expo-secure-store`. `fileStore` still holds them in its 0600 state file; it
 * is a scratch artifact for a test rig on a single-operator box, and a product
 * client must not reuse it.
 *
 * # Host imports
 *
 * There are none, on purpose. This module is reachable from Hermes; `file.ts`
 * (`node:fs`) and `driver.ts` (`bun:sqlite`) are not, and nothing here imports
 * either of them.
 */

import { platform } from "../platform";
import { STREAM_COLD, STREAM_HOT, type Stream } from "../wire/blob";
import { ZERO_HASH, type ChainKey, type Head } from "../wire/chain";
import { parseDecimal, type Op } from "../wire/op";

/**
 * The on-disk format version. Bumping it is a deliberate, breaking act.
 *
 * **v1 → v2 (Task 5): `rows` left the state.** A v1 file carries the log inside
 * itself, and its cursors mean nothing without it. Read as a v2 file it would
 * produce a client whose cursor says "fully synced" over an empty log — and
 * `check` over an empty log passes vacuously, so nothing downstream would
 * notice. Refusing it is the only safe reading; the recovery is to delete the
 * profile and re-pull, which costs nothing but time.
 */
export const STATE_VERSION = 2;

/**
 * How many rows a full pass reads at a time.
 *
 * 250 is the chunk size the Phase 0 fix shipped with, and Task 8 mandates the
 * same one for the sync engine. Note what the chunking alone does NOT buy: the
 * yield between chunks is what restores the garbage collector, and a synchronous
 * `Store` cannot yield. Responsiveness comes from Task 1's async batch API.
 */
export const ROW_CHUNK = 250;

/**
 * An Ed25519 keypair in JWK form: `x` is the public key and `d` the private
 * seed, both base64url. JWK rather than PKCS#8 DER because both halves are then
 * plain strings — no DER prefix to slice, and the public key the API wants
 * (32 raw bytes) is `x` decoded, with nothing to strip.
 */
export interface WriterKey {
  x: string;
  d: string;
}

/**
 * One op-log row as `GET /api/v1/sync` returned it. Persisted VERBATIM: the
 * bytes that were verified are the bytes that are re-verified later, and one
 * decoder (`decodeWireRow`) reads both the live response and the stored copy,
 * so a stored row cannot mean something the pulled row did not.
 */
export interface WireRow {
  seq: string;
  stream: string;
  writer_id: string;
  writer_counter: string;
  type_flag: string;
  size_bucket: number;
  blob_hash: string;
  prev_hash: string;
  created_at: string;
  blob: string;
}

/**
 * One blob of the batch a push is currently uploading.
 *
 * # Why the intent has to be durable, and why `authoredHead` is not enough
 *
 * `POST /api/v1/sync` has an ambiguous outcome: the server appends the batch in
 * one transaction and then answers, so a process that dies — or a phone whose
 * app is terminated — between the commit and the answer leaves a device that
 * cannot tell whether its ops landed. Everything that recorded the upload
 * (`authoredHead`, the emptied `pending`) is written AFTER the request returns,
 * which is the step that failed, so on the next launch the device sees an
 * untouched `pending` and re-derives a batch from it.
 *
 * Two things then go wrong, both measured in `outbox.test.ts` against the
 * unguarded code:
 *
 *  1. If the pre-push sync has caught up, the counters have moved, so the SAME
 *     ops are appended again at fresh positions — a permanent double-append in
 *     an append-only log, and one that manufactures a `ForkNotice` against the
 *     device's own edit.
 *  2. If it has not (read-after-write lag), the ops are re-batched — the packer
 *     is greedy, so an op emitted in the meantime joins the first blob — and the
 *     server answers `409 chain_break: that position already holds different
 *     bytes`. Nothing clears it: every later push rebuilds the same batch. The
 *     device is wedged, showing the user a tampering warning for a fault that is
 *     entirely its own.
 *
 * So a push records what it is about to send BEFORE it sends it. Recovery is
 * then a measurement rather than a guess: the recorded hash of the last blob is
 * compared against the chain head the next sync VERIFIES, which is an
 * independent source (the server's bytes, re-hashed locally) rather than
 * another local flag.
 *
 * The bytes themselves are not stored — up to 8 MiB in a state file that is
 * rewritten whole on every command. `opIds` records the GROUPING instead, and
 * the resend re-seals exactly those ops at exactly that counter. Sealing is
 * deterministic (canonical JSON, fixed gzip settings, zero padding), so that
 * reproduces the bytes; `Client.rebuildInflight` re-hashes and refuses to send
 * anything whose hash does not match what was recorded, so the determinism is
 * checked at runtime instead of assumed.
 */
export interface InflightBlob {
  /** The writer counter this blob claims. */
  counter: bigint;
  /** The chain hash this device computed for it. */
  hash: Uint8Array;
  /** The ops it carries, in order. The grouping a resend must reproduce. */
  opIds: string[];
}

export interface ClientState {
  /** Base URL of the server this profile talks to. */
  server: string;
  userId: string | null;
  sessionToken: string | null;
  /** The writer this profile authors as. */
  writerId: string | null;
  /** Key material by writer id — more than one, because `enroll --sign-with`
   *  needs the SIGNING writer's key as well as the one being enrolled. */
  writers: Map<string, WriterKey>;
  /**
   * Per-stream body cursors. Two, never one: a hot-only pull is the mode the
   * product ships (spec §3.3:70), and a single cursor over a shared `seq` space
   * would make "I skipped cold on purpose" indistinguishable from "the server
   * dropped a row".
   */
  cursors: Record<Stream, bigint>;
  /**
   * Per-stream cursors for the per-blob hash list, which advance independently
   * of the body cursors and must: `pull-cold-hashes` pins a chain far ahead of
   * any body it has downloaded, and re-fetching from 0 would hand
   * `verifyHashList` entries below its own pinned head.
   */
  hashCursors: Record<Stream, bigint>;
  /** Verified chain heads, keyed `${writerId}|${stream}`. */
  pinnedHeads: Map<ChainKey, Head>;
  /** Per-blob hashes pinned by `pull-cold-hashes`, by chain then by counter. */
  pinnedBlobHashes: Map<ChainKey, Map<bigint, Uint8Array>>;
  /** Ops authored locally and not yet uploaded. They hold no `seq` yet. */
  pending: Op[];
  /**
   * The batch a push has BUILT and is about to upload, or has uploaded without
   * yet confirming — written BEFORE the request goes out and cleared only after
   * the answer comes back.
   *
   * Null except inside that window. See {@link InflightBlob} for why the window
   * needs a durable record at all.
   */
  inflight: InflightBlob[] | null;
  /**
   * The head of OUR OWN chain as last uploaded, which is not the same thing as
   * the pinned head: between a successful upload and the pull that brings those
   * rows back, the server holds blobs this client has not verified. Counter
   * assignment reads whichever of the two is further along, so an upload
   * followed by a failed pull cannot reuse a counter.
   *
   * It is NOT a crash guard, and reading it as one is the defect
   * {@link ClientState.inflight} exists to close: it is written only once the
   * upload has SUCCEEDED, so it says nothing at all about the batch that was in
   * flight when the process died.
   */
  authoredHead: Head | null;
  /** The roster, sorted, as of the last checkpoint this client wrote. */
  checkpointRoster: string[] | null;
  /**
   * The heads this client last attested, canonically rendered
   * (`net/client.ts`'s `headsKey`).
   *
   * The roster alone is not enough to decide whether a new checkpoint is owed:
   * the roster stops changing after the second device joins, while the chains
   * keep advancing, so gating on it means exactly one checkpoint is ever
   * written per account and it goes on claiming counter 0 forever.
   */
  checkpointHeads: string | null;
}

export function emptyClientState(server = ""): ClientState {
  return {
    server,
    userId: null,
    sessionToken: null,
    writerId: null,
    writers: new Map(),
    cursors: { hot: 0n, cold: 0n },
    hashCursors: { hot: 0n, cold: 0n },
    pinnedHeads: new Map(),
    pinnedBlobHashes: new Map(),
    pending: [],
    inflight: null,
    authoredHead: null,
    checkpointRoster: null,
    checkpointHeads: null,
  };
}

/**
 * The verified op log: append-only, read by range, pruned from below.
 *
 * Every method is synchronous, because `Client` is (see the plan's Decision 3 —
 * widening this to async ripples through every `Client` method for no gain that
 * `expo-sqlite`'s `*Sync` family does not already provide).
 */
export interface RowStore {
  /**
   * Appends rows. Idempotent for a byte-identical row at a seq already held —
   * which is what makes `pull`'s "append the rows, THEN save the cursor" safe
   * across a crash between the two. A row that DIFFERS from one already held is
   * refused: that is a server substituting bytes under a seq, and quietly
   * keeping either copy destroys the evidence I3 exists to find.
   */
  append(stream: Stream, rows: readonly WireRow[]): void;
  /** Ascending by seq, from exclusive `afterSeq`, at most `limit`. THE ONLY READ PATH. */
  range(stream: Stream, afterSeq: bigint, limit: number): WireRow[];
  count(stream: Stream): number;
  /** Drops rows below `beforeSeq`. Task 10's cold window. */
  prune(stream: Stream, beforeSeq: bigint): void;
}

/**
 * Walks every row of a stream in ascending seq order, `limit` at a time.
 *
 * This is the sanctioned replacement for the `all()` that {@link RowStore}
 * deliberately does not have. `fn` is called with one chunk at a time and must
 * consume it before returning: nothing here retains a chunk, and a caller that
 * accumulates them has simply moved `all()` into its own body.
 */
export function eachRowChunk(
  rows: RowStore,
  stream: Stream,
  fn: (chunk: readonly WireRow[]) => void,
  limit: number = ROW_CHUNK,
): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`eachRowChunk needs a positive integer chunk size, got ${String(limit)}`);
  }
  let after = 0n;
  for (;;) {
    const chunk = rows.range(stream, after, limit);
    if (chunk.length === 0) return;
    const last = chunk[chunk.length - 1];
    if (last === undefined) return;
    const next = parseDecimal(last.seq);
    // A store that answers with rows at or below the cursor it was given would
    // loop here forever. Louder is better than slower.
    if (next <= after) {
      throw new Error(`${stream} rows: range() did not advance past seq ${after.toString(10)}`);
    }
    fn(chunk);
    after = next;
    if (chunk.length < limit) return;
  }
}

/** Where a {@link Client} reads and writes its state. */
export interface Store {
  /** A human-readable location, for error messages and `cli state`. */
  readonly location: string;
  load(): ClientState;
  /** Persists the state. Does NOT write the rows — see {@link RowStore}. */
  save(state: ClientState): void;
  rows(): RowStore;
  /**
   * Commits the rows and the state written inside `fn` together, or neither.
   *
   * **This exists because splitting the log out of the state split one write
   * into two.** `pull` step 4 persists a page of rows and the cursor that says
   * they were taken; a crash between them leaves either rows the cursor denies
   * (recoverable, but the next pull re-serves rows the fold has already
   * consumed and the replay ordering guard refuses them) or — far worse, in the
   * other order — a cursor claiming rows that are gone, which nothing will ever
   * ask for again. {@link sqliteStore} makes the pair atomic and the window
   * disappears.
   *
   * `memStore` and `fileStore` implement it as a plain call: one has no
   * durability at all and the other is two files, which cannot be made atomic
   * without a journal. `fileStore` therefore still writes the rows FIRST, so
   * its residual crash window lands on the recoverable side. It is a CLI
   * instrument on a box that does not get killed mid-pull; the phone gets the
   * real thing.
   *
   * Not re-entrant across implementations — `expo-sqlite`'s
   * `withTransactionSync` does not nest — so nested calls flatten into the
   * outermost one rather than opening a savepoint.
   */
  transaction<T>(fn: () => T): T;
}

/**
 * Where the two secrets go when they are not going in the database.
 *
 * On a device this is `expo-secure-store` (the Keychain), wired up in
 * `app/src/auth/keys.ts` for Task 13. `null` means "not present", and setting
 * `null` deletes — signing out has to actually remove the token.
 */
export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string | null): void;
}

/** The secret store the tests use. Holds nothing after the process exits. */
export function memSecretStore(): SecretStore {
  const held = new Map<string, string>();
  return {
    get: (name) => held.get(name) ?? null,
    set: (name, value) => {
      if (value === null) held.delete(name);
      else held.set(name, value);
    },
  };
}

// ---------------------------------------------------------------------------
// The in-memory row store, shared by memStore and fileStore
// ---------------------------------------------------------------------------

interface Entry {
  seq: bigint;
  row: WireRow;
}

export interface ArrayRowStoreHooks {
  /** Rows read back from durable storage on first use, if there are any. */
  hydrate?: () => readonly WireRow[];
  /** Called with the rows actually accepted — never with a re-appended duplicate. */
  onAppend?: (stream: Stream, accepted: readonly WireRow[]) => void;
  /**
   * Called after a prune removed something, with **every row that remains, in
   * both streams**.
   *
   * Not just the pruned stream's: a durable store that keeps one file for the
   * log would rewrite it from a per-stream list and silently delete the other
   * stream. That defect is invisible in memory — the arrays are right either
   * way — and only shows up on the next open, which is why the durability
   * tests prune and then REOPEN.
   */
  onPrune?: (remaining: readonly WireRow[]) => void;
}

/**
 * A {@link RowStore} over two sorted arrays.
 *
 * Backs {@link memStore} and, with hooks, `fileStore`. It holds the whole log
 * in memory, which is exactly what {@link sqliteStore} exists not to do: both
 * of its users are host-side instruments (a unit test, a CLI process), and a
 * device never constructs one.
 */
export function arrayRowStore(hooks: ArrayRowStoreHooks = {}): RowStore {
  const held: Record<Stream, Entry[]> = { hot: [], cold: [] };
  const index: Record<Stream, Map<string, WireRow>> = { hot: new Map(), cold: new Map() };
  let hydrated = hooks.hydrate === undefined;
  const bySeq = (a: Entry, b: Entry): number => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);

  const ready = (): void => {
    if (hydrated) return;
    hydrated = true; // set first: a hydrate that reads back must not recurse
    for (const row of hooks.hydrate?.() ?? []) {
      const stream = streamOf(row.stream);
      const seq = parseDecimal(row.seq);
      const key = seq.toString(10);
      const have = index[stream].get(key);
      if (have !== undefined) {
        sameRowOrThrow(have, row, seq);
        continue;
      }
      held[stream].push({ seq, row });
      index[stream].set(key, row);
    }
    for (const s of [STREAM_HOT, STREAM_COLD] as const) held[s].sort(bySeq);
  };

  /** First index whose seq is strictly greater than `afterSeq`. */
  const upperBound = (list: Entry[], afterSeq: bigint): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid]?.seq ?? 0n) <= afterSeq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    append(stream, rows) {
      ready();
      // Validated WHOLE before anything is stored, so a batch whose third row
      // is bad leaves nothing behind. The SQLite store gets this from its
      // transaction; without the two phases here the two implementations would
      // disagree only on the failure path, which is the hardest divergence to
      // find and the worst one to have.
      const accepted: Entry[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const seq = checkRow(stream, row);
        const key = seq.toString(10);
        const have = index[stream].get(key);
        if (have !== undefined) {
          sameRowOrThrow(have, row, seq);
          continue;
        }
        if (seen.has(key)) {
          // Twice in ONE batch: same rule, and the earlier copy is not stored
          // yet so `index` cannot see it.
          const earlier = accepted.find((e) => e.seq === seq);
          if (earlier !== undefined) sameRowOrThrow(earlier.row, row, seq);
          continue;
        }
        seen.add(key);
        accepted.push({ seq, row: { ...row } });
      }
      if (accepted.length === 0) return;

      const list = held[stream];
      let ordered = true;
      for (const e of accepted) {
        if (list.length > 0 && (list[list.length - 1]?.seq ?? 0n) >= e.seq) ordered = false;
        list.push(e);
        index[stream].set(e.seq.toString(10), e.row);
      }
      if (!ordered) list.sort(bySeq);
      hooks.onAppend?.(
        stream,
        accepted.map((e) => e.row),
      );
    },
    range(stream, afterSeq, limit) {
      ready();
      if (limit <= 0) return [];
      const list = held[stream];
      const out: WireRow[] = [];
      for (let i = upperBound(list, afterSeq); i < list.length && out.length < limit; i++) {
        out.push({ ...(list[i] as Entry).row });
      }
      return out;
    },
    count(stream) {
      ready();
      return held[stream].length;
    },
    prune(stream, beforeSeq) {
      ready();
      const before = held[stream].length;
      const kept = held[stream].filter((e) => e.seq >= beforeSeq);
      if (kept.length === before) return;
      held[stream] = kept;
      index[stream] = new Map(kept.map((e) => [e.seq.toString(10), e.row]));
      hooks.onPrune?.([...held.hot, ...held.cold].map((e) => e.row));
    },
  };
}

/** Validates a row against the stream it is being filed under, and returns its seq. */
export function checkRow(stream: Stream, row: WireRow): bigint {
  if (row.stream !== stream) {
    throw new Error(`row at seq ${JSON.stringify(row.seq)} is stream ${JSON.stringify(row.stream)}, not ${stream}`);
  }
  return parseDecimal(row.seq);
}

/** Refuses a second row at a seq already held unless it is byte-identical. */
export function sameRowOrThrow(have: WireRow, want: WireRow, seq: bigint): void {
  if (rowKey(have) === rowKey(want)) return;
  throw new Error(
    `${want.stream} seq ${seq.toString(10)} was already stored with different bytes — ` +
      `the server is re-serving a position with new content`,
  );
}

/** A canonical rendering of every wire field, for the identity comparison above. */
function rowKey(r: WireRow): string {
  return JSON.stringify([
    r.seq,
    r.stream,
    r.writer_id,
    r.writer_counter,
    r.type_flag,
    r.size_bucket,
    r.blob_hash,
    r.prev_hash,
    r.created_at,
    r.blob,
  ]);
}

function streamOf(s: string): Stream {
  if (s === STREAM_HOT || s === STREAM_COLD) return s;
  throw new Error(`stored row names an unknown stream ${JSON.stringify(s)}`);
}

/**
 * A store that keeps everything in memory. Used by the unit tests, and by
 * nothing else: a CLI run that lost its cursor on exit would re-pull the whole
 * log every time and could never detect a re-serving server.
 */
export function memStore(server = ""): Store {
  let heldState = emptyClientState(server);
  const heldRows = arrayRowStore();
  return {
    location: "memory",
    load: () => heldState,
    save: (s) => {
      heldState = s;
    },
    rows: () => heldRows,
    // Nothing here is durable, so there is nothing to make atomic.
    transaction: <T,>(fn: () => T): T => fn(),
  };
}

// ---------------------------------------------------------------------------
// Encoding
//
// Everything that is a bigint in memory is a decimal STRING on disk and
// everything that is bytes is HEX, for the same reason the wire protocol makes
// that choice: JSON.parse turns a number into a float64, and a rounded seq or
// counter is a silently wrong chain.
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array): string => platform().toHex(b);

function unhex(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || !/^([0-9a-f]{2})*$/.test(s)) {
    throw new Error(`${what} is not lower-case hex: ${JSON.stringify(s)}`);
  }
  return platform().fromHex(s);
}

function requireStrings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`${what} is not an array of strings: ${JSON.stringify(v)}`);
  }
  return v as string[];
}

/**
 * The persisted shape of {@link ClientState}.
 *
 * `writers` is typed with an OPTIONAL `d`, because {@link sqliteStore} strips
 * the private half out to the {@link SecretStore} and puts it back on load. A
 * missing one is then caught by {@link decodeState}'s existing "no usable key"
 * check rather than by a second, parallel guard.
 */
export interface WireState {
  v: number;
  server: string;
  user_id: string | null;
  session_token: string | null;
  writer_id: string | null;
  writers: Record<string, { x: string; d?: string }>;
  cursors: Record<string, string>;
  hash_cursors: Record<string, string>;
  pinned_heads: { chain: string; counter: string; hash: string }[];
  pinned_blob_hashes: { chain: string; entries: [string, string][] }[];
  pending: Op[];
  /**
   * Optional, and its ABSENCE is meaningful rather than merely tolerated: a
   * state file written by a build that had no in-flight record was written by a
   * build that also never left one behind, so `null` is the truth about it and
   * not a default standing in for an unknown. That is why this is additive and
   * does not bump {@link STATE_VERSION} — contrast the v1→v2 bump, which was
   * needed because an old file loaded as "synced" over an empty log and the
   * checker passed it vacuously.
   */
  inflight?: { counter: string; hash: string; op_ids: string[] }[] | null;
  authored_head: { counter: string; hash: string } | null;
  checkpoint_roster: string[] | null;
  checkpoint_heads: string | null;
}

export function encodeState(s: ClientState): WireState {
  return {
    v: STATE_VERSION,
    server: s.server,
    user_id: s.userId,
    session_token: s.sessionToken,
    writer_id: s.writerId,
    writers: Object.fromEntries(s.writers),
    cursors: { hot: s.cursors.hot.toString(10), cold: s.cursors.cold.toString(10) },
    hash_cursors: { hot: s.hashCursors.hot.toString(10), cold: s.hashCursors.cold.toString(10) },
    pinned_heads: [...s.pinnedHeads].map(([chain, h]) => ({
      chain,
      counter: h.counter.toString(10),
      hash: hex(h.hash),
    })),
    pinned_blob_hashes: [...s.pinnedBlobHashes].map(([chain, m]) => ({
      chain,
      entries: [...m].map(([counter, h]): [string, string] => [counter.toString(10), hex(h)]),
    })),
    pending: s.pending,
    inflight:
      s.inflight === null
        ? null
        : s.inflight.map((b) => ({ counter: b.counter.toString(10), hash: hex(b.hash), op_ids: [...b.opIds] })),
    authored_head:
      s.authoredHead === null ? null : { counter: s.authoredHead.counter.toString(10), hash: hex(s.authoredHead.hash) },
    checkpoint_roster: s.checkpointRoster,
    checkpoint_heads: s.checkpointHeads,
  };
}

/**
 * Reads a persisted state, refusing anything it cannot read exactly.
 *
 * It throws rather than repairing: a client that silently reset a cursor it
 * could not parse would re-pull from 0 and lose every pinned head, which is
 * precisely the state in which a re-serving server is undetectable.
 */
export function decodeState(raw: unknown, where: string): ClientState {
  if (typeof raw !== "object" || raw === null) throw new Error(`${where}: not a JSON object`);
  const d = raw as Partial<WireState>;
  if (d.v !== STATE_VERSION) {
    throw new Error(`${where}: state version is ${String(d.v)}, this build writes v${STATE_VERSION}`);
  }
  const out = emptyClientState(typeof d.server === "string" ? d.server : "");
  out.userId = typeof d.user_id === "string" ? d.user_id : null;
  out.sessionToken = typeof d.session_token === "string" ? d.session_token : null;
  out.writerId = typeof d.writer_id === "string" ? d.writer_id : null;
  for (const [id, k] of Object.entries(d.writers ?? {})) {
    if (typeof k?.x !== "string" || typeof k?.d !== "string") throw new Error(`${where}: writer ${id} has no usable key`);
    out.writers.set(id, { x: k.x, d: k.d });
  }
  for (const stream of [STREAM_HOT, STREAM_COLD] as const) {
    out.cursors[stream] = parseDecimal(d.cursors?.[stream] ?? "0");
    out.hashCursors[stream] = parseDecimal(d.hash_cursors?.[stream] ?? "0");
  }
  for (const h of d.pinned_heads ?? []) {
    out.pinnedHeads.set(h.chain, { counter: parseDecimal(h.counter), hash: unhex(h.hash, `${where}: pinned head hash`) });
  }
  for (const p of d.pinned_blob_hashes ?? []) {
    const m = new Map<bigint, Uint8Array>();
    for (const [counter, h] of p.entries) m.set(parseDecimal(counter), unhex(h, `${where}: pinned blob hash`));
    out.pinnedBlobHashes.set(p.chain, m);
  }
  out.pending = Array.isArray(d.pending) ? d.pending : [];
  out.inflight = Array.isArray(d.inflight)
    ? d.inflight.map((b) => ({
        counter: parseDecimal(b.counter),
        hash: unhex(b.hash, `${where}: inflight blob hash`),
        // Refused rather than coerced: a resend re-seals exactly these ids in
        // exactly this order, so a record this cannot read is a record that
        // would produce different bytes at a claimed position.
        opIds: requireStrings(b.op_ids, `${where}: inflight op ids`),
      }))
    : null;
  out.authoredHead =
    d.authored_head == null
      ? null
      : { counter: parseDecimal(d.authored_head.counter), hash: unhex(d.authored_head.hash, `${where}: authored head`) };
  out.checkpointRoster = Array.isArray(d.checkpoint_roster) ? d.checkpoint_roster : null;
  out.checkpointHeads = typeof d.checkpoint_heads === "string" ? d.checkpoint_heads : null;
  return out;
}

/** The head of a chain nothing has been written to yet. */
export function genesisHead(): Head {
  return { counter: 0n, hash: ZERO_HASH };
}
