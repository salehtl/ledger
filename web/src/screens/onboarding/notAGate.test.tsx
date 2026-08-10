/**
 * **The test that encodes the whole design: onboarding cannot lock anybody out.**
 *
 * A brand-new account skips every optional step — address, forwarding, home
 * currency — reaches the product, and adds a transaction by hand. If this
 * passes, there is no configuration a user can fail to complete that keeps them
 * out of their own app. (There is no bank step to skip: the bank question left
 * the walk, and mail proves the bank.)
 *
 * It is driven through the REAL boot gate and the REAL walk, because the failure
 * it guards against is a join and not a screen. Both lockouts on the day this
 * was written were joins: a mail quota that ate a provider's confirmation, and
 * one predicate that refused the only message a step could proceed on. Neither
 * would have been caught by a component test of the screen that stopped.
 *
 * The address read here FAILS, deliberately. That is the shape of the whole
 * class: one network call, no second door. Before the skip existed, the address
 * screen's only control was "Try again", so a user whose address could not be
 * minted had no way past it at all.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { NetworkError } from "@ledger/client/net/client";
import type { OpSpec } from "@ledger/client/outbox/outbox";
import type { SqlDriver } from "@ledger/client/store/driver";
import type { Op } from "@ledger/client/wire/op";

import { MotionProvider } from "../../app/MotionProvider";
import { ToastProvider } from "../../components/Toast";
import { CLEAN_SYNC, fakeEngine } from "../../test/engineDouble";
import { projectionWith } from "../../test/projectionFixture";
import { BootGate, PROFILE } from "../../v2/BootGate";
import { memoryKeyVault } from "../../v2/keys";
import { SyncCoordinator } from "../../v2/engine";
import { loadLocalRecord, onboardingComplete, resumeFacts, ONBOARDING_LOCAL_KEY } from "../../v2/onboarding";
import { sqlReviewSource } from "../../v2/sources/review";
import { sqlTxnSource } from "../../v2/sources/transactions";
import { webSecretStore, type V2Handle } from "../../v2/session";
import type { Writer } from "../../v2/writer";
import { Transactions } from "../Transactions";
import { Onboarding } from "./Onboarding";

let db: SqlDriver;

beforeEach(async () => {
  localStorage.clear();
  db = await projectionWith();
});

/** A writer that records what the product would have authored. */
function recorder(): Writer & { queued: OpSpec[] } {
  const queued: OpSpec[] = [];
  return {
    queued,
    get pending(): readonly Op[] {
      return [];
    },
    enqueueMany: (specs) => queued.push(...specs),
    flush: async () => {},
  };
}

/**
 * An account with a session, keys, and **nothing else**: no bank in the log, no
 * home currency, and a server that will not hand over an address.
 */
function freshAccount() {
  const emitted: { type: string; payload: unknown }[] = [];
  const handle = {
    signedIn: () => true,
    enrol: async () => {},
    signOut: async () => {},
    close: () => {},
    driver: db,
    client: {
      get userId() {
        return "u_1";
      },
      get sessionToken() {
        return "tok";
      },
      get writerId() {
        return "web-1";
      },
      emitMany(specs: readonly { type: string; payload: unknown }[]) {
        emitted.push(...specs);
        return [];
      },
      state: () => ({ txns: new Map(), homeCurrency: null, banks: new Map() }),
    },
  } as unknown as V2Handle;
  return { handle, emitted, coordinator: new SyncCoordinator(fakeEngine({ sync: async () => CLEAN_SYNC })) };
}

function mountApp(account: ReturnType<typeof freshAccount>, writer: Writer) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <BootGate
            open={async () => account.handle}
            engine={() => account.coordinator}
            // The failure that used to be a dead end.
            address={async () => {
              throw new NetworkError("GET /api/v1/address: offline", null);
            }}
            keysReady={async () => true}
            wipe={async () => {}}
            onboarding={({ handle, facts, done }) => (
              <Onboarding
                handle={handle}
                facts={facts}
                done={done}
                fetch={
                  (async () =>
                    new Response(JSON.stringify({ templates: [] }), {
                      status: 200,
                      headers: { "Content-Type": "application/json" },
                    })) as unknown as typeof fetch
                }
              />
            )}
          >
            <Transactions source={sqlTxnSource(db)} reviewSource={sqlReviewSource(db)} writer={writer} />
          </BootGate>
        </ToastProvider>
      </QueryClientProvider>
    </MotionProvider>,
  );
}

/**
 * The skip control for one step: the BUTTON, not the block around it.
 *
 * Found by the step it belongs to rather than by its label, because every one of
 * them says the same four words — which is deliberate. "Set this up later" is
 * one answer the product gives everywhere, not four differently-worded escapes.
 */
async function skipButton(step: string): Promise<HTMLElement> {
  const block = await screen.findByTestId(`skip-${step}`, {}, { timeout: 3000 });
  return within(block).getByRole("button", { name: /set this up later/i });
}

