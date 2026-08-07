/**
 * Task 5: boot, passkey sign-up/sign-in, and the device-writer enrolment that
 * both of them must end with.
 *
 * The fake server below answers the six passkey routes with the exact JSON
 * `internal/v2/api/passkey.go` documents, plus the two writer-enrolment routes
 * whose wire fixtures are copied from `client/src/net/client.test.ts`
 * (`/api/v1/writers/challenge` answers `{nonce}`, `/api/v1/writers/register`
 * answers `204`, `GET /api/v1/writers` answers `{writers}`).
 *
 * `navigator.credentials` is stubbed rather than mocked away: the shapes it is
 * handed and the shapes it returns are the part of this task most likely to be
 * wrong, because the server speaks base64url and `webPlatform`'s base64 helpers
 * speak the standard alphabet.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  encodeAssertionCredential,
  encodeRegistrationCredential,
  fromBase64Url,
  initV2,
  isEnrollmentError,
  isPasskeyError,
  publicKeyCreationOptions,
  publicKeyRequestOptions,
  toBase64Url,
  type V2Handle,
} from "./session";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function u8(...v: number[]): Uint8Array {
  return new Uint8Array(v);
}

function buf(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(b);
  return out;
}

/** Standard base64, for the writer-enrolment nonce the fake server mints. */
function b64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

const USER_ID = "0f5e1c9a-4a2b-4d1e-9c3f-8a7b6c5d4e3f";

/** A byte string whose standard base64 contains both `+` and `/`. */
const AWKWARD = u8(0xfb, 0xff, 0xbf, 0x00, 0x10, 0x83);

interface FakeCredential {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string;
  response: Record<string, unknown>;
  getClientExtensionResults(): Record<string, unknown>;
}

function registrationCredential(): FakeCredential {
  return {
    id: toBase64Url(u8(1, 2, 3, 4)),
    rawId: buf(u8(1, 2, 3, 4)),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: buf(u8(0x7b, 0x7d)),
      attestationObject: buf(AWKWARD),
      getTransports: () => ["internal", "hybrid"],
    },
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
  };
}

function assertionCredential(): FakeCredential {
  return {
    id: toBase64Url(u8(1, 2, 3, 4)),
    rawId: buf(u8(1, 2, 3, 4)),
    type: "public-key",
    response: {
      clientDataJSON: buf(u8(0x7b, 0x7d)),
      authenticatorData: buf(u8(9, 9, 9)),
      signature: buf(AWKWARD),
      userHandle: buf(u8(5, 6, 7)),
    },
    getClientExtensionResults: () => ({}),
  };
}

class FakeCredentials {
  createOptions: PublicKeyCredentialCreationOptions[] = [];
  getOptions: PublicKeyCredentialRequestOptions[] = [];
  createResult: () => unknown = () => registrationCredential();
  getResult: () => unknown = () => assertionCredential();

  async create(opts: CredentialCreationOptions): Promise<unknown> {
    this.createOptions.push(opts.publicKey as PublicKeyCredentialCreationOptions);
    return this.createResult();
  }

  async get(opts: CredentialRequestOptions): Promise<unknown> {
    this.getOptions.push(opts.publicKey as PublicKeyCredentialRequestOptions);
    return this.getResult();
  }
}

interface RosterRow {
  writer_id: string;
  kind: string;
  revoked_at: string | null;
  pubkey: string;
}

class FakeServer {
  invite = "GOODCODE";
  writers: RosterRow[] = [];
  /** Bodies posted to the two `finish` routes, for shape assertions. */
  finished: Record<string, unknown>[] = [];
  registerBegins = 0;
  loginBegins = 0;

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    const json = (v: unknown, status = 200): Response =>
      new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

