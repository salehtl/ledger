/**
 * Writes `conformance/ts/` — blobs sealed by THIS executor, for the Go one to
 * open (`internal/v2/oplog.TestTypeScriptSealedBlobsOpenInGo`).
 *
 * # Why this direction needs its own fixtures
 *
 * `conformance/blob` and `conformance/op` are authored by Go and read by both,
 * which proves this port can READ the format. A port that reads Go's bytes
 * perfectly and WRITES subtly wrong ones passes every one of those tests — and
 * the failure would surface as the server rejecting a device's uploads, or
 * worse, accepting them and no other device being able to open them. This is the
 * only direction that catches it before it ships.
 *
 * # Freshness
 *
 * The committed bytes must be the bytes this code produces today, or the Go test
 * is checking a fossil. `assertFixturesAreFresh` re-derives them in memory and
 * `blob.test.ts` calls it on every run, so a stale set fails on the TypeScript
 * side rather than passing quietly on the Go one.
 *
 *     bun run gen-fixtures      # rewrite conformance/ts/
 */

import { mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  BUCKETS,
  MAX_BUCKET,
  NONCE_SIZE,
  TAG_SIZE,
  aad,
  openBlob,
  sealBlob,
  sealedRegion,
  type Envelope,
  type Stream,
} from "../src/wire/blob";
import { encodeBlobOps, encodeRawBody, type Op } from "../src/wire/op";

export const TS_FIXTURE_DIR = `${import.meta.dir}/../../conformance/ts`;

const USER = "11111111-1111-1111-1111-111111111111";
const INGEST_ID = "a".repeat(64);
const AUTHORED_AT = "2026-06-05T10:00:00.000Z";

/** The same three ops as Go's goldenOps, built through this executor's model. */
function goldenOps(): Op[] {
  return [
    {
      v: 1,
      type: "txn_ingested",
      op_id: "01J000000000000000000000I1",
      authored_at: AUTHORED_AT,
      entity: { kind: "txn", id: "T1" },
      parent_version: null,
      ingest_id: INGEST_ID,
      payload: { amount_minor: "25000", currency: "AED" },
    },
    {
      v: 1,
      type: "txn_categorized",
      op_id: "01J000000000000000000000A1",
      authored_at: AUTHORED_AT,
      entity: { kind: "txn", id: "T1" },
      parent_version: 3,
      payload: { category: "groceries" },
    },
    {
      v: 1,
      type: "rate_set",
      op_id: "01J000000000000000000000R1",
      authored_at: AUTHORED_AT,
      parent_version: null,
      payload: { currency: "USD", rate_micro: "3672500" },
    },
  ];
}

/**
 * An op whose payload carries every character the two encoders treat
 * differently. Go's `encoding/json` escapes `<`, `>`, `&`, U+2028 and U+2029;
 * `JSON.stringify` emits them literally. The bytes therefore differ and the
 * VALUES must not, which is exactly what the Go side asserts.
 */
function escapeTrapOps(): Op[] {
  return [
    {
      v: 1,
      type: "txn_edited",
      op_id: "01J000000000000000000000E1",
      authored_at: AUTHORED_AT,
      entity: { kind: "txn", id: "T1" },
      parent_version: 1,
      payload: {
        merchant_raw: "كارفور",
        // Written as escapes on purpose: literal U+2028/U+2029 in source are
        // invisible and were line terminators in JS before ES2019.
        note: "Smith & Sons <flagged> \u2028 second line \u2029 end",
        amount_minor: "9007199254740993",
      },
    },
  ];
}

interface FixtureSpec {
  file: string;
  note: string;
  kind: string;
  envelope: Envelope;
  plaintext: Uint8Array;
}

