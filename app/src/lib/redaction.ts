import { platform } from "@ledger/client/platform.ts";

/** Identifier of the exact disclosure the server accepts for raw-mail donation. */
export const DONATION_CONSENT = "donate-sample-v1";
export const DONATION_RETENTION_DAYS = 180;

export interface DonationPreview {
  /** Defensive copy of the complete message bytes the server will copy. */
  bytes: Uint8Array;
  /** Display form only; `bytes`, not this decoded string, is the evidence. */
  text: string;
  ingestId: string;
}

/**
 * Builds the consent preview only when the verified cold body is exactly the
 * message named by ingestId. There is deliberately no "redacted" transform:
 * the donation is the complete email and the preview must not imply otherwise.
 */
export function donationPreview(coldBody: Uint8Array, ingestId: string): DonationPreview {
  if (!/^[0-9a-f]{64}$/.test(ingestId)) throw new Error("donation ingest_id must be 64 lower-case hex characters");
  const p = platform();
  const actual = p.toHex(p.sha256(coldBody));
  if (actual !== ingestId) throw new Error("donation preview bytes do not match ingest_id");
  const bytes = coldBody.slice();
  return { bytes, text: p.utf8Decode(bytes), ingestId };
}

export interface DonationRequest { ingest_id: string; consent: typeof DONATION_CONSENT }

/** Refuses to make a callable request until the exact consent is affirmative. */
export function donationRequest(preview: DonationPreview, consent: string | null): DonationRequest {
  if (consent !== DONATION_CONSENT) throw new Error(`donation requires consent ${DONATION_CONSENT}`);
  const p = platform();
  if (p.toHex(p.sha256(preview.bytes)) !== preview.ingestId) {
    throw new Error("donation preview changed after consent");
  }
  return { ingest_id: preview.ingestId, consent: DONATION_CONSENT };
}
