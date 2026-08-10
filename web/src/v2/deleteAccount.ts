/**
 * Deleting the account, from inside the app.
 *
 * `DELETE /api/v1/account` takes three factors and refuses everything else with
 * one bodyless 403 (`internal/v2/api/account.go`):
 *
 *  1. the session, which says only WHICH account is being talked about;
 *  2. a passkey assertion over a challenge the server minted for this action;
 *  3. an Ed25519 signature by this device's enrolled writer key over the same
 *     challenge.
 *
 * All three are collected in one gesture, because there is one challenge and it
 * dies in five minutes.
 *
 * # Why this is not in `session.ts` and not on `Client`
 *
 * `session.ts`'s ceremonies all end in a session. This one ends in there being
 * no account, so nothing it does afterwards is shared. And `Client` deliberately
 * does not wrap every route — `address.ts` makes the same call for the same
 * reason — so widening its private `request` to reach one DELETE would put an
 * ad-hoc method on the protocol client's surface for a call made once, ever.
 *
 * What IS reused rather than re-spelled: `publicKeyRequestOptions`,
 * `encodeAssertionCredential`, `fromBase64Url` and `classifyPasskeyFailure`, so
 * the base64url conventions and the failure taxonomy have one definition.
 *
 * # Factor 2 needs no options from the server
 *
 * There is no begin step and no ceremony id. The challenge is the deletion
 * nonce, and `rpId` is deliberately omitted from the request options so the
 * browser uses the origin the page was served from — which is what the server's
 * relying-party id is configured to be. Sending an `rpId` the server did not
 * hand over would be this module guessing at a value it cannot see.
 *
 * # Factor 3 reads the writer key out of the secret store
 *
 * `Client` holds the device's Ed25519 key and exposes no "sign these bytes":
 * the only signature it makes is a writer registration. Rather than widen that
 * seam for one call, the key is read from where `sqliteStore` puts it — the
 * `SecretStore`, under `writer_key:<writer id>` — and signed with directly. The
 * private half never leaves this function.
 */

import { ApiError, NetworkError } from "@ledger/client/net/client";
import { webPlatform } from "@ledger/client/platform.web";
import { SECRET_WRITER } from "@ledger/client/store/sqlite";
import type { SecretStore } from "@ledger/client/store/store";

import {
  classifyPasskeyFailure,
  encodeAssertionCredential,
  fromBase64Url,
  PasskeyError,
  publicKeyRequestOptions,
} from "./session";

/**
 * The domain prefix `purge.DeletionMessage` uses. A signature made for one flow
 * must be worthless in another, and this is the flow where being wrong cannot
 * be undone.
 */
const DELETION_DOMAIN = "ledger/v2 account-delete\0";

/**
 * The exact bytes a device key signs to authorize deleting an account,
 * mirroring `purge.DeletionMessage`:
 *
 *     "ledger/v2 account-delete\0" || nonce || 0x00 || user_id
 *
 * Unambiguous by construction: the prefix is fixed, the nonce is always 32
 * bytes, and the user id is a 36-character UUID. Nothing here has a
 * variable-length tail that could be re-split.
 */
export function deletionMessage(nonce: Uint8Array, userId: string): Uint8Array {
  const p = webPlatform;
  const domain = p.utf8Encode(DELETION_DOMAIN);
  const id = p.utf8Encode(userId);
  const out = new Uint8Array(domain.length + nonce.length + 1 + id.length);
  let n = 0;
  out.set(domain, n);
  n += domain.length;
  out.set(nonce, n);
  n += nonce.length;
  out[n++] = 0;
  out.set(id, n);
  return out;
}

export interface DeleteAccountDeps {
  /** `handle.client`. Read for its token, account id and writer id only. */
  client: { sessionToken: string | null; userId: string; writerId: string };
  /** Where `sqliteStore` keeps the writer's private key. */
  secrets: Pick<SecretStore, "get">;
  server?: string;
  fetch?: typeof fetch;
  credentials?: CredentialsContainer;
}