function specs(): FixtureSpec[] {
  return [
    {
      file: "ts-hot-dev-a-7.bin",
      note: "the golden op set, encoded and sealed by the TypeScript executor",
      kind: "ops",
      envelope: { userId: USER, stream: "hot" as Stream, writerId: "dev-a", writerCounter: 7n },
      plaintext: encodeBlobOps(goldenOps()),
    },
    {
      file: "ts-hot-dev-a-9-escapes.bin",
      note: "a payload holding every character Go escapes and JSON.stringify does not, plus non-ASCII",
      kind: "ops",
      envelope: { userId: USER, stream: "hot" as Stream, writerId: "dev-a", writerCounter: 9n },
      plaintext: encodeBlobOps(escapeTrapOps()),
    },
    {
      file: "ts-cold-ingest-3.bin",
      note: "a cold raw-body record, encoded and sealed by the TypeScript executor",
      kind: "raw_body",
      envelope: { userId: USER, stream: "cold" as Stream, writerId: "ingest", writerCounter: 3n },
      plaintext: encodeRawBody({
        ingest_id: INGEST_ID,
        received_at: AUTHORED_AT,
        raw: new TextEncoder().encode("From: bank@example.ae\r\nSubject: purchase\r\n\r\nhi"),
      }),
    },
    {
      file: "ts-hot-dev-a-13-bucket-edge.bin",
      note: "one byte under the 1 KiB bucket, sealed by TypeScript: an off-by-one in this executor's framing is fatal here and invisible everywhere else",
      kind: "",
      envelope: { userId: USER, stream: "hot" as Stream, writerId: "dev-a", writerCounter: 13n },
      plaintext: bucketEdgePlaintext(
        { userId: USER, stream: "hot" as Stream, writerId: "dev-a", writerCounter: 13n },
        0,
      ),
    },
    {
      file: "ts-hot-dev-a-14-bucket-edge-4k.bin",
      note: "the same, one rung up: nothing else in either fixture set crosses the boundary above bucket 0",
      kind: "",
      envelope: { userId: USER, stream: "hot" as Stream, writerId: "dev-a", writerCounter: 14n },
      plaintext: bucketEdgePlaintext(
        { userId: USER, stream: "hot" as Stream, writerId: "dev-a", writerCounter: 14n },
        1,
      ),
    },
  ];
}

/** The framed length before bucket padding, derived from the frozen layout. */
function prePadLength(b: Uint8Array): number {
  const { start } = sealedRegion(b);
  const payloadLen = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(start);
  return start + 4 + payloadLen + TAG_SIZE;
}

/**
 * n bytes gzip cannot shrink, derived from a hash chain so the value is
 * identical on every machine and every run — a random source would make the
 * committed fixtures churn and `assertFixturesAreFresh` useless.
 */
function incompressibleBytes(n: number): Uint8Array {
  const out = new Uint8Array(n + 32);
  let off = 0;
  for (let i = 0; off < n; i++) {
    const ctr = new Uint8Array(8);
    new DataView(ctr.buffer).setBigUint64(0, BigInt(i));
    const h = new Bun.CryptoHasher("sha256");
    h.update(ctr);
    out.set(new Uint8Array(h.digest()), off);
    off += 32;
  }
  return out.subarray(0, n);
}

/**
 * A plaintext whose framed length lands exactly one byte under bucket
 * `bucketIdx`, i.e. a blob with exactly one padding byte.
 *
 * The Go fixture set has had one of these from the start; the TypeScript set did
 * not, so an off-by-one in THIS executor's `overhead()`/`bucketFor()` that only
 * bites at a boundary was invisible to Go — and Go is the direction the server
 * actually sees, since a device uploads blobs it sealed itself.
 */
function bucketEdgePlaintext(env: Envelope, bucketIdx: number): Uint8Array {
  const bucket = BUCKETS[bucketIdx]!;
  const target = bucket - 1;
  for (let n = bucket - 200; n < bucket; n++) {
    if (n < 1) continue;
    const pt = incompressibleBytes(n);
    let sealed: Uint8Array;
    try {
      sealed = sealBlob(env, pt);
    } catch {
      continue;
    }
    if (sealed.length < bucket) continue; // still fits a smaller rung
    if (sealed.length > bucket) break; // overshot this rung
    if (prePadLength(sealed) === target) return pt;
  }
  throw new Error(`no plaintext frames to exactly ${target} bytes (bucket ${bucket})`);
}

export interface BuiltFixture {
  file: string;
  bytes: Uint8Array;
  plaintext: Uint8Array;
}

export interface Built {
  manifest: string;
  files: BuiltFixture[];
}

