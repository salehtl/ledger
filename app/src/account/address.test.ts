/**
 * The address endpoints, and the statement a rotation signs.
 *
 * The signature is VERIFIED here with the same curve the server verifies with,
 * over a message rebuilt byte by byte from `addresses.RotationMessage`'s own
 * documented layout. Asserting that `rotateAddress` "produced a base64 string"
 * would pass for any 64 bytes; this fails unless the bytes are a real Ed25519
 * signature by the enrolled key over the exact statement Go will reconstruct.
 */

import { describe, expect, mock, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";

import { ApiError } from "@ledger/client/net/client.ts";
import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";

import { mayWipeLocalData } from "../auth/session.ts";
import { SECRET_WRITER_ID } from "../auth/keys.ts";
import { fromBase64, toBase64, utf8Encode } from "../platform/bytes.ts";
import { ed25519PublicKey } from "../platform/signing.ts";
import {
  addressSource,
  localPartOf,
  rotateAddress,
  rotationFailureCopy,
  rotationMessage,
} from "./address.ts";

const USER = "123e4567-e89b-42d3-a456-426614174000";
const SEED = new Uint8Array(32).fill(7);
const LOCAL = "k7qmz3x9r2w5t8v4n6p1c0abcd";
const ADDRESS = `${LOCAL}@in.example`;
const SERVER = "https://ledger.test";

function secrets(over: Record<string, string> = {}) {
  const values = new Map<string, string>([
    [SECRET_SESSION, "held"],
    [SECRET_WRITER_ID, "phone"],
    [`${SECRET_WRITER}phone`, toBase64(SEED)],
    ...Object.entries(over),
  ]);
  return { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string | null) => { if (v === null) values.delete(k); else values.set(k, v); } };
}

function server(answers: { status: number; body: unknown }[]) {
  const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  let call = 0;
  const fetch = async (request: Request): Promise<Response> => {
    const raw = await request.text();
    seen.push({
      url: request.url,
      method: request.method,
      auth: request.headers.get("authorization"),
      body: raw === "" ? null : JSON.parse(raw),
    });
    const a = answers[Math.min(call++, answers.length - 1)] as { status: number; body: unknown };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body } as unknown as Response;
  };
  return { seen, fetch };
}

const ADDRESS_BODY = { address: ADDRESS, created_at: "2026-08-05T00:00:00Z" };

// ---------------------------------------------------------------------------
// The signed statement
// ---------------------------------------------------------------------------

describe("rotationMessage", () => {
  /**
   * Rebuilt from the layout `addresses.go:659` documents, independently of the
   * implementation:
   *
   *   "ledger-v2-address-rotation" NUL nonce NUL userID NUL localPart
   */
  test("is byte-identical to the layout Go documents", () => {
    const nonce = new Uint8Array(32).map((_, i) => i);
    const want = new Uint8Array([
      ...utf8Encode("ledger-v2-address-rotation"),
      0,
      ...nonce,
      0,
      ...utf8Encode(USER),
      0,
      ...utf8Encode(LOCAL),
    ]);
    expect(Array.from(rotationMessage(nonce, USER, LOCAL))).toEqual(Array.from(want));
  });

  test("refuses a nonce that is not 32 bytes, a non-UUID and a full address", () => {
    const nonce = new Uint8Array(32);
    expect(() => rotationMessage(new Uint8Array(31), USER, LOCAL)).toThrow(/32/);
    expect(() => rotationMessage(nonce, "not-a-uuid", LOCAL)).toThrow(/UUID/);
    expect(() => rotationMessage(nonce, USER, ADDRESS)).toThrow(/local part/);
    expect(() => rotationMessage(nonce, USER, "")).toThrow(/local part/);
  });

  /** The three replays the binding closes, each shown to change the bytes. */
  test("binds the nonce, the account and the address being retired", () => {
    const a = rotationMessage(new Uint8Array(32).fill(1), USER, LOCAL);
    expect(Array.from(rotationMessage(new Uint8Array(32).fill(2), USER, LOCAL))).not.toEqual(Array.from(a));
    expect(Array.from(rotationMessage(new Uint8Array(32).fill(1), "223e4567-e89b-42d3-a456-426614174000", LOCAL))).not.toEqual(Array.from(a));
    expect(Array.from(rotationMessage(new Uint8Array(32).fill(1), USER, `${LOCAL}z`))).not.toEqual(Array.from(a));
  });
});

