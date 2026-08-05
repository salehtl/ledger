import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import { memSecretStore } from "@ledger/client/store/store.ts";
import { IDP_GOOGLE } from "../auth/idp.ts";
import { SECRET_WRITER_ID } from "../auth/keys.ts";
import { toBase64, utf8Decode } from "../platform/bytes.ts";
import { deleteAccount, deletionMessage, type AccountFetch, type DeleteAccountOptions } from "./deletion.ts";

const USER = "123e4567-e89b-42d3-a456-426614174000";
const NONCE = new Uint8Array(32).map((_, i) => i);
function response(status: number, body?: unknown): Response { return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function fixture(fetcher: AccountFetch) { const secrets = memSecretStore(); const seed = new Uint8Array(32).fill(7); secrets.set(SECRET_SESSION, "session"); secrets.set(SECRET_WRITER_ID, "phone"); secrets.set(`${SECRET_WRITER}phone`, toBase64(seed)); let wiped = 0; const seen: string[] = []; const opts: DeleteAccountOptions = { server: "https://ledger.test", userId: () => USER, secrets, fetch: fetcher, wipe: async () => { wiped++; }, authenticator: { idp: IDP_GOOGLE, isAvailable: async () => true, authenticate: async (nonce: string) => { seen.push(nonce); return { idToken: "fresh", email: null }; } } }; return { seed, seen, get wiped() { return wiped; }, opts }; }

describe("account deletion", () => {
  test("pins the Go domain, nonce, separator, and canonical UUID", () => { const m = deletionMessage(NONCE, USER.toUpperCase()); expect(utf8Decode(m.slice(0, 25))).toBe("ledger/v2 account-delete\0"); expect([...m.slice(25, 57)]).toEqual([...NONCE]); expect(m[57]).toBe(0); expect(utf8Decode(m.slice(58))).toBe(USER); });
  test("uses challenge for IdP and signed three-factor DELETE, then wipes", async () => { let f!: ReturnType<typeof fixture>; let call = 0; f = fixture(async (_input, init) => { call++; if (call === 1) return response(200, { nonce: toBase64(NONCE) }); const body = JSON.parse(String(init?.body)); expect(body.nonce).toBe(toBase64(NONCE)); expect(body.idp).toBe("google"); expect(body.id_token).toBe("fresh"); expect(ed25519.verify(Uint8Array.from(atob(body.sig), c => c.charCodeAt(0)), deletionMessage(NONCE, USER), ed25519.getPublicKey(f.seed))).toBe(true); return response(204); }); await deleteAccount(f.opts); expect(f.seen).toEqual([toBase64(NONCE)]); expect(f.wiped).toBe(1); });
  test("plain 401 retains local data", async () => { let call = 0; const f = fixture(async () => ++call === 1 ? response(200, { nonce: toBase64(NONCE) }) : response(401, { error: "unauthorized" })); await expect(deleteAccount(f.opts)).rejects.toMatchObject({ status: 401 }); expect(f.wiped).toBe(0); });
  test("only exact deleted-account 410 wipes", async () => { for (const code of ["account_deleted", "other"]) { let call = 0; const f = fixture(async () => ++call === 1 ? response(200, { nonce: toBase64(NONCE) }) : response(410, { error: code })); await expect(deleteAccount(f.opts)).rejects.toMatchObject({ status: 410, code }); expect(f.wiped).toBe(code === "account_deleted" ? 1 : 0); } });
});