/** Derives the whole fixture set in memory. Called by the writer and the check. */
export function build(): Built {
  const files: BuiltFixture[] = [];
  const fixtures = specs().map((s) => {
    const bytes = sealBlob(s.envelope, s.plaintext);
    // Re-open every fixture before writing it. Without this the generator will
    // happily emit blobs it cannot itself read — under a deliberate
    // little-endian mutation it wrote three of them, and the failure surfaced
    // one layer later as a Go test, which is the wrong place to learn it.
    const reopened = openBlob(s.envelope, bytes);
    if (Buffer.compare(Buffer.from(reopened), Buffer.from(s.plaintext)) !== 0) {
      throw new Error(`${s.file}: sealed bytes do not reopen to their own plaintext`);
    }
    files.push({ file: s.file, bytes, plaintext: s.plaintext });
    return {
      file: s.file,
      note: s.note,
      kind: s.kind,
      envelope: {
        user_id: s.envelope.userId,
        stream: s.envelope.stream,
        writer_id: s.envelope.writerId,
        writer_counter: s.envelope.writerCounter.toString(10),
      },
      expect_aad: new TextDecoder().decode(aad(s.envelope)),
      expect_bucket: bytes.length,
      expect_plaintext_base64: Buffer.from(s.plaintext).toString("base64"),
      expect_pre_pad_length: prePadLength(bytes),
    };
  });

  const manifest =
    JSON.stringify(
      {
        note:
          "Sealed by client/scripts/gen-fixtures.ts. Regenerate with `cd client && bun run gen-fixtures`; " +
          "do not hand-edit. Go opens these bytes in oplog.TestTypeScriptSealedBlobsOpenInGo.",
        buckets: BUCKETS,
        nonce_size: NONCE_SIZE,
        tag_size: TAG_SIZE,
        max_bucket: MAX_BUCKET,
        // No chain_steps here: the chain golden vector belongs to the Go-authored
        // manifest, which is where both executors read it from. An empty array
        // in this one was dead weight that read like a missing check.
        fixtures,
      },
      null,
      2,
    ) + "\n";
  return { manifest, files };
}

/**
 * Fails if the committed fixtures are not what this code produces now.
 *
 * The diagnosis matters more than the failure: if the PLAINTEXT changed, the op
 * encoder moved and the Go side is being checked against a fossil. If only the
 * framed bytes changed, the gzip implementation was retuned by a runtime
 * upgrade — harmless, since gunzip does not care which encoder produced a
 * stream, and a regeneration is all it needs.
 */
export async function assertFixturesAreFresh(): Promise<void> {
  const { manifest, files } = build();
  const onDisk = await Bun.file(`${TS_FIXTURE_DIR}/manifest.json`).text();
  const fix = "regenerate with `cd client && bun run gen-fixtures`";
  if (onDisk !== manifest) {
    throw new Error(`conformance/ts/manifest.json is stale: ${fix}`);
  }
  for (const f of files) {
    const committed = await Bun.file(`${TS_FIXTURE_DIR}/${f.file}`).bytes();
    if (Buffer.compare(committed, f.bytes) === 0) continue;
    const samePlaintext =
      committed.length === f.bytes.length &&
      Buffer.compare(Buffer.from(openForDiff(committed)), Buffer.from(f.plaintext)) === 0;
    throw new Error(
      samePlaintext
        ? `conformance/ts/${f.file} has the same plaintext but different framed bytes — ` +
          `the gzip implementation changed under us, which is harmless: ${fix}`
        : `conformance/ts/${f.file} no longer matches what this executor encodes — ` +
          `the op wire model moved and Go is being checked against a fossil: ${fix}`,
    );
  }
}

/** Opens a committed fixture for the freshness diagnosis only. */
function openForDiff(bytes: Uint8Array): Uint8Array {
  const { start } = sealedRegion(bytes);
  const payloadLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(start);
  return new Uint8Array(gunzipSync(bytes.subarray(start + 4, start + 4 + payloadLen)));
}

if (import.meta.main) {
  const { manifest, files } = build();
  await mkdir(TS_FIXTURE_DIR, { recursive: true });
  for (const f of files) {
    await writeFile(`${TS_FIXTURE_DIR}/${f.file}`, f.bytes);
    console.log(`wrote ${f.file} (${f.bytes.length} bytes)`);
  }
  await writeFile(`${TS_FIXTURE_DIR}/manifest.json`, manifest);
  console.log(`wrote manifest.json (${files.length} fixtures)`);
}
