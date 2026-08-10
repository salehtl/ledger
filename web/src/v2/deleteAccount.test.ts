/**
 * The three-factor deletion ceremony.
 *
 * The property under test is not "a DELETE was sent". It is that the bytes this
 * module produces are the ones `internal/v2/api/account.go` accepts:
 *
 *  - the assertion is over the challenge the SERVER minted, not one this module
 *    chose, because that binding is the whole of factor 2;
 *  - the Ed25519 signature verifies against the device's public key over
 *    exactly `purge.DeletionMessage(nonce, user_id)`, because a signature over
 *    anything else is a bodyless 403 nobody can debug.
 */

import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

import { deleteAccount, deletionMessage } from "./deleteAccount";
import { fromBase64Url, isPasskeyError, toBase64Url } from "./session";
import { webPlatform } from "@ledger/client/platform.web";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const WRITER = "device-1";
const NONCE = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

function keypair() {
  const { priv, pub } = webPlatform.ed25519GenerateKey();
  return { priv, pub };
}

/** A browser authenticator that records the challenge and rpId it was handed. */
function credentialsThatRecord(seen: { challenge: Uint8Array | null; rpId?: string }): CredentialsContainer {
  return {
    get: vi.fn(async (opts?: CredentialRequestOptions) => {
      const pk = opts?.publicKey;
      seen.challenge = new Uint8Array(pk?.challenge as ArrayBuffer);
      seen.rpId = pk?.rpId;
      return {
        id: "cred",
        rawId: new Uint8Array([1, 2, 3]).buffer,
        type: "public-key",
        getClientExtensionResults: () => ({}),
        response: {
          clientDataJSON: new Uint8Array([4]).buffer,
          authenticatorData: new Uint8Array([5]).buffer,
          signature: new Uint8Array([6]).buffer,
          userHandle: new Uint8Array([7]).buffer,
        },
      } as unknown as Credential;
    }),
  } as unknown as CredentialsContainer;
}

describe("deleteAccount", () => {
  it("signs the server's own challenge with the passkey and the device key", async () => {
    const { priv, pub } = keypair();
    const sent: { path: string; body: Record<string, unknown> }[] = [];
    const doFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      sent.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (path.endsWith("/api/v1/account/challenge")) {
        return new Response(JSON.stringify({ nonce: webPlatform.toBase64(NONCE) }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const seen = { challenge: null as Uint8Array | null };

    await deleteAccount({
      client: { sessionToken: "session", userId: ACCOUNT, writerId: WRITER },
      secrets: { get: (k) => (k === `writer_key:${WRITER}` ? toBase64Url(priv) : null) },
      fetch: doFetch as unknown as typeof fetch,
      credentials: credentialsThatRecord(seen),
    });

    // Factor 2 is bound to the SERVER's nonce. A module that minted its own
    // challenge would pass every other assertion in this file.
    expect(seen.challenge).not.toBeNull();
    expect(Array.from(seen.challenge!)).toEqual(Array.from(NONCE));

    const del = sent.find((r) => r.path.endsWith("/api/v1/account"));
    expect(del).toBeDefined();
    expect(del!.body["nonce"]).toBe(webPlatform.toBase64(NONCE));
    expect(del!.body["assertion"]).toMatchObject({ id: "cred", type: "public-key" });

    // Factor 3, verified the way the server verifies it.
    const sig = webPlatform.fromBase64(String(del!.body["sig"]));
    expect(ed25519.verify(sig, deletionMessage(NONCE, ACCOUNT), pub)).toBe(true);
    // And not over anything else: a domain-free or user-free message must not
    // verify, or the signature would be replayable into another flow.
    expect(ed25519.verify(sig, NONCE, pub)).toBe(false);
  });

  // The bug the operator hit: the assertion must target the account's OWN
  // relying-party id (the parent domain), not the app origin. With no rpId the
  // browser finds no credential under the origin and offers to CREATE a passkey
  // instead of asserting with one. The server carries rp_id in the challenge;
  // this proves it reaches the get() call.
  it("asserts against the relying-party id the challenge carries, not the app origin", async () => {
    const { priv } = keypair();
    const doFetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/v1/account/challenge")) {
        return new Response(JSON.stringify({ nonce: webPlatform.toBase64(NONCE), rp_id: "sirdab.ae" }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    });
    const seen = { challenge: null as Uint8Array | null, rpId: undefined as string | undefined };

    await deleteAccount({
      client: { sessionToken: "session", userId: ACCOUNT, writerId: WRITER },
      secrets: { get: (k) => (k === `writer_key:${WRITER}` ? toBase64Url(priv) : null) },
      fetch: doFetch as unknown as typeof fetch,
      credentials: credentialsThatRecord(seen),
    });

    expect(seen.rpId).toBe("sirdab.ae");
  });

  it("never asks for a passkey when this device holds no writer key", async () => {
    const doFetch = vi.fn();
    const seen = { challenge: null as Uint8Array | null };
    const credentials = credentialsThatRecord(seen);

    await expect(
      deleteAccount({
        client: { sessionToken: "session", userId: ACCOUNT, writerId: WRITER },
        secrets: { get: () => null },
        fetch: doFetch as unknown as typeof fetch,
        credentials,
      }),
    ).rejects.toSatisfy(isPasskeyError);
    expect(doFetch).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it("reports the server's one refusal as a rejection, not as a server fault", async () => {
    const { priv } = keypair();
    const doFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/v1/account/challenge")) {
        return new Response(JSON.stringify({ nonce: webPlatform.toBase64(NONCE) }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "deletion_rejected" }), { status: 403 });
    });

    const err = await deleteAccount({
      client: { sessionToken: "session", userId: ACCOUNT, writerId: WRITER },
      secrets: { get: () => toBase64Url(priv) },
      fetch: doFetch as unknown as typeof fetch,
      credentials: credentialsThatRecord({ challenge: null }),
    }).catch((e: unknown) => e);

    expect(isPasskeyError(err)).toBe(true);
    expect(isPasskeyError(err) ? err.passkeyKind : "").toBe("rejected");
  });

  it("builds the message the Go side builds", () => {
    const msg = deletionMessage(NONCE, ACCOUNT);
    const domain = webPlatform.utf8Encode("ledger/v2 account-delete\0");
    expect(msg.length).toBe(domain.length + 32 + 1 + 36);
    expect(Array.from(msg.slice(0, domain.length))).toEqual(Array.from(domain));
    expect(Array.from(msg.slice(domain.length, domain.length + 32))).toEqual(Array.from(NONCE));
    expect(msg[domain.length + 32]).toBe(0);
    expect(new TextDecoder().decode(msg.slice(domain.length + 33))).toBe(ACCOUNT);
  });
});

// Kept honest: the helper above must produce a real key, or the signature
// assertions would be checking zeroes against zeroes.
describe("fixtures", () => {
  it("uses a real Ed25519 key", () => {
    const { priv, pub } = keypair();
    expect(priv.length).toBe(32);
    expect(fromBase64Url(toBase64Url(priv)).length).toBe(32);
    expect(pub.length).toBe(32);
  });
});
