/**
 * The twelve qualifications, and the rule that skipping a step must never skip
 * a warning.
 *
 * Onboarding now has a way past almost every screen. The obvious way to get
 * that wrong is to make a warning skippable along with the step it sits on, or
 * to shorten one while moving it — so these are enumerated by hand, and asserted
 * as **rendered on the screen that carries them**, not merely as present in a
 * constants file. A string nothing draws is a promise nobody read.
 *
 * The twelve, in the order they are asserted:
 *
 *  1. The passkey has no recovery — the account is gone (`RECOVERY_WARNING`,
 *     on the front door, before the passkey is created).
 *  2. Clearing this browser without the words is unrecoverable
 *     (`RECOVERY_PHRASE_COPY.noWayBack`).
 *  3. There is no way around the entry screen, and nobody can let you in
 *     (`RECOVERY_ENTRY_COPY.noWayBack`).
 *  4. What encryption protects: sealed before storage, ciphertext on a stolen
 *     disk (`whatItProtects`).
 *  5. What it does not: **ledger does see each email as it arrives**
 *     (`whatItDoesNot`). Four and five are a pair and neither may be shown
 *     without the other.
 *  6. The phrase WRITES as well as reads, on the generate screen.
 *  7. The same, on the entry screen.
 *  8. The wipe distinction: what is synced is safe, what was never sent is
 *     destroyed — with the count of it.
 *  9. Held mail is filed under the domain that SIGNED it.
 * 10. Pressing trust on your bank's mail files its alerts from now on.
 * 11. Pressing it on a provider's confirmation trusts everything that provider
 *     relays.
 * 12. ledger blocks that for the providers it recognises — but the safe rule is
 *     only your bank.
 *
 * Nine through twelve are the four clauses of `TRUST_ONLY_YOUR_BANK`, which was
 * deleted once on reasoning that turned out to be backwards, and which the
 * operator then hit as a live refusal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { generateAccountKeys, wrapAccountKeys } from "@ledger/client/crypto/keys";
import { generatePhrase } from "@ledger/client/crypto/phrase";
import { webPlatform } from "@ledger/client/platform.web";

import { MotionProvider } from "../../app/MotionProvider";
import { memoryKeyVault, type PublishedKeys } from "../../v2/keys";
import {
  RECOVERY_ENTRY_COPY,
  RECOVERY_PHRASE_COPY,
  RECOVERY_WARNING,
  TRUST_ONLY_YOUR_BANK,
} from "../../v2/onboarding";
import { AccountMismatchError, type V2Handle } from "../../v2/session";

import { RecoveryPhrase } from "./RecoveryPhrase";
import { Verification } from "./Verification";
import { Welcome } from "./Welcome";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const FAST = { t: 1, m: 64, p: 1 } as const;

function mount(node: React.ReactElement) {
  return render(<MotionProvider>{node}</MotionProvider>);
}

/** A handle whose sign-in lands on the other account this browser holds. */
function mismatchHandle(pending: { op_id: string; type: string }[]): V2Handle {
  return {
    signedIn: () => true,
    signUp: async () => {},
    signIn: () => Promise.reject(new AccountMismatchError("u_old", "u_new")),
    enrol: async () => {},
    signOut: async () => {},
    close: () => {},
    client: {
      get userId() {
        return "u_1";
      },
      get sessionToken() {
        return "tok";
      },
      get pending() {
        return pending;
      },
      state: () => ({ txns: new Map(), homeCurrency: null }),
    },
  } as unknown as V2Handle;
}

async function publishedKeys(): Promise<PublishedKeys> {
  const phrase = generatePhrase(webPlatform);
  const keys = generateAccountKeys(webPlatform);
  const wrapped = await wrapAccountKeys(phrase, keys, webPlatform, FAST);
  return {
    ingestPub: Uint8Array.from(keys.ingestPub),
    recoveryPub: Uint8Array.from(keys.recoveryPub),
    wrapped,
    keyVersion: 1,
  };
}

/** One held message with a verified signature, so the trust control is drawn. */
const HELD = {
  id: "q1",
  ingest_id: "abc",
  received_at: "2026-08-08T09:00:00Z",
  expires_at: "2026-09-07T09:00:00Z",
  outer_domain: "dib.ae",
  inner_domain: "",
  attested: true,
  attested_by: "DKIM",
  dkim: "pass",
  arc: "none",
  size_bucket: 1,
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [HELD], action_needed: 1, expiring_soon: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
});