/**
 * Runs the whole ceremony. Resolves when the server has answered 204 — which it
 * does only after the purge committed, so a resolution here means the account
 * really is gone.
 *
 * Throws {@link PasskeyError} for every failure, including a dismissed prompt,
 * which is a `cancelled` and not an error to apologise for. A 403 is
 * `rejected`: the server does not say which factor was missing, and this must
 * not invent a reason.
 */
export async function deleteAccount(deps: DeleteAccountDeps): Promise<void> {
  try {
    const credentials =
      deps.credentials ?? (typeof navigator === "undefined" ? undefined : navigator.credentials);
    if (credentials === undefined || typeof credentials.get !== "function") {
      throw new PasskeyError("unsupported", "this browser does not support passkeys");
    }
    const token = deps.client.sessionToken;
    if (token === null || token === "") {
      throw new PasskeyError("rejected", "deleting an account needs a live session");
    }
    // Read BEFORE the challenge is minted and before the user is asked for a
    // biometric: a device with no writer key can never satisfy factor 3, and
    // finding that out after the passkey prompt would be a prompt asked for
    // nothing.
    const writerId = deps.client.writerId;
    const secret = deps.secrets.get(`${SECRET_WRITER}${writerId}`);
    if (secret === null || secret === "") {
      throw new PasskeyError(
        "rejected",
        "this device no longer holds the key that authorizes changes, so it cannot delete the account",
      );
    }

    const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const call = async <T,>(method: string, path: string, body: unknown): Promise<T | null> => {
      let res: Response;
      try {
        res = await doFetch(`${deps.server ?? ""}${path}`, {
          method,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new NetworkError(
          `${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
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
      return text === "" ? null : (JSON.parse(text) as T);
    };

    const challenge = await call<{ nonce: string; rp_id?: string }>("POST", "/api/v1/account/challenge", {});
    const nonceB64 = challenge?.nonce ?? "";
    if (nonceB64 === "") throw new PasskeyError("unavailable", "the server issued no challenge");
    // The rpId the account's passkeys were registered under — the PARENT domain
    // (sirdab.ae), not the app origin (app.sirdab.ae). Without it the browser
    // asserts against the origin, finds no matching credential, and offers to
    // create a new passkey. Sign-in avoids this because its options come from
    // login/begin already carrying rpId; this ceremony builds its own.
    const rpId = challenge?.rp_id ?? "";
    // Standard base64 on the wire (every binary field in this API is), and
    // base64url inside a WebAuthn challenge. One conversion, used for both the
    // bytes signed by the device key and the challenge handed to the browser,
    // so the two cannot drift apart.
    const nonceB64Url = nonceB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const nonce = fromBase64Url(nonceB64Url);

    const assertion = await credentials.get({
      publicKey: publicKeyRequestOptions({
        publicKey: {
          challenge: nonceB64Url,
          userVerification: "preferred",
          // Only when the server supplied it; an empty rpId would be worse than
          // omitting the key (the browser rejects "" rather than defaulting).
          ...(rpId === "" ? {} : { rpId }),
        },
      }),
    });
    if (assertion === null) throw new PasskeyError("cancelled", "no passkey was used");

    const sig = webPlatform.ed25519Sign(
      fromBase64Url(secret),
      deletionMessage(nonce, deps.client.userId),
    );

    await call<void>("DELETE", "/api/v1/account", {
      assertion: encodeAssertionCredential(assertion as PublicKeyCredential),
      nonce: nonceB64,
      sig: webPlatform.toBase64(sig),
    });
  } catch (err) {
    // The server's one refusal is a 403 with `deletion_rejected`, and
    // `classifyPasskeyFailure` files an unrecognised 403 as `unavailable` —
    // "ledger is having trouble", which is the wrong sentence to put in front
    // of somebody whose deletion was refused for a reason they can act on.
    // Classified here rather than there because `session.ts` is about
    // establishing sessions and knows nothing about this endpoint.
    const shape = err as { status?: unknown; code?: unknown };
    if (shape?.status === 403 && shape.code === "deletion_rejected") {
      throw new PasskeyError("rejected", "the server refused the deletion", err);
    }
    throw classifyPasskeyFailure(err);
  }
}