    switch (url.pathname) {
      case "/api/v1/auth/passkey/register/begin": {
        this.registerBegins++;
        if (body["invite_code"] !== this.invite) return json({ error: "not_invited" }, 403);
        return json({ ceremony_id: "ceremony-reg", options: this.creationOptions() });
      }
      case "/api/v1/auth/passkey/register/finish":
        this.finished.push(body);
        return json({ session_token: "session-signup", user_id: USER_ID });
      case "/api/v1/auth/passkey/login/begin":
        this.loginBegins++;
        return json({ ceremony_id: "ceremony-login", options: this.requestOptions() });
      case "/api/v1/auth/passkey/login/finish":
        this.finished.push(body);
        return json({ session_token: "session-signin", user_id: USER_ID });
      case "/api/v1/writers/challenge":
        return json({ nonce: b64(new Uint8Array(32).fill(7)) });
      case "/api/v1/writers/register": {
        const id = String(body["writer_id"]);
        if (this.writers.some((w) => w.writer_id === id)) return json({ error: "registration_rejected" }, 403);
        this.writers.push({ writer_id: id, kind: "device", revoked_at: null, pubkey: String(body["pubkey"]) });
        return new Response(null, { status: 204 });
      }
      case "/api/v1/writers":
        return json({ writers: this.writers });
      default:
        return json({ error: "not_found" }, 404);
    }
  };

  /** go-webauthn's `protocol.CredentialCreation`, base64url throughout. */
  creationOptions(): unknown {
    return {
      publicKey: {
        challenge: toBase64Url(AWKWARD),
        rp: { id: "ledger.test", name: "ledger" },
        user: { id: toBase64Url(u8(0xff, 0xee, 0xdd)), name: "", displayName: "" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        timeout: 300000,
        excludeCredentials: [{ type: "public-key", id: toBase64Url(u8(1, 2, 3, 4)) }],
      },
    };
  }

  /** go-webauthn's `protocol.CredentialAssertion`. No user, no username. */
  requestOptions(): unknown {
    return {
      publicKey: {
        challenge: toBase64Url(AWKWARD),
        timeout: 300000,
        rpId: "ledger.test",
        allowCredentials: [],
        userVerification: "preferred",
      },
    };
  }
}

let n = 0;
function open(server: FakeServer, creds: FakeCredentials, name: string): Promise<V2Handle> {
  return initV2("https://ledger.test", { name, fetch: server.fetch, credentials: creds as unknown as CredentialsContainer });
}

