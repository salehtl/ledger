/**
 * Passkey unlock, end to end against a fake authenticator.
 *
 * The properties under test are the ones that decide whether somebody is locked
 * out: enrolment stores a wrap that later opens the SAME keys the phrase opens,
 * the PRF secret never reaches the server, and every refusal — no PRF, no wrap,
 * a wrap that no longer opens — leaves the account reachable by phrase.
 *
 * What this cannot test is the assumption the whole feature rests on: that a
 * REAL authenticator returns the SAME PRF output across sessions and across the
 * create → get transition. The fake here is stable by construction. Only the
 * operator's own device can confirm that.
 */

import { describe, expect, test, vi } from "vitest";
import { generateAccountKeys, wrapAccountKeys, type AccountKeys } from "@ledger/client/crypto/keys";
import { PRF_EVAL_SALT } from "@ledger/client/crypto/prf";
import { webPlatform } from "@ledger/client/platform.web";

import { memoryKeyVault, type PublishedKeys } from "./keys";
import { enrolPrfUnlock, forgetPrfUnlock, isPrfError, prfAvailability, unlockWithPrf } from "./prf";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const FAST = { t: 1, m: 64, p: 1 } as const;
const CRED = new Uint8Array([1, 2, 3, 4]);

const buf = (b: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(b);
  return out;
};

/** A published account: a real phrase wrap over a real key set. */
async function publish(): Promise<{ keys: AccountKeys; published: PublishedKeys }> {
  const keys = generateAccountKeys(webPlatform);
  const ingestPub = Uint8Array.from(keys.ingestPub);
  const recoveryPub = Uint8Array.from(keys.recoveryPub);
  const wrapped = await wrapAccountKeys(PHRASE, keys, webPlatform, FAST);
  return { keys, published: { ingestPub, recoveryPub, wrapped, keyVersion: 1 } };
}

/**
 * An authenticator whose PRF output is a fixed function of the credential id
 * and the salt — stable across ceremonies, which is exactly the property a real
 * one has to have and only real hardware can prove.
 */
class FakeAuthenticator {
  prfEnabled = true;
  returnsOutput = true;
  secret = 0x5a;
  lastGetOptions: PublicKeyCredentialRequestOptions | null = null;

  output(credentialId: Uint8Array): Uint8Array {
    const seed = new Uint8Array(credentialId.length + PRF_EVAL_SALT.length + 1);
    seed.set(credentialId, 0);
    seed.set(PRF_EVAL_SALT, credentialId.length);
    seed[seed.length - 1] = this.secret;
    return webPlatform.sha256(seed);
  }

  container(): CredentialsContainer {
    return {
      create: async (options?: CredentialCreationOptions) => {
        const extensions = (options?.publicKey as { extensions?: Record<string, unknown> } | undefined)?.extensions;
        return {
          id: "cred",
          rawId: buf(CRED),
          type: "public-key",
          response: {
            clientDataJSON: buf(new Uint8Array([0x7b, 0x7d])),
            attestationObject: buf(new Uint8Array([1])),
          },
          // A real authenticator reports `enabled` only when it was asked, and
          // this fake refuses to pretend otherwise.
          getClientExtensionResults: () =>
            extensions !== undefined && "prf" in extensions ? { prf: { enabled: this.prfEnabled } } : {},
        } as unknown as Credential;
      },
      get: async (options?: CredentialRequestOptions) => {
        this.lastGetOptions = (options?.publicKey ?? null) as PublicKeyCredentialRequestOptions | null;
        return {
          id: "cred",
          rawId: buf(CRED),
          type: "public-key",
          response: {
            clientDataJSON: buf(new Uint8Array([0x7b, 0x7d])),
            authenticatorData: buf(new Uint8Array([9])),
            signature: buf(new Uint8Array([9])),
            userHandle: null,
          },
          getClientExtensionResults: () =>
            this.returnsOutput ? { prf: { results: { first: buf(this.output(CRED)) } } } : { prf: {} },
        } as unknown as Credential;
      },
    } as unknown as CredentialsContainer;
  }
}

