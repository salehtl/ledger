import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import type { SecretStore } from "@ledger/client/store/store.ts";
import { fromBase64, toBase64, utf8Encode } from "../platform/bytes.ts";
import { ed25519Sign } from "../platform/signing.ts";
import { SECRET_WRITER_ID } from "../auth/keys.ts";
import type { IdpAuthenticator } from "../auth/idp.ts";
import { mayWipeLocalData } from "../auth/session.ts";

const DOMAIN = utf8Encode("ledger/v2 account-delete\u0000");
export function deletionMessage(nonce: Uint8Array, userId: string): Uint8Array {
  if (nonce.length !== 32) throw new Error(`deletion nonce is ${nonce.length} bytes, want 32`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) throw new Error("user id is not a UUID");
  const id = utf8Encode(userId.toLowerCase()); const out = new Uint8Array(DOMAIN.length + 32 + 1 + id.length);
  out.set(DOMAIN); out.set(nonce, DOMAIN.length); out[DOMAIN.length + 32] = 0; out.set(id, DOMAIN.length + 33); return out;
}

export class AccountRequestError extends Error { constructor(readonly status: number, readonly code: string, detail = "") { super(detail || `account request failed: ${status}`); this.name = "AccountRequestError"; } }
async function failure(response: Response): Promise<AccountRequestError> {
  let body: unknown = null; try { body = await response.json(); } catch { /* body is optional */ }
  const o = body as { error?: unknown; detail?: unknown } | null;
  return new AccountRequestError(response.status, typeof o?.error === "string" ? o.error : "http_error", typeof o?.detail === "string" ? o.detail : "");
}

export type AccountFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface DeleteAccountOptions { server: string; userId: () => string | null; secrets: SecretStore; authenticator: IdpAuthenticator; wipe(): Promise<void>; fetch?: AccountFetch; }
export async function deleteAccount(opts: DeleteAccountOptions): Promise<void> {
  const token = opts.secrets.get(SECRET_SESSION); const writerId = opts.secrets.get(SECRET_WRITER_ID); const userId = opts.userId();
  if (!token || !writerId || !userId) throw new Error("account deletion requires a session, user id, and enrolled device key");
  const seedText = opts.secrets.get(`${SECRET_WRITER}${writerId}`); if (!seedText) throw new Error("this device's signing key is unavailable");
  const request = opts.fetch ?? fetch; const auth = { authorization: `Bearer ${token}` };
  const challenge = await request(new URL("/api/v1/account/challenge", opts.server), { method: "POST", headers: auth });
  if (!challenge.ok) { const error = await failure(challenge); if (mayWipeLocalData(error)) await opts.wipe(); throw error; }
  const doc = await challenge.json() as { nonce?: unknown }; if (typeof doc.nonce !== "string") throw new Error("account challenge returned no nonce");
  const nonce = fromBase64(doc.nonce); if (nonce.length !== 32) throw new Error("account challenge nonce is not 32 bytes");
  const credential = await opts.authenticator.authenticate(doc.nonce);
  const sig = toBase64(ed25519Sign(fromBase64(seedText), deletionMessage(nonce, userId)));
  const response = await request(new URL("/api/v1/account", opts.server), { method: "DELETE", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ idp: opts.authenticator.idp, id_token: credential.idToken, nonce: doc.nonce, sig }) });
  if (!response.ok) { const error = await failure(response); if (mayWipeLocalData(error)) await opts.wipe(); throw error; }
  if (response.status !== 204) throw new Error(`account deletion returned ${response.status}, want 204`);
  await opts.wipe();
}
