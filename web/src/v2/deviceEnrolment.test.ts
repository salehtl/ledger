import { describe, expect, it } from "vitest";

import {
  comparisonCode,
  comparisonDigest,
  COMPARISON_DOMAIN,
  decodeEnrolmentRequest,
  EnrolmentCodeError,
  encodeEnrolmentRequest,
  type KeyHistoryEntry,
} from "./deviceEnrolment";

const KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const OTHER = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);

const LOG: KeyHistoryEntry[] = [
  { id: 1, writer_id: "ingest", pubkey: "", event: "registered", at: "2026-08-01T00:00:00Z" },
  { id: 2, writer_id: "web-a", pubkey: "AAECAwQFBgcICQoLDA0ODw==", event: "registered", at: "2026-08-01T00:01:00Z" },
];

const REQ = { writerId: "web-6f57dd99", publicKey: KEY };

describe("the transfer code", () => {
  it("round-trips a request", () => {
    const back = decodeEnrolmentRequest(encodeEnrolmentRequest(REQ));
    expect(back.writerId).toBe(REQ.writerId);
    expect(Array.from(back.publicKey)).toEqual(Array.from(KEY));
  });

  it("survives the wrapping a message app adds", () => {
    const code = encodeEnrolmentRequest(REQ);
    const wrapped = `  ${code.slice(0, 20)}\n${code.slice(20)}  `;
    expect(decodeEnrolmentRequest(wrapped).writerId).toBe(REQ.writerId);
  });

  it("carries no private material — only the id and the public key", () => {
    const code = encodeEnrolmentRequest(REQ);
    expect(code.startsWith("ledger-device-1:web-6f57dd99:")).toBe(true);
    expect(code.split(":")).toHaveLength(3);
  });

  it("refuses a writer id the server would refuse", () => {
    expect(() => encodeEnrolmentRequest({ writerId: "web 1", publicKey: KEY })).toThrow(EnrolmentCodeError);
  });

  it("refuses a key that is not 32 bytes, on both sides", () => {
    expect(() => encodeEnrolmentRequest({ writerId: "web-1", publicKey: new Uint8Array(31) })).toThrow(
      EnrolmentCodeError,
    );
    // A truncated key must be REFUSED, never padded: a silently wrong key
    // presents as the server's bodyless 403, with nothing to act on.
    const short = `ledger-device-1:web-1:${encodeEnrolmentRequest(REQ).split(":")[2].slice(0, 20)}`;
    expect(() => decodeEnrolmentRequest(short)).toThrow(EnrolmentCodeError);
  });

  it("refuses a code that is not one, and says so in words a person can act on", () => {
    expect(() => decodeEnrolmentRequest("")).toThrow(/Paste the code/);
    expect(() => decodeEnrolmentRequest("hello")).toThrow(/not a ledger device code/i);
    expect(() => decodeEnrolmentRequest("ledger-device-1:web-1")).toThrow(/incomplete/i);
    expect(() => decodeEnrolmentRequest("ledger-device-1:web 1:AAAA")).toThrow(/damaged/i);
  });
});

describe("the comparison code", () => {
  it("is ten characters — 50 bits — from an unambiguous alphabet, grouped", () => {
    expect(comparisonCode(REQ, LOG)).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it("is the same on both devices for the same log and the same key", () => {
    expect(comparisonCode(REQ, LOG)).toBe(comparisonCode({ ...REQ }, [...LOG]));
  });

  it("does not depend on the order the entries arrived in", () => {
    expect(comparisonCode(REQ, [...LOG].reverse())).toBe(comparisonCode(REQ, LOG));
  });

  /**
   * The half that detects the attack §3.4 names: a server that shows one device
   * a key history with a writer added or removed cannot make the two codes
   * agree.
   */
  it("changes when the key history differs", () => {
    const planted = [...LOG, { id: 3, writer_id: "web-evil", pubkey: "Zg==", event: "registered", at: "x" }];
    expect(comparisonCode(REQ, planted)).not.toBe(comparisonCode(REQ, LOG));
  });

  it("changes when a single entry is altered", () => {
    const altered = LOG.map((e) => (e.id === 2 ? { ...e, pubkey: "BBECAwQFBgcICQoLDA0ODw==" } : e));
    expect(comparisonCode(REQ, altered)).not.toBe(comparisonCode(REQ, LOG));
  });

  /** The half that detects a code changed in transit. */
  it("changes when the key being enrolled changes", () => {
    expect(comparisonCode({ ...REQ, publicKey: OTHER }, LOG)).not.toBe(comparisonCode(REQ, LOG));
  });

  it("changes when the writer id being enrolled changes", () => {
    expect(comparisonCode({ ...REQ, writerId: "web-other" }, LOG)).not.toBe(comparisonCode(REQ, LOG));
  });

  it("is a full sha256 underneath, truncated only for display", () => {
    expect(comparisonDigest(REQ, LOG)).toHaveLength(32);
  });

  /**
   * The width is a security parameter, not a layout choice. In the
   * malicious-server model the attacker controls both the key it substitutes
   * and the key history it serves each device, so it can grind for a collision
   * offline with nothing to commit against: 8 characters (40 bits) is hours on
   * a GPU, 10 (50 bits) is not. Pinned so a "tidier" 8 cannot come back
   * without this test failing and the reasoning above being read.
   */
  it("carries 50 bits, which is the number the grinding analysis chose", () => {
    expect(comparisonCode(REQ, LOG).replace("-", "")).toHaveLength(10);
  });

  /**
   * A golden vector over the whole derivation — the domain prefix, the
   * canonical log encoding, the request fields, the truncation and the base32
   * packer. Any change to any of them moves this string, which is the point:
   * the two devices must agree byte for byte, so a silent re-encoding is a
   * silent loss of the check rather than a cosmetic edit.
   *
   * If this fails after a deliberate format change, note that every already-
   * enrolled pair of devices computes the old value until both are updated.
   */
  it("is pinned to a known value", () => {
    expect(comparisonCode(REQ, LOG)).toBe("YAKAN-99HGC");
  });

  /**
   * The domain prefix ends in a NUL, and it must be written `\x00` rather than
   * as a literal byte: git treats a file containing one as binary and prints no
   * diff for it, which has hidden two modules from review on this branch
   * already. Asserted by code point so neither the label nor the terminator can
   * drift while the file stays reviewable.
   */
  it("is domain-separated by a terminator that is escaped, not embedded", () => {
    expect(COMPARISON_DOMAIN).toBe("ledger-v2-device-comparison\x00");
    expect(COMPARISON_DOMAIN.codePointAt(COMPARISON_DOMAIN.length - 1)).toBe(0);
    expect(COMPARISON_DOMAIN.slice(0, -1)).toMatch(/^[\x20-\x7e]+$/);
  });
});