/** The two add-passkey routes and the three wrap routes, over an in-memory store. */
class FakeServer {
  wraps = new Map<string, { wrapped: string; wrap_version: number }>();
  bodies: { path: string; body: string }[] = [];

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    this.bodies.push({ path, body });
    const json = (status: number, value: unknown): Response =>
      new Response(status === 204 ? null : JSON.stringify(value), {
        status,
        ...(status === 204 ? {} : { headers: { "Content-Type": "application/json" } }),
      });

    if (path.endsWith("/auth/passkey/add/begin")) {
      return json(200, {
        ceremony_id: "ceremony",
        options: { publicKey: { challenge: "AQID", rp: { id: "ledger.test" }, user: { id: "AQID", name: "a" } } },
      });
    }
    if (path.endsWith("/auth/passkey/add/finish")) {
      return json(200, { credential_id: webPlatform.toBase64(CRED) });
    }
    if (path.endsWith("/api/v1/keys/wraps")) {
      if (init?.method === "POST") {
        const parsed = JSON.parse(body) as { credential_id: string; wrapped: string; wrap_version: number };
        this.wraps.set(parsed.credential_id, { wrapped: parsed.wrapped, wrap_version: parsed.wrap_version });
        return json(204, null);
      }
      if (init?.method === "DELETE") {
        this.wraps.delete((JSON.parse(body) as { credential_id: string }).credential_id);
        return json(204, null);
      }
      return json(200, {
        wraps: [...this.wraps].map(([credential_id, w]) => ({
          credential_id,
          wrapped: w.wrapped,
          wrap_version: w.wrap_version,
          created_at: "2026-08-09T00:00:00Z",
        })),
      });
    }
    return json(404, { error: "not_found" });
  };
}

function deps(server: FakeServer, auth: FakeAuthenticator) {
  return { client: { sessionToken: "session" }, fetch: server.fetch, credentials: auth.container() };
}

