/**
 * The store contract, run against every implementation.
 *
 * Three stores back a {@link Client}: {@link memStore} (unit tests),
 * {@link fileStore} (the CLI instrument) and {@link sqliteStore} (the phone).
 * They are exercised by the SAME table below, because Task 5's exit condition
 * is that the existing suite passes against either backing — a contract only
 * one implementation satisfies is not a contract.
 *
 * The properties that matter here are the ones a phone can be killed by:
 *
 *  - `save()` writes the small state and NOT the log (the whole-state write is
 *    what made every command cost O(log) bytes on disk);
 *  - `range()` is the only read path, so a full pass is chunked at the CALLER
 *    and no method hands back the whole log;
 *  - `append()` is idempotent, which is what makes "append rows, then save the
 *    cursor" crash-safe without a cross-object transaction;
 *  - seqs order NUMERICALLY, including across a digit-count boundary, which
 *    plain lexicographic ordering of a decimal string gets wrong at 9 → 10;
 *  - the session token and the Ed25519 private key are NOT in the database.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunDriver, type SqlDriver } from "./driver";
import { fileStore } from "./file";
import { sqliteStore } from "./sqlite";
import {
  ROW_CHUNK,
  decodeState,
  eachRowChunk,
  emptyClientState,
  encodeState,
  memSecretStore,
  memStore,
  type ClientState,
  type RowStore,
  type SecretStore,
  type Store,
  type WireRow,
} from "./store";
import { Client } from "../net/client";
import { STREAM_COLD, STREAM_HOT, sealBlob, type Stream } from "../wire/blob";
import { ZERO_HASH, chainHash } from "../wire/chain";
import { SCHEMA_VERSION, encodeBlobOps, type Op } from "../wire/op";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratch = (): string => mkdtempSync(join(tmpdir(), "ledger-store-"));

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function wireRow(stream: Stream, seq: bigint, extra: Partial<WireRow> = {}): WireRow {
  return {
    seq: seq.toString(10),
    stream,
    writer_id: "dev-a",
    writer_counter: seq.toString(10),
    type_flag: "edit",
    size_bucket: 1024,
    blob_hash: "a1".repeat(32),
    prev_hash: "b2".repeat(32),
    created_at: "2026-08-01T00:00:00.000Z",
    blob: "QUJDRA==",
    ...extra,
  };
}

/**
 * One store implementation, plus the two things a test needs that the `Store`
 * interface deliberately does not expose: how big the persisted state is, and
 * how to reopen the same durable location.
 */
interface Rig {
  store: Store;
  /** A second `Store` over the same bytes. `null` when the store is not durable. */
  reopen: (() => Store) | null;
  /** Size in bytes of the persisted state — NOT counting the rows. */
  stateBytes: () => number;
}

const IMPLS = ["memStore", "fileStore", "sqliteStore"] as const;
type Impl = (typeof IMPLS)[number];

function makeRig(impl: Impl): Rig {
  if (impl === "memStore") {
    const mem = memStore("http://memory.test");
    return { store: mem, reopen: null, stateBytes: () => JSON.stringify(encodeState(mem.load())).length };
  }
  if (impl === "fileStore") {
    const dir = scratch();
    return {
      store: fileStore(dir, "p"),
      reopen: () => fileStore(dir, "p"),
      stateBytes: () => statSync(join(dir, "p.json")).size,
    };
  }
  const path = join(scratch(), "p.db");
  const secrets = memSecretStore();
  return {
    store: sqliteStore(bunDriver(path), { secrets }),
    reopen: () => sqliteStore(bunDriver(path), { secrets }),
    stateBytes: () => {
      const db = bunDriver(path);
      try {
        const rows = db.prepare("SELECT length(json) AS n FROM client_state WHERE id = 1").all() as { n: number }[];
        return rows[0]?.n ?? 0;
      } finally {
        db.close();
      }
    },
  };
}

/** Every row of a stream, for a test — never for the product. See {@link eachRowChunk}. */
function drain(rows: RowStore, stream: Stream): WireRow[] {
  const out: WireRow[] = [];
  eachRowChunk(rows, stream, (chunk) => {
    for (const r of chunk) out.push(r);
  });
  return out;
}

// ---------------------------------------------------------------------------
// The contract, once per implementation
// ---------------------------------------------------------------------------

