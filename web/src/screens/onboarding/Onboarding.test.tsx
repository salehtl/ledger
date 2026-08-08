/**
 * The five onboarding screens, driven the way a person drives them.
 *
 * Everything here mounts a REAL screen against a scripted `fetch` and a stub
 * {@link V2Handle}, because the decisions these screens make are the ones a
 * pure test cannot reach: which path a `not_invited` takes, whether the address
 * a walk lands on is the one the server minted, and whether confirming a
 * currency actually puts ops in the outbox rather than merely advancing a step.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SqlDriver } from "@ledger/client/store/driver";

import { MotionProvider } from "../../app/MotionProvider";
import { projectionWith } from "../../test/projectionFixture";
import { emptyFacts, type OnboardingFacts } from "../../v2/onboarding";
import { AccountMismatchError, EnrollmentError, PasskeyError, type V2Handle } from "../../v2/session";
import type { SecretStore } from "@ledger/client/store/store";

import { Onboarding } from "./Onboarding";
import { Welcome } from "./Welcome";

// ---------------------------------------------------------------------------
// Rigs
// ---------------------------------------------------------------------------

const ADDRESS = "u-7f3a91c4@in.sirdab.ae";

/**
 * A REAL projection behind every rig, because the finish screen reads one.
 *
 * The stub `{} as never` that used to sit in `driver` was fine while no step
 * touched the database, and stopped being fine the moment the plan control had
 * to read the plan the account already holds before offering to replace it —
 * which is the whole of Task 1. A stub there fails as a thrown render, not as a
 * quiet wrong answer, but the walk that reaches the finish screen is driven by
 * several tests here and all of them need it.
 */
let db: SqlDriver;

beforeEach(async () => {
  db = await projectionWith();
});

function memorySecrets(): SecretStore {
  const held = new Map<string, string>();
  return {
    get: (k) => held.get(k) ?? null,
    set: (k, v) => {
      if (v === null) held.delete(k);
      else held.set(k, v);
    },
  };
}

interface HandleRig {
  handle: V2Handle;
  /** Every op spec `emitMany` was handed, flattened. */
  emitted: { type: string; payload: unknown }[];
  /** What `Client.pending` reports — the outbox depth. */
  pending: { op_id: string; type: string }[];
}

function handleRig(over: { signUp?: () => Promise<void>; signIn?: () => Promise<void> } = {}): HandleRig {
  const out: HandleRig = {
    emitted: [],
    pending: [],
    handle: null as unknown as V2Handle,
  };
  out.handle = {
    signedIn: () => true,
    signUp: over.signUp ?? (async () => {}),
    signIn: over.signIn ?? (async () => {}),
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
      get pending() {
        return out.pending;
      },
      emitMany(specs: readonly { type: string; payload: unknown }[]) {
        for (const s of specs) {
          out.emitted.push({ type: s.type, payload: s.payload });
          out.pending.push({ op_id: `op_${String(out.pending.length)}`, type: s.type });
        }
        return [];
      },
      state: () => ({ txns: new Map(), homeCurrency: null }),
    },
  } as unknown as V2Handle;
  return out;
}

