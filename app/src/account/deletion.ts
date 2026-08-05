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

/**
 * A 2xx that is not the `204` the protocol defines.
 *
 * Its own class because it is the one ending where the app genuinely does not
 * know what happened on the server, and the copy must say so rather than
 * borrow a 4xx's confident "your account was not deleted". Nothing is wiped on
 * this path: a response the client cannot interpret is not proof of a
 * deletion, and this is the only irreversible operation in the product.
 */
export class UnconfirmedDeletionError extends Error { constructor(readonly status: number) { super(`account deletion returned ${status}, want 204`); this.name = "UnconfirmedDeletionError"; } }

/**
 * The server confirmed the deletion and the LOCAL erase then failed.
 *
 * `opts.wipe()` closes the driver, deletes the database file and purges the
 * Keychain, and any of the three can reject. Before this class existed that
 * rejection travelled as a plain error and `deletionFailureCopy`'s fallthrough
 * told the user "Your account was not deleted. Your data remains on this
 * device." — two claims, both false, on the one irreversible operation in the
 * product: the account WAS deleted, and the local database may be partly gone.
 *
 * It carries the confirmed outcome so the copy can say what is actually true,
 * and it is an error rather than a result because this device is not clean and
 * the user has something to do about it.
 */
export class LocalWipeError extends Error {
  constructor(readonly outcome: DeletionOutcome, override readonly cause: unknown) {
    super(`the account was deleted on the server but this device could not finish erasing its copy: ${String(cause)}`);
    this.name = "LocalWipeError";
  }
}

/**
 * How a deletion ended, for the two endings that erase this device.
 *
 *  - `deleted` - this device asked, the server answered `204`, the account is gone.
 *  - `already_deleted` - the server answered `410 account_deleted`: the account
 *    was destroyed elsewhere (the user's other phone, or support), so what is
 *    held here is orphaned data belonging to an account that no longer exists,
 *    and it is erased too.
 *
 * Both are **returned** rather than thrown, because both leave this device with
 * no database, no writer key and no session: the caller must navigate out of
 * the signed-in graph on either. Signalling one of them through the same
 * `throw` as "nothing happened" is precisely what made the 410 path wipe the
 * device, stay on the delete screen, and tell the user their data was intact.
 *
 * Every other ending throws, and every path that throws leaves the ledger on
 * the device - an invariant `deletion.test.ts` measures by counting wipes per
 * server answer, not by trusting this comment.
 */
export type DeletionOutcome = "deleted" | "already_deleted";
/** `wiped` records that `opts.wipe()` actually ran. It is measured, not restated from `outcome`. */
export interface DeletionResult { outcome: DeletionOutcome; wiped: boolean }

export type AccountFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface DeleteAccountOptions { server: string; userId: () => string | null; secrets: SecretStore; authenticator: IdpAuthenticator; wipe(): Promise<void>; fetch?: AccountFetch; }
export async function deleteAccount(opts: DeleteAccountOptions): Promise<DeletionResult> {
  let wiped = false;
  // A wipe that throws is NOT "nothing happened": the server has already
  // confirmed, so the outcome is carried into the error rather than lost.
  const wipe = async (outcome: DeletionOutcome): Promise<void> => {
    try { await opts.wipe(); } catch (cause) { throw new LocalWipeError(outcome, cause); }
    wiped = true;
  };
  const token = opts.secrets.get(SECRET_SESSION); const writerId = opts.secrets.get(SECRET_WRITER_ID); const userId = opts.userId();
  if (!token || !writerId || !userId) throw new Error("account deletion requires a session, user id, and enrolled device key");
  const seedText = opts.secrets.get(`${SECRET_WRITER}${writerId}`); if (!seedText) throw new Error("this device's signing key is unavailable");
  const request = opts.fetch ?? fetch; const auth = { authorization: `Bearer ${token}` };
  const challenge = await request(new URL("/api/v1/account/challenge", opts.server), { method: "POST", headers: auth });
  if (!challenge.ok) { const error = await failure(challenge); if (!mayWipeLocalData(error)) throw error; await wipe("already_deleted"); return { outcome: "already_deleted", wiped }; }
  const doc = await challenge.json() as { nonce?: unknown }; if (typeof doc.nonce !== "string") throw new Error("account challenge returned no nonce");
  const nonce = fromBase64(doc.nonce); if (nonce.length !== 32) throw new Error("account challenge nonce is not 32 bytes");
  const credential = await opts.authenticator.authenticate(doc.nonce);
  const sig = toBase64(ed25519Sign(fromBase64(seedText), deletionMessage(nonce, userId)));
  const response = await request(new URL("/api/v1/account", opts.server), { method: "DELETE", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ idp: opts.authenticator.idp, id_token: credential.idToken, nonce: doc.nonce, sig }) });
  if (!response.ok) { const error = await failure(response); if (!mayWipeLocalData(error)) throw error; await wipe("already_deleted"); return { outcome: "already_deleted", wiped }; }
  if (response.status !== 204) throw new UnconfirmedDeletionError(response.status);
  await wipe("deleted");
  return { outcome: "deleted", wiped };
}

/**
 * What the screen says, and the `wiped` flag the message has to agree with.
 *
 * Copy lives beside the outcome for the reason `failureCopy` lives in
 * `session.ts`: it is the part of this path most likely to be wrong in a way a
 * test can catch. `deletion.test.ts` drives each real server answer through
 * {@link deleteAccount}, counts the wipes the fixture observed, and asserts
 * `copy.wiped` equals that count - so a message claiming "your data remains on
 * this device" cannot be shown on a path that erased it, however a future edit
 * moves the branches around.
 */
export interface DeletionCopy { body: string; wiped: boolean }

export function deletionResultCopy(result: DeletionResult): DeletionCopy {
  return {
    wiped: result.wiped,
    body: result.outcome === "deleted"
      ? "Your account is deleted. Everything the server held for you is gone, and this device's ledger has been erased. Backup copies are removed on the server's own retention schedule."
      : "This account had already been deleted, from another device or by support. Everything on the server is gone, and this device's ledger has now been erased too.",
  };
}

export function deletionFailureCopy(error: unknown): DeletionCopy {
  // First, because it is the one failure where the account really is gone. It
  // used to fall through to the sentence below and tell the user the opposite
  // of what happened, twice.
  if (error instanceof LocalWipeError) return { wiped: false, body: `Your account is deleted. Everything the server held for you is gone and it cannot be brought back. This device could not finish erasing its own copy, so some of your ledger may still be stored here — delete and reinstall ledger to remove it.` };
  if (error instanceof UnconfirmedDeletionError) return { wiped: false, body: `ledger could not confirm the deletion: the server answered ${error.status} instead of 204. Nothing on this device was erased, and your account may or may not still exist. Try again, and check before assuming it is gone.` };
  const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : 0;
  if (status === 401) return { wiped: false, body: "Your sign-in expired before anything was deleted. Your account and everything on this device are untouched. Sign in again and retry." };
  return { wiped: false, body: "Your account was not deleted. Your data remains on this device." };
}