for (const impl of IMPLS) {
  describe(`${impl}: the row store`, () => {
    let rig: Rig;
    let rows: RowStore;
    beforeEach(() => {
      rig = makeRig(impl);
      rows = rig.store.rows();
    });

    test("save() does not write rows", () => {
      const st = rig.store.load();
      st.server = "http://127.0.0.1:9";
      for (let i = 0; i < 40; i++) {
        const batch: WireRow[] = [];
        for (let j = 0; j < 250; j++) {
          batch.push(wireRow(STREAM_HOT, BigInt(i * 250 + j + 1), { blob: "Q".repeat(240) }));
        }
        rows.append(STREAM_HOT, batch);
      }
      expect(rows.count(STREAM_HOT)).toBe(10_000);

      rig.store.save(st);
      // 10,000 rows at ~240 bytes of blob each is ~2.4 MB of log. What the
      // state holds is cursors, heads and keys, and nothing else.
      expect(rig.stateBytes()).toBeLessThan(8 * 1024);
    });

    test("range() is ascending, exclusive on afterSeq, and honours limit", () => {
      rows.append(
        STREAM_HOT,
        [5n, 1n, 3n, 9n, 7n].map((s) => wireRow(STREAM_HOT, s)),
      );

      expect(rows.range(STREAM_HOT, 0n, 100).map((r) => r.seq)).toEqual(["1", "3", "5", "7", "9"]);
      // Exclusive: 3 itself is not returned.
      expect(rows.range(STREAM_HOT, 3n, 100).map((r) => r.seq)).toEqual(["5", "7", "9"]);
      // A seq that is not stored still positions correctly.
      expect(rows.range(STREAM_HOT, 4n, 100).map((r) => r.seq)).toEqual(["5", "7", "9"]);
      expect(rows.range(STREAM_HOT, 0n, 2).map((r) => r.seq)).toEqual(["1", "3"]);
      expect(rows.range(STREAM_HOT, 9n, 100)).toEqual([]);
      expect(rows.range(STREAM_HOT, 0n, 0)).toEqual([]);
    });

    // Plain lexicographic ordering of a decimal string puts "10" before "9",
    // and a small-N test never crosses the boundary that shows it. Both
    // boundaries are here, and so is a seq past 2^63 — the reason `seq` is a
    // string on the wire and a string in the schema.
    // The values above 10^20 are not decoration. A fixed-width zero pad — the
    // other implementation the plan sanctions — orders every seq below its
    // width correctly and gets 9×10^20 vs 10^21 backwards, because neither is
    // padded at all and `"9…" > "1…"`. A battery that stops at 2^63 cannot
    // tell the two implementations apart.
    test("range() orders numerically across digit-count boundaries", () => {
      const seqs = [
        1n,
        2n,
        9n,
        10n,
        11n,
        99n,
        100n,
        101n,
        999n,
        1000n,
        9_223_372_036_854_775_808n,
        10n ** 20n,
        9n * 10n ** 20n,
        10n ** 21n,
        10n ** 30n,
      ];
      rows.append(
        STREAM_HOT,
        [...seqs].reverse().map((s) => wireRow(STREAM_HOT, s)),
      );
      expect(drain(rows, STREAM_HOT).map((r) => r.seq)).toEqual(seqs.map((s) => s.toString(10)));
      expect(rows.range(STREAM_HOT, 9n, 2).map((r) => r.seq)).toEqual(["10", "11"]);
      expect(rows.range(STREAM_HOT, 99n, 2).map((r) => r.seq)).toEqual(["100", "101"]);
      expect(rows.range(STREAM_HOT, 9_223_372_036_854_775_807n, 1).map((r) => r.seq)).toEqual(["9223372036854775808"]);
      expect(rows.range(STREAM_HOT, 9n * 10n ** 20n, 1).map((r) => r.seq)).toEqual([(10n ** 21n).toString(10)]);
      expect(rows.range(STREAM_HOT, 10n ** 29n, 5).map((r) => r.seq)).toEqual([(10n ** 30n).toString(10)]);
    });

    // A batch is all-or-nothing. SQLite gets that from its transaction; the
    // array store has to be written for it, and a divergence that shows up
    // only on the failure path is the hardest kind to find.
    test("a batch containing a bad row stores none of it", () => {
      rows.append(STREAM_HOT, [wireRow(STREAM_HOT, 1n)]);
      expect(() =>
        rows.append(STREAM_HOT, [wireRow(STREAM_HOT, 5n), wireRow(STREAM_HOT, 1n, { blob: "ZZZZ" })]),
      ).toThrow(/already stored/);
      expect(rows.count(STREAM_HOT)).toBe(1);
      expect(drain(rows, STREAM_HOT).map((r) => r.seq)).toEqual(["1"]);

      expect(() => rows.append(STREAM_HOT, [wireRow(STREAM_HOT, 6n), wireRow(STREAM_COLD, 7n)])).toThrow(/stream/);
      expect(rows.count(STREAM_HOT)).toBe(1);
    });

    // This is what makes `append rows; save cursor` crash-safe: a crash between
    // the two re-pulls the same page, and re-appending it must be a no-op
    // rather than a duplicate.
    test("append() is idempotent for a byte-identical re-append at the same seq", () => {
      const page = [1n, 2n, 3n].map((s) => wireRow(STREAM_HOT, s));
      rows.append(STREAM_HOT, page);
      rows.append(
        STREAM_HOT,
        page.map((r) => ({ ...r })),
      );
      expect(rows.count(STREAM_HOT)).toBe(3);
      expect(drain(rows, STREAM_HOT).map((r) => r.seq)).toEqual(["1", "2", "3"]);
    });

    // …and the other half: a server re-serving a seq with DIFFERENT bytes is
    // the substitution I3 exists to catch. Keeping either copy silently
    // destroys the evidence, so the store refuses.
    test("append() refuses a different row at a seq it already holds", () => {
      rows.append(STREAM_HOT, [wireRow(STREAM_HOT, 1n)]);
      expect(() => rows.append(STREAM_HOT, [wireRow(STREAM_HOT, 1n, { blob: "ZZZZ" })])).toThrow(/already stored/);
      expect(rows.count(STREAM_HOT)).toBe(1);
      expect(rows.range(STREAM_HOT, 0n, 10)[0]?.blob).toBe("QUJDRA==");
    });

    test("the two streams are independent", () => {
      rows.append(STREAM_HOT, [wireRow(STREAM_HOT, 1n), wireRow(STREAM_HOT, 2n)]);
      rows.append(STREAM_COLD, [wireRow(STREAM_COLD, 1n)]);
      expect(rows.count(STREAM_HOT)).toBe(2);
      expect(rows.count(STREAM_COLD)).toBe(1);
      expect(rows.range(STREAM_COLD, 0n, 10).map((r) => r.stream)).toEqual([STREAM_COLD]);
    });

    test("prune() removes cold rows below a seq and leaves hot untouched", () => {
      rows.append(
        STREAM_HOT,
        [1n, 2n, 3n].map((s) => wireRow(STREAM_HOT, s)),
      );
      rows.append(
        STREAM_COLD,
        [1n, 2n, 3n, 4n].map((s) => wireRow(STREAM_COLD, s)),
      );
      rows.prune(STREAM_COLD, 3n);
      expect(drain(rows, STREAM_COLD).map((r) => r.seq)).toEqual(["3", "4"]);
      expect(rows.count(STREAM_COLD)).toBe(2);
      expect(drain(rows, STREAM_HOT).map((r) => r.seq)).toEqual(["1", "2", "3"]);
    });

    test("append() refuses a row filed under the wrong stream", () => {
      expect(() => rows.append(STREAM_HOT, [wireRow(STREAM_COLD, 1n)])).toThrow(/stream/);
    });

    // A caller that mutated what `range` handed back would corrupt the store's
    // own copy in mem/file and not in SQLite — a divergence the equivalence
    // gate would surface as an unreproducible failure in one mode only.
    test("range() hands back copies, not the store's own rows", () => {
      rows.append(STREAM_HOT, [wireRow(STREAM_HOT, 1n)]);
      const got = rows.range(STREAM_HOT, 0n, 1)[0];
      if (got === undefined) throw new Error("no row");
      got.blob = "mutated";
      expect(rows.range(STREAM_HOT, 0n, 1)[0]?.blob).toBe("QUJDRA==");
    });
  });
}