/**
 * The same account, opened on a device that holds no keys yet — so the walk
 * starts at the one step that is still a hard gate.
 *
 * `keysReady: false` is what puts the key ceremony on the glass, and the
 * scripted `fetch` answers the two calls it makes: no published keys (404), and
 * a `PUT` that accepts them.
 */
function mountWithKeyCeremony(writer: Writer) {
  const account = freshAccount();
  const vault = memoryKeyVault();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Flipped by the ceremony's own PUT, so the boot that follows sees what the
  // ceremony actually did rather than a constant.
  let keysPublished = false;
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/keys")) {
      if (init?.method === "PUT") {
        keysPublished = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }
    return new Response(JSON.stringify({ templates: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <BootGate
            open={async () => account.handle}
            engine={() => account.coordinator}
            address={async () => {
              throw new NetworkError("GET /api/v1/address: offline", null);
            }}
            keysReady={async () => keysPublished}
            wipe={async () => {}}
            onboarding={({ handle, facts, done }) => (
              <Onboarding handle={handle} facts={facts} done={done} fetch={doFetch} vault={vault} server="" />
            )}
          >
            <Transactions source={sqlTxnSource(db)} reviewSource={sqlReviewSource(db)} writer={writer} />
          </BootGate>
        </ToastProvider>
      </QueryClientProvider>
    </MotionProvider>,
  );
  return account;
}

describe("onboarding is not a gate", () => {
  /**
   * The recovery phrase stays mandatory — there is no account without keys —
   * but it is no longer a two-screen ritual. The operator's instruction, in his
   * words: the user is trusted to store the words the way they wish, and the app
   * does not need to double check.
   */
  it("walks from a new account to the product without typing a word of the phrase", async () => {
    const user = userEvent.setup();
    mountWithKeyCeremony(recorder());

    // The one gate: the words, in full, with the warning that they cannot be
    // recovered.
    const words = await screen.findByTestId("recovery-phrase-words", {}, { timeout: 10_000 });
    expect(within(words).getAllByRole("listitem")).toHaveLength(12);
    expect(document.body.textContent ?? "").toMatch(/the account is gone/i);
    // And no field asking for any of them back, here or after the press.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /i have written these down/i }));

    // Straight on to the optional steps, all of which are skippable. The first
    // is the address: there is no bank question.
    await user.click(await skipButton("address_issued"));
    await user.click(await skipButton("home_currency_set"));
    await user.click(await screen.findByRole("button", { name: /open ledger/i }));

    expect(await screen.findByRole("button", { name: "Add transaction" }, { timeout: 5000 })).toBeInTheDocument();
    // Not one text field was typed into on the way here.
    expect(screen.queryByTestId("onboarding-recovery-confirm")).toBeNull();
  }, 60_000);

  it("skips every optional step, reaches the product, and adds a transaction by hand", async () => {
    const user = userEvent.setup();
    const account = freshAccount();
    const writer = recorder();
    mountApp(account, writer);

    // 1. The address, whose read just failed. The skip is on screen anyway —
    //    that is the point of it. (No bank question: the walk starts here.)
    await screen.findByTestId("address-failed");
    await user.click(await skipButton("address_issued"));

    // 2. The forwarding step went with it: they are one subject, and a page of
    //    forwarding instructions with no address on it points at nothing.
    expect(screen.queryByTestId("forwarding")).toBeNull();

    // 3. The home currency — the one irreversible choice, and therefore exactly
    //    the one a person is allowed to sleep on.
    await user.click(await skipButton("home_currency_set"));

    // 4. Out.
    await user.click(await screen.findByRole("button", { name: /open ledger/i }));

    // THE PRODUCT. Not a wall, not a "finish setting up first".
    const add = await screen.findByRole("button", { name: "Add transaction" }, { timeout: 3000 });

    // Nothing was authored on the way through: skipping is not doing a thing.
    expect(account.emitted).toEqual([]);

    // And the fallback the design leans on is real.
    await user.click(add);
    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText("Amount"), "12.50");
    await user.type(screen.getByLabelText("Merchant"), "CORNER COFFEE");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(writer.queued).toHaveLength(1);
    });
    expect(writer.queued[0]?.type).toBe("txn_ingested");
  }, 30_000);

  it("remembers the skips, so a reload opens the app rather than the walk again", async () => {
    const user = userEvent.setup();
    const account = freshAccount();
    const first = mountApp(account, recorder());

    await user.click(await skipButton("address_issued"));
    await user.click(await skipButton("home_currency_set"));
    await user.click(await screen.findByRole("button", { name: /open ledger/i }));
    await screen.findByRole("button", { name: "Add transaction" }, { timeout: 3000 });

    // The device-local record is the only place a declined step can be
    // recorded — nothing in the log or on the server says "not now".
    expect(localStorage.getItem(`ledger-v2:ledger:${ONBOARDING_LOCAL_KEY}`) ?? "").toMatch(/address_issued/);

    first.unmount();
    mountApp(freshAccount(), recorder());
    // Straight to the product: no bank step, no address step.
    expect(await screen.findByRole("button", { name: "Add transaction" }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByTestId("bank")).toBeNull();
  }, 30_000);
});

