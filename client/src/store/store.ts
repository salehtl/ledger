/**
 * Local persistence for the headless client: cursors, pinned heads, pinned
 * cold-blob hashes, the writer's key material, and the rows it has verified.
 *
 * # What is stored, and why it is the ROWS
 *
 * The obvious design persists the materialized {@link State}. This one persists
 * the verified op-log ROWS, exactly as the server returned them, and re-folds
 * them on every command.
 *
 * That is the whole point of the instrument. Spec §5's exit criterion is "a
 * headless client replays cleanly", and the invariant checker's I9/I10 compare
 * the state against a re-fold of its own op log — a comparison that is vacuous
 * if the state was never anything but the fold's own output, saved. Keeping the
 * rows means every `check` re-derives the ops from the bytes it verified
 * (nothing joins ops to rows through a side channel), re-runs the chain, AAD and
 * bucket checks from genesis, and re-folds from position 0. It costs O(log) work
 * per command and O(log) bytes on disk, which is the correct trade for a test
 * instrument and the wrong one for a phone — the product client (Phase 2) keeps
 * a materialized snapshot and prunes. This file is not that client.
 *
 * # One file per PROFILE, not per user
 *
 * The plan says "one JSON file per user". That is not expressible: the Phase 1
 * exit test runs TWO devices on ONE account, and two devices differ in every
 * field here — their own writer key, their own cursors, their own pinned heads.
 * Keying by user id would make them share a file and immediately corrupt each
 * other's chain state. So the key is a PROFILE (`--profile`, default `default`),
 * which is one device's view of one account; {@link fileStore} records the user
 * id inside and {@link Client} refuses to log a profile into a second account.
 *
 * # Secrets
 *
 * The file holds the writer's Ed25519 PRIVATE key and the session bearer token,
 * both in the clear. It is written 0600 inside a 0700 directory, re-chmod'ed on
 * every save (mode on `open` applies only at creation), and written through a
 * temp file + rename so a crash cannot leave a truncated one. There is no
 * passphrase and no keychain: this is a scratch artifact for a test rig on a
 * single-operator box. A product client must not reuse this — Phase 2's key
 * belongs in the platform keystore.
 *
 * `client/.gitignore` names the DEFAULT state directory, which covers nothing
 * when `--state-dir` points somewhere else — and it takes any path. So the
 * directory ignores itself: {@link fileStore} writes a `.gitignore` containing
 * `*` beside the state file on every save, and a state directory created
 * anywhere inside a working tree therefore cannot be committed by accident.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { STREAM_COLD, STREAM_HOT, type Stream } from "../wire/blob";
import { ZERO_HASH, type ChainKey, type Head } from "../wire/chain";
import { parseDecimal, type Op } from "../wire/op";

/** The on-disk format version. Bumping it is a deliberate, breaking act. */
export const STATE_VERSION = 1;

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
  rows: Record<Stream, WireRow[]>;
  /** Ops authored locally and not yet uploaded. They hold no `seq` yet. */
  pending: Op[];
  /**
   * The head of OUR OWN chain as last uploaded, which is not the same thing as
   * the pinned head: between a successful upload and the pull that brings those
   * rows back, the server holds blobs this client has not verified. Counter
   * assignment reads whichever of the two is further along, so an upload
   * followed by a failed pull cannot reuse a counter.
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
    rows: { hot: [], cold: [] },
    pending: [],
    authoredHead: null,
    checkpointRoster: null,
    checkpointHeads: null,
  };
}

/** Where a {@link Client} reads and writes its state. */
export interface Store {
  /** A human-readable location, for error messages and `cli state`. */
  readonly location: string;
  load(): ClientState;
  save(state: ClientState): void;
}

/**
 * A store that keeps everything in memory. Used by the unit tests, and by
 * nothing else: a CLI run that lost its cursor on exit would re-pull the whole
 * log every time and could never detect a re-serving server.
 */
