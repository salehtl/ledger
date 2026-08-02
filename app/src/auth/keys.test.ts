import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { memSecretStore } from "@ledger/client/store/store.ts";
import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";

import {
  KEYCHAIN_ACCESSIBILITY,
  SECRET_WRITER_ID,
  ensureWriterId,
  isValidWriterId,
  keychainKeyFor,
  keychainNames,
} from "./keys.ts";

/** expo-secure-store/build/SecureStore.js:152, copied verbatim. */
const SECURE_STORE_KEY_RE = /^[\w.-]+$/;

describe("Keychain key escaping", () => {
  test("the name sqliteStore actually uses is illegal unescaped, and legal escaped", () => {
    // This is the whole reason the function exists: `SECRET_WRITER` ends in a
    // colon, expo-secure-store refuses a colon, and every other SecretStore in
    // the tree is a Map or a file — so nothing but a device would ever notice.
    const raw = `${SECRET_WRITER}01JQZ5X9WBTA0K7CQ0M4V2N6RS`;
    expect(SECURE_STORE_KEY_RE.test(raw)).toBe(false);
    expect(SECURE_STORE_KEY_RE.test(keychainKeyFor(raw))).toBe(true);
  });

  test("names that already are legal are still legal, and stable", () => {
    expect(keychainKeyFor(SECRET_SESSION)).toBe("session_5ftoken");
    expect(keychainKeyFor("a.b-c")).toBe("a.b-c");
    expect(keychainKeyFor(keychainKeyFor("a.b-c"))).toBe("a.b-c");
  });

  test("the escape is injective on the pairs a naive one collapses", () => {
    // `replace(/:/g, "_")` maps the first two onto one key, which is two
    // writers' private seeds in one Keychain slot: a silent key swap.
    const names = [
      "writer_key:X",
      "writer_key_X",
      "writer_key_5fX",
      "writer_key_3aX",
      "writer_key::X",
      "writer_key:x",
      "session_token",
      "session.token",
      "session-token",
      "wrïter",
      "writer🔑",
      " leading",
      "trailing ",
    ];
    const keys = names.map(keychainKeyFor);
    expect(new Set(keys).size).toBe(names.length);
    for (const k of keys) expect(SECURE_STORE_KEY_RE.test(k)).toBe(true);
  });

  test("an empty name is refused rather than producing an empty key", () => {
    // expo-secure-store refuses an empty key too, but with a message that says
    // nothing about which SecretStore name produced it.
    expect(() => keychainKeyFor("")).toThrow(/may not be empty/);
  });

  test("non-ASCII escapes per UTF-8 byte and stays distinct", () => {
    expect(keychainKeyFor("é")).toBe("_c3_a9");
    expect(keychainKeyFor("é")).not.toBe(keychainKeyFor("e"));
  });
});

describe("the accessibility class", () => {
  test("is WHEN_UNLOCKED_THIS_DEVICE_ONLY", () => {
    expect(KEYCHAIN_ACCESSIBILITY).toBe("WHEN_UNLOCKED_THIS_DEVICE_ONLY");
  });

  test("native.ts resolves the class through KEYCHAIN_ACCESSIBILITY and hard-codes none", () => {
    // `native.ts` imports expo-secure-store, so bun cannot load it — and a
    // constant chosen in a doc comment but not applied at the call site is
    // exactly the "written, never wired" shape. Reading the source is the
    // available measurement, and it is the same trick `host-globals.test.ts`
    // uses on files it cannot import.
    //
    // The computed access is deliberate and is itself a check: `SecureStore`'s
    // declarations make `SecureStore[KEYCHAIN_ACCESSIBILITY]` compile only if
    // that export really exists, so a typo in the name fails `bun run
    // typecheck` rather than reading back the SDK's default.
    const src = readFileSync(new URL("./native.ts", import.meta.url).pathname, "utf8");
    expect(src).toContain("SecureStore[KEYCHAIN_ACCESSIBILITY]");
    // Nothing hard-codes a class beside it. The default is `WHEN_UNLOCKED`,
    // which IS iCloud-backed, so a stray literal here is the exact thing spec
    // §3.4 forbids for the device identity key.
    const hardCoded = [...src.matchAll(/SecureStore\.(WHEN_[A-Z_]+|AFTER_[A-Z_]+|ALWAYS[A-Z_]*)/g)];
    expect(hardCoded.map((m) => m[0])).toEqual([]);
    // And the option is actually passed: a value written under one class and
    // read with a default is a value that reads back null on a locked device.
    expect(src).toContain("keychainAccessible");
    expect(KEYCHAIN_ACCESSIBILITY.endsWith("_THIS_DEVICE_ONLY")).toBe(true);
  });

  test("native.ts routes every Keychain name through keychainKeyFor", () => {
    const src = readFileSync(new URL("./native.ts", import.meta.url).pathname, "utf8");
    // Any SecureStore call whose first argument is not the escaped key is the
    // colon bug back again.
    for (const m of src.matchAll(/SecureStore\.(getItem|setItem|deleteItemAsync)\(([^,)]*)/g)) {
      expect(m[2]?.trim()).toBe("key");
    }
  });
});