/**
 * The same account, walked the DECLARED way: keys, an address the server
 * mints, "I have set up forwarding", a currency chosen — every question
 * answered rather than deferred.
 *
 * The scripted `fetch` answers the walk's four routes: the key ceremony
 * (404 then a PUT that accepts), the address read, an empty held-mail lane,
 * and templates.
 */
function mountDeclaredWalk(writer: Writer) {
  const account = freshAccount();
  const vault = memoryKeyVault();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let keysPublished = false;
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/keys")) {
      if (init?.method === "PUT") {
        keysPublished = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }
    if (url.includes("/api/v1/address")) {
      return json({ address: "u-7f3a91c4@in.sirdab.ae", created_at: "2026-08-07T00:00:00Z" });
    }
    if (url.includes("/api/v1/quarantine")) {
      return json({ items: [], action_needed: 0, expiring_soon: 0 });
    }
    return json({ templates: [] });
  }) as unknown as typeof fetch;

  const view = render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <BootGate
            open={async () => account.handle}
            engine={() => account.coordinator}
            // Boot has no address to hand the walk, so the address STEP is on
            // the glass and the screen's own read is what mints one.
            address={async () => null}
            keysReady={async () => keysPublished}
            wipe={async () => {}}
            onboarding={({ handle, facts, done }) => (
              <Onboarding handle={handle} facts={facts} done={done} fetch={doFetch} vault={vault} server="" />
            )}
          >
            <Transactions source={sqlTxnSource(db)} reviewSource={sqlReviewSource(db)} writer={writer} />
          </BootGate>
        </ToastProvider>
      </QueryClientProvider>
    </MotionProvider>,
  );
  return { account, view };
}

describe("the declared path is remembered", () => {
  /**
   * The complement of the skip walk above, and the E2E replay of the resume
   * loop (2026-08-09): the user does everything the walk asks — and no bank
   * mail EVER arrives, because arrival needs them to spend money. Then the
   * device reloads three times with every account fact regressed at once: the
   * address read fails, and the log is empty again (so the currency set on
   * mount 1 is gone too, and `firstMailConfirmedAt` is still null). Only the
   * device-local record can hold the door open. Before the record remembered
   * the declaration and the finish, every one of these reloads bounced the
   * user back to "Send your bank mail here".
   */
  it("declares forwarding, finishes, and three regressed reloads later is still in the app — no mail ever arrived", async () => {
    const user = userEvent.setup();
    const { account, view } = mountDeclaredWalk(recorder());

    // 1. Keys — the one hard gate.
    await screen.findByTestId("recovery-phrase-words", {}, { timeout: 10_000 });
    await user.click(screen.getByRole("button", { name: /i have written these down/i }));

    // 2. The address, freshly minted by the screen's own read.
    await user.click(await screen.findByRole("button", { name: /i have my address/i }, { timeout: 5000 }));

    // 3. The declaration — the user's answer, not the world's evidence.
    await user.click(await screen.findByRole("button", { name: /i have set up forwarding/i }));

    // 4. The currency, SET rather than skipped — so on later boots no skip
    //    record and no account fact can re-derive "finished". The log below is
    //    empty on every reload; the record alone holds the door shut.
    await user.click(await screen.findByRole("button", { name: /AED — UAE dirham/i }));
    await user.click(screen.getByRole("checkbox", { name: /AED is permanent/i }));
    await user.click(screen.getByRole("button", { name: /set aed as my home currency/i }));

    // 5. Out, through the finish screen.
    await user.click(await screen.findByRole("button", { name: /open ledger/i }));
    await screen.findByRole("button", { name: "Add transaction" }, { timeout: 5000 });

    // The currency went through the real outbox path on the way.
    expect(account.emitted.map((o) => o.type)).toEqual(["home_currency_set", "rate_set"]);

    // The record, resumed exactly the way boot resumes it, with every account
    // fact regressed and mail never arrived: still declared, still complete.
    const record = loadLocalRecord(webSecretStore(PROFILE));
    expect(record?.forwardingDeclared).toBe(true);
    expect(record?.finishedAt).toBeTruthy();
    const resumed = resumeFacts({
      hasSession: true,
      accountId: "u_1",
      keysReady: true,
      banks: [],
      inboundAddress: null, // the address read failed on this launch
      firstMailConfirmedAt: null, // no bank mail, still
      homeCurrency: null, // the log regressed too
      local: record,
    });
    expect(resumed.forwardingDeclared).toBe(true);
    expect(onboardingComplete(resumed)).toBe(true);

    // 6. Three reloads through the REAL gate, each one fully regressed
    //    (`mountApp`'s address read throws; `freshAccount`'s log is empty).
    //    Every one opens the product; none re-enters the walk.
    view.unmount();
    for (let reload = 1; reload <= 3; reload++) {
      const again = mountApp(freshAccount(), recorder());
      expect(await screen.findByRole("button", { name: "Add transaction" }, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.queryByTestId("forwarding")).toBeNull();
      expect(screen.queryByTestId("skip-home_currency_set")).toBeNull();
      again.unmount();
    }
  }, 60_000);
});