/** A `fetch` that answers exactly the routes onboarding calls, and 404s the rest. */
function scriptedFetch(
  over: { quarantine?: unknown; waitlistStatus?: number; waitlistBody?: unknown; hostileTemplates?: boolean } = {},
) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const doFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body) as unknown;
    calls.push({ url, method, body });

    const ok = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/api/v1/templates")) {
      return ok({
        version: "7",
        removed: [],
        templates: [
          // A template's `bank` is a free JSON string set by whoever published
          // it. Nothing on the wire holds it to the grammar `bank_declared` is
          // keyed on, so the picker has to survive both an id it cannot store
          // and one that only survives by being changed.
          ...(over.hostileTemplates === true
            ? [
                { id: "adib.card.v1", bank: "adib_uae", version: 1, normalizer_version: 1, definition: {}, status: "published" },
                { id: "dib.upper.v1", bank: "DIB", version: 1, normalizer_version: 1, definition: {}, status: "published" },
              ]
            : []),
          { id: "dib.card.v1", bank: "dib", version: 1, normalizer_version: 1, definition: {}, status: "published" },
          { id: "dib.account.v1", bank: "dib", version: 1, normalizer_version: 1, definition: {}, status: "published" },
          { id: "enbd.alert.v1", bank: "enbd", version: 1, normalizer_version: 1, definition: {}, status: "published" },
        ],
      });
    }
    if (url.includes("/api/v1/waitlist")) {
      const status = over.waitlistStatus ?? 204;
      if (status === 204) return new Response(null, { status: 204 });
      return ok(over.waitlistBody ?? { error: "invalid_bank", detail: "no" }, status);
    }
    if (url.includes("/api/v1/address")) {
      return ok({ address: ADDRESS, created_at: "2026-08-07T00:00:00Z" });
    }
    if (url.includes("/api/v1/quarantine")) {
      return ok(over.quarantine ?? { items: [], removed: [], action_needed: 0, expiring_soon: 0, complete: true });
    }
    return new Response("no route", { status: 404 });
  });
  return { doFetch: doFetch as unknown as typeof fetch, calls };
}

function mount(facts: OnboardingFacts, rig: HandleRig, doFetch: typeof fetch, done = vi.fn()) {
  const secrets = memorySecrets();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <Onboarding handle={rig.handle} facts={facts} done={done} fetch={doFetch} secrets={secrets} pollMs={0} />
      </QueryClientProvider>
    </MotionProvider>,
  );
  return { done, secrets };
}

/**
 * Signed in, invited, and this device already holds the account keys.
 *
 * `keysReady` is true because the recovery step is covered by its own file:
 * every test here is about a step BEHIND it, and a fixture that left it false
 * would put the recovery screen on the glass for all of them.
 */
function invited(): OnboardingFacts {
  return { ...emptyFacts(), hasSession: true, accountId: "u_1", keysReady: true };
}

// ---------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------

