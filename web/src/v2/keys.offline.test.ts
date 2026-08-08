/**
 * `keyStatus` when the server cannot be reached.
 *
 * # Why this is its own file
 *
 * These four assertions were written in `keys.test.ts` under a
 * `describe("keyStatus, offline")`, which is a perfectly good place for them
 * and a bad place to FIND them: a review of the fix that added them grepped for
 * `keyStatus` across `web/**` and concluded the safety property was unguarded.
 * A property whose whole purpose is that nobody re-breaks it should be findable
 * by filename, so it lives here, named after the behaviour rather than after
 * the module.
 *
 * # The regression
 *
 * `keyStatus` always did a `GET /api/v1/keys`. Offline that threw, `boot`'s
 * `keysReadyOrFalse` swallowed it to `false`, the onboarding walk collapsed to
 * `invited`, and a local-first PWA **whose keys were sitting in IndexedDB**
 * showed a fully set-up user the recovery-phrase screen — asking for twelve
 * words they wrote down months ago because a fetch failed.
 *
 * It could never mint a second key set (`keyStatus` throwing rather than
 * answering `unpublished` is what kept that safe), so this was alarming rather
 * than destructive. It is the same class as "offline is not an integrity halt",
 * fixed earlier the same week.
 *
 * # The five boundaries, and why each one is a boundary and not a case
 *
 * The fix is one line of judgement — "handles for this account plus no answer
 * means ready" — and every part of that sentence is load bearing. Each test
 * below removes exactly one part and requires the answer to change.
 */

import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "@ledger/client/net/client";
import { generateAccountKeys } from "@ledger/client/crypto/keys";
import { webPlatform } from "@ledger/client/platform.web";
import { installAccountKeys, keyStatus, memoryKeyVault } from "./keys";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";

/**
 * A `fetch` that fails the way a real one does with no network: a `TypeError`,
 * which is the only thing `fetch` is specified to reject with for a network
 * failure and what `readPublishedKeys` turns into a {@link NetworkError}.
 *
 * Deliberately NOT a hand-rolled `NetworkError`: that would test this file's
 * idea of the offline path rather than the path the browser actually takes.
 */
const offline = (): never => {
  throw new TypeError("Failed to fetch");
};

const httpFetch = (status: number, error: string) => async () =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

/** A vault holding a real, installed key set for `accountId`. */
async function vaultFor(accountId: string) {
  const vault = memoryKeyVault();
  await installAccountKeys(accountId, generateAccountKeys(webPlatform), vault);
  return vault;
}

describe("keyStatus when the server cannot be reached", () => {
  // 1. The fix itself. A device that can decrypt says so.
  it("is `ready` for a device holding this account's keys", async () => {
    const status = await keyStatus(ACCOUNT, await vaultFor(ACCOUNT), {
      sessionToken: "t",
      fetch: offline as never,
    });
    expect(status.kind).toBe("ready");
    if (status.kind === "ready") {
      // The real handles, not a placeholder: whatever reads this next is going
      // to try to decrypt with them.
      expect(status.keys.accountId).toBe(ACCOUNT);
      expect(status.keys.ingestPub.length).toBe(32);
      expect(status.keys.dek.extractable).toBe(false);
    }
  });

  // 2. It really is the NETWORK path being forgiven, not "any throw". A failure
  //    that is not a transport failure must not be swallowed by the same branch.
  it("forgives a NetworkError specifically", async () => {
    let caught: unknown = null;
    await keyStatus(ACCOUNT, memoryKeyVault(), { sessionToken: "t", fetch: offline as never }).catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(NetworkError);
  });

  // 3. Remove the handles. A device with nothing genuinely cannot tell
  //    "generate a key set" from "ask for the phrase" without the server, and
  //    guessing the first would mint a SECOND key set for an account whose data
  //    is sealed to the first — the one catastrophic answer available here.
  it("still fails for a device that holds nothing", async () => {
    await expect(
      keyStatus(ACCOUNT, memoryKeyVault(), { sessionToken: "t", fetch: offline as never }),
    ).rejects.toThrow();
  });

  // 4. Remove "for this account". A browser profile that signed out and into a
  //    different account still holds the first account's handles, and reading
  //    those as `ready` would hand this account another user's keys.
  it("still fails for handles belonging to a different account", async () => {
    await expect(
      keyStatus(ACCOUNT, await vaultFor(OTHER_ACCOUNT), { sessionToken: "t", fetch: offline as never }),
    ).rejects.toThrow();
  });

  // 5. Remove "no answer". A session answer is a fact about the ACCOUNT rather
  //    than about the connection, and swallowing it would hide a deleted or
  //    signed-out account behind a working-looking app — on the one device that
  //    can still decrypt everything, which is the worst place to hide it.
  //    `sessionAnswerOf` is what draws that line; both statuses are checked
  //    because only one of them means "wipe".
  it("does not swallow a 410 account_deleted", async () => {
    await expect(
      keyStatus(ACCOUNT, await vaultFor(ACCOUNT), { sessionToken: "t", fetch: httpFetch(410, "account_deleted") }),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("does not swallow a 401", async () => {
    const failed = keyStatus(ACCOUNT, await vaultFor(ACCOUNT), {
      sessionToken: "t",
      fetch: httpFetch(401, "unauthorized"),
    });
    await expect(failed).rejects.toBeInstanceOf(ApiError);
    await expect(failed).rejects.toMatchObject({ status: 401 });
  });
});
