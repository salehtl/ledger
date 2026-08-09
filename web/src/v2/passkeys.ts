/**
 * Listing and removing passkeys — the client half of
 * `docs/superpowers/specs/2026-08-09-passkey-management-design.md`.
 *
 * # ⚠ The two routes this calls DO NOT EXIST on the server yet
 *
 * `GET /api/v1/auth/passkeys` and `DELETE /api/v1/auth/passkeys/{id}` are the
 * spec's two new endpoints, owned by the Go side and unbuilt at the time of
 * writing. These functions are the real production path — they call the real
 * routes with the real bearer token — so until the server lands they answer
 * with a 404 `ApiError` and the screen shows its honest error state. Nothing
 * here fakes an answer.
 *
 * # The wire shape this module expects
 *
 * `GET /api/v1/auth/passkeys` → 200
 *
 *     { "passkeys": [ {
 *         "credential_id": "<standard base64, as PasskeyAddResponse sends it>",
 *         "created_at":    "<RFC3339>",
 *         "last_used_at":  "<RFC3339>" | null,
 *         "authenticator": "<AAGUID-derived name>" | null,
 *         "current":       true | false   // authenticated THIS session
 *     } ] }
 *
 * Per the spec it returns NO public key material, and this parser enforces its
 * side of that: only the five fields above are ever read, so a server that
 * mistakenly sent key bytes would still not put them anywhere.
 *
 * `DELETE /api/v1/auth/passkeys/{credential_id}` → 204. The server MUST refuse
 * to delete the caller's last credential with `409 {"error":"last_passkey"}` —
 * that guard is server-authoritative. The screen also disables removal at one
 * credential (defence in depth, and an honest control), but the client is not
 * the thing that knows the rule.
 *
 * # Why this is not in `session.ts` or `passkeyAdd.ts`
 *
 * Same reason `passkeyAdd.ts` is not in `session.ts`: no ceremony, no session
 * change, no writer change. These are two plain authenticated requests. The
 * error taxonomy is `Client`'s own (`ApiError` / `NetworkError`) so callers
 * read the same shapes every other route produces.
 */

import { ApiError, NetworkError } from "@ledger/client/net/client";

export interface PasskeySummary {
  /** Opaque credential id, standard base64. The DELETE path's key. */
  credentialId: string;
  /** RFC3339. When the credential was created. */
  createdAt: string;
  /** RFC3339, or null for a credential that has never signed in. */
  lastUsedAt: string | null;
  /** AAGUID-derived name ("iCloud Keychain"), or null when unknown. */
  authenticator: string | null;
  /** True for the credential that authenticated the current session. */
  current: boolean;
}

export interface PasskeyApiDeps {
  /** `handle.client` — read for its bearer token only. */
  client: { sessionToken: string | null };
  server?: string;
  fetch?: typeof fetch;
}

/** The spec's own error code for refusing to delete the last credential. */
export const LAST_PASSKEY_CODE = "last_passkey";

export function isLastPasskeyRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.code === LAST_PASSKEY_CODE;
}

async function request(deps: PasskeyApiDeps, method: "GET" | "DELETE", path: string): Promise<string> {
  const token = deps.client.sessionToken;
  if (token === null || token === "") {
    throw new ApiError(401, "no_session", "managing passkeys needs a live session", `${method} ${path}: no session`);
  }
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let res: Response;
  try {
    res = await doFetch(`${deps.server ?? ""}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new NetworkError(`${method} ${path}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  const text = await res.text();
  if (!res.ok) {
    let code = "";
    let detail = "";
    try {
      const e = JSON.parse(text) as { error?: string; detail?: string };
      code = e.error ?? "";
      detail = e.detail ?? "";
    } catch {
      detail = text.slice(0, 200);
    }
    throw new ApiError(res.status, code, detail, `${method} ${path}: ${String(res.status)} ${code}`);
  }
  return text;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** The caller's credentials, exactly the five fields the screen shows. */
export async function listPasskeys(deps: PasskeyApiDeps): Promise<PasskeySummary[]> {
  const text = await request(deps, "GET", "/api/v1/auth/passkeys");
  const parsed: unknown = text === "" ? {} : JSON.parse(text);
  const rows =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { passkeys?: unknown }).passkeys)
      ? ((parsed as { passkeys: unknown[] }).passkeys)
      : [];
  return rows.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new TypeError("a passkey row is not an object");
    }
    const r = raw as Record<string, unknown>;
    const credentialId = str(r["credential_id"]);
    const createdAt = str(r["created_at"]);
    if (credentialId === null || createdAt === null) {
      throw new TypeError("a passkey row is missing its credential_id or created_at");
    }
    return {
      credentialId,
      createdAt,
      lastUsedAt: str(r["last_used_at"]),
      authenticator: str(r["authenticator"]),
      current: r["current"] === true,
    };
  });
}

/**
 * Removes one credential. The id goes in the path URL-encoded — it is standard
 * base64, whose `+` and `/` would otherwise change the route.
 */
export async function removePasskey(deps: PasskeyApiDeps, credentialId: string): Promise<void> {
  await request(deps, "DELETE", `/api/v1/auth/passkeys/${encodeURIComponent(credentialId)}`);
}
