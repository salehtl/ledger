/**
 * Second-device enrolment: the transfer code a new device shows, and the
 * cross-device comparison code both devices must display the same value for.
 *
 * # Why any of this exists
 *
 * `internal/v2/auth/writer.go` will only enrol a writer against an Ed25519
 * signature by an ALREADY-ENROLLED, non-revoked device key of the same account,
 * over `RegistrationMessage(nonce, writerID, pubkey)`. The one exception is the
 * account's very first device, which self-signs (TOFU) and closes the window
 * forever. So a second device's registration is not something that device can
 * perform at all: it can only ask a device that is already enrolled to sign for
 * it. Everything here is the plumbing for that ask.
 *
 * The private key never moves — `Client.enroll`'s doc says why: a private key
 * that can be exported is a private key that will be. What moves is the new
 * device's writer id and PUBLIC key, in the code {@link encodeEnrolmentRequest}
 * produces.
 *
 * # There is no server-side list of pending requests, and that is deliberate
 *
 * Nothing in `internal/v2` stores an unapproved enrolment: the endpoints are
 * `POST /writers/challenge`, `POST /writers/register` and `GET /writers`, and a
 * writer either exists or does not. So the request travels OUT OF BAND — the
 * new device shows a code and the person carries it to the enrolled device.
 * That is a weaker product than a push notification and a stronger security
 * story: the pubkey the enrolled device signs for is one the server never
 * touched.
 *
 * # The comparison code, and exactly what it is evidence of
 *
 * Spec §3.4 asks for a short cross-device comparison code at second-device
 * enrolment, "a hash over the key-history head and the writer-checkpoint
 * heads", surfaced on both devices, because single-operator infrastructure
 * "cannot make key substitution impossible, only detectable".
 *
 * {@link comparisonCode} hashes two things, and both halves are load bearing:
 *
 *  1. **The whole key-history log** each device fetched FOR ITSELF from
 *     `GET /api/v1/key-history`. A server that showed one device a log with an
 *     attacker's writer removed — or added — produces a different code there
 *     than on the other device, and the codes stop matching. This is §3.4's
 *     detection, and it works precisely because the server does not compute it.
 *  2. **The enrolment being authorised** — the new device's writer id and
 *     public key. The new device hashes the key it actually holds; the enrolled
 *     device hashes the key it is about to sign for. A code that was retyped,
 *     truncated or swapped in transit changes this half.
 *
 * **What it does NOT cover, stated rather than implied:** the writer-checkpoint
 * heads §3.4 also names. A checkpoint head is read out of a device's folded
 * projection, and the device being enrolled has no projection yet — it has
 * never been able to author or fold anything, which is the whole reason it is
 * on this screen. Hashing them would make the two sides differ on every
 * legitimate enrolment, which is worse than useless: a check that cries wolf is
 * a check nobody reads. The key-history half is the half that detects key
 * substitution, and it is the half that is computable on both sides.
 */

import { fromBase64Url, toBase64Url } from "./session";
import { webPlatform } from "@ledger/client/platform.web";

export type { KeyHistoryEntry } from "@ledger/client/net/client";
import type { KeyHistoryEntry } from "@ledger/client/net/client";

/** An Ed25519 public key is 32 bytes; `auth.checkPublicKey` refuses anything else. */
const PUBLIC_KEY_BYTES = 32;

/** Mirrors `writers_writer_id_charset` and `auth.validWriterID`. */
const WRITER_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The version tag the code carries, so a later format can be told apart from a
 * mistyped one instead of being decoded into the wrong bytes.
 */
const CODE_PREFIX = "ledger-device-1";

/** `:` separates the fields because it is the one ASCII character in neither the writer-id charset nor base64url. */
const SEP = ":";

/**
 * The domain-separation prefix, ending in a NUL that cannot appear in the ASCII
 * label itself — the same shape as `auth.registrationDomain`, so a digest taken
 * here can never be mistaken for one taken over another statement.
 *
 * Written as `\x00`, NOT as a literal NUL byte. It was a literal one for one
 * commit, and the consequence is not cosmetic: git classifies a file containing
 * a NUL as binary and prints no diff for it at all. That has cost this branch
 * twice already — `replay/snapshot.ts` hid a whole module from two audits until
 * the build broke, and `queries.ts` hid a screen's entire data path from a code
 * review. The string value is identical; only the file stays reviewable.
 * `deviceEnrolment.test.ts` pins the code points so the escape cannot be
 * "tidied" back into something else.
 */
export const COMPARISON_DOMAIN = "ledger-v2-device-comparison\x00";

/**
 * Crockford's base32 alphabet: no `I`, `L`, `O` or `U`, so nothing in a code
 * read aloud or copied by hand collides with `1`, `0` or a swear word.
 */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** What one device asks another to enrol on its behalf. The private half never leaves the device that made it. */
export interface EnrolmentRequest {
  writerId: string;
  publicKey: Uint8Array;
}

/** A code that is not one. Its message is shown to a person, so it says what to do. */
export class EnrolmentCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrolmentCodeError";
  }
}

