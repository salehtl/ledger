/**
 * Turning passkey unlock on and off.
 *
 * The property under test is not "the form submits". It is that the panel
 * stores a wrap only when a real ceremony produced a PRF output, that it never
 * says anything that would let somebody stop keeping their recovery phrase, and
 * that a browser without PRF is told so plainly instead of being offered a
 * button that cannot work.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PasskeyUnlockPanel, PASSKEY_UNLOCK_COPY } from "./PasskeyUnlockPanel";
import { MotionProvider } from "../../app/MotionProvider";
import { generateAccountKeys, wrapAccountKeys } from "@ledger/client/crypto/keys";
import { generatePhrase } from "@ledger/client/crypto/phrase";
import { PRF_EVAL_SALT } from "@ledger/client/crypto/prf";
import { webPlatform } from "@ledger/client/platform.web";

const FAST = { t: 1, m: 64, p: 1 } as const;
const CRED = new Uint8Array([9, 9, 9, 9]);

const buf = (b: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(b);
  return out;
};

async function account() {
  const phrase = generatePhrase(webPlatform);
  const keys = generateAccountKeys(webPlatform);
  const ingestPub = Uint8Array.from(keys.ingestPub);
  const recoveryPub = Uint8Array.from(keys.recoveryPub);
  const wrapped = await wrapAccountKeys(phrase, keys, webPlatform, FAST);
  return { phrase, ingestPub, recoveryPub, wrapped };
}

function authenticator(opts: { prfEnabled?: boolean } = {}): CredentialsContainer {
  const output = webPlatform.sha256(PRF_EVAL_SALT);
  return {
    create: async () =>
      ({
        id: "cred",
        rawId: buf(CRED),
        type: "public-key",
        response: { clientDataJSON: buf(new Uint8Array([0x7b])), attestationObject: buf(new Uint8Array([1])) },
        getClientExtensionResults: () => ({ prf: { enabled: opts.prfEnabled ?? true } }),
      }) as unknown as Credential,
    get: async () =>
      ({
        id: "cred",
        rawId: buf(CRED),
        type: "public-key",
        response: {
          clientDataJSON: buf(new Uint8Array([0x7b])),
          authenticatorData: buf(new Uint8Array([9])),
          signature: buf(new Uint8Array([9])),
          userHandle: null,
        },
        getClientExtensionResults: () => ({ prf: { results: { first: buf(output) } } }),
      }) as unknown as Credential,
  } as unknown as CredentialsContainer;
}

/** The routes the panel touches, over an in-memory wrap store. */
function server(a: Awaited<ReturnType<typeof account>>) {
  const wraps = new Map<string, unknown>();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const json = (status: number, body: unknown): Response =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        ...(status === 204 ? {} : { headers: { "Content-Type": "application/json" } }),
      });
    if (path.endsWith("/api/v1/keys/wraps")) {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { credential_id: string }) : null;
      if (init?.method === "POST") {
        wraps.set(body!.credential_id, JSON.parse(init.body as string));
        return json(204, null);
      }
      if (init?.method === "DELETE") {
        wraps.delete(body!.credential_id);
        return json(204, null);
      }
      return json(200, {
        wraps: [...wraps].map(([credential_id, w]) => ({
          credential_id,
          ...(w as object),
          created_at: "2026-08-09T00:00:00Z",
        })),
      });
    }
    if (path.endsWith("/api/v1/keys")) {
      return json(200, {
        ingest_pubkey: webPlatform.toBase64(a.ingestPub),
        recovery_pubkey: webPlatform.toBase64(a.recoveryPub),
        wrapped_keys: webPlatform.toBase64(a.wrapped),
        key_version: 1,
      });
    }
    if (path.endsWith("/auth/passkey/add/begin")) {
      return json(200, {
        ceremony_id: "ceremony",
        options: { publicKey: { challenge: "AQID", rp: { id: "ledger.test" }, user: { id: "AQID", name: "a" } } },
      });
    }
    if (path.endsWith("/auth/passkey/add/finish")) return json(200, { credential_id: webPlatform.toBase64(CRED) });
    return json(404, { error: "not_found" });
  });
  return { fetch, wraps };
}