describe("the qualifications that may never be dropped", () => {
  it("1. says a lost passkey cannot be recovered, before the passkey is made", () => {
    mount(<Welcome handle={mismatchHandle([])} done={vi.fn()} />);
    const warning = screen.getByTestId("recovery-warning");
    expect(warning.textContent ?? "").toContain(RECOVERY_WARNING.body);
    expect(warning.textContent ?? "").toMatch(/no password to reset/i);
    expect(warning.textContent ?? "").toMatch(/cannot be reached again/i);
  });

  it("2, 4, 5, 6. carries the no-way-back, the pair, and the write capability on the phrase screen", async () => {
    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={memoryKeyVault()}
        io={{ sessionToken: "t", fetch: (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch }}
        published={null}
        onSecured={vi.fn()}
      />,
    );
    await screen.findByTestId("recovery-phrase-words");
    const page = document.body.textContent ?? "";

    // 2. Unrecoverable, in the words that do not hedge.
    expect(page).toContain(RECOVERY_PHRASE_COPY.noWayBack);
    // 6. The phrase writes, not just reads — said where the user decides where
    //    to keep the words, which is the decision it changes.
    expect(page).toContain(RECOVERY_PHRASE_COPY.alsoWrites);

    // 4 and 5: the pair. Either half alone is a misleading privacy claim, and
    // the second is the sentence a kinder edit deletes. Asserted ADJACENT, in
    // this order, because splitting them is how "encrypted at rest" becomes "we
    // can't see it" in a reader's head. They were on the confirmation step
    // until the quiz was removed; a ceremony with one screen has to carry them
    // on that screen or not at all.
    expect(page).toContain(`${RECOVERY_PHRASE_COPY.whatItProtects}${RECOVERY_PHRASE_COPY.whatItDoesNot}`);
    expect(page).toMatch(/does see each email/i);
  }, 30_000);

  it("3, 7. carries the no-way-round and the write capability on the entry screen", async () => {
    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={memoryKeyVault()}
        io={{ sessionToken: "t" }}
        published={await publishedKeys()}
        onSecured={vi.fn()}
      />,
    );
    await screen.findByTestId("recovery-entry-phrase");
    const page = document.body.textContent ?? "";
    expect(page).toContain(RECOVERY_ENTRY_COPY.noWayBack);
    expect(page).toContain(RECOVERY_ENTRY_COPY.alsoWrites);
  }, 30_000);

  it("8. distinguishes synced records from unsent work, and counts the unsent", async () => {
    const user = userEvent.setup();
    mount(
      <MotionProvider>
        <Welcome
          handle={mismatchHandle([
            { op_id: "o1", type: "txn_add" },
            { op_id: "o2", type: "txn_categorize" },
          ])}
          done={vi.fn()}
          wipe={vi.fn(async () => {})}
        />
      </MotionProvider>,
    );
    await user.click(screen.getAllByRole("button", { name: /^sign in$/i })[0]!);

    const notice = await screen.findByTestId("account-mismatch");
    expect(notice.textContent ?? "").toMatch(/already.*synced.*safe on the server/is);
    const warning = await screen.findByTestId("unsynced-warning");
    // The count, and the word that makes it a decision rather than a shrug.
    expect(warning.textContent ?? "").toMatch(/2 changes have never been sent/i);
    expect(warning.textContent ?? "").toMatch(/permanently/i);
  });

  it("9–12. carries all four clauses of the trust warning, above the control that acts on them", async () => {
    mount(
      <Verification
        client={{ sessionToken: "tok" }}
        firstMailAt={() => null}
        pollMs={0}
        server=""
      />,
    );
    const warning = await screen.findByTestId("verification-trust-warning");
    const said = warning.textContent ?? "";
    expect(said).toContain(TRUST_ONLY_YOUR_BANK.title);
    // 9. Filed under the domain that signed it.
    expect(said).toMatch(/domain that signed it/i);
    // 10. On your bank's mail, its alerts are filed from now on.
    expect(said).toMatch(/bank'?s mail and ledger files/i);
    // 11. On a provider's confirmation, everything that provider relays.
    expect(said).toMatch(/everything\s+that provider relays/i);
    // 12. ledger blocks that for the ones it recognises — but the safe rule is
    //     only your bank. "Recognises", never "always catches".
    expect(said).toMatch(/blocks that for the providers it recognises/i);
    expect(said).toMatch(/only your bank/i);

    // Above the button, not below it: a warning under the control it is about
    // is a warning read after the press.
    const item = await screen.findByTestId("verification-item-q1");
    expect(warning.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(item).getByRole("button", { name: /this is my bank/i })).toBeInTheDocument();
  });
});

describe("skipping a step never skips a warning", () => {
  /**
   * The steps that HAVE no skip, asserted as the absence of any control that
   * offers one. Account creation is the only gate the design keeps, and this is
   * what keeps it: a later edit that added "set this up later" to the key
   * ceremony would fail here rather than in review.
   */
  it("offers nothing that defers the key ceremony", async () => {
    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={memoryKeyVault()}
        io={{ sessionToken: "t", fetch: (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch }}
        published={null}
        onSecured={vi.fn()}
      />,
    );
    await screen.findByTestId("recovery-phrase-words");
    expect(screen.queryByTestId(/^skip-/)).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect((button.textContent ?? "").toLowerCase()).not.toMatch(/skip|later|not now|remind me/);
    }
  }, 30_000);

  it("offers nothing that defers entering a phrase this browser needs", async () => {
    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={memoryKeyVault()}
        io={{ sessionToken: "t" }}
        published={await publishedKeys()}
        onSecured={vi.fn()}
      />,
    );
    await screen.findByTestId("recovery-entry-phrase");
    expect(screen.queryByTestId(/^skip-/)).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect((button.textContent ?? "").toLowerCase()).not.toMatch(/skip|later|not now|remind me/);
    }
  }, 30_000);
});