/** The code the new device displays. */
export function encodeEnrolmentRequest(req: EnrolmentRequest): string {
  if (!WRITER_ID.test(req.writerId)) {
    throw new EnrolmentCodeError(`${JSON.stringify(req.writerId)} is not a legal writer id`);
  }
  if (req.publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new EnrolmentCodeError(`an Ed25519 public key is ${PUBLIC_KEY_BYTES} bytes, and this one is ${req.publicKey.length}`);
  }
  return `${CODE_PREFIX}${SEP}${req.writerId}${SEP}${toBase64Url(req.publicKey)}`;
}

/**
 * The inverse, strictly, with a message for each way it can be wrong.
 *
 * Whitespace is stripped first and nothing else is repaired: a code that
 * travelled through a message app arrives wrapped, and a code that arrives
 * short must be REFUSED rather than padded — the server answers every
 * registration refusal with the same bodyless 403, so a code silently decoded
 * into the wrong bytes would present as "rejected" with nothing to act on.
 */
export function decodeEnrolmentRequest(code: string): EnrolmentRequest {
  const trimmed = code.replace(/\s+/g, "");
  if (trimmed === "") throw new EnrolmentCodeError("Paste the code shown on the device you are adding.");
  const parts = trimmed.split(SEP);
  if (parts[0] !== CODE_PREFIX) {
    throw new EnrolmentCodeError("This is not a ledger device code. Copy the whole code from the other device, including the part before the first colon.");
  }
  if (parts.length !== 3) {
    throw new EnrolmentCodeError("This code is incomplete. Copy all of it from the other device — it is one line, with no spaces.");
  }
  const writerId = parts[1];
  if (!WRITER_ID.test(writerId)) {
    throw new EnrolmentCodeError("This code is damaged: the device name in it is not one ledger could have written.");
  }
  let publicKey: Uint8Array;
  try {
    publicKey = fromBase64Url(parts[2]);
  } catch {
    throw new EnrolmentCodeError("This code is damaged: the key in it is not readable. Copy it again from the other device.");
  }
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new EnrolmentCodeError("This code is damaged: the key in it is the wrong length. Copy it again from the other device.");
  }
  return { writerId, publicKey };
}

/**
 * The digest, as bytes. Split out from {@link comparisonCode} so the encoding
 * and the derivation can be pinned separately.
 *
 * Entries are hashed in the order the server serves them (oldest first), sorted
 * by `id` defensively so two devices that received the same log in a different
 * order still agree. Fields are newline-separated and every one of them —
 * a decimal id, a writer id from a closed charset, standard base64, and one of
 * three fixed event words — is newline-free, so no two logs encode alike. The
 * entry COUNT is hashed first for the same reason.
 *
 * `at` is deliberately excluded: it is a server timestamp, it is not part of
 * what a peer is auditing, and a serialisation difference in it would break
 * every comparison for no gain.
 */
export function comparisonDigest(req: EnrolmentRequest, entries: readonly KeyHistoryEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  const lines = [
    COMPARISON_DOMAIN,
    String(sorted.length),
    ...sorted.flatMap((e) => [String(e.id), e.writer_id, e.pubkey, e.event]),
    req.writerId,
    toBase64Url(req.publicKey),
  ];
  return webPlatform.sha256(new TextEncoder().encode(lines.join("\n")));
}

/** Characters of the digest a person compares. 10 x 5 bits = 50. */
const CODE_CHARS = 10;

/**
 * The code a person compares: 10 characters, 50 bits, grouped `ABCDE-FGHJK`.
 *
 * # Why 50 bits and not 40
 *
 * The check's whole audience is a person looking at two screens, so the length
 * is chosen against the attacker who wants those two screens to agree while the
 * enrolments behind them differ. In the malicious-server model that attacker
 * controls BOTH inputs — the key it is substituting and the key-history log it
 * serves each device — so it can grind for a collision offline, with no
 * commitment step to stop it. At 40 bits that is a ~2^40 SHA-256 search: hours
 * on one GPU, which is well inside the window of a live enrolment.
 *
 * 50 bits puts it at ~2^50, which is not hours, and it costs two characters
 * nobody comparing two codes will notice. It is not the *point* at which the
 * check becomes sound — in that model the attacker is also serving the
 * JavaScript that computes the code, at which point no on-device digest means
 * anything — but leaving a grindable number in place invites exactly the
 * question this comment now answers.
 *
 * A wider code is not free forever: past roughly twelve characters people stop
 * comparing and start assuming, and a check nobody performs is worth nothing.
 * If more strength is ever needed it should come from a commitment step (the
 * approver commits to its digest before seeing the peer's), not from length.
 */
export function comparisonCode(req: EnrolmentRequest, entries: readonly KeyHistoryEntry[]): string {
  const digest = comparisonDigest(req, entries);
  let bits = 0;
  let acc = 0;
  let out = "";
  for (let i = 0; out.length < CODE_CHARS; i++) {
    // `acc` keeps stale high bits and JS truncates `<<` to 32 bits, and neither
    // matters: `bits` is at most 12 when a character is read, so only the low
    // 17 bits of `acc` are ever consulted and those are always exact.
    acc = (acc << 8) | digest[i];
    bits += 8;
    while (bits >= 5 && out.length < CODE_CHARS) {
      bits -= 5;
      out += BASE32[(acc >> bits) & 31];
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}
