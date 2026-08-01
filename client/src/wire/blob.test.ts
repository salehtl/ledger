import { expect, test } from "bun:test";
import {
  BUCKETS,
  MAX_BUCKET,
  NONCE_SIZE,
  TAG_SIZE,
  VERSION,
  aad,
  bucketFor,
  embeddedAAD,
  openBlob,
  sealBlob,
  sealedRegion,
  type Envelope,
} from "./blob";
import { BlobDecodeError, InvalidEnvelopeError } from "./op";
import { assertFixturesAreFresh } from "../../scripts/gen-fixtures";

const dir = `${import.meta.dir}/../../../conformance/blob`;

interface Fixture {
  file: string;
  kind: string;
  envelope: { user_id: string; stream: string; writer_id: string; writer_counter: string };
  expect_aad: string;
  expect_bucket: number;
  expect_plaintext_base64: string;
  expect_pre_pad_length: number;
}

const manifest: {
  buckets: number[];
  nonce_size: number;
  tag_size: number;
  fixtures: Fixture[];
} = await Bun.file(`${dir}/manifest.json`).json();

function envelopeOf(f: Fixture): Envelope {
  return {
    userId: f.envelope.user_id,
    stream: f.envelope.stream as "hot" | "cold",
    writerId: f.envelope.writer_id,
    writerCounter: BigInt(f.envelope.writer_counter),
  };
}

function fixture(name: string): Fixture {
  const f = manifest.fixtures.find((x) => x.file === name);
  if (!f) throw new Error(`conformance fixture ${name} is missing; regenerate with LEDGER_WRITE_CONFORMANCE=1`);
  return f;
}

const env: Envelope = {
  userId: "11111111-1111-1111-1111-111111111111",
  stream: "hot",
  writerId: "dev-a",
  writerCounter: 7n,
};

// ---------------------------------------------------------------------------
// The frozen layout
// ---------------------------------------------------------------------------

test("aad is the canonical pipe-joined field set", () => {
  expect(new TextDecoder().decode(aad(env))).toBe("11111111-1111-1111-1111-111111111111|hot|dev-a|7");
});

test("the layout constants match the ones Go wrote into the manifest", () => {
  expect(BUCKETS).toEqual(manifest.buckets);
  expect(NONCE_SIZE).toBe(manifest.nonce_size);
  expect(TAG_SIZE).toBe(manifest.tag_size);
  expect(MAX_BUCKET).toBe(BUCKETS[BUCKETS.length - 1]!);
  expect(BUCKETS.length).toBe(7);
});

test("bucketFor returns the smallest bucket that holds the framed length", () => {
  expect(bucketFor(1)).toBe(1024);
  expect(bucketFor(1024)).toBe(1024);
  expect(bucketFor(1025)).toBe(4096);
  expect(() => bucketFor(MAX_BUCKET + 1)).toThrow();
});

// ---------------------------------------------------------------------------
// Opening what Go sealed
// ---------------------------------------------------------------------------

for (const f of manifest.fixtures) {
  test(`openBlob round-trips the Go-sealed fixture ${f.file}`, async () => {
    // Bun.file() returns a BunFile, not bytes — .bytes() is the accessor.
    const bytes = await Bun.file(`${dir}/${f.file}`).bytes();
    expect(bytes.length).toBe(f.expect_bucket);
    expect(bytes[0]).toBe(VERSION);

    const e = envelopeOf(f);
    expect(new TextDecoder().decode(aad(e))).toBe(f.expect_aad);
    expect(new TextDecoder().decode(embeddedAAD(bytes))).toBe(f.expect_aad);

    const got = openBlob(e, bytes);
    expect(Buffer.from(got).toString("base64")).toBe(f.expect_plaintext_base64);
  });
}

test("the reserved nonce and tag slots are zero in Phase 1", async () => {
  const bytes = await Bun.file(`${dir}/hot-dev-a-7.bin`).bytes();
  const { start, end } = sealedRegion(bytes);
  for (const b of bytes.slice(start - NONCE_SIZE, start)) expect(b).toBe(0);
  for (const b of bytes.slice(end)) expect(b).toBe(0);
  expect(bytes.length - end).toBe(TAG_SIZE);
});

