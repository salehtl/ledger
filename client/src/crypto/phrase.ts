/**
 * The recovery phrase: twelve words that ARE the account's keys.
 *
 * # What this is for, stated plainly
 *
 * The account's X25519 ingest key and its AES-256-GCM data key are wrapped
 * under a key derived from this phrase, and the wrapped blob is the only copy
 * that leaves the device (`keys.ts`). On iOS the beta design treated a phrase as
 * a backstop because iCloud Keychain synced a device wrap key; **a browser has
 * no Keychain**. So on the web this phrase is the only recovery path there is:
 * a user who clears site data without it has an account nobody — including the
 * operator — can open again, because nobody holds anything that could.
 *
 * # Why it is BIP-39 shaped
 *
 * Twelve words from {@link WORDLIST}: 128 bits of entropy plus a 4-bit SHA-256
 * checksum, packed 11 bits per word, exactly as BIP-39 specifies. Three
 * properties are worth the conformance:
 *
 *  1. **The checksum catches a transcription error before the KDF runs.** A
 *     swapped pair or one wrong word is twelve legal words in a legal-looking
 *     order; nothing but a checksum tells them apart from the real phrase. The
 *     alternative feedback is a several-second Argon2id run that fails with
 *     "that did not work", on the screen where a person is already worried.
 *  2. **The list is transcribable.** Every word is unique in four letters, so
 *     autocomplete is unambiguous and a phrase read aloud survives.
 *  3. **It outlives us.** A BIP-39 phrase can be written on a metal plate, kept
 *     in a password manager, or typed into a tool that is not this one. That
 *     matters for a secret whose whole job is to still work after the device,
 *     the browser profile and possibly the product are gone.
 *
 * It is **not** a Bitcoin seed and nothing derives a BIP-32 tree from it. The
 * shared shape is the encoding, and `keys.ts` derives from the WORDS, not from
 * BIP-39's PBKDF2 seed — see its header.
 *
 * # 128 bits and not 256
 *
 * Twelve words rather than twenty-four, because the phrase must actually be
 * written down. 128 bits is beyond any brute force, and the failure mode this
 * product will really see is a person not recording twenty-four words at all —
 * which costs the whole account, where the extra 128 bits buys nothing against
 * an attacker who was never going to search 2^128 either way.
 *
 * # Everything here is pure and takes its platform as an argument
 *
 * No module-level `platform()` call: these functions run inside a screen on one
 * host and inside tests against both, and passing the seam in keeps the
 * cross-host equivalence checkable in one expression.
 */

import type { Platform } from "../platform";
import { WORDLIST } from "./wordlist";

/** Bits of entropy in a phrase. */
export const PHRASE_ENTROPY_BITS = 128;

/** Bits each word carries: log2(2048). */
const BITS_PER_WORD = 11;

/** BIP-39's checksum length: one bit per 32 bits of entropy. */
const CHECKSUM_BITS = PHRASE_ENTROPY_BITS / 32;

/** 12. Derived rather than written down, so the three constants cannot drift. */
export const PHRASE_WORDS = (PHRASE_ENTROPY_BITS + CHECKSUM_BITS) / BITS_PER_WORD;

/** Bytes of entropy. */
const ENTROPY_BYTES = PHRASE_ENTROPY_BITS / 8;

/**
 * A phrase that is not one. Distinct from `Error` because the recovery screen
 * shows its message to a person and must not show an internal one.
 */
export class PhraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhraseError";
  }
}

/**
 * The canonical form of a phrase a person typed: lower case, single spaces,
 * nothing at the ends.
 *
 * Unicode whitespace is folded to a plain space, not just ASCII: a phrase
 * pasted out of a notes app or a PDF routinely carries a non-breaking space or
 * a narrow no-break space, both of which are a space to the person looking at
 * them and are not one to `split(" ")`.
 *
 * NFKD normalisation runs first for the same reason it does in BIP-39, even
 * though this wordlist is pure ASCII and cannot itself be affected: the input is
 * whatever a keyboard produced, and normalising it means a full-width character
 * from an IME becomes the ASCII one rather than an "unknown word" the user
 * cannot see anything wrong with.
 */
export function normalizePhrase(input: string): string {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/** The words of a normalized phrase. `[]` for the empty string, never `[""]`. */
function wordsOf(input: string): string[] {
  const s = normalizePhrase(input);
  return s === "" ? [] : s.split(" ");
}

/**
 * Packs 128 bits of entropy plus its 4-bit checksum into twelve words.
 *
 * The bit accumulator is a `number` and stays exact: at most 8 + 10 = 18 bits
 * are ever live in it, well inside the 53 a double holds precisely.
 */
export function entropyToPhrase(entropy: Uint8Array, p: Platform): string {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new PhraseError(`a recovery phrase carries ${ENTROPY_BYTES} bytes of entropy, got ${entropy.length}`);
  }
  // BIP-39's checksum: the first CHECKSUM_BITS of SHA-256 over the entropy,
  // appended to the entropy's bits before packing.
  const checksum = p.sha256(entropy)[0]!;

  const words: string[] = [];
  let acc = 0;
  let bits = 0;
  const emit = (byte: number): void => {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= BITS_PER_WORD) {
      bits -= BITS_PER_WORD;
      words.push(WORDLIST[(acc >> bits) & 0x7ff]!);
    }
  };
  for (const b of entropy) emit(b);
  // The checksum byte contributes only its top CHECKSUM_BITS bits, and after
  // 128 + 8 = 136 bits exactly 12 words have been emitted with 4 bits left
  // over — which are the low, unused half of that byte.
  emit(checksum);
  return words.slice(0, PHRASE_WORDS).join(" ");
}

