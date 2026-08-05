import { describe, expect, test } from "bun:test";

import { platform } from "@ledger/client/platform.ts";
import { DONATION_CONSENT, DONATION_RETENTION_DAYS, donationPreview, donationRequest } from "./redaction.ts";

function fixture() {
  const bytes = platform().utf8Encode("From: bank@example.test\r\n\r\nAED 9,912.45 at SECRET MERCHANT\r\nCard 4567");
  const ingestId = platform().toHex(platform().sha256(bytes));
  return { bytes, ingestId };
}

describe("raw-message donation guard", () => {
  test("preview is the complete exact cold body named by ingest_id", () => {
    const { bytes, ingestId } = fixture();
    const preview = donationPreview(bytes, ingestId);
    expect(preview.bytes).toEqual(bytes);
    expect(platform().toHex(platform().sha256(preview.bytes))).toBe(ingestId);
    expect(preview.text).toContain("AED 9,912.45");
    expect(preview.text).toContain("SECRET MERCHANT");
    expect(preview.text).toContain("4567");
    expect(DONATION_RETENTION_DAYS).toBe(180);
    bytes.fill(0);
    expect(platform().toHex(platform().sha256(preview.bytes))).toBe(ingestId);
  });

  test("a different or malformed body cannot be previewed under an ingest id", () => {
    const { bytes, ingestId } = fixture();
    bytes[0] = bytes[0]! ^ 1;
    expect(() => donationPreview(bytes, ingestId)).toThrow("do not match");
    expect(() => donationPreview(bytes, "A".repeat(64))).toThrow("lower-case hex");
  });

  test("donation is never callable without the exact consent identifier", () => {
    const { bytes, ingestId } = fixture();
    const preview = donationPreview(bytes, ingestId);
    for (const consent of [null, "", "yes", "donate-sample-v1.1"]) {
      expect(() => donationRequest(preview, consent)).toThrow("requires consent");
    }
    expect(donationRequest(preview, DONATION_CONSENT)).toEqual({ ingest_id: ingestId, consent: "donate-sample-v1" });
  });

  test("bytes changed after preview invalidate earlier consent", () => {
    const { bytes, ingestId } = fixture();
    const preview = donationPreview(bytes, ingestId);
    preview.bytes[0] = preview.bytes[0]! ^ 1;
    expect(() => donationRequest(preview, DONATION_CONSENT)).toThrow("changed after consent");
  });
});
