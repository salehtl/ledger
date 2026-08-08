/**
 * The recovery phrase's contract.
 *
 * The phrase is the ONLY thing that can recover an account on the web — there
 * is no Keychain and the server holds nothing that could help — so these tests
 * are about the two ways it can fail a person: a phrase that decodes to
 * different key material than the one they wrote down, and a phrase that they
 * mistyped and the app accepted anyway.
 */

import { describe, expect, test } from "bun:test";
import { bunPlatform } from "../platform";
import { webPlatform } from "../platform.web";
import {
  PHRASE_ENTROPY_BITS,
  PHRASE_WORDS,
  PhraseError,
  entropyToPhrase,
  generatePhrase,
  normalizePhrase,
  phraseToEntropy,
  suggestWords,
  validatePhrase,
} from "./phrase";
import { WORDLIST, WORDLIST_SHA256, WORD_PREFIX_LENGTH } from "./wordlist";

const P = bunPlatform;
const hexToBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

describe("the wordlist", () => {
  test("is 2048 words, so a word is exactly 11 bits", () => {
    expect(WORDLIST.length).toBe(2048);
    expect(Math.log2(WORDLIST.length)).toBe(11);
  });

  // The digest is over the canonical file form — one word per line, newline
  // terminated — so this recomputes what the generator hashed. An edit,
  // reorder or truncation fails here, and it has to: a word's INDEX is its
  // meaning, and moving one changes what every phrase ever written down
  // decodes to.
  test("hashes to the published BIP-39 English digest", () => {
    const canonical = WORDLIST.join("\n") + "\n";
    expect(P.toHex(P.sha256(P.utf8Encode(canonical)))).toBe(WORDLIST_SHA256);
  });

  test("every word is unique, lower-case ASCII, and 3-8 letters", () => {
    expect(new Set(WORDLIST).size).toBe(WORDLIST.length);
    for (const w of WORDLIST) expect(w).toMatch(/^[a-z]{3,8}$/);
  });

  // BIP-39's four-letter-prefix property, checked rather than assumed: it is
  // what makes a transcribed phrase typeable with autocomplete and what makes a
  // truncated word unambiguous.
  test("every word is unique in its first four letters", () => {
    const prefixes = new Set(WORDLIST.map((w) => w.slice(0, WORD_PREFIX_LENGTH)));
    expect(prefixes.size).toBe(WORDLIST.length);
  });
});

describe("generatePhrase", () => {
  test("is 12 words from the list, and carries 128 bits", () => {
    const phrase = generatePhrase(P);
    const words = phrase.split(" ");
    expect(words.length).toBe(PHRASE_WORDS);
    expect(PHRASE_WORDS).toBe(12);
    expect(PHRASE_ENTROPY_BITS).toBe(128);
    for (const w of words) expect(WORDLIST).toContain(w);
  });

  test("does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generatePhrase(P));
    expect(seen.size).toBe(100);
  });

  // Not a randomness test — a test that the entropy was actually drawn. A
  // platform whose randomBytes returns zeros must not produce a phrase that
  // looks as legitimate as any other.
  test("draws its entropy from the platform, and every word position varies", () => {
    const positions: Set<string>[] = Array.from({ length: PHRASE_WORDS }, () => new Set<string>());
    for (let i = 0; i < 100; i++) {
      generatePhrase(P)
        .split(" ")
        .forEach((w, j) => positions[j]!.add(w));
    }
    // The last word is part checksum, so it varies less; every other position
    // should be close to all-distinct across 100 draws.
    for (let j = 0; j < PHRASE_WORDS - 1; j++) expect(positions[j]!.size).toBeGreaterThan(80);
  });

  test("round-trips through its own entropy", () => {
    for (let i = 0; i < 50; i++) {
      const phrase = generatePhrase(P);
      const entropy = phraseToEntropy(phrase, P);
      expect(entropy.length).toBe(PHRASE_ENTROPY_BITS / 8);
      expect(entropyToPhrase(entropy, P)).toBe(phrase);
    }
  });

  test("webPlatform and bunPlatform agree on the encoding", () => {
    for (let i = 0; i < 20; i++) {
      const entropy = P.randomBytes(16);
      expect(entropyToPhrase(entropy, webPlatform)).toBe(entropyToPhrase(entropy, P));
    }
  });
});