/** Why a phrase was refused. Each arm is a different thing to tell the person. */
type PhraseRejection =
  | { ok: false; reason: "length"; message: string; count: number }
  | { ok: false; reason: "unknown_word"; message: string; index: number; word: string }
  | { ok: false; reason: "checksum"; message: string };

export type PhraseVerdict = { ok: true; phrase: string } | PhraseRejection;

/**
 * Checks a typed phrase, without running the KDF.
 *
 * Order matters and is chosen for the person reading the result: the length is
 * checked before the words, and the words before the checksum, so the most
 * specific and most actionable complaint is the one that surfaces. "One of
 * these words is not on the list, and it is the sixth one" is a fixable
 * sentence; "that phrase is wrong" is not.
 */
export function validatePhrase(input: string, p: Platform): PhraseVerdict {
  const words = wordsOf(input);
  if (words.length !== PHRASE_WORDS) {
    return {
      ok: false,
      reason: "length",
      count: words.length,
      message: `A recovery phrase is ${PHRASE_WORDS} words. This one has ${words.length}.`,
    };
  }
  const indices: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const at = WORDLIST.indexOf(words[i]!);
    if (at < 0) {
      return {
        ok: false,
        reason: "unknown_word",
        index: i,
        word: words[i]!,
        message: `Word ${i + 1}, "${words[i]}", is not one of the words a ledger recovery phrase is made of.`,
      };
    }
    indices.push(at);
  }
  if (!checksumHolds(indices, p)) {
    return {
      ok: false,
      reason: "checksum",
      message:
        "Every word is a real one, but together they are not a phrase ledger produced — " +
        "two words are probably swapped, or one is not the word that was written down.",
    };
  }
  return { ok: true, phrase: words.join(" ") };
}

/**
 * The entropy a phrase encodes, or a {@link PhraseError}.
 *
 * There is deliberately no lenient variant. A phrase that fails the checksum
 * decodes to *some* 16 bytes, and those bytes would derive a key that unwraps
 * nothing — the failure would surface several seconds later as an
 * authentication failure with nothing to act on.
 */
export function phraseToEntropy(input: string, p: Platform): Uint8Array {
  const verdict = validatePhrase(input, p);
  if (!verdict.ok) throw new PhraseError(verdict.message);
  return unpack(wordsOf(verdict.phrase).map((w) => WORDLIST.indexOf(w))).entropy;
}

/** A fresh phrase, from `p.randomBytes`. */
export function generatePhrase(p: Platform): string {
  return entropyToPhrase(p.randomBytes(ENTROPY_BYTES), p);
}

/**
 * Every word starting with `prefix`, in list order — the recovery screen's
 * autocomplete.
 *
 * Empty for the empty prefix on purpose: offering all 2048 words is not a
 * suggestion, and a field that drops a list over the keyboard before a
 * character is typed is the shape that made the harness's geometry audit
 * exist.
 */
export function suggestWords(prefix: string): string[] {
  const p = normalizePhrase(prefix);
  if (p === "") return [];
  return WORDLIST.filter((w) => w.startsWith(p));
}

// ---------------------------------------------------------------------------
// The bit packing
// ---------------------------------------------------------------------------

function unpack(indices: readonly number[]): { entropy: Uint8Array; checksum: number } {
  const entropy = new Uint8Array(ENTROPY_BYTES);
  let acc = 0;
  let bits = 0;
  let at = 0;
  let checksum = 0;
  for (const index of indices) {
    acc = (acc << BITS_PER_WORD) | index;
    bits += BITS_PER_WORD;
    while (bits >= 8) {
      bits -= 8;
      const byte = (acc >> bits) & 0xff;
      if (at < ENTROPY_BYTES) entropy[at++] = byte;
    }
  }
  // What is left is the checksum, in the LOW `bits` positions, aligned up to
  // the top of a byte the way `entropyToPhrase` emitted it.
  checksum = ((acc & ((1 << bits) - 1)) << (8 - bits)) & 0xff;
  return { entropy, checksum };
}

function checksumHolds(indices: readonly number[], p: Platform): boolean {
  const { entropy, checksum } = unpack(indices);
  const expected = p.sha256(entropy)[0]! & (0xff << (8 - CHECKSUM_BITS)) & 0xff;
  return checksum === expected;
}