describe("Welcome", () => {
  function mountWelcome(over: Parameters<typeof handleRig>[0] = {}) {
    const rig = handleRig(over);
    const done = vi.fn();
    render(
      <MotionProvider>
        <Welcome handle={rig.handle} done={done} />
      </MotionProvider>,
    );
    return { rig, done };
  }

  it("offers both paths: an invite code to create an account, and one button to sign in", () => {
    mountWelcome();
    expect(screen.getByLabelText("Invite code")).toBeTruthy();
    expect(screen.getByRole("button", { name: /create my account/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeTruthy();
  });

  it("has no email, username or password field anywhere — sign-in is username-less", () => {
    const { container } = render(
      <MotionProvider>
        <Welcome handle={handleRig().handle} done={vi.fn()} />
      </MotionProvider>,
    );
    for (const input of Array.from(container.querySelectorAll("input"))) {
      expect(input.type).not.toBe("password");
      expect(input.type).not.toBe("email");
      expect(`${input.name} ${input.getAttribute("autocomplete") ?? ""}`.toLowerCase()).not.toMatch(
        /username|email|password/,
      );
    }
  });

  it("warns, before the passkey is created, that a lost passkey cannot be recovered", () => {
    mountWelcome();
    const warning = screen.getByTestId("recovery-warning");
    expect(warning.textContent).toMatch(/cannot|no way/i);
    expect(warning.textContent).toMatch(/recover|reset/i);
  });

  it("renders the not-invited copy when the server refuses the code, and keeps the field", async () => {
    const user = userEvent.setup();
    const { rig } = mountWelcome({
      signUp: () => Promise.reject(new PasskeyError("not_invited", "403 not_invited", { status: 403, code: "not_invited" })),
    });
    await user.type(screen.getByLabelText("Invite code"), "ABC123");
    await user.click(screen.getByRole("button", { name: /create my account/i }));

    await waitFor(() => {
      expect(screen.getByTestId("not-invited")).toBeTruthy();
    });
    expect(screen.getByTestId("not-invited").textContent).toMatch(/single use|one at a time/i);
    // The code is still there to correct rather than retyped from scratch.
    expect((screen.getByLabelText("Invite code") as HTMLInputElement).value).toBe("ABC123");
    expect(rig.handle).toBeTruthy();
  });

  it("keeps a later failure on the not-invited screen instead of bouncing to the front door", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    mountWelcome({
      signUp: () => {
        attempt += 1;
        return Promise.reject(
          attempt === 1
            ? new PasskeyError("not_invited", "403", { status: 403, code: "not_invited" })
            : new PasskeyError("rate_limited", "429", { status: 429, code: "rate_limited" }),
        );
      },
    });

    await user.type(screen.getByLabelText("Invite code"), "ABC123");
    await user.click(screen.getByRole("button", { name: /create my account/i }));
    await screen.findByTestId("not-invited");

    await user.click(screen.getByRole("button", { name: /try this code/i }));

    // Still here, with the code intact and the real reason on screen.
    expect(await screen.findByTestId("not-invited-failure")).toBeTruthy();
    expect(screen.getByTestId("welcome-not-invited")).toBeTruthy();
    expect((screen.getByLabelText("Invite code") as HTMLInputElement).value).toBe("ABC123");
  });

  /** Signs in as a different account than this browser profile is bound to. */
  function mountMismatch(pending: { op_id: string; type: string }[]) {
    const rig = handleRig({ signIn: () => Promise.reject(new AccountMismatchError("u_old", "u_new")) });
    rig.pending = pending;
    const wipe = vi.fn(async () => {});
    render(
      <MotionProvider>
        <Welcome handle={rig.handle} done={vi.fn()} wipe={wipe} />
      </MotionProvider>,
    );
    return { rig, wipe };
  }

  it("offers to clear the browser when this profile holds another account", async () => {
    const user = userEvent.setup();
    const { rig, wipe } = mountMismatch([]);

    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    const notice = await screen.findByTestId("account-mismatch");
    // The reassurance, in its narrow and true form.
    expect(notice.textContent).toMatch(/already.*synced.*safe on the server/is);
    // With nothing unsynced there is no warning and no arming step.
    expect(screen.queryByTestId("unsynced-warning")).toBeNull();

    await user.click(screen.getByRole("button", { name: /clear this browser's data/i }));
    await waitFor(() => {
      expect(wipe).toHaveBeenCalledWith(rig.handle);
    });
  });

  it("never promises nothing was lost when unsynced work would be destroyed", async () => {
    const user = userEvent.setup();
    const { wipe } = mountMismatch([
      { op_id: "o1", type: "txn_add" },
      { op_id: "o2", type: "txn_categorize" },
    ]);

    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    const warning = await screen.findByTestId("unsynced-warning");
    expect(warning.textContent).toMatch(/2 changes have never been sent/i);
    expect(warning.textContent).toMatch(/permanently/i);
    // The old, false blanket reassurance must not be anywhere on the screen.
    expect(document.body.textContent).not.toMatch(/untouched on the server/i);

    // Destructive and unrecoverable, so it is inert until acknowledged.
    const clear = screen.getByRole("button", { name: /clear this browser's data/i });
    expect(clear).toHaveProperty("disabled", true);
    await user.click(clear);
    expect(wipe).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: /unsent work will be destroyed/i }));
    await user.click(clear);
    await waitFor(() => {
      expect(wipe).toHaveBeenCalled();
    });
  });

  it("treats an unreadable outbox as risky rather than as empty", async () => {
    const user = userEvent.setup();
    const rig = handleRig({ signIn: () => Promise.reject(new AccountMismatchError("u_old", "u_new")) });
    Object.defineProperty(rig.handle.client, "pending", {
      get() {
        throw new Error("store is degraded");
      },
    });
    render(
      <MotionProvider>
        <Welcome handle={rig.handle} done={vi.fn()} wipe={vi.fn(async () => {})} />
      </MotionProvider>,
    );

    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    const warning = await screen.findByTestId("unsynced-warning");
    expect(warning.textContent).toMatch(/cannot tell whether/i);
    expect(screen.getByRole("button", { name: /clear this browser's data/i })).toHaveProperty("disabled", true);
  });

  it("signs in with one button and no argument at all", async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(async () => {});
    const { done } = mountWelcome({ signIn });
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => {
      expect(done).toHaveBeenCalled();
    });
    expect(signIn).toHaveBeenCalledWith();
  });

  /**
   * A SECOND device: the passkey works, the session lands, and only the writer
   * enrolment is refused (spec §3.4 — no enrolled key signed for it). Reporting
   * that as "the server refused the request, nothing was created on this
   * device" is false twice over, and it is what made a second device a dead
   * end. The gate owns this state, so the screen hands off.
   */
  it("hands an enrolment refusal to the boot gate instead of calling sign-in failed", async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(async () => {
      throw new EnrollmentError("rejected", "403 registration_rejected");
    });
    const { done } = mountWelcome({ signIn });
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => {
      expect(done).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("welcome-failure")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Bank → Address
// ---------------------------------------------------------------------------

describe("the bank and address walk", () => {
  it("lists the banks the server has templates for, and lands on the minted address", async () => {
    const user = userEvent.setup();
    const rig = handleRig();
    const { doFetch } = scriptedFetch();
    mount(invited(), rig, doFetch);

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /dubai islamic bank/i })).toBeTruthy();
    });
    // Two templates for `dib`, one row.
    expect(screen.getAllByRole("checkbox", { name: /dubai islamic bank/i })).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: /emirates nbd/i })).toBeTruthy();

    await user.click(screen.getByRole("checkbox", { name: /dubai islamic bank/i }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    expect(rig.emitted).toEqual([{ type: "bank_declared", payload: { bank: "dib", active: true } }]);
    await waitFor(() => {
      expect(screen.getByTestId("inbound-address").textContent).toBe(ADDRESS);
    });
  });

  it("declares SEVERAL banks, one op each, because people bank in more than one place", async () => {
    // The multi-select. One op per bank rather than one carrying a list: two
    // devices each adding a different bank offline both survive.
    const user = userEvent.setup();
    const rig = handleRig();
    const { doFetch } = scriptedFetch();
    mount(invited(), rig, doFetch);

    await user.click(await screen.findByRole("checkbox", { name: /dubai islamic bank/i }));
    await user.click(screen.getByRole("checkbox", { name: /emirates nbd/i }));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    expect(rig.emitted).toEqual([
      { type: "bank_declared", payload: { bank: "dib", active: true } },
      { type: "bank_declared", payload: { bank: "enbd", active: true } },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId("inbound-address").textContent).toBe(ADDRESS);
    });
  });

  it("does not offer a template id it could not declare, rather than blanking the app on the tap", async () => {
    // `bankDeclaredOps` throws for a name the grammar cannot store, and there is
    // no error boundary in web/src — a throw in this onClick unmounts the tree
    // and the user sees a blank page. The id is left out of the list instead.
    // "DIB" is the quiet one: it folds to "dib", so declaring it would key a row
    // the picker cannot then untick.
    const user = userEvent.setup();
    const rig = handleRig();
    const { doFetch } = scriptedFetch({ hostileTemplates: true });
    mount(invited(), rig, doFetch);

    await waitFor(() => {
      expect(screen.getByTestId("bank-row-dib")).toBeTruthy();
    });
    expect(screen.queryByTestId("bank-row-adib_uae")).toBeNull();
    expect(screen.queryByTestId("bank-row-DIB")).toBeNull();
    // One row for `dib`, not two, and it still declares cleanly.
    expect(screen.getAllByRole("checkbox", { name: /dubai islamic bank/i })).toHaveLength(1);
    await user.click(screen.getByTestId("bank-row-dib"));
    await user.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(rig.emitted).toEqual([{ type: "bank_declared", payload: { bank: "dib", active: true } }]);
  });

  it("ticks the supported bank instead of waitlisting one ledger already reads", async () => {
    // Typing the display name of a bank on the list used to declare
    // `dubai islamic bank` — a phantom third row for one bank — and ask the
    // demand counter for a parser that already exists.
    const user = userEvent.setup();
    const rig = handleRig();
    const { doFetch, calls } = scriptedFetch();
    mount(invited(), rig, doFetch);

    await user.type(await screen.findByLabelText("Bank name"), "Dubai Islamic Bank");
    await user.click(screen.getByRole("button", { name: /request support/i }));

    expect(calls.some((c) => c.url.includes("/api/v1/waitlist"))).toBe(false);
    expect(screen.getByTestId("bank-row-dib").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("bank-already-supported").textContent).toMatch(/already reads dubai islamic bank/i);

    await user.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(rig.emitted).toEqual([{ type: "bank_declared", payload: { bank: "dib", active: true } }]);
  });

  it("cannot be left with nothing declared — Continue is dead until a bank is ticked", async () => {
    const rig = handleRig();
    const { doFetch } = scriptedFetch();
    mount(invited(), rig, doFetch);
    expect(await screen.findByRole("button", { name: /^continue$/i })).toHaveProperty("disabled", true);
    expect(rig.emitted).toHaveLength(0);
  });

  it("records an unsupported bank on the waitlist and still lets the user through", async () => {
    const user = userEvent.setup();
    const rig = handleRig();
    const { doFetch, calls } = scriptedFetch();
    mount(invited(), rig, doFetch);

    await waitFor(() => {
      expect(screen.getByLabelText("Bank name")).toBeTruthy();
    });
    await user.type(screen.getByLabelText("Bank name"), "Mashreq");
    await user.click(screen.getByRole("button", { name: /request support/i }));

    await waitFor(() => {
      expect(screen.getByTestId("waitlist-confirmation")).toBeTruthy();
    });
    const posted = calls.find((c) => c.url.includes("/api/v1/waitlist"));
    expect(posted?.body).toEqual({ bank: "mashreq" });
    // Stops on the confirmation rather than walking straight on: the point of
    // the step is that this bank cannot be read yet.
    expect(screen.queryByTestId("inbound-address")).toBeNull();
    expect(rig.emitted).toHaveLength(0);

    // Carrying on declares the bank under the name they typed: ledger cannot
    // read it yet, but it is still where they bank, and Settings lists it.
    await user.click(screen.getByRole("button", { name: /carry on setting up/i }));
    expect(rig.emitted).toEqual([{ type: "bank_declared", payload: { bank: "mashreq", active: true } }]);
    await waitFor(() => {
      expect(screen.getByTestId("inbound-address").textContent).toBe(ADDRESS);
    });
  });

  it("keeps the grammar refusal from being a dead end, and declares the sentinel on the way past", async () => {
    const user = userEvent.setup();
    const rig = handleRig();
    const { doFetch, calls } = scriptedFetch();
    mount(invited(), rig, doFetch);

    await user.type(await screen.findByLabelText("Bank name"), "Mashreq (UAE)");
    await user.click(screen.getByRole("button", { name: /request support/i }));
    // Refused here, with the rule, rather than as a 400 rendered "Try again."
    expect(screen.getByTestId("bank-name-rule").textContent).toMatch(/not a name this list can store/i);
    expect(calls.some((c) => c.url.includes("/api/v1/waitlist"))).toBe(false);

    await user.click(screen.getByRole("button", { name: /continue without adding it/i }));
    expect(rig.emitted).toEqual([{ type: "bank_declared", payload: { bank: "other", active: true } }]);
  });

  /**
   * The direct route, end to end through the real machine: no forwarder, no
   * confirmation, and the same waiting-for-first-mail step at the end of it.
   *
   * Worth driving here rather than in `Address.test.tsx` alone, because the
   * thing being checked is that a route chosen on one screen reaches the copy on
   * the NEXT one — which is exactly the join a component test cannot see.
   */
  it("walks the direct-with-the-bank route to the same waiting step, with no code to enter", async () => {
    const user = userEvent.setup();
    const rig = handleRig();
    const { doFetch } = scriptedFetch();
    mount({ ...invited(), banks: ["dib"], inboundAddress: ADDRESS }, rig, doFetch);

    await user.click(await screen.findByRole("button", { name: /with your bank directly/i }));
    await user.click(screen.getByRole("button", { name: /i have set this address with my bank/i }));

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toMatch(/waiting for your first bank email/i);
    expect(screen.getByTestId("verification").textContent).not.toMatch(/confirmation code is held|forwarding rule/i);
    // The gate has not moved: nothing is in the log, so nothing advances.
    expect(screen.queryByTestId("onboarding-finish")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HomeCurrency
// ---------------------------------------------------------------------------

describe("the home currency picker", () => {
  function atCurrency(): OnboardingFacts {
    return {
      ...invited(),
      banks: ["dib"],
      inboundAddress: ADDRESS,
      forwardingDeclared: true,
      firstMailConfirmedAt: "2026-08-01T00:00:00Z",
    };
  }

  it("puts the ops in the outbox only after the permanence is acknowledged", async () => {
    const user = userEvent.setup();
    const rig = handleRig();
    const { doFetch } = scriptedFetch();
    mount(atCurrency(), rig, doFetch);

    await user.click(await screen.findByRole("button", { name: /AED — UAE dirham/i }));

    const confirm = screen.getByRole("button", { name: /set aed as my home currency/i });
    expect(confirm).toHaveProperty("disabled", true);
    expect(rig.pending).toHaveLength(0);

    await user.click(screen.getByRole("checkbox", { name: /AED is permanent/i }));
    await user.click(confirm);

    await waitFor(() => {
      // The op AND the AED USD peg — two ops, one outbox write.
      expect(rig.pending).toHaveLength(2);
    });
    expect(rig.emitted.map((o) => o.type)).toEqual(["home_currency_set", "rate_set"]);
    expect(rig.emitted[0]?.payload).toEqual({ currency: "AED" });
  });

  it("never says the choice can be changed later", async () => {
    const user = userEvent.setup();
    const rig = handleRig();
    const { doFetch } = scriptedFetch();
    mount(atCurrency(), rig, doFetch);
    await user.click(await screen.findByRole("button", { name: /USD — US dollar/i }));
    const panel = screen.getByTestId("home-currency-consequence");
    expect(within(panel).getByText(/delete your account/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/change this later|change it later|in settings later/i);
  });
});

// ---------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------

/**
 * The finish screen carries the plan control, and the plan control authors a
 * whole `budget_split_set` — which REPLACES the plan. Every device that had to
 * secure keys used to land here: a second phone, a cleared browser, a failing
 * `GET /api/v1/keys`. `resumeFacts` no longer routes them here, and this is the
 * other half — that the control, when it IS shown, reads what the account
 * already holds first.
 *
 * The driver is a REAL projection and no source is injected, so what is under
 * test is the production wiring: `Onboarding` handing the finish screen this
 * device's projection.
 */
describe("the finish screen", () => {
  function atFinish(): OnboardingFacts {
    return {
      ...invited(),
      banks: ["dib"],
      inboundAddress: ADDRESS,
      forwardingDeclared: true,
      firstMailConfirmedAt: "2026-08-01T00:00:00Z",
      homeCurrency: "AED",
    };
  }

  function mountFinish(): HandleRig {
    db.prepare("INSERT INTO budget_split (id,need,want,saving,monthly_total_minor) VALUES (1,60,20,20,'1200000')").run();
    const rig = handleRig();
    const { doFetch } = scriptedFetch();
    mount(atFinish(), rig, doFetch);
    return rig;
  }

  it("shows the plan the account already holds rather than an empty picker", async () => {
    mountFinish();
    await screen.findByTestId("onboarding-finish");
    const needs = (await screen.findByLabelText(/Needs/)) as HTMLInputElement;
    await waitFor(() => {
      expect(needs.value).toBe("60");
    });
    expect(screen.getByLabelText(/monthly budget/i)).toHaveValue("12000.00");
  });

  it("does not clear a monthly total set on another device", async () => {
    const user = userEvent.setup();
    const rig = mountFinish();
    await screen.findByTestId("onboarding-finish");
    const needs = (await screen.findByLabelText(/Needs/)) as HTMLInputElement;
    await waitFor(() => {
      expect(needs).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: /save plan/i }));
    expect(rig.emitted).toEqual([
      { type: "budget_split_set", payload: { need: 60, want: 20, saving: 20, monthly_total_minor: "1200000" } },
    ]);
  });
});