const panel = (props: Partial<Parameters<typeof PasskeyUnlockPanel>[0]> = {}) =>
  render(
    <MotionProvider>
      <PasskeyUnlockPanel client={{ sessionToken: "session" }} {...props} />
    </MotionProvider>,
  );

describe("PasskeyUnlockPanel", () => {
  // The sentence that keeps this feature honest. It is on the panel before any
  // ceremony runs, not tucked behind a success message.
  it("says the recovery phrase is still needed, before anything is turned on", async () => {
    const a = await account();
    const s = server(a);
    panel({ fetch: s.fetch, credentials: authenticator() });
    expect(screen.getByText(PASSKEY_UNLOCK_COPY.phraseStays)).toBeTruthy();
    // And nothing anywhere offers to replace it.
    expect(screen.queryByText(/instead of your recovery phrase/i)).toBeNull();
    await waitFor(() => expect(s.fetch).toHaveBeenCalled());
  });

  it("warns about the two prompts before starting", async () => {
    const a = await account();
    const s = server(a);
    panel({ fetch: s.fetch, credentials: authenticator() });
    expect(screen.getByText(PASSKEY_UNLOCK_COPY.howItGoes)).toBeTruthy();
    await waitFor(() => expect(s.fetch).toHaveBeenCalled());
  });

  it("stores a wrap when the phrase and the authenticator both answer", async () => {
    const a = await account();
    const s = server(a);
    panel({ fetch: s.fetch, credentials: authenticator() });

    await userEvent.type(screen.getByTestId("passkey-unlock-phrase"), a.phrase);
    await userEvent.click(screen.getByRole("button", { name: PASSKEY_UNLOCK_COPY.turnOn }));

    await waitFor(() => expect(s.wraps.size).toBe(1));
    await screen.findByText(PASSKEY_UNLOCK_COPY.on);
    // The unlock secret is not in anything that was sent.
    const secret = webPlatform.toBase64(webPlatform.sha256(PRF_EVAL_SALT));
    for (const call of s.fetch.mock.calls) {
      expect(String(call[1]?.body ?? "")).not.toContain(secret);
    }
  });

  it("turning it off removes the wrap", async () => {
    const a = await account();
    const s = server(a);
    panel({ fetch: s.fetch, credentials: authenticator() });
    await userEvent.type(screen.getByTestId("passkey-unlock-phrase"), a.phrase);
    await userEvent.click(screen.getByRole("button", { name: PASSKEY_UNLOCK_COPY.turnOn }));
    await screen.findByText(PASSKEY_UNLOCK_COPY.on);

    await userEvent.click(screen.getByRole("button", { name: PASSKEY_UNLOCK_COPY.turnOff }));
    await waitFor(() => expect(s.wraps.size).toBe(0));
  });

  it("a wrong phrase stores nothing and never reaches the authenticator", async () => {
    const a = await account();
    const s = server(a);
    const creds = authenticator();
    const create = vi.spyOn(creds, "create");
    panel({ fetch: s.fetch, credentials: creds });

    await userEvent.type(screen.getByTestId("passkey-unlock-phrase"), "zoo zoo zoo");
    await userEvent.click(screen.getByRole("button", { name: PASSKEY_UNLOCK_COPY.turnOn }));

    await screen.findByRole("alert");
    expect(s.wraps.size).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("an authenticator without PRF is told so, and nothing is stored", async () => {
    const a = await account();
    const s = server(a);
    panel({ fetch: s.fetch, credentials: authenticator({ prfEnabled: false }) });

    await userEvent.type(screen.getByTestId("passkey-unlock-phrase"), a.phrase);
    await userEvent.click(screen.getByRole("button", { name: PASSKEY_UNLOCK_COPY.turnOn }));

    await screen.findByRole("alert");
    expect(s.wraps.size).toBe(0);
    expect(screen.queryByText(PASSKEY_UNLOCK_COPY.on)).toBeNull();
  });

  // A stubbed credentials container that cannot run a ceremony: the panel offers
  // no button it cannot honour.
  it("a browser without passkeys is told plainly", async () => {
    const a = await account();
    panel({ fetch: server(a).fetch, credentials: {} as CredentialsContainer });
    await screen.findByText(PASSKEY_UNLOCK_COPY.unsupported);
    expect(screen.queryByRole("button", { name: PASSKEY_UNLOCK_COPY.turnOn })).toBeNull();
  });
});
