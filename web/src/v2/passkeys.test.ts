/**
 * The wire behaviour of the passkey list and remove calls.
 *
 * The two routes do not exist on the server yet, so these tests are the
 * contract: paths, method, bearer token, the URL-encoding of a base64 id, and
 * the refusal codes. When the Go side lands, its handler tests and these must
 * describe the same wire.
 */
import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "@ledger/client/net/client";

import { isLastPasskeyRefusal, listPasskeys, removePasskey } from "./passkeys";

const CLIENT = { sessionToken: "tok-1" };

function fetchAnswering(status: number, body: string) {
  // A 204 must carry a null body — the Response constructor refuses "".
  return vi.fn(async () => new Response(body === "" ? null : body, { status }));
}

describe("listPasskeys", () => {
  it("GETs /api/v1/auth/passkeys with the bearer token, and reads the five fields", async () => {
    const doFetch = fetchAnswering(
      200,
      JSON.stringify({
        passkeys: [
          {
            credential_id: "abc+/=",
            created_at: "2026-08-01T10:00:00Z",
            last_used_at: "2026-08-09T09:00:00Z",
            authenticator: "iCloud Keychain",
            current: true,
            // Key material must never be read, whatever the server sends.
            public_key: "SHOULD-NEVER-BE-READ",
          },
          { credential_id: "def", created_at: "2026-08-02T10:00:00Z" },
        ],
      }),
    );

    const rows = await listPasskeys({ client: CLIENT, fetch: doFetch });

    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/passkeys");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect(rows).toEqual([
      {
        credentialId: "abc+/=",
        createdAt: "2026-08-01T10:00:00Z",
        lastUsedAt: "2026-08-09T09:00:00Z",
        authenticator: "iCloud Keychain",
        current: true,
      },
      {
        credentialId: "def",
        createdAt: "2026-08-02T10:00:00Z",
        lastUsedAt: null,
        authenticator: null,
        current: false,
      },
    ]);
    // Not on the summary type, and not smuggled through either.
    expect(JSON.stringify(rows)).not.toContain("SHOULD-NEVER-BE-READ");
  });

  it("refuses without a session, before any request is made", async () => {
    const doFetch = vi.fn();
    await expect(listPasskeys({ client: { sessionToken: null }, fetch: doFetch })).rejects.toBeInstanceOf(ApiError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("throws an ApiError carrying the server's status and code", async () => {
    const doFetch = fetchAnswering(404, JSON.stringify({ error: "not_found" }));
    const err = await listPasskeys({ client: CLIENT, fetch: doFetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
  });

  it("wraps a transport failure as a NetworkError", async () => {
    const doFetch = vi.fn(async () => {
      throw new TypeError("failed to fetch");
    });
    await expect(listPasskeys({ client: CLIENT, fetch: doFetch })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("removePasskey", () => {
  it("DELETEs the credential with its id URL-encoded — base64's + and / would change the route", async () => {
    const doFetch = fetchAnswering(204, "");
    await removePasskey({ client: CLIENT, fetch: doFetch }, "ab+/cd==");
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/auth/passkeys/${encodeURIComponent("ab+/cd==")}`);
    expect(url).not.toContain("+");
    expect(url).not.toContain("=");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("surfaces the server's last-passkey refusal as its own recognisable code", async () => {
    const doFetch = fetchAnswering(409, JSON.stringify({ error: "last_passkey" }));
    const err = await removePasskey({ client: CLIENT, fetch: doFetch }, "abc").catch((e: unknown) => e);
    expect(isLastPasskeyRefusal(err)).toBe(true);
    // And nothing else reads as that refusal.
    expect(isLastPasskeyRefusal(new ApiError(409, "other", "", "x"))).toBe(false);
    expect(isLastPasskeyRefusal(new Error("last_passkey"))).toBe(false);
  });
});