// ---------------------------------------------------------------------------
// Durability — only the stores that have any
// ---------------------------------------------------------------------------

/** A state with one of everything, so a round trip has something to lose. */
function fullState(): ClientState {
  const s = emptyClientState("http://127.0.0.1:8443");
  s.userId = "3f1e2d4c-0000-4000-8000-abcdefabcdef";
  s.sessionToken = "sess-TOP-SECRET-0123456789";
  s.writerId = "dev-a";
  s.writers.set("dev-a", { x: "cHVibGljLWEA", d: "cHJpdmF0ZS1hLVNFQ1JFVA" });
  s.writers.set("dev-b", { x: "cHVibGljLWIA", d: "cHJpdmF0ZS1iLVNFQ1JFVA" });
  s.cursors.hot = 9_223_372_036_854_775_809n;
  s.cursors.cold = 42n;
  s.hashCursors.hot = 7n;
  s.hashCursors.cold = 8n;
  s.pinnedHeads.set("dev-a|hot", { counter: 12n, hash: new Uint8Array(32).fill(0xab) });
  s.pinnedHeads.set("ingest|cold", { counter: 3n, hash: new Uint8Array(32).fill(0x01) });
  s.pinnedBlobHashes.set(
    "ingest|cold",
    new Map([
      [1n, new Uint8Array(32).fill(0x7f)],
      [2n, new Uint8Array(32).fill(0x80)],
    ]),
  );
  s.pending = [
    {
      v: SCHEMA_VERSION,
      type: "rate_set",
      op_id: "op-0001",
      authored_at: "2026-08-01T00:00:00.000Z",
      parent_version: null,
      payload: { currency: "USD", rate_micro: "3672500" },
    },
  ];
  s.authoredHead = { counter: 5n, hash: new Uint8Array(32).fill(0x5a) };
  s.checkpointRoster = ["dev-a", "dev-b", "ingest"];
  s.checkpointHeads = "dev-a|hot=12:abab";
  return s;
}

