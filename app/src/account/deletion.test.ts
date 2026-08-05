import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import { memSecretStore } from "@ledger/client/store/store.ts";
import { IDP_GOOGLE } from "../auth/idp.ts";
import { SECRET_WRITER_ID } from "../auth/keys.ts";
import { toBase64, utf8Decode } from "../platform/bytes.ts";
import { deleteAccount, deletionFailureCopy, deletionMessage, deletionResultCopy, UnconfirmedDeletionError, type AccountFetch, type DeletionCopy, type DeleteAccountOptions } from "./deletion.ts";

const USER = "123e4567-e89b-42d3-a456-426614174000";
const NONCE = new Uint8Array(32).map((_, i) => i);
function response(status: number, body?: unknown): Response { return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function fixture(fetcher: AccountFetch) { const secrets = memSecretStore(); const seed = new Uint8Array(32).fill(7); secrets.set(SECRET_SESSION, "session"); secrets.set(SECRET_WRITER_ID, "phone"); secrets.set(`${SECRET_WRITER}phone`, toBase64(seed)); let wiped = 0; const seen: string[] = []; const opts: DeleteAccountOptions = { server: "https://ledger.test", userId: () => USER, secrets, fetch: fetcher, wipe: async () => { wiped++; }, authenticator: { idp: IDP_GOOGLE, isAvailable: async () => true, authenticate: async (nonce: string) => { seen.push(nonce); return { idToken: "fresh", email: null }; } } }; return { seed, seen, get wiped() { return wiped; }, opts }; }

describe("account deletion", () => {
  test("pins the Go domain, nonce, separator, and canonical UUID", () => { const m = deletionMessage(NONCE, USER.toUpperCase()); expect(utf8Decode(m.slice(0, 25))).toBe("ledger/v2 account-delete\0"); expect([...m.slice(25, 57)]).toEqual([...NONCE]); expect(m[57]).toBe(0); expect(utf8Decode(m.slice(58))).toBe(USER); });
  test("uses challenge for IdP and signed three-factor DELETE, then wipes", async () => { let f!: ReturnType<typeof fixture>; let call = 0; f = fixture(async (_input, init) => { call++; if (call === 1) return response(200, { nonce: toBase64(NONCE) }); const body = JSON.parse(String(init?.body)); expect(body.nonce).toBe(toBase64(NONCE)); expect(body.idp).toBe("google"); expect(body.id_token).toBe("fresh"); expect(ed25519.verify(Uint8Array.from(atob(body.sig), c => c.charCodeAt(0)), deletionMessage(NONCE, USER), ed25519.getPublicKey(f.seed))).toBe(true); return response(204); }); await deleteAccount(f.opts); expect(f.seen).toEqual([toBase64(NONCE)]); expect(f.wiped).toBe(1); });
  test("plain 401 retains local data", async () => { let call = 0; const f = fixture(async () => ++call === 1 ? response(200, { nonce: toBase64(NONCE) }) : response(401, { error: "unauthorized" })); await expect(deleteAccount(f.opts)).rejects.toMatchObject({ status: 401 }); expect(f.wiped).toBe(0); });
  test("only exact deleted-account 410 wipes, and it RESOLVES so the caller can leave the signed-in graph", async () => {
    // `account_deleted` is not a failure: the account is genuinely gone and the
    // local ledger has just been erased, so it returns an outcome. `other` is a
    // failure and must keep every row.
    let call = 0; const gone = fixture(async () => ++call === 1 ? response(200, { nonce: toBase64(NONCE) }) : response(410, { error: "account_deleted" }));
    expect(await deleteAccount(gone.opts)).toEqual({ outcome: "already_deleted", wiped: true });
    expect(gone.wiped).toBe(1);
    let other = 0; const kept = fixture(async () => ++other === 1 ? response(200, { nonce: toBase64(NONCE) }) : response(410, { error: "other" }));
    await expect(deleteAccount(kept.opts)).rejects.toMatchObject({ status: 410, code: "other" });
    expect(kept.wiped).toBe(0);
  });

  test("a 410 on the CHALLENGE wipes and resolves too, without an IdP round trip", async () => {
    const f = fixture(async () => response(410, { error: "account_deleted" }));
    expect(await deleteAccount(f.opts)).toEqual({ outcome: "already_deleted", wiped: true });
    expect(f.wiped).toBe(1);
    expect(f.seen).toEqual([]);
  });

  /**
   * The mutation this kills: delete the `status !== 204` guard and every other
   * test in this file still passes, because none of them ever sends a 2xx that
   * is not 204. A server answering `200` or `202` - including one that did NOT
   * delete the account - would then erase the only copy of a user's ledger.
   */
  test("a 2xx that is not 204 rejects and wipes NOTHING", async () => {
    for (const status of [200, 202]) {
      let call = 0; const f = fixture(async () => ++call === 1 ? response(200, { nonce: toBase64(NONCE) }) : response(status, { ok: true }));
      await expect(deleteAccount(f.opts)).rejects.toBeInstanceOf(UnconfirmedDeletionError);
      expect(f.wiped).toBe(0);
    }
  });

  /**
   * The copy may never contradict the action.
   *
   * Each case drives a real server answer through `deleteAccount`, COUNTS the
   * wipes the fixture observed, and derives the message the screen renders from
   * whatever came back. The assertion compares the sentence against the
   * measurement - not against the branch that produced it - so the pre-fix
   * behaviour (410: wipe, throw, "your data remains on this device") fails here.
   */
  test("every message agrees with whether the ledger was actually erased", async () => {
    const CLAIMS_ERASED = /this device's ledger has (been|now been) erased/;
    const CLAIMS_INTACT = /(remains on this device|are untouched|Nothing on this device was erased)/;
    const nonce = () => response(200, { nonce: toBase64(NONCE) });
    const cases: { name: string; fetch: () => AccountFetch; wipes: number }[] = [
      { name: "204 deleted", wipes: 1, fetch: () => { let c = 0; return async () => ++c === 1 ? nonce() : response(204); } },
      { name: "410 account_deleted on DELETE", wipes: 1, fetch: () => { let c = 0; return async () => ++c === 1 ? nonce() : response(410, { error: "account_deleted" }); } },
      { name: "410 account_deleted on challenge", wipes: 1, fetch: () => async () => response(410, { error: "account_deleted" }) },
      { name: "401 expired session", wipes: 0, fetch: () => { let c = 0; return async () => ++c === 1 ? nonce() : response(401, { error: "unauthorized" }); } },
      { name: "401 on challenge", wipes: 0, fetch: () => async () => response(401, { error: "unauthorized" }) },
      { name: "410 some other gone", wipes: 0, fetch: () => { let c = 0; return async () => ++c === 1 ? nonce() : response(410, { error: "other" }); } },
      { name: "200 unconfirmed", wipes: 0, fetch: () => { let c = 0; return async () => ++c === 1 ? nonce() : response(200, { ok: true }); } },
      { name: "500 server error", wipes: 0, fetch: () => { let c = 0; return async () => ++c === 1 ? nonce() : response(500, { error: "boom" }); } },
    ];
    for (const c of cases) {
      const f = fixture(c.fetch());
      let copy: DeletionCopy;
      try { copy = deletionResultCopy(await deleteAccount(f.opts)); } catch (error) { copy = deletionFailureCopy(error); }
      const erased = f.wiped === 1;
      expect({ case: c.name, wipes: f.wiped }).toEqual({ case: c.name, wipes: c.wipes });
      expect({ case: c.name, saysWiped: copy.wiped }).toEqual({ case: c.name, saysWiped: erased });
      expect({ case: c.name, erasure: CLAIMS_ERASED.test(copy.body) }).toEqual({ case: c.name, erasure: erased });
      expect({ case: c.name, intact: CLAIMS_INTACT.test(copy.body) }).toEqual({ case: c.name, intact: !erased });
    }
  });
});
