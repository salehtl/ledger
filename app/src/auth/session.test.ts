import { describe, expect, test } from "bun:test";

import { memSecretStore } from "@ledger/client/store/store.ts";
import { SECRET_SESSION } from "@ledger/client/store/sqlite.ts";
import type { Client } from "@ledger/client/net/client.ts";

import { NonceMismatchError, UserCancelledError, IDP_APPLE, IDP_GOOGLE } from "./idp.ts";
import {
  classifyFailure,
  clearSession,
  exchangeOnce,
  failureCopy,
  hasSession,
  initialSignInState,
  mayWipeLocalData,
  signInReducer,
  type AuthFailureKind,
  type ExchangeBackend,
  type SignInState,
} from "./session.ts";

/**
 * The seam matches the library, checked by the type system rather than by
 * hope: if `Client.login` ever changes shape, this stops compiling under
 * `bun run typecheck` instead of failing on a phone.
 */
const _clientSatisfiesBackend: (c: Client) => ExchangeBackend = (c) => c;
void _clientSatisfiesBackend;

/** An `ApiError`-shaped rejection, built without importing the class. */
function apiError(status: number, code: string): Error & { status: number; code: string } {
  return Object.assign(new Error(`${status} ${code}`), { status, code });
}

/** Records every call so "what did the client actually send" is measurable. */
function recordingBackend(answer: (code: string | undefined) => Promise<string>): ExchangeBackend & {
  calls: { idp: string; args: number; code: string | undefined }[];
} {
  const calls: { idp: string; args: number; code: string | undefined }[] = [];
  return {
    calls,
    login(idp: string, _idToken: string, inviteCode?: string) {
      // `arguments.length` is the only way to tell `login(a, b)` from
      // `login(a, b, undefined)`, and that is exactly the difference between
      // a request body with no `invite_code` field and one with a null.
      // eslint-disable-next-line prefer-rest-params
      calls.push({ idp, args: arguments.length, code: inviteCode });
      return answer(inviteCode);
    },
  };
}

// ---------------------------------------------------------------------------

describe("mayWipeLocalData — the one decision that can destroy data", () => {
  test("only 410 account_deleted permits a wipe", () => {
    expect(mayWipeLocalData(apiError(410, "account_deleted"))).toBe(true);
  });

  test("a bare 401 never permits a wipe, whatever the body says", () => {
    // This is the footgun the server's own doc calls out: a 401 is what a
    // routine token expiry looks like, and an offline device with a full
    // outbox loses everything if it wipes on one.
    expect(mayWipeLocalData(apiError(401, ""))).toBe(false);
    expect(mayWipeLocalData(apiError(401, "unauthorized"))).toBe(false);
    // The crossing that matters: the code alone must not be enough, or an
    // intermediary that rewrote a body could wipe a device.
    expect(mayWipeLocalData(apiError(401, "account_deleted"))).toBe(false);
  });

  test("410 with any other code does not permit a wipe either", () => {
    // The status alone must not be enough: a future 410 on this endpoint would
    // otherwise inherit a destructive meaning nobody granted it.
    expect(mayWipeLocalData(apiError(410, "gone"))).toBe(false);
    expect(mayWipeLocalData(apiError(410, ""))).toBe(false);
  });

  test("nothing without an HTTP status permits a wipe", () => {
    expect(mayWipeLocalData(new TypeError("Network request failed"))).toBe(false);
    expect(mayWipeLocalData(null)).toBe(false);
    expect(mayWipeLocalData("410 account_deleted")).toBe(false);
    expect(mayWipeLocalData({ status: "410", code: "account_deleted" })).toBe(false);
  });
});