export function memStore(server = ""): Store {
  let held = emptyClientState(server);
  return {
    location: "memory",
    load: () => held,
    save: (s) => {
      held = s;
    },
  };
}

/**
 * A store backed by one JSON file per profile under `dir`.
 *
 * The directory is created 0700 and the file written 0600 — see the module doc
 * on what is in it.
 */
export function fileStore(dir: string, profile: string): Store {
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error(`profile ${JSON.stringify(profile)} must match [A-Za-z0-9._-]+`);
  }
  const path = join(dir, `${profile}.json`);
  return {
    location: path,
    load(): ClientState {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyClientState();
        throw err;
      }
      return decodeState(JSON.parse(text) as unknown, path);
    },
    save(state: ClientState): void {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // The directory ignores ITSELF, because `client/.gitignore` can only name
      // the default `.ledger-client/` and `--state-dir` takes any path — the
      // manual runs in this task's own report used one. A state directory
      // created anywhere inside a working tree therefore cannot be committed by
      // accident, and what it holds is an Ed25519 private key and a session
      // bearer token. Written every save rather than only on create, so a
      // directory that predates this still gets one.
      writeFileSync(join(dirname(path), ".gitignore"), "# ledger v2 client state: private keys and session tokens.\n*\n", {
        mode: 0o600,
      });
      const tmp = `${path}.tmp`;
      // mode on write applies only when the file is CREATED, so an existing
      // temp file from a crashed run would keep whatever mode it had. Removed
      // first, then chmod'ed again after writing, so neither path can leave the
      // private key world-readable.
      try {
        unlinkSync(tmp);
      } catch {
        /* not there: the normal case */
      }
      writeFileSync(tmp, JSON.stringify(encodeState(state), null, 2), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    },
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

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function unhex(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || !/^([0-9a-f]{2})*$/.test(s)) {
    throw new Error(`${what} is not lower-case hex: ${JSON.stringify(s)}`);
  }
  return new Uint8Array(Buffer.from(s, "hex"));
}

interface WireState {
  v: number;
  server: string;
  user_id: string | null;
  session_token: string | null;
  writer_id: string | null;
  writers: Record<string, WriterKey>;
  cursors: Record<string, string>;
  hash_cursors: Record<string, string>;
  pinned_heads: { chain: string; counter: string; hash: string }[];
  pinned_blob_hashes: { chain: string; entries: [string, string][] }[];
  rows: Record<string, WireRow[]>;
  pending: Op[];
  authored_head: { counter: string; hash: string } | null;
  checkpoint_roster: string[] | null;
  checkpoint_heads: string | null;
}

function encodeState(s: ClientState): WireState {
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
    rows: { hot: s.rows.hot, cold: s.rows.cold },
    pending: s.pending,
    authored_head:
      s.authoredHead === null ? null : { counter: s.authoredHead.counter.toString(10), hash: hex(s.authoredHead.hash) },
    checkpoint_roster: s.checkpointRoster,
    checkpoint_heads: s.checkpointHeads,
  };
}

/**
 * Reads a state file, refusing anything it cannot read exactly.
 *
 * It throws rather than repairing: a client that silently reset a cursor it
 * could not parse would re-pull from 0 and lose every pinned head, which is
 * precisely the state in which a re-serving server is undetectable.
 */
export function decodeState(raw: unknown, where: string): ClientState {
  if (typeof raw !== "object" || raw === null) throw new Error(`${where}: not a JSON object`);
  const d = raw as Partial<WireState>;
  if (d.v !== STATE_VERSION) {
    throw new Error(`${where}: state file version is ${String(d.v)}, this build writes v${STATE_VERSION}`);
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
    const rows = d.rows?.[stream] ?? [];
    if (!Array.isArray(rows)) throw new Error(`${where}: rows.${stream} is not an array`);
    out.rows[stream] = rows;
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
