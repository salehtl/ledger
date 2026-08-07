/**
 * Enrolling a SECOND passkey on an account that already has a session.
 *
 * # Why this is a product requirement and not a settings nicety
 *
 * There is no account recovery, and there cannot be one. The server holds no
 * password to reset, no recovery email and no second factor; an account is
 * reachable only through a credential an authenticator holds. So a user whose
 * only passkey lives on one device has a single point of failure for everything
 * ledger has recorded, and the operator cannot help them — spec Decision 10
 * refused a recovery phrase that recovers nothing, and the honest replacement is
 * to make a second credential available at the moment the first one is created,
 * next to the sentence explaining why (`onboarding.ts`'s `RECOVERY_WARNING`).
 *
 * # Why it is not in `session.ts`
 *
 * `session.ts`'s `ceremony` exists to establish a SESSION: both of its paths end
 * in `adoptSession` plus `ensureDeviceWriter`, and neither is right here. Adding
 * a passkey changes nothing about who is signed in and nothing about which
 * writer this device is — the account, the session token and the device key are
 * all exactly as they were. Threading a "do not adopt, do not enrol" flag
 * through `ceremony` would make the load-bearing path conditional in order to
 * reuse forty lines.
 *
 * What IS reused is everything that could drift: `publicKeyCreationOptions`,
 * `encodeRegistrationCredential` and `classifyPasskeyFailure` are imported, not
 * re-spelled, so the base64url conventions and the failure taxonomy have one
 * definition between the two ceremonies.
 *
 * # These two routes need a bearer token; the sign-up ones do not
 *
 * `POST /api/v1/auth/passkey/add/{begin,finish}` are wrapped in
 * `passkeyLimitedSession` — the rate limiter, and then `requireSession`. That is
 * the whole difference from register/login, and it is why this module has its
 * own `post` rather than borrowing `session.ts`'s (which sends no Authorization
 * header, correctly, because a sign-up has no session yet).
 */

import { ApiError, NetworkError } from "@ledger/client/net/client";

import {
  classifyPasskeyFailure,
  encodeRegistrationCredential,
  PasskeyError,
  publicKeyCreationOptions,
} from "./session";

export interface AddPasskeyDeps {
  /** `handle.client` — read for its bearer token only. */
  client: { sessionToken: string | null };
  server?: string;
  fetch?: typeof fetch;
  credentials?: CredentialsContainer;
}

interface BeginResponse {
  ceremony_id: string;
  options: unknown;
}

interface AddResponse {
  credential_id: string;
}

/**
 * Runs the add ceremony and returns the new credential's id (standard base64,
 * as `PasskeyAddResponse` sends it).
 *
 * Throws {@link PasskeyError} for every failure, including a dismissed prompt —
 * which is a `cancelled`, not an error to apologise for. A user who decides not
 * to add a second passkey right now has done nothing wrong, and the caller is
 * expected to render that kind quietly.
 */
export async function addPasskey(deps: AddPasskeyDeps): Promise<string> {
  try {
    const credentials =
      deps.credentials ?? (typeof navigator === "undefined" ? undefined : navigator.credentials);
    if (credentials === undefined || typeof credentials.create !== "function") {
      throw new PasskeyError("unsupported", "this browser does not support passkeys");
    }
    const token = deps.client.sessionToken;
    if (token === null || token === "") {
      throw new PasskeyError("rejected", "adding a passkey needs a live session");
    }

    const post = async <T,>(path: string, body: unknown): Promise<T> => {
      const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
      let res: Response;
      try {
        res = await doFetch(`${deps.server ?? ""}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new NetworkError(`POST ${path}: ${err instanceof Error ? err.message : String(err)}`, err);
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
        throw new ApiError(res.status, code, detail, `POST ${path}: ${String(res.status)} ${code}`);
      }
      return JSON.parse(text) as T;
    };

    const begin = await post<BeginResponse>("/api/v1/auth/passkey/add/begin", {});
    const cred = await credentials.create({ publicKey: publicKeyCreationOptions(begin.options) });
    if (cred === null) throw new PasskeyError("cancelled", "no credential was created");
    const out = await post<AddResponse>("/api/v1/auth/passkey/add/finish", {
      ceremony_id: begin.ceremony_id,
      credential: encodeRegistrationCredential(cred as PublicKeyCredential),
    });
    return out.credential_id;
  } catch (err) {
    throw classifyPasskeyFailure(err);
  }
}