describe("classifyFailure", () => {
  const cases: [unknown, AuthFailureKind][] = [
    [apiError(403, "not_invited"), "not_invited"],
    [apiError(403, "forbidden"), "unknown"],
    [apiError(410, "account_deleted"), "account_deleted"],
    [apiError(401, ""), "reauth"],
    [apiError(429, "rate_limited"), "rate_limited"],
    [apiError(503, "unavailable"), "unavailable"],
    [apiError(400, "bad_request"), "bad_request"],
    [apiError(500, "internal"), "unknown"],
    [new UserCancelledError(IDP_APPLE), "cancelled"],
    [new NonceMismatchError(IDP_APPLE, "raw", "nope"), "nonce_mismatch"],
    [new TypeError("Network request failed"), "offline"],
    [new Error("something else entirely"), "unknown"],
  ];

  for (const [err, kind] of cases) {
    test(`${String(kind)} for ${err instanceof Error ? err.name : typeof err}`, () => {
      expect(classifyFailure(err).kind).toBe(kind);
    });
  }

  test("every kind has copy, and not_invited's copy does not blame the credential", () => {
    const kinds: AuthFailureKind[] = [
      "cancelled",
      "not_invited",
      "account_deleted",
      "reauth",
      "unavailable",
      "rate_limited",
      "bad_request",
      "nonce_mismatch",
      "offline",
      "unknown",
    ];
    for (const kind of kinds) {
      const copy = failureCopy({ kind, detail: "" });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
    // The one piece of copy the API's own doc argues for: the person holding
    // the phone must learn that re-entering their Apple password will not help.
    expect(failureCopy({ kind: "not_invited", detail: "" }).body).toContain("will not help");
    expect(failureCopy({ kind: "not_invited", detail: "" }).retry).toBe(false);
    // And an expired session must not read as data loss.
    expect(failureCopy({ kind: "reauth", detail: "" }).body).toContain("Nothing was lost");
  });
});

describe("the reducer, and the returning alpha who has no invite code", () => {
  function drive(events: Parameters<typeof signInReducer>[1][]): SignInState {
    return events.reduce(signInReducer, initialSignInState());
  }

  test("a fresh provider round trip exchanges with NO invite code", () => {
    const s = drive([
      { type: "press", idp: IDP_APPLE },
      { type: "authenticated", idp: IDP_APPLE, idToken: "tok" },
    ]);
    expect(s.step).toBe("exchanging");
    expect(s.step === "exchanging" && s.inviteCode).toBeNull();
  });

  test("an account that already exists never reaches the invite screen", () => {
    const s = drive([
      { type: "press", idp: IDP_GOOGLE },
      { type: "authenticated", idp: IDP_GOOGLE, idToken: "tok" },
      { type: "exchanged", userId: "u-1" },
    ]);
    expect(s.step).toBe("signed_in");
  });

  test("only 403 not_invited opens the invite screen", () => {
    const base: Parameters<typeof signInReducer>[1][] = [
      { type: "press", idp: IDP_APPLE },
      { type: "authenticated", idp: IDP_APPLE, idToken: "tok" },
    ];
    expect(drive([...base, { type: "failed", failure: classifyFailure(apiError(403, "not_invited")) }]).step).toBe(
      "needs_invite",
    );
    for (const err of [apiError(401, ""), apiError(503, "x"), apiError(429, "y"), apiError(410, "account_deleted")]) {
      const s = drive([...base, { type: "failed", failure: classifyFailure(err) }]);
      expect(s.step).toBe("idle");
      expect(s.step === "idle" && s.failure?.kind).toBe(classifyFailure(err).kind);
    }
  });

  test("the invite draft is a string and survives a wrong code", () => {
    let s = drive([
      { type: "press", idp: IDP_APPLE },
      { type: "authenticated", idp: IDP_APPLE, idToken: "tok" },
      { type: "failed", failure: classifyFailure(apiError(403, "not_invited")) },
      { type: "invite_draft", draft: "ABCD-EFGH" },
    ]);
    expect(s.step === "needs_invite" && s.draft).toBe("ABCD-EFGH");
    s = signInReducer(s, { type: "invite_submit" });
    expect(s.step === "exchanging" && s.inviteCode).toBe("ABCD-EFGH");
    // Spent or mistyped: back to the invite screen, keeping what was typed and
    // saying that the code is the problem.
    s = signInReducer(s, { type: "failed", failure: classifyFailure(apiError(403, "not_invited")) });
    expect(s.step).toBe("needs_invite");
    expect(s.step === "needs_invite" && s.draft).toBe("ABCD-EFGH");
    expect(s.step === "needs_invite" && s.failure?.kind).toBe("not_invited");
  });

  test("the FIRST not_invited shows a blank field and no error; a rejected code shows both", () => {
    // Two arrivals at one screen. Collapsing them shows "that code did not
    // work" to somebody who has not typed a character yet, or silently eats a
    // rejection — the fixture with one of something that cannot tell the two
    // apart is exactly what this pins.
    const notInvited = classifyFailure(apiError(403, "not_invited"));
    const first = signInReducer(
      { step: "exchanging", idp: IDP_APPLE, idToken: "tok", inviteCode: null },
      { type: "failed", failure: notInvited },
    );
    expect(first.step === "needs_invite" && first.draft).toBe("");
    expect(first.step === "needs_invite" && first.failure).toBeNull();

    const second = signInReducer(
      { step: "exchanging", idp: IDP_APPLE, idToken: "tok", inviteCode: "WRONG" },
      { type: "failed", failure: notInvited },
    );
    expect(second.step === "needs_invite" && second.draft).toBe("WRONG");
    expect(second.step === "needs_invite" && second.failure?.kind).toBe("not_invited");
  });

  test("an empty or whitespace draft cannot be submitted", () => {
    const at = (draft: string) =>
      signInReducer(
        { step: "needs_invite", idp: IDP_APPLE, idToken: "tok", draft, failure: null },
        { type: "invite_submit" },
      );
    expect(at("").step).toBe("needs_invite");
    expect(at("   ").step).toBe("needs_invite");
    expect(at(" X ").step).toBe("exchanging");
  });

  test("an ID token that expires while the code is being typed sends the user back to sign in", () => {
    // Apple's identity token is short-lived. Re-submitting a code against a
    // dead token fails forever, so this must not stay on the invite screen.
    const s = signInReducer(
      { step: "needs_invite", idp: IDP_APPLE, idToken: "tok", draft: "CODE", failure: null },
      { type: "failed", failure: classifyFailure(apiError(401, "")) },
    );
    expect(s.step).toBe("idle");
    expect(s.step === "idle" && s.failure?.kind).toBe("reauth");
  });

  test("a second press while a flow is running is ignored", () => {
    const s = drive([
      { type: "press", idp: IDP_APPLE },
      { type: "press", idp: IDP_GOOGLE },
    ]);
    expect(s.step === "authenticating" && s.idp).toBe(IDP_APPLE);
  });

  test("events out of order are no-ops rather than state corruption", () => {
    expect(signInReducer(initialSignInState(), { type: "authenticated", idp: IDP_APPLE, idToken: "t" }).step).toBe(
      "idle",
    );
    expect(signInReducer(initialSignInState(), { type: "exchanged", userId: "u" }).step).toBe("idle");
    expect(signInReducer(initialSignInState(), { type: "invite_submit" }).step).toBe("idle");
    expect(signInReducer({ step: "signed_in", userId: "u" }, { type: "restart" }).step).toBe("idle");
  });
});

describe("exchangeOnce — what actually goes on the wire", () => {
  test("the first attempt sends no invite_code argument at all", async () => {
    const backend = recordingBackend(async () => "u-1");
    await exchangeOnce(backend, IDP_APPLE, "tok", null);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.args).toBe(2);
    expect(backend.calls[0]?.code).toBeUndefined();
  });

  test("a code is sent only once there is one", async () => {
    const backend = recordingBackend(async () => "u-1");
    await exchangeOnce(backend, IDP_GOOGLE, "tok", "INVITE-1");
    expect(backend.calls[0]?.args).toBe(3);
    expect(backend.calls[0]?.code).toBe("INVITE-1");
  });

  test("a returning account signs in on the first call, and no code is ever produced", async () => {
    // The whole flow, driven end to end against a server that behaves like one
    // holding an existing account: it answers the code-less exchange with a
    // user id, and would 403 if a code were required.
    const backend = recordingBackend(async (code) => {
      if (code !== undefined) throw new Error("an existing account must never be asked for a code");
      return "u-existing";
    });
    let s = initialSignInState();
    s = signInReducer(s, { type: "press", idp: IDP_APPLE });
    s = signInReducer(s, { type: "authenticated", idp: IDP_APPLE, idToken: "tok" });
    expect(s.step).toBe("exchanging");
    const userId = await exchangeOnce(
      backend,
      IDP_APPLE,
      "tok",
      s.step === "exchanging" ? s.inviteCode : "SHOULD NOT HAPPEN",
    );
    s = signInReducer(s, { type: "exchanged", userId });
    expect(s).toEqual({ step: "signed_in", userId: "u-existing" });
    expect(backend.calls.every((c) => c.args === 2)).toBe(true);
  });

  test("a new account goes 403 → code → session, and only then carries a code", async () => {
    const backend = recordingBackend(async (code) => {
      if (code === undefined) throw apiError(403, "not_invited");
      if (code !== "GOOD") throw apiError(403, "not_invited");
      return "u-new";
    });
    let s: SignInState = { step: "exchanging", idp: IDP_GOOGLE, idToken: "tok", inviteCode: null };
    await expect(exchangeOnce(backend, IDP_GOOGLE, "tok", null)).rejects.toBeDefined();
    s = signInReducer(s, { type: "failed", failure: classifyFailure(apiError(403, "not_invited")) });
    expect(s.step).toBe("needs_invite");
    s = signInReducer(s, { type: "invite_draft", draft: "GOOD" });
    s = signInReducer(s, { type: "invite_submit" });
    const userId = await exchangeOnce(backend, IDP_GOOGLE, "tok", s.step === "exchanging" ? s.inviteCode : null);
    expect(signInReducer(s, { type: "exchanged", userId })).toEqual({ step: "signed_in", userId: "u-new" });
    expect(backend.calls.map((c) => c.args)).toEqual([2, 3]);
  });
});

describe("the stored session", () => {
  test("hasSession reads the same Keychain name sqliteStore writes", () => {
    const secrets = memSecretStore();
    expect(hasSession(secrets)).toBe(false);
    secrets.set(SECRET_SESSION, "tok");
    expect(hasSession(secrets)).toBe(true);
  });

  test("an empty string counts as no session", () => {
    // `keychainSecretStore` clears by writing "" — expo-secure-store has no
    // synchronous delete — so an empty value must not read as a live session.
    const secrets = memSecretStore();
    secrets.set(SECRET_SESSION, "");
    expect(hasSession(secrets)).toBe(false);
  });

  test("clearSession drops the token and nothing else", () => {
    const secrets = memSecretStore();
    secrets.set(SECRET_SESSION, "tok");
    secrets.set("writer_key:W1", "seed");
    clearSession(secrets);
    expect(hasSession(secrets)).toBe(false);
    // The writer key survives: signing out is not enrolment loss, and a device
    // that regenerated its identity key on every sign-out would fork its own
    // chain.
    expect(secrets.get("writer_key:W1")).toBe("seed");
  });
});