describe("prfAvailability", () => {
  test("a credentials container that cannot run a ceremony is unsupported", async () => {
    expect(await prfAvailability({ credentials: {} as CredentialsContainer })).toBe("unsupported");
    expect(await prfAvailability({ credentials: { create: () => undefined } as unknown as CredentialsContainer })).toBe(
      "unsupported",
    );
  });

  test("a browser that says it has no PRF extension is believed", async () => {
    const pk = { getClientCapabilities: async () => ({ "extension:prf": false }) };
    vi.stubGlobal("PublicKeyCredential", pk);
    try {
      expect(await prfAvailability({ credentials: new FakeAuthenticator().container() })).toBe("unsupported");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Never a promise made in advance: a browser with the extension still tells
  // us nothing about the authenticator the person will pick.
  test("a browser that says it has the extension is still only unknown", async () => {
    const pk = { getClientCapabilities: async () => ({ "extension:prf": true }) };
    vi.stubGlobal("PublicKeyCredential", pk);
    try {
      expect(await prfAvailability({ credentials: new FakeAuthenticator().container() })).toBe("unknown");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("enrol then unlock", () => {
  test("the unlocked keys are the keys the phrase publishes", async () => {
    const { published } = await publish();
    const server = new FakeServer();
    const auth = new FakeAuthenticator();

    const enrolled = await enrolPrfUnlock({ deps: deps(server, auth), published, phrase: PHRASE });
    expect(webPlatform.toHex(enrolled.credentialId)).toBe(webPlatform.toHex(CRED));
    expect(server.wraps.size).toBe(1);

    const vault = memoryKeyVault();
    const stored = await unlockWithPrf({ deps: deps(server, auth), accountId: ACCOUNT, published, vault });
    expect(stored).not.toBeNull();
    // The check that matters: the ingest key this device now holds is the one
    // the account published, so mail sealed to it is readable here.
    expect(webPlatform.toHex(stored!.ingestPub)).toBe(webPlatform.toHex(published.ingestPub));
    expect((await vault.read())?.accountId).toBe(ACCOUNT);
  });

  // The secret that opens the account must never be uploaded. It travels
  // nowhere: not in the add ceremony, not with the wrap.
  test("the PRF output never reaches the server", async () => {
    const { published } = await publish();
    const server = new FakeServer();
    const auth = new FakeAuthenticator();
    await enrolPrfUnlock({ deps: deps(server, auth), published, phrase: PHRASE });

    const secret = webPlatform.toBase64(auth.output(CRED));
    const secretHex = webPlatform.toHex(auth.output(CRED));
    for (const sent of server.bodies) {
      expect(sent.body).not.toContain(secret);
      expect(sent.body).not.toContain(secretHex);
      expect(sent.body).not.toContain("prf");
    }
  });

  test("the assertion asks only for the enrolled credential, with the fixed salt", async () => {
    const { published } = await publish();
    const server = new FakeServer();
    const auth = new FakeAuthenticator();
    await enrolPrfUnlock({ deps: deps(server, auth), published, phrase: PHRASE });

    const opts = auth.lastGetOptions!;
    expect(opts.allowCredentials?.length).toBe(1);
    const asked = new Uint8Array(opts.allowCredentials![0]!.id as ArrayBuffer);
    expect(webPlatform.toHex(asked)).toBe(webPlatform.toHex(CRED));
    const salt = new Uint8Array(
      (opts.extensions as unknown as { prf: { eval: { first: ArrayBuffer } } }).prf.eval.first,
    );
    expect(webPlatform.toHex(salt)).toBe(webPlatform.toHex(PRF_EVAL_SALT));
  });

  test("a wrong phrase enrols nothing", async () => {
    const { published } = await publish();
    const server = new FakeServer();
    const auth = new FakeAuthenticator();
    await expect(
      enrolPrfUnlock({
        deps: deps(server, auth),
        published,
        phrase: "legal winner thank year wave sausage worth useful legal winner thank zoo",
      }),
    ).rejects.toThrow();
    expect(server.wraps.size).toBe(0);
    expect(server.bodies.length).toBe(0);
  });

  test("an authenticator without PRF is refused, and stores nothing", async () => {
    const { published } = await publish();
    const server = new FakeServer();
    const auth = new FakeAuthenticator();
    auth.prfEnabled = false;
    const err = await enrolPrfUnlock({ deps: deps(server, auth), published, phrase: PHRASE }).catch((e: unknown) => e);
    expect(isPrfError(err) && err.prfKind).toBe("no_prf");
    expect(server.wraps.size).toBe(0);
  });
});

describe("unlock refusals all end at the recovery phrase", () => {
  test("an account with no wraps is null, not an error", async () => {
    const { published } = await publish();
    const server = new FakeServer();
    const stored = await unlockWithPrf({
      deps: deps(server, new FakeAuthenticator()),
      accountId: ACCOUNT,
      published,
      vault: memoryKeyVault(),
    });
    expect(stored).toBeNull();
  });

  test("an authenticator that returns no output is a refusal", async () => {
    const { published } = await publish();
    const server = new FakeServer();
    const auth = new FakeAuthenticator();
    await enrolPrfUnlock({ deps: deps(server, auth), published, phrase: PHRASE });

    auth.returnsOutput = false;
    const err = await unlockWithPrf({
      deps: deps(server, auth),
      accountId: ACCOUNT,
      published,
      vault: memoryKeyVault(),
    }).catch((e: unknown) => e);
    expect(isPrfError(err) && err.prfKind).toBe("no_prf");
  });

  // An authenticator whose PRF secret changed — an OS update, a reset key. The
  // wrap can never open again, so it is removed rather than offered forever.
  test("a wrap that no longer opens is deleted", async () => {
    const { published } = await publish();
    const server = new FakeServer();
    const auth = new FakeAuthenticator();
    await enrolPrfUnlock({ deps: deps(server, auth), published, phrase: PHRASE });
    expect(server.wraps.size).toBe(1);

    auth.secret = 0x0b; // the same credential, a different PRF secret
    const err = await unlockWithPrf({
      deps: deps(server, auth),
      accountId: ACCOUNT,
      published,
      vault: memoryKeyVault(),
    }).catch((e: unknown) => e);
    expect(isPrfError(err) && err.prfKind).toBe("wrap_dead");
    expect(server.wraps.size).toBe(0);
  });
});

test("forgetting an unlock removes the wrap and nothing else", async () => {
  const { published } = await publish();
  const server = new FakeServer();
  const auth = new FakeAuthenticator();
  await enrolPrfUnlock({ deps: deps(server, auth), published, phrase: PHRASE });
  await forgetPrfUnlock(deps(server, auth), CRED);
  expect(server.wraps.size).toBe(0);
});