describe("the writer id", () => {
  test("mints once, persists, and returns the same id forever after", () => {
    const secrets = memSecretStore();
    let minted = 0;
    const mint = () => `01JQZ5X9WBTA0K7CQ0M4V2N6R${minted++}`;
    const first = ensureWriterId(secrets, mint);
    expect(secrets.get(SECRET_WRITER_ID)).toBe(first);
    expect(ensureWriterId(secrets, mint)).toBe(first);
    expect(minted).toBe(1);
  });

  test("is written before it is returned", () => {
    // A writer id used to enrol and then lost to a crashed process is a writer
    // the server knows and this device can never sign for again.
    const secrets = memSecretStore();
    let seenDuringMint: string | null = "not read";
    ensureWriterId(secrets, () => {
      seenDuringMint = secrets.get(SECRET_WRITER_ID);
      return "W1";
    });
    expect(seenDuringMint).toBeNull();
    expect(secrets.get(SECRET_WRITER_ID)).toBe("W1");
  });

  test("a stored id the server would refuse is a refusal, not a silent re-mint", () => {
    const secrets = memSecretStore();
    secrets.set(SECRET_WRITER_ID, "not a legal id!");
    expect(() => ensureWriterId(secrets, () => "W2")).toThrow(/not a legal writer id/);
    // And it did not overwrite what was there — the enrolled writer is still
    // recoverable by hand.
    expect(secrets.get(SECRET_WRITER_ID)).toBe("not a legal id!");
  });

  test("an empty stored value mints rather than returning empty", () => {
    const secrets = memSecretStore();
    secrets.set(SECRET_WRITER_ID, "");
    expect(ensureWriterId(secrets, () => "W3")).toBe("W3");
  });

  test("a minted id that would be refused fails here rather than at registration", () => {
    expect(() => ensureWriterId(memSecretStore(), () => "")).toThrow(/not a legal writer id/);
    expect(() => ensureWriterId(memSecretStore(), () => "x".repeat(65))).toThrow(/not a legal writer id/);
  });

  test("isValidWriterId mirrors the CHECK constraint, both ways", () => {
    expect(isValidWriterId("01JQZ5X9WBTA0K7CQ0M4V2N6RS")).toBe(true);
    expect(isValidWriterId("a._-Z9")).toBe(true);
    expect(isValidWriterId("x".repeat(64))).toBe(true);
    expect(isValidWriterId("x".repeat(65))).toBe(false);
    expect(isValidWriterId("")).toBe(false);
    expect(isValidWriterId("has space")).toBe(false);
    expect(isValidWriterId("has:colon")).toBe(false);
    expect(isValidWriterId("emoji🔑")).toBe(false);
  });
});

describe("keychainNames", () => {
  test("covers the session, the writer id and every writer key", () => {
    expect(keychainNames(["W1", "W2"])).toEqual([
      SECRET_SESSION,
      SECRET_WRITER_ID,
      `${SECRET_WRITER}W1`,
      `${SECRET_WRITER}W2`,
    ]);
  });

  test("two writers, not one — a device that enrolled twice must clear both", () => {
    expect(keychainNames(["W1", "W2"]).filter((n) => n.startsWith(SECRET_WRITER))).toHaveLength(2);
  });
});