for (const impl of IMPLS) {
  if (makeRig(impl).reopen === null) continue;

  describe(`${impl}: durability`, () => {
    let rig: Rig;
    let reopen: () => Store;
    beforeEach(() => {
      rig = makeRig(impl);
      const r = rig.reopen;
      if (r === null) throw new Error("not durable");
      reopen = r;
    });

    test("a reopened store returns the identical ClientState", () => {
      const want = fullState();
      rig.store.save(want);
      const got = reopen().load();

      expect(got.server).toBe(want.server);
      expect(got.userId).toBe(want.userId);
      expect(got.sessionToken).toBe(want.sessionToken);
      expect(got.writerId).toBe(want.writerId);
      expect([...got.writers]).toEqual([...want.writers]);
      // bigints, not numbers: a float64 round trip loses the low bits of a seq
      // past 2^53, and loses them silently.
      expect(got.cursors.hot).toBe(want.cursors.hot);
      expect(got.cursors.cold).toBe(want.cursors.cold);
      expect(got.hashCursors.hot).toBe(want.hashCursors.hot);
      expect(got.hashCursors.cold).toBe(want.hashCursors.cold);
      expect([...got.pinnedHeads]).toEqual([...want.pinnedHeads]);
      expect([...got.pinnedBlobHashes].map(([k, m]) => [k, [...m]])).toEqual(
        [...want.pinnedBlobHashes].map(([k, m]) => [k, [...m]]),
      );
      expect(got.pending).toEqual(want.pending);
      expect(got.authoredHead).toEqual(want.authoredHead);
      expect(got.checkpointRoster).toEqual(want.checkpointRoster);
      expect(got.checkpointHeads).toBe(want.checkpointHeads);
    });

    test("a reopened store returns the identical rows", () => {
      const page = [1n, 2n, 300n].map((s) => wireRow(STREAM_HOT, s, { blob: `blob-${s.toString(10)}` }));
      rig.store.rows().append(STREAM_HOT, page);
      rig.store.rows().append(STREAM_COLD, [wireRow(STREAM_COLD, 4n)]);
      rig.store.save(rig.store.load());

      const back = reopen().rows();
      expect(drain(back, STREAM_HOT)).toEqual(page);
      expect(back.count(STREAM_COLD)).toBe(1);
    });

    // Pruning cold must not take hot with it. In memory it never does — the
    // two arrays are separate — so this only fails after a REOPEN, which is
    // precisely why it is here and not in the contract block above.
    test("pruning one stream leaves the other intact after a reopen", () => {
      const rows = rig.store.rows();
      rows.append(
        STREAM_HOT,
        [1n, 2n, 3n].map((s) => wireRow(STREAM_HOT, s)),
      );
      rows.append(
        STREAM_COLD,
        [1n, 2n, 3n, 4n].map((s) => wireRow(STREAM_COLD, s)),
      );
      rows.prune(STREAM_COLD, 3n);

      const back = reopen().rows();
      expect(drain(back, STREAM_HOT).map((r) => r.seq)).toEqual(["1", "2", "3"]);
      expect(drain(back, STREAM_COLD).map((r) => r.seq)).toEqual(["3", "4"]);
    });

    // The crash the ordering in `pull` step 4 is built around: rows land, the
    // process dies before the cursor does, the next run re-pulls the same page.
    test("rows appended before a crash re-append byte-identically", () => {
      const page = [1n, 2n, 3n].map((s) => wireRow(STREAM_HOT, s));
      rig.store.rows().append(STREAM_HOT, page);
      // …and no save(). The cursor never advanced.
      const after = reopen();
      expect(after.load().cursors.hot).toBe(0n);
      after.rows().append(STREAM_HOT, page);
      expect(after.rows().count(STREAM_HOT)).toBe(3);
    });
  });
}

// ---------------------------------------------------------------------------
// fileStore — the properties the CLI instrument depends on
// ---------------------------------------------------------------------------