describe("entropyToPhrase", () => {
  // The BIP-39 published vectors: all-zero entropy, all-0x7f, all-0x80,
  // all-0xff. They pin the bit packing AND the checksum, which a round-trip
  // test on its own cannot — a consistently wrong packing round-trips fine.
  const VECTORS: readonly (readonly [string, string])[] = [
    ["00000000000000000000000000000000", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"],
    ["7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f", "legal winner thank year wave sausage worth useful legal winner thank yellow"],
    ["80808080808080808080808080808080", "letter advice cage absurd amount doctor acoustic avoid letter advice cage above"],
    ["ffffffffffffffffffffffffffffffff", "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"],
    ["9e885d952ad362caeb4efe34a8e91bd2", "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic"],
  ];

  for (const [hex, phrase] of VECTORS) {
    test(`BIP-39 vector ${hex.slice(0, 8)}…`, () => {
      expect(entropyToPhrase(hexToBytes(hex), P)).toBe(phrase);
      expect(P.toHex(phraseToEntropy(phrase, P))).toBe(hex);
    });
  }

  test("entropy that is not 16 bytes is refused", () => {
    expect(() => entropyToPhrase(new Uint8Array(15), P)).toThrow();
    expect(() => entropyToPhrase(new Uint8Array(32), P)).toThrow();
  });
});

describe("normalizePhrase", () => {
  test("collapses the ways a person types a phrase they wrote on paper", () => {
    const canonical = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    for (const typed of [
      "  legal winner thank year wave sausage worth useful legal winner thank yellow  ",
      "LEGAL WINNER THANK YEAR WAVE SAUSAGE WORTH USEFUL LEGAL WINNER THANK YELLOW",
      "legal\twinner\nthank year   wave sausage worth useful legal winner thank yellow",
      "Legal Winner Thank Year Wave Sausage Worth Useful Legal Winner Thank Yellow",
    ]) {
      expect(normalizePhrase(typed)).toBe(canonical);
    }
  });

  // A phrase typed on iOS may arrive in NFC or NFD, and the ASCII wordlist
  // makes that invisible — except for the non-breaking space a paste can carry,
  // which is a space to a person and not one to `split(" ")`.
  test("a non-breaking space is a space", () => {
    expect(normalizePhrase("zoo\u00a0zoo\u202fwrong")).toBe("zoo zoo wrong");
  });
});

describe("validatePhrase", () => {
  const GOOD = "legal winner thank year wave sausage worth useful legal winner thank yellow";

  test("accepts a phrase this module generated, however it was typed", () => {
    expect(validatePhrase(`  ${GOOD.toUpperCase()} `, P).ok).toBe(true);
  });

  test("names the wrong length rather than failing on the checksum", () => {
    const r = validatePhrase("zoo zoo zoo", P);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("length");
      expect(r.message).toContain("12");
    }
  });

  // The reason typo detection is worth having at all: it names the word,
  // before a several-second Argon2id run that would otherwise be the only
  // feedback and would say nothing useful when it failed.
  test("names an unknown word, and where it is", () => {
    const r = validatePhrase(GOOD.replace("sausage", "sausages"), P);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "unknown_word") {
      expect(r.message).toContain("sausages");
      expect(r.message).toContain("6");
      expect(r.index).toBe(5);
      expect(r.word).toBe("sausages");
    } else {
      throw new Error(`expected an unknown_word rejection, got ${JSON.stringify(r)}`);
    }
  });

  // The checksum is the whole reason the phrase is BIP-39 shaped rather than
  // twelve arbitrary words: a swapped pair is 12 known words in a legal-looking
  // order, and only the checksum catches it.
  test("catches a swapped pair, which every other check passes", () => {
    const words = GOOD.split(" ");
    [words[2], words[3]] = [words[3]!, words[2]!];
    const r = validatePhrase(words.join(" "), P);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("checksum");
  });

  test("catches a single substituted word 15 times out of 16, on average", () => {
    // One word wrong changes 11 bits of the decoded value; the 4-bit checksum
    // catches all but 1 in 16. Asserted as a floor over a fixed sweep rather
    // than as a probability, so the test cannot flake.
    let caught = 0;
    let tried = 0;
    const words = GOOD.split(" ");
    for (let i = 0; i < 12; i++) {
      for (let k = 1; k <= 20; k++) {
        const swapped = [...words];
        swapped[i] = WORDLIST[(WORDLIST.indexOf(words[i]!) + k * 97) % WORDLIST.length]!;
        if (swapped.join(" ") === GOOD) continue;
        tried++;
        if (!validatePhrase(swapped.join(" "), P).ok) caught++;
      }
    }
    expect(tried).toBeGreaterThan(200);
    expect(caught / tried).toBeGreaterThan(0.85);
  });

  test("an empty phrase is a length complaint, not a crash", () => {
    const r = validatePhrase("", P);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("length");
  });
});

describe("phraseToEntropy", () => {
  test("throws a PhraseError rather than returning wrong bytes", () => {
    expect(() => phraseToEntropy("zoo zoo zoo", P)).toThrow(PhraseError);
    expect(() => phraseToEntropy("legal winner thank year wave sausages worth useful legal winner thank yellow", P)).toThrow(
      PhraseError,
    );
  });
});

describe("suggestWords", () => {
  test("completes from a prefix, in list order", () => {
    expect(suggestWords("aban")).toEqual(["abandon"]);
    expect(suggestWords("zo")).toEqual(["zone", "zoo"]);
  });

  test("is empty for a prefix no word has, and for the empty string", () => {
    expect(suggestWords("qqqq")).toEqual([]);
    expect(suggestWords("")).toEqual([]);
  });

  test("is case- and whitespace-insensitive, like the phrase itself", () => {
    expect(suggestWords("  ZO ")).toEqual(["zone", "zoo"]);
  });
});