test("the bucket-edge fixture has exactly one padding byte", async () => {
  // Every other fixture has hundreds of bytes of slack, so an off-by-one in the
  // offset math would still find the payload. This one would not.
  const f = fixture("hot-dev-a-8-bucket-edge.bin");
  expect(f.expect_pre_pad_length).toBe(f.expect_bucket - 1);
  const bytes = await Bun.file(`${dir}/${f.file}`).bytes();
  const { start, end } = sealedRegion(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLen = view.getUint32(start);
  expect(start + 4 + payloadLen + TAG_SIZE).toBe(f.expect_bucket - 1);
  expect(bytes[end - 1]).toBe(0); // the single pad byte, inside the sealed region
  expect(openBlob(envelopeOf(f), bytes).length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// The AAD is the replay check, so it has to actually be checked
// ---------------------------------------------------------------------------

test("openBlob rejects an envelope that does not match the sealed AAD", async () => {
  // Note the fixture is loaded and passed intact: an earlier draft of this test
  // passed empty bytes, so it threw for the wrong reason and would have passed
  // against an implementation that ignored the AAD entirely.
  const bytes = await Bun.file(`${dir}/hot-dev-a-7.bin`).bytes();
  expect(openBlob(env, bytes).length).toBeGreaterThan(0); // the control

  expect(() => openBlob({ ...env, writerCounter: 8n }, bytes)).toThrow(BlobDecodeError);
  expect(() => openBlob({ ...env, stream: "cold" }, bytes)).toThrow(BlobDecodeError);
  expect(() => openBlob({ ...env, writerId: "dev-b" }, bytes)).toThrow(BlobDecodeError);
  expect(() => openBlob({ ...env, userId: "22222222-2222-2222-2222-222222222222" }, bytes)).toThrow(BlobDecodeError);
});

test("openBlob rejects framing it cannot read", async () => {
  const bytes = await Bun.file(`${dir}/hot-dev-a-7.bin`).bytes();

  const notABucket = bytes.slice(0, bytes.length - 1);
  expect(() => openBlob(env, notABucket)).toThrow(BlobDecodeError);

  const badVersion = Uint8Array.from(bytes);
  badVersion[0] = 2;
  expect(() => openBlob(env, badVersion)).toThrow(BlobDecodeError);

  const hugeAADLen = Uint8Array.from(bytes);
  hugeAADLen[1] = 0xff;
  hugeAADLen[2] = 0xff;
  expect(() => openBlob(env, hugeAADLen)).toThrow(BlobDecodeError);

  const hugePayloadLen = Uint8Array.from(bytes);
  const { start } = sealedRegion(bytes);
  new DataView(hugePayloadLen.buffer).setUint32(start, 0xffffffff);
  expect(() => openBlob(env, hugePayloadLen)).toThrow(BlobDecodeError);

  // Corrupt the LAST payload byte, which is the gzip CRC32/ISIZE trailer. An
  // earlier draft flipped start+8 — inside the gzip MTIME header, which gunzip
  // ignores — so it decompressed cleanly and the assertion tested nothing.
  const corruptPayload = Uint8Array.from(bytes);
  const payloadLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(start);
  expect(payloadLen).toBeGreaterThan(0);
  const last = start + 4 + payloadLen - 1;
  corruptPayload.set([corruptPayload[last]! ^ 0xff], last);
  expect(() => openBlob(env, corruptPayload)).toThrow(BlobDecodeError);
});

test("an unusable envelope is a caller bug, not a set-aside blob", async () => {
  // Go draws the same line: ErrInvalidEnvelope does not wrap ErrSetAside,
  // because a blob that will not open is warned about and a caller that asked
  // the wrong question is a bug.
  const bytes = await Bun.file(`${dir}/hot-dev-a-7.bin`).bytes();
  for (const bad of [
    { ...env, writerCounter: 0n },
    { ...env, writerId: "" },
    { ...env, writerId: "dev|a" },
    { ...env, stream: "hott" as "hot" },
    { ...env, userId: "00000000-0000-0000-0000-000000000000" },
    { ...env, userId: "not-a-uuid" },
  ]) {
    expect(() => openBlob(bad, bytes)).toThrow(InvalidEnvelopeError);
  }
});

// ---------------------------------------------------------------------------
// Sealing: the direction the server and every other device sees
// ---------------------------------------------------------------------------

test("sealBlob frames, pads to a bucket and reopens", () => {
  const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, kind: "ops", ops: [] }));
  const sealed = sealBlob(env, plaintext);
  expect(BUCKETS).toContain(sealed.length);
  expect(sealed[0]).toBe(VERSION);
  expect(new TextDecoder().decode(embeddedAAD(sealed))).toBe("11111111-1111-1111-1111-111111111111|hot|dev-a|7");
  expect(openBlob(env, sealed)).toEqual(plaintext);
  expect(() => openBlob({ ...env, writerCounter: 8n }, sealed)).toThrow(BlobDecodeError);

  const { start, end } = sealedRegion(sealed);
  for (const b of sealed.slice(start - NONCE_SIZE, start)) expect(b).toBe(0);
  for (const b of sealed.slice(end)) expect(b).toBe(0);
});

test("two different plaintexts in one bucket are the same size on the wire", () => {
  // The whole point of the ladder: a server or a backup thief learns the
  // bucket and nothing finer.
  const a = sealBlob(env, new TextEncoder().encode("x"));
  const b = sealBlob(env, new TextEncoder().encode("y".repeat(500)));
  expect(a.length).toBe(b.length);
});

test("the TypeScript-authored conformance fixtures are the bytes this code produces", async () => {
  // conformance/ts/ is what Go opens in TestTypeScriptSealedBlobsOpenInGo. If it
  // went stale, that test would keep passing against a fossil while this
  // executor quietly wrote something else — the exact blind spot a one-way
  // fixture set has.
  await assertFixturesAreFresh();
});

test("sealBlob refuses a plaintext no bucket can hold", () => {
  // Incompressible, so gzip cannot rescue it into a bucket.
  const huge = new Uint8Array(3 << 20);
  crypto.getRandomValues(huge.subarray(0, 65536));
  for (let i = 65536; i < huge.length; i += 65536) huge.copyWithin(i, 0, 65536);
  expect(() => sealBlob(env, huge)).toThrow();
});