describe("fileStore", () => {
  test("the state file is 0600 inside a 0700 directory that ignores itself", () => {
    const dir = join(scratch(), "nested");
    const s = fileStore(dir, "p");
    s.save(emptyClientState("http://127.0.0.1:1"));
    expect(statSync(join(dir, "p.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("*");
  });

  // The rows moved out of the state file, so they need the same treatment: the
  // log is as sensitive as the state it was carved out of, and a `--state-dir`
  // inside a working tree must not become a commit.
  test("the rows file is 0600 and beside the .gitignore", () => {
    const dir = join(scratch(), "nested");
    const s = fileStore(dir, "p");
    s.rows().append(STREAM_HOT, [wireRow(STREAM_HOT, 1n)]);
    expect(statSync(join(dir, "p.rows.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("*");
  });

  test("the state file is written through a temp file that does not survive", () => {
    const dir = scratch();
    const s = fileStore(dir, "p");
    s.save(emptyClientState("http://127.0.0.1:1"));
    expect(existsSync(join(dir, "p.json.tmp"))).toBe(false);
  });

  test("a missing profile loads as empty rather than throwing", () => {
    const s = fileStore(scratch(), "fresh");
    expect(s.load().userId).toBeNull();
    expect(s.rows().count(STREAM_HOT)).toBe(0);
  });

  test("a profile name that is not a plain identifier is refused", () => {
    expect(() => fileStore(scratch(), "../escape")).toThrow(/must match/);
  });

  // Rewriting the rows file on every save is exactly the whole-state write
  // this task removes, and on the CLI it is directly measurable.
  //
  // By ABSENCE, not by mtime: the first version of this test compared
  // `mtimeMs` and `size` across five saves, and five saves inside one
  // millisecond of a file rewritten with identical content change neither.
  // Mutation M13 — a save that rewrites the whole rows file — walked straight
  // through it. Deleting the file first cannot be faked.
  test("save() does not rewrite the rows file", () => {
    const dir = scratch();
    const s = fileStore(dir, "p");
    s.rows().append(
      STREAM_HOT,
      [1n, 2n, 3n].map((q) => wireRow(STREAM_HOT, q)),
    );
    const path = join(dir, "p.rows.jsonl");
    expect(existsSync(path)).toBe(true);

    rmSync(path);
    for (let i = 0; i < 5; i++) s.save(s.load());
    expect(existsSync(path)).toBe(false);

    // …and an append still writes it, so the absence above is about `save`
    // and not about a store that has stopped persisting rows at all.
    s.rows().append(STREAM_HOT, [wireRow(STREAM_HOT, 4n)]);
    expect(existsSync(path)).toBe(true);
  });

  test("a truncated last line in the rows file is refused, not skipped", () => {
    const dir = scratch();
    const s = fileStore(dir, "p");
    s.rows().append(STREAM_HOT, [wireRow(STREAM_HOT, 1n)]);
    const path = join(dir, "p.rows.jsonl");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text + text.slice(0, 20));
    expect(() => fileStore(dir, "p").rows().count(STREAM_HOT)).toThrow(/p\.rows\.jsonl/);
  });
});

// ---------------------------------------------------------------------------
// sqliteStore — the phone's store
// ---------------------------------------------------------------------------

describe("sqliteStore", () => {
  function open(): { db: SqlDriver; secrets: SecretStore; store: Store } {
    const db = bunDriver(join(scratch(), "p.db"));
    const secrets = memSecretStore();
    return { db, secrets, store: sqliteStore(db, { secrets }) };
  }

  test("secrets are not in the database", () => {
    const { db, secrets, store } = open();
    store.save(fullState());
    store.rows().append(STREAM_HOT, [wireRow(STREAM_HOT, 1n, { blob: "cHJpdmF0ZQ==" })]);

    const dumped = [
      ...(db.prepare("SELECT json AS t FROM client_state").all() as { t: string }[]).map((r) => r.t),
      ...(db.prepare("SELECT * FROM wire_rows").all() as Record<string, unknown>[]).map((r) => JSON.stringify(r)),
    ].join("\n");

    expect(dumped).not.toContain("sess-TOP-SECRET-0123456789");
    expect(dumped).not.toContain("cHJpdmF0ZS1hLVNFQ1JFVA");
    expect(dumped).not.toContain("cHJpdmF0ZS1iLVNFQ1JFVA");
    // …and they are somewhere, or this test would pass by deleting them.
    expect(secrets.get("session_token")).toBe("sess-TOP-SECRET-0123456789");
    expect(secrets.get("writer_key:dev-a")).toBe("cHJpdmF0ZS1hLVNFQ1JFVA");
    expect(secrets.get("writer_key:dev-b")).toBe("cHJpdmF0ZS1iLVNFQ1JFVA");
    // The PUBLIC half stays in the database: it is not a secret, and the
    // enrolment path reads it back.
    expect(dumped).toContain("cHVibGljLWEA");
    // The round trip still produces both halves.
    expect(store.load().writers.get("dev-a")).toEqual({ x: "cHVibGljLWEA", d: "cHJpdmF0ZS1hLVNFQ1JFVA" });
    expect(store.load().sessionToken).toBe("sess-TOP-SECRET-0123456789");
  });

  test("a writer whose private key the secret store lost is refused, not silently keyless", () => {
    const { secrets, store } = open();
    store.save(fullState());
    secrets.set("writer_key:dev-a", null);
    expect(() => store.load()).toThrow(/dev-a/);
  });

  test("signing out clears the session token from the secret store too", () => {
    const { secrets, store } = open();
    store.save(fullState());
    const st = store.load();
    st.sessionToken = null;
    store.save(st);
    expect(secrets.get("session_token")).toBeNull();
    expect(store.load().sessionToken).toBeNull();
  });

  test("the state is one row, always", () => {
    const { db, store } = open();
    for (let i = 0; i < 5; i++) {
      const st = store.load();
      st.cursors.hot = BigInt(i);
      store.save(st);
    }
    const n = db.prepare("SELECT count(*) AS n FROM client_state").all() as { n: number }[];
    expect(n[0]?.n).toBe(1);
    expect(store.load().cursors.hot).toBe(4n);
  });

  test("opening an existing database does not lose its rows", () => {
    const path = join(scratch(), "p.db");
    const secrets = memSecretStore();
    sqliteStore(bunDriver(path), { secrets })
      .rows()
      .append(STREAM_HOT, [wireRow(STREAM_HOT, 1n)]);
    expect(sqliteStore(bunDriver(path), { secrets }).rows().count(STREAM_HOT)).toBe(1);
  });

  test("the blob is stored verbatim, not re-encoded", () => {
    const { store } = open();
    // Base64 WITH padding, which a decode/re-encode round trip is free to
    // change. The chain hashes these bytes, so nothing may normalize them.
    const blob = "QUJDRA==";
    store.rows().append(STREAM_HOT, [wireRow(STREAM_HOT, 1n, { blob })]);
    expect(store.rows().range(STREAM_HOT, 0n, 1)[0]?.blob).toBe(blob);
  });

  // The rows come back off DISK, so their types are not guaranteed by the
  // compiler the way a pulled row's are. Passing a number through where a
  // string belongs would surface downstream as `decodeWireRow` reporting a
  // protocol error against the SERVER, for a fault in local storage.
  test("a stored row whose columns have the wrong type is refused on read", () => {
    const { db, store } = open();
    store.rows().append(STREAM_HOT, [wireRow(STREAM_HOT, 1n)]);
    // A BLOB, because TEXT affinity silently converts an inserted number to
    // text and a blob is the one storage class it leaves alone.
    db.prepare("UPDATE wire_rows SET blob_hash = x'0102' WHERE seq = '1'").run();
    expect(() => store.rows().range(STREAM_HOT, 0n, 1)).toThrow(/blob_hash/);

    db.prepare("UPDATE wire_rows SET blob_hash = 'ab', size_bucket = 'big' WHERE seq = '1'").run();
    expect(() => store.rows().range(STREAM_HOT, 0n, 1)).toThrow(/size_bucket/);

    db.prepare("UPDATE wire_rows SET size_bucket = 1.5 WHERE seq = '1'").run();
    expect(() => store.rows().range(STREAM_HOT, 0n, 1)).toThrow(/size_bucket/);

    db.prepare("UPDATE wire_rows SET size_bucket = 10, seq = 'seven' WHERE seq = '1'").run();
    expect(() => store.rows().range(STREAM_HOT, 0n, 1)).toThrow(/decimal-integer/);
  });

  test("every wire column survives the round trip", () => {
    const { store } = open();
    const row = wireRow(STREAM_COLD, 7n, {
      writer_id: "ingest",
      writer_counter: "3",
      type_flag: "ingest",
      size_bucket: 4096,
      blob_hash: "0f".repeat(32),
      prev_hash: "f0".repeat(32),
      created_at: "2026-08-01T12:34:56.789Z",
      blob: "YmxvYg==",
    });
    store.rows().append(STREAM_COLD, [row]);
    expect(store.rows().range(STREAM_COLD, 0n, 1)[0]).toEqual(row);
  });
});

// ---------------------------------------------------------------------------
// eachRowChunk — the reason there is no `all()`
// ---------------------------------------------------------------------------

describe("eachRowChunk", () => {
  test("never asks for more than the chunk size, and visits every row once, in order", () => {
    const rows = memStore().rows();
    for (let i = 0; i < 4; i++) {
      const batch: WireRow[] = [];
      for (let j = 0; j < 250; j++) batch.push(wireRow(STREAM_HOT, BigInt(i * 250 + j + 1)));
      rows.append(STREAM_HOT, batch);
    }

    const limits: number[] = [];
    const spy: RowStore = {
      append: (s, r) => rows.append(s, r),
      range: (s, after, limit) => {
        limits.push(limit);
        return rows.range(s, after, limit);
      },
      count: (s) => rows.count(s),
      prune: (s, before) => rows.prune(s, before),
    };

    const seen: string[] = [];
    let chunks = 0;
    eachRowChunk(spy, STREAM_HOT, (chunk) => {
      chunks++;
      expect(chunk.length).toBeLessThanOrEqual(ROW_CHUNK);
      for (const r of chunk) seen.push(r.seq);
    });

    expect(Math.max(...limits)).toBe(ROW_CHUNK);
    expect(chunks).toBe(4);
    expect(seen.length).toBe(1000);
    expect(seen[0]).toBe("1");
    expect(seen[999]).toBe("1000");
    expect(new Set(seen).size).toBe(1000);
  });

  test("a row store that does not advance is refused rather than looped on forever", () => {
    // A FULL chunk that does not advance is the looping shape: a short chunk
    // ends the walk on its own, so a store returning one row forever would
    // stop after one. This one answers with `limit` copies of the same seq.
    const stuck: RowStore = {
      append: () => undefined,
      range: (_s, _after, limit) => Array.from({ length: limit }, () => wireRow(STREAM_HOT, 1n)),
      count: () => 1,
      prune: () => undefined,
    };
    expect(() => eachRowChunk(stuck, STREAM_HOT, () => undefined)).toThrow(/did not advance/);
  });
});

// ---------------------------------------------------------------------------
// The consumer: a fold that holds one chunk, not the log
// ---------------------------------------------------------------------------

/**
 * A row store that POISONS the previous chunk when the next one is asked for.
 *
 * This is the measurement that separates "chunked" from "chunked and actually
 * streaming". An implementation that pages through `range()` and then decodes
 * the accumulated array at the end reads exactly the same bytes, looks
 * identical in every other test here, and holds the whole log in memory — the
 * >500 MB shape the Phase 0 build froze on. Against this store it decodes
 * poison and fails loudly.
 */
function poisoning(inner: Store): Store {
  const rows = inner.rows();
  let lastHandedOut: WireRow[] = [];
  const wrapper: RowStore = {
    append: (s, r) => rows.append(s, r),
    range: (s, after, limit) => {
      for (const r of lastHandedOut) r.blob = "!!!! poisoned: this chunk was retained past its turn";
      lastHandedOut = rows.range(s, after, limit);
      return lastHandedOut;
    },
    count: (s) => rows.count(s),
    prune: (s, before) => rows.prune(s, before),
  };
  return {
    location: inner.location,
    load: () => inner.load(),
    save: (s) => inner.save(s),
    rows: () => wrapper,
    transaction: (fn) => inner.transaction(fn),
  };
}

describe("the fold reads the log a chunk at a time", () => {
  const USER = "11111111-2222-4333-8444-555555555555";
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  /** Distinct three-letter codes; `currencyOf` refuses anything else. */
  function ccy(i: number): string {
    return `${LETTERS[Math.floor(i / 676) % 26] ?? "A"}${LETTERS[Math.floor(i / 26) % 26] ?? "A"}${LETTERS[i % 26] ?? "A"}`;
  }

  /**
   * An honestly chained hot log of `n` rate_set ops, optionally with the blob
   * at `corruptAt` swapped for one the chain does not name.
   */
  function seeded(n: number, corruptAt = 0): Store {
    const store = memStore("http://127.0.0.1:9");
    const st = store.load();
    st.userId = USER;
    st.writerId = "ingest";
    store.save(st);
    const rows: WireRow[] = [];
    let prev = ZERO_HASH;
    for (let i = 1; i <= n; i++) {
      const counter = BigInt(i);
      const op: Op = {
        v: SCHEMA_VERSION,
        type: "rate_set",
        op_id: `op-${String(i).padStart(5, "0")}`,
        authored_at: "2026-08-01T00:00:00.000Z",
        parent_version: null,
        payload: { currency: ccy(i), rate_micro: `${1_000_000 + i}` },
      };
      const seal = (o: Op): Uint8Array =>
        sealBlob({ userId: USER, stream: STREAM_HOT, writerId: "ingest", writerCounter: counter }, encodeBlobOps([o]));
      const blob = seal(op);
      const hash = chainHash(prev, blob);
      // The substitution I3 exists to catch: the chain still names the honest
      // blob's hash, the stored bytes are a different one.
      const stored = i === corruptAt ? seal({ ...op, op_id: `op-swapped-${i}` }) : blob;
      rows.push({
        seq: counter.toString(10),
        stream: STREAM_HOT,
        writer_id: "ingest",
        writer_counter: counter.toString(10),
        type_flag: "ingest",
        size_bucket: stored.length,
        blob_hash: hexOf(hash),
        prev_hash: hexOf(prev),
        created_at: "2026-08-01T00:00:00.000Z",
        blob: Buffer.from(stored).toString("base64"),
      });
      prev = hash;
    }
    store.rows().append(STREAM_HOT, rows);
    return store;
  }

  test("materialize() folds each chunk before it asks for the next", () => {
    const n = ROW_CHUNK * 2 + 7;
    const c = new Client({ store: poisoning(seeded(n)) });
    const { state, ops } = c.materialize();
    expect(ops.length).toBe(n);
    expect(state.rates.size).toBe(n);
    expect(state.unreadable).toEqual([]);
    expect(state.cursors.hot).toBe(BigInt(n));
  });

  // The coverage claim, made where it can fail. An earlier version of this
  // test asserted `check().length > 0` over a synthetic chain, which a checker
  // reading only the FIRST chunk satisfies just as well — mutation M10 walked
  // straight through it. The defect is now in the LAST chunk.
  test("check() sees a substituted blob in the last chunk, not just the first", () => {
    const n = ROW_CHUNK + 3;

    const clean = new Client({ store: seeded(n) });
    expect(clean.check().filter((v) => v.id.startsWith("I3"))).toEqual([]);
    expect(clean.rowsFor(STREAM_HOT).length).toBe(n);

    const bad = new Client({ store: seeded(n, n) });
    expect(bad.check().some((v) => v.id.startsWith("I3"))).toBe(true);
    expect(bad.rowsFor(STREAM_HOT).length).toBe(n);

    // …and one in the first chunk is caught too, so the assertion above is
    // about WHERE the checker looked and not about I3 being unreachable.
    expect(
      new Client({ store: seeded(n, 1) })
        .check()
        .some((v) => v.id.startsWith("I3")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// State encoding
// ---------------------------------------------------------------------------

describe("decodeState", () => {
  test("round-trips every field", () => {
    const want = fullState();
    const got = decodeState(JSON.parse(JSON.stringify(encodeState(want))), "test");
    expect(got.cursors.hot).toBe(want.cursors.hot);
    expect([...got.pinnedHeads]).toEqual([...want.pinnedHeads]);
    expect([...got.writers]).toEqual([...want.writers]);
    expect(got.pending).toEqual(want.pending);
  });

  // Task 4's mutation M16: nothing in the suite fed `unhex` a malformed hash,
  // so a decoder that quietly returned empty bytes for a corrupt chain head
  // would have gone unnoticed — and an empty head compares equal to nothing.
  test("refuses a pinned head hash that is not lower-case hex", () => {
    for (const bad of ["AB".repeat(32), "zz".repeat(32), "abc", 12, null]) {
      const w = encodeState(fullState()) as unknown as { pinned_heads: { hash: unknown }[] };
      w.pinned_heads[0]!.hash = bad;
      expect(() => decodeState(w, "test")).toThrow(/not lower-case hex/);
    }
  });

  test("refuses a pinned blob hash that is not lower-case hex", () => {
    const w = encodeState(fullState()) as unknown as { pinned_blob_hashes: { entries: [string, string][] }[] };
    w.pinned_blob_hashes[0]!.entries[0]![1] = "nothex";
    expect(() => decodeState(w, "test")).toThrow(/not lower-case hex/);
  });

  test("refuses an authored head hash that is not lower-case hex", () => {
    const w = encodeState(fullState()) as unknown as { authored_head: { hash: string } };
    w.authored_head.hash = "0x1234";
    expect(() => decodeState(w, "test")).toThrow(/not lower-case hex/);
  });

  // A v1 file carries `rows` INSIDE the state, and its cursors are only
  // meaningful together with them. Read as a v2 file it would produce a client
  // whose cursor says "fully synced" over an empty log — and `check` over an
  // empty log passes vacuously, which is the worst failure mode available.
  test("refuses a v1 state file rather than silently dropping its log", () => {
    const v1 = { ...(encodeState(emptyClientState("http://x")) as unknown as Record<string, unknown>), v: 1 };
    expect(() => decodeState(v1, "test")).toThrow(/version is 1/);
  });

  test("refuses a state that is not an object", () => {
    expect(() => decodeState(null, "test")).toThrow(/not a JSON object/);
    expect(() => decodeState("{}", "test")).toThrow(/not a JSON object/);
  });
});