function freshName(): string {
  n++;
  return `session-test-${n}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------

describe("base64url", () => {
  it("round-trips bytes whose standard base64 contains + and /", () => {
    const url = toBase64Url(AWKWARD);
    expect(url).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(url))).toEqual(Array.from(AWKWARD));
  });

  it("strips padding and accepts an unpadded input back", () => {
    expect(toBase64Url(u8(1))).toBe("AQ");
    expect(Array.from(fromBase64Url("AQ"))).toEqual([1]);
    expect(Array.from(fromBase64Url(""))).toEqual([]);
  });

  it("refuses the standard alphabet and impossible lengths", () => {
    expect(() => fromBase64Url("+/++")).toThrow(/base64url/);
    expect(() => fromBase64Url("AQ==")).toThrow(/base64url/);
    expect(() => fromBase64Url("AQAAA")).toThrow(/base64url/);
  });
});

describe("WebAuthn option and credential shaping", () => {
  it("decodes every base64url field of a creation options blob into bytes", () => {
    const opts = publicKeyCreationOptions(new FakeServer().creationOptions());
    expect(Array.from(new Uint8Array(opts.challenge as ArrayBuffer))).toEqual(Array.from(AWKWARD));
    expect(Array.from(new Uint8Array(opts.user.id as ArrayBuffer))).toEqual([0xff, 0xee, 0xdd]);
    expect(Array.from(new Uint8Array(opts.excludeCredentials![0]!.id as ArrayBuffer))).toEqual([1, 2, 3, 4]);
    // Everything else survives untouched.
    expect(opts.rp).toEqual({ id: "ledger.test", name: "ledger" });
    expect(opts.timeout).toBe(300000);
  });

  it("decodes assertion options and never invents a user or a username", () => {
    const opts = publicKeyRequestOptions(new FakeServer().requestOptions());
    expect(Array.from(new Uint8Array(opts.challenge as ArrayBuffer))).toEqual(Array.from(AWKWARD));
    expect(opts.rpId).toBe("ledger.test");
    expect(Object.keys(opts)).not.toContain("user");
  });

  it("encodes a registration credential as base64url JSON", () => {
    const out = encodeRegistrationCredential(registrationCredential() as unknown as PublicKeyCredential);
    expect(out).toEqual({
      id: toBase64Url(u8(1, 2, 3, 4)),
      rawId: "AQIDBA",
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: toBase64Url(u8(0x7b, 0x7d)),
        attestationObject: toBase64Url(AWKWARD),
        transports: ["internal", "hybrid"],
      },
    });
  });

  it("encodes an assertion credential, carrying the discoverable user handle", () => {
    const out = encodeAssertionCredential(assertionCredential() as unknown as PublicKeyCredential);
    expect(out["response"]).toEqual({
      clientDataJSON: toBase64Url(u8(0x7b, 0x7d)),
      authenticatorData: toBase64Url(u8(9, 9, 9)),
      signature: toBase64Url(AWKWARD),
      userHandle: toBase64Url(u8(5, 6, 7)),
    });
  });
});

describe("signUp", () => {
  let server: FakeServer;
  let creds: FakeCredentials;

  beforeEach(() => {
    server = new FakeServer();
    creds = new FakeCredentials();
  });

  it("signs in AND enrols this device as a writer", async () => {
    const handle = await open(server, creds, freshName());
    expect(handle.signedIn()).toBe(false);

    await handle.signUp("GOODCODE");

    expect(handle.signedIn()).toBe(true);
    // The exact regression from 8365532: this getter is what every write path
    // reads, and it throws when no writer is enrolled.
    expect(() => handle.client.writerId).not.toThrow();
    expect(handle.client.writerId).toMatch(/^web-/);
    expect(server.writers).toHaveLength(1);
    expect(server.writers[0]!.writer_id).toBe(handle.client.writerId);
    handle.close();
  });

  it("posts the ceremony id and the browser's credential to finish", async () => {
    const handle = await open(server, creds, freshName());
    await handle.signUp("GOODCODE");
    const finish = server.finished[0]!;
    expect(finish["ceremony_id"]).toBe("ceremony-reg");
    expect((finish["credential"] as Record<string, unknown>)["rawId"]).toBe("AQIDBA");
    // The challenge reached the authenticator as bytes, not as a string.
    expect(Array.from(new Uint8Array(creds.createOptions[0]!.challenge as ArrayBuffer))).toEqual(Array.from(AWKWARD));
    handle.close();
  });

  it("survives a re-initV2 against the same driver name, without re-registering", async () => {
    const name = freshName();
    const first = await open(server, creds, name);
    await first.signUp("GOODCODE");
    const writerId = first.client.writerId;
    await first.driver.flush();
    first.close();

    const second = await open(server, creds, name);
    expect(second.signedIn()).toBe(true);
    expect(second.client.writerId).toBe(writerId);
    // The fast path: no second row on an append-only roster.
    expect(server.writers).toHaveLength(1);
    second.close();
  });

  it("surfaces 403 not_invited as a typed error the UI can branch on", async () => {
    const handle = await open(server, creds, freshName());
    const err = await handle.signUp("WRONG").then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPasskeyError(err)).toBe(true);
    expect((err as { passkeyKind: string }).passkeyKind).toBe("not_invited");
    expect((err as { status?: number }).status).toBe(403);
    expect(handle.signedIn()).toBe(false);
    // Nothing was asked of the authenticator: the refusal is about the invite.
    expect(creds.createOptions).toHaveLength(0);
    handle.close();
  });

  it("reports a dismissed system prompt as cancelled, not as a failure", async () => {
    creds.createResult = () => {
      throw Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    };
    const handle = await open(server, creds, freshName());
    const err = await handle.signUp("GOODCODE").then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { passkeyKind: string }).passkeyKind).toBe("cancelled");
    handle.close();
  });

  it("reports an enrolment failure as its own kind, not as a sign-in failure", async () => {
    // The passkey ceremony succeeds; the writer challenge that enrolment needs
    // is rate limited.
    const refusing: typeof fetch = async (input, init) =>
      new URL(String(input)).pathname === "/api/v1/writers/challenge"
        ? new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 })
        : server.fetch(input, init);
    const handle = await initV2("https://ledger.test", {
      name: freshName(),
      fetch: refusing,
      credentials: creds as unknown as CredentialsContainer,
    });
    const err = await handle.signUp("GOODCODE").then(
      () => null,
      (e: unknown) => e,
    );
    expect(isEnrollmentError(err)).toBe(true);
    expect((err as { enrollmentKind?: string }).enrollmentKind).toBe("rate_limited");
    // The session DID land, which is why enrolment gets its own error kind: a
    // user told "sign-in failed" after a successful sign-in has been told
    // something false.
    expect(handle.signedIn()).toBe(true);
    expect(() => handle.client.writerId).toThrow(/not set up to make changes yet/);
    handle.close();
  });
});

describe("signIn", () => {
  it("is username-less and still ends with the writer enrolled", async () => {
    const server = new FakeServer();
    const creds = new FakeCredentials();
    const handle = await open(server, creds, freshName());

    await handle.signIn();

    expect(server.loginBegins).toBe(1);
    // Nothing about the request named a user.
    expect(JSON.stringify(server.finished[0])).not.toContain("username");
    expect(handle.signedIn()).toBe(true);
    expect(() => handle.client.writerId).not.toThrow();
    expect(server.writers).toHaveLength(1);
    handle.close();
  });
});

describe("signOut", () => {
  it("drops the session and leaves the writer key alone", async () => {
    const name = freshName();
    const server = new FakeServer();
    const creds = new FakeCredentials();
    const handle = await open(server, creds, name);
    await handle.signUp("GOODCODE");
    const writerId = handle.client.writerId;

    await handle.signOut();
    expect(handle.signedIn()).toBe(false);

    await handle.signIn();
    expect(handle.signedIn()).toBe(true);
    expect(handle.client.writerId).toBe(writerId);
    expect(server.writers).toHaveLength(1);
    handle.close();
  });
});