test("localPartOf splits at the last @ and refuses a bare name", () => {
  expect(localPartOf(ADDRESS)).toBe(LOCAL);
  expect(localPartOf("a@b@in.example")).toBe("a@b");
  expect(() => localPartOf("no-at-sign")).toThrow();
  expect(() => localPartOf("@in.example")).toThrow();
});

// ---------------------------------------------------------------------------
// GET /api/v1/address
// ---------------------------------------------------------------------------

describe("addressSource.current", () => {
  test("is one authenticated GET, and decodes the response", async () => {
    const s = server([{ status: 200, body: { ...ADDRESS_BODY, rotates_from: "old@in.example", grace_until: "2026-08-12T00:00:00Z" } }]);
    const got = await addressSource({ server: SERVER, token: () => "held", fetch: s.fetch }).current();
    expect(got.address).toBe(ADDRESS);
    expect(got.rotatesFrom).toBe("old@in.example");
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]?.method).toBe("GET");
    expect(s.seen[0]?.url).toBe(`${SERVER}/api/v1/address`);
    expect(s.seen[0]?.auth).toBe("Bearer held");
  });

  /**
   * The defect this consolidation fixed, measured through the predicate that
   * actually decides.
   *
   * The inline fetch this replaced threw an error with a hard-coded `code: ""`,
   * so `mayWipeLocalData` said false for a `410 account_deleted` and a device
   * whose account had been deleted elsewhere reported a fatal open with every
   * local row still on disk.
   */
  test("a 410 account_deleted carries the server's own code, so the wipe path can see it", async () => {
    const s = server([{ status: 410, body: { error: "account_deleted" } }]);
    const source = addressSource({ server: SERVER, token: () => "held", fetch: s.fetch });
    const error = await source.current().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(410);
    expect((error as ApiError).code).toBe("account_deleted");
    expect(mayWipeLocalData(error)).toBe(true);
  });

  test("a bare 401 is NOT a wipe", async () => {
    const s = server([{ status: 401, body: { error: "unauthorized" } }]);
    const error = await addressSource({ server: SERVER, token: () => "held", fetch: s.fetch }).current().then(() => null, (e: unknown) => e);
    expect((error as ApiError).status).toBe(401);
    expect(mayWipeLocalData(error)).toBe(false);
  });

  test("refuses to call at all without a session", async () => {
    const s = server([{ status: 200, body: ADDRESS_BODY }]);
    await expect(addressSource({ server: SERVER, token: () => null, fetch: s.fetch }).current()).rejects.toThrow(/not signed in/);
    expect(s.seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe("rotateAddress", () => {
  const authenticator = (seenNonces: string[]) => ({
    idp: "apple" as const,
    isAvailable: async () => true,
    authenticate: async (nonce: string) => { seenNonces.push(nonce); return { idToken: "fresh-id-token", email: null }; },
  });

  test("runs challenge then rotate, and signs the statement the server will rebuild", async () => {
    const nonce = new Uint8Array(32).map((_, i) => (i * 7) & 0xff);
    const s = server([
      { status: 200, body: ADDRESS_BODY },                       // current()
      { status: 200, body: { nonce: toBase64(nonce) } },          // challenge
      { status: 200, body: { address: "new@in.example", created_at: "2026-08-05T12:00:00Z", rotates_from: ADDRESS, grace_until: "2026-08-12T12:00:00Z" } },
    ]);
    const nonces: string[] = [];
    const got = await rotateAddress({
      server: SERVER, token: () => "held", fetch: s.fetch,
      userId: () => USER, secrets: secrets(), authenticator: authenticator(nonces),
    });

    expect(s.seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /api/v1/address",
      "POST /api/v1/address/challenge",
      "POST /api/v1/address/rotate",
    ]);

    // The provider was handed the server's own spelling of the nonce, verbatim.
    expect(nonces).toEqual([toBase64(nonce)]);

    const sent = s.seen[2]?.body as { idp: string; id_token: string; nonce: string; sig: string };
    expect(sent.idp).toBe("apple");
    expect(sent.id_token).toBe("fresh-id-token");
    expect(sent.nonce).toBe(toBase64(nonce));

    // The measurement that matters: a real signature by the enrolled key over
    // the statement built from the address BEING RETIRED.
    const verified = ed25519.verify(
      fromBase64(sent.sig),
      rotationMessage(nonce, USER, LOCAL),
      ed25519PublicKey(SEED),
    );
    expect(verified).toBe(true);

    // ...and it is not a signature over anything else.
    expect(ed25519.verify(fromBase64(sent.sig), rotationMessage(nonce, USER, "someone-else"), ed25519PublicKey(SEED))).toBe(false);

    expect(got.address).toBe("new@in.example");
    expect(got.rotatesFrom).toBe(ADDRESS);
    expect(got.graceUntil).toBe("2026-08-12T12:00:00Z");
  });

  test("signs over the address the server currently holds, not one it was told", async () => {
    const nonce = new Uint8Array(32).fill(3);
    const s = server([
      { status: 200, body: { address: "server-truth@in.example", created_at: "2026-08-05T00:00:00Z" } },
      { status: 200, body: { nonce: toBase64(nonce) } },
      { status: 200, body: ADDRESS_BODY },
    ]);
    await rotateAddress({
      server: SERVER, token: () => "held", fetch: s.fetch,
      userId: () => USER, secrets: secrets(), authenticator: authenticator([]),
    });
    const sent = s.seen[2]?.body as { sig: string };
    expect(ed25519.verify(fromBase64(sent.sig), rotationMessage(nonce, USER, "server-truth"), ed25519PublicKey(SEED))).toBe(true);
  });

  /**
   * No provider sheet appears when this device cannot finish the job. Asking
   * somebody to re-authenticate and then failing on a missing key is a worse
   * outcome than refusing up front.
   */
  test("refuses before touching the provider when the device key is missing", async () => {
    const s = server([{ status: 200, body: ADDRESS_BODY }]);
    const authenticate = mock(async (_nonce: string) => ({ idToken: "never", email: null }));
    const missing = secrets();
    missing.set(`${SECRET_WRITER}phone`, null);
    await expect(rotateAddress({
      server: SERVER, token: () => "held", fetch: s.fetch, userId: () => USER, secrets: missing,
      authenticator: { idp: "apple", isAvailable: async () => true, authenticate },
    })).rejects.toThrow(/signing key/);
    expect(authenticate).toHaveBeenCalledTimes(0);
    expect(s.seen).toHaveLength(0);
  });

  test("refuses a challenge nonce that is not 32 bytes", async () => {
    const s = server([
      { status: 200, body: ADDRESS_BODY },
      { status: 200, body: { nonce: toBase64(new Uint8Array(16)) } },
    ]);
    await expect(rotateAddress({
      server: SERVER, token: () => "held", fetch: s.fetch, userId: () => USER,
      secrets: secrets(), authenticator: authenticator([]),
    })).rejects.toThrow(/32 bytes/);
  });

  test("a 403 stops before anything is claimed to have changed", async () => {
    const s = server([
      { status: 200, body: ADDRESS_BODY },
      { status: 200, body: { nonce: toBase64(new Uint8Array(32)) } },
      { status: 403, body: { error: "rotation_rejected" } },
    ]);
    const error = await rotateAddress({
      server: SERVER, token: () => "held", fetch: s.fetch, userId: () => USER,
      secrets: secrets(), authenticator: authenticator([]),
    }).then(() => null, (e: unknown) => e);
    expect((error as ApiError).code).toBe("rotation_rejected");
    expect(rotationFailureCopy(error)).toContain("was not changed");
  });
});

describe("rotationFailureCopy", () => {
  /**
   * Every arm says the address did not change, because that is the fact the
   * user needs and the one a partially-written message would fumble.
   */
  test("every failure says the address is unchanged", () => {
    const cases: unknown[] = [
      new ApiError(403, "rotation_rejected", "", "x"),
      new ApiError(429, "rate_limited", "", "x"),
      new ApiError(409, "no_address", "", "x"),
      new ApiError(503, "unavailable", "", "x"),
      new ApiError(401, "unauthorized", "", "x"),
      new Error("offline"),
    ];
    for (const c of cases) {
      const said = rotationFailureCopy(c).toLowerCase();
      expect({ c: String(c), unchanged: said.includes("not changed") || said.includes("unchanged") || said.includes("no address to change") }).toEqual({ c: String(c), unchanged: true });
    }
  });

  test("distinguishes the states a user can act on", () => {
    expect(rotationFailureCopy(new ApiError(429, "rate_limited", "", "x"))).toContain("wait a minute");
    expect(rotationFailureCopy(new ApiError(409, "no_address", "", "x"))).toContain("no address to change");
    expect(rotationFailureCopy(new ApiError(503, "unavailable", "", "x"))).toContain("provider is unavailable");
  });
});
