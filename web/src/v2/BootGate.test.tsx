import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApiError } from "@ledger/client/net/client";
import type { SyncProgress, SyncResult } from "@ledger/client/net/engine";

import { BootGate, deleteBrowserDatabase } from "./BootGate";
import { IDLE_PROGRESS, SyncCoordinator, type CoordinatedEngine } from "./engine";
import { encodeLocal, ONBOARDING_LOCAL_KEY } from "./onboarding";
import { EnrollmentError, type V2Handle } from "./session";

const CLEAN: SyncResult = { pulled: 0, applied: 0, violations: [], halted: false };

const SETTLED = encodeLocal({
  hasSession: true,
  accountId: "u_1",
  bank: "dib",
  inboundAddress: "u-abc@in.sirdab.ae",
  forwardingDeclared: true,
  firstMailConfirmedAt: "2026-08-01T00:00:00Z",
  homeCurrency: "AED",
  finishedAt: "2026-08-02T00:00:00Z",
});

interface Rig {
  handle: V2Handle;
  coordinator: SyncCoordinator;
  publish(p: Partial<SyncProgress>): void;
  enrolCalls: number;
}

function rig(
  over: {
    signedIn?: boolean;
    enrolled?: boolean;
    enrolFails?: unknown;
    sync?: () => Promise<SyncResult>;
    halted?: string | null;
    homeCurrency?: string | null;
    local?: unknown;
  } = {},
): Rig {
  // localStorage IS the secret store's backing (webSecretStore), and the gate
  // builds its own over the "ledger" profile — so the device-local onboarding
  // record has to be planted where that will find it.
  localStorage.setItem(
    `ledger-v2:ledger:${ONBOARDING_LOCAL_KEY}`,
    JSON.stringify(over.local ?? SETTLED),
  );

  let enrolled = over.enrolled ?? false;
  const out: Rig = {
    enrolCalls: 0,
    handle: {
      signedIn: () => over.signedIn ?? true,
      enrol: async () => {
        out.enrolCalls += 1;
        if (over.enrolFails !== undefined) throw over.enrolFails;
        enrolled = true;
      },
      signOut: async () => {},
      close: () => {},
      client: {
        get userId() {
          return "u_1";
        },
        get sessionToken() {
          return "tok";
        },
        state: () => ({
          txns: new Map([["t1", { posted_at: "2026-08-01T00:00:00Z" }]]),
          homeCurrency: over.homeCurrency === undefined ? "AED" : over.homeCurrency,
        }),
        /** The property every write path reads. Throws until enrolment lands. */
        get writerId(): string {
          if (!enrolled) throw new Error("this device is not set up to make changes yet");
          return "web-1";
        },
      },
    } as unknown as V2Handle,
    coordinator: null as unknown as SyncCoordinator,
    publish: () => {},
  };

  const watchers = new Set<(p: SyncProgress) => void>();
  let progress: SyncProgress = { ...IDLE_PROGRESS };
  const engine: CoordinatedEngine = {
    get progress() {
      return { ...progress };
    },
    halted: over.halted ?? null,
    sync: over.sync ?? (async () => CLEAN),
    subscribe: (fn) => {
      watchers.add(fn);
      return () => {
        watchers.delete(fn);
      };
    },
    halt: () => {},
  };
  out.coordinator = new SyncCoordinator(engine);
  out.publish = (patch) => {
    progress = { ...progress, ...patch };
    for (const w of watchers) w({ ...progress });
  };
  return out;
}

function mount(r: Rig, props: Partial<Parameters<typeof BootGate>[0]> = {}) {
  return render(
    <BootGate
      open={async () => r.handle}
      engine={() => r.coordinator}
      address={async () => "u-abc@in.sirdab.ae"}
      wipe={async () => {}}
      {...props}
    >
      <div data-testid="app">the app</div>
    </BootGate>,
  );
}

describe("BootGate", () => {
  it("shows the app once boot lands", async () => {
    mount(rig());
    expect(await screen.findByTestId("app")).toBeInTheDocument();
  });

  it("does not show the app while it is still opening", async () => {
    // `act` so the open() microtask and every state update it causes are
    // flushed before the assertions; the sync itself never settles, which is
    // what keeps the gate in `opening`.
    await act(async () => {
      mount(rig({ sync: () => new Promise<SyncResult>(() => {}) }));
    });
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/opening/i);
  });

  it("renders the sign-in slot when there is no session, and never the app", async () => {
    mount(rig({ signedIn: false }), {
      signIn: () => <div data-testid="welcome">welcome</div>,
    });
    expect(await screen.findByTestId("welcome")).toBeInTheDocument();
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
  });

  it("names the owner of an unfilled slot rather than rendering nothing", async () => {
    mount(rig({ signedIn: false }));
    expect(await screen.findByText(/not built yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Task 7/)).toBeInTheDocument();
  });

  it("resumes onboarding, with the facts, when the device is not set up", async () => {
    const seen: string[] = [];
    mount(rig({ local: { bank: null, forwardingDeclared: false, finishedAt: null, inboundAddress: null } }), {
      onboarding: ({ facts }) => {
        seen.push(String(facts.bank));
        return <div data-testid="onboarding">onboarding</div>;
      },
    });
    expect(await screen.findByTestId("onboarding")).toBeInTheDocument();
    expect(seen).toContain("null");
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
  });

  // -- the half-signed-in repair -------------------------------------------

  it("REPAIRS a device signed in with no writer: it enrols at boot and the app becomes usable", async () => {
    // The exact state Task 5's ceremony can strand a user in — `adoptSession`
    // ran, `enrolThisDevice` did not. Before the repair, `writerId` throws and
    // every write with it.
    const r = rig({ enrolled: false });
    expect(() => r.handle.client.writerId).toThrow(/not set up to make changes/);

    mount(r);

    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(r.enrolCalls).toBeGreaterThan(0);
    // Usable, not merely rendered: the property every write path reads answers.
    expect(r.handle.client.writerId).toBe("web-1");
  });

  it("walls off the app, retryably, when the repair itself fails", async () => {
    const r = rig({ enrolled: false, enrolFails: new EnrollmentError("offline", "no connection") });
    mount(r);
    expect(await screen.findByText(/could not finish setting up this device/i)).toBeInTheDocument();
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("recovers when the retry succeeds — the wall is not a dead end", async () => {
    let fail = true;
    const r = rig({ enrolled: false });
    const handle = r.handle as unknown as { enrol: () => Promise<void> };
    const enrol = handle.enrol.bind(handle);
    handle.enrol = async () => {
      if (fail) throw new EnrollmentError("offline", "no connection");
      await enrol();
    };

    mount(r);
    const retry = await screen.findByRole("button", { name: /try again/i });
    fail = false;
    await userEvent.click(retry);

    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(r.handle.client.writerId).toBe("web-1");
  });

  it("offers no retry when the server refused this device outright", async () => {
    mount(rig({ enrolled: false, enrolFails: new EnrollmentError("rejected", "403") }));
    expect(await screen.findByText(/was not accepted/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  // -- halts ---------------------------------------------------------------

  it("gives a boot halt the whole screen, as an alert, with no way to dismiss it", async () => {
    mount(
      rig({
        halted: "I3_chain",
        sync: async () => ({
          pulled: 0,
          applied: 0,
          violations: [{ id: "I3_chain", severity: "hard_stop", detail: "spliced at seq 12" } as never],
          halted: true,
        }),
      }),
    );
    const alert = await screen.findByRole("alert");
    // The LIBRARY's copy for the tamper class, not a paraphrase of the error.
    expect(alert).toHaveTextContent(/doesn't match its own record/i);
    expect(alert).toHaveTextContent(/still readable/i);
    expect(screen.getByTestId("halt-detail")).toHaveTextContent("spliced at seq 12");
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
    // Non-dismissable: nothing to press, and no loading affordance either.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("never tells a user their integrity check failed just because they are offline", async () => {
    // Round-1 critical 1, end to end: a cold launch with no network.
    mount(rig({ sync: () => Promise.reject(new TypeError("Failed to fetch")) }));
    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("takes the screen when a LATER sync halts, replacing the app that was on it", async () => {
    let halt = false;
    const r = rig({
      halted: "I3_chain",
      sync: async () =>
        halt
          ? {
              pulled: 0,
              applied: 0,
              violations: [{ id: "I3_chain", severity: "hard_stop", detail: "spliced" } as never],
              halted: true,
            }
          : CLEAN,
    });
    mount(r);
    expect(await screen.findByTestId("app")).toBeInTheDocument();

    halt = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/doesn't match its own record/i);
    await waitFor(() => {
      expect(screen.queryByTestId("app")).not.toBeInTheDocument();
    });
  });

  it("does not wall off a running app because one background sync went offline", async () => {
    let offline = false;
    const r = rig({ sync: async () => (offline ? Promise.reject(new TypeError("Failed to fetch")) : CLEAN) });
    mount(r);
    expect(await screen.findByTestId("app")).toBeInTheDocument();

    offline = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByTestId("app")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("RECOVERS on its own once a later sync succeeds — the wall is not permanent", async () => {
    // Round-1 critical 2: the fault was sticky and outranked everything, so a
    // wall raised by one background sync could only be cleared by a manual
    // reload — on a screen with no buttons on it.
    //
    // The launch sync is clean (this is about a fault raised while the app is
    // ALREADY on screen, which is the only state a fault can be raised in);
    // the second halts; the third succeeds.
    let halted = false;
    const r = rig({
      sync: async () => (halted ? { pulled: 0, applied: 0, violations: [], halted: true } : CLEAN),
    });
    mount(r);
    expect(await screen.findByTestId("app")).toBeInTheDocument();

    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");

    halted = true;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();

    halted = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("runs no background sync at all while this device cannot author", async () => {
    // Belt to the next test's braces. A device with no writer has nothing to
    // push and cannot attest, so a foreground trigger there is a request that
    // can only fail — and round 1 let its failure eat the enrolment wall.
    let calls = 0;
    const r = rig({
      enrolled: false,
      enrolFails: new EnrollmentError("offline", "no connection"),
      sync: async () => {
        calls += 1;
        return CLEAN;
      },
    });
    mount(r);
    await screen.findByRole("button", { name: /try again/i });
    calls = 0;

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(calls).toBe(0);
  });

  it("KEEPS the retryable enrolment wall when a background sync would fail", async () => {
    // Round-1 critical 2's worse half: with the trigger live in the unenrolled
    // state, a tab-switch synced with no writer, threw, and the un-retryable
    // halt wall replaced the one affordance that could fix the account.
    const r = rig({
      enrolled: false,
      enrolFails: new EnrollmentError("offline", "no connection"),
      sync: () => Promise.reject(new Error("no writer selected")),
    });
    mount(r);
    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("walls off the app when the engine publishes a halt nobody was awaiting", async () => {
    // `SyncEngine.halt(reason)` called from outside a `run()` — the phase is
    // the only signal, and it must still take the screen.
    const r = rig({ halted: "halted by the integrity screen" });
    mount(r);
    expect(await screen.findByTestId("app")).toBeInTheDocument();
    act(() => {
      r.publish({ phase: "halted" });
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/couldn't finish checking your data/i);
    expect(screen.getByTestId("halt-detail")).toHaveTextContent("halted by the integrity screen");
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
  });

  // -- session answers ------------------------------------------------------

  it("signs out on a 401 rather than showing a fault", async () => {
    mount(rig({ enrolFails: new ApiError(401, "unauthorized", "", "401") }), {
      signIn: () => <div data-testid="welcome">welcome</div>,
    });
    expect(await screen.findByTestId("welcome")).toBeInTheDocument();
  });

  it("says so, and does not pretend to be signed out, when the wipe could not finish", async () => {
    mount(rig({ enrolFails: new ApiError(410, "account_deleted", "", "410") }), {
      wipe: () => Promise.reject(new Error("another ledger tab still has the local database open")),
      signIn: () => <div data-testid="welcome">welcome</div>,
    });
    expect(await screen.findByText(/could not open this account/i)).toBeInTheDocument();
    expect(screen.getByText(/another ledger tab/)).toBeInTheDocument();
    expect(screen.queryByTestId("welcome")).not.toBeInTheDocument();
  });

  it("wipes on 410 account_deleted", async () => {
    const wiped = vi.fn(async () => {});
    mount(rig({ enrolFails: new ApiError(410, "account_deleted", "", "410") }), {
      wipe: wiped,
      signIn: () => <div data-testid="welcome">welcome</div>,
    });
    await waitFor(() => {
      expect(wiped).toHaveBeenCalled();
    });
  });

  it("reports a failure to open the database as fatal, with a retry", async () => {
    mount(rig(), { open: () => Promise.reject(new Error("indexedDB refused")) });
    expect(await screen.findByText(/could not open this account/i)).toBeInTheDocument();
    expect(screen.getByText(/indexedDB refused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("deleteBrowserDatabase", () => {
  function fakeIndexedDB(fire: "success" | "error" | "blocked") {
    const request: Record<string, unknown> = { error: { message: "quota" } };
    vi.stubGlobal("indexedDB", {
      deleteDatabase: () => {
        // Fired asynchronously, as a real IDBRequest is — the whole point is
        // that the caller must wait for it.
        setTimeout(() => {
          const handler = request[`on${fire}`];
          if (typeof handler === "function") (handler as () => void)();
        }, 0);
        return request;
      },
    });
  }

  it("resolves only once the database is actually gone", async () => {
    fakeIndexedDB("success");
    let settled = false;
    const done = deleteBrowserDatabase().then(() => {
      settled = true;
    });
    // Not resolved in the same turn: round 1 fired the request and reloaded
    // immediately, which lost this race.
    expect(settled).toBe(false);
    await done;
    expect(settled).toBe(true);
  });

  it("REJECTS when another tab is holding the database open", async () => {
    // The case that matters: blocked means the deleted account's log survives
    // under the same fixed name for the next sign-in to open.
    fakeIndexedDB("blocked");
    await expect(deleteBrowserDatabase()).rejects.toThrow(/another ledger tab/i);
  });

  it("rejects rather than resolving on an error", async () => {
    fakeIndexedDB("error");
    await expect(deleteBrowserDatabase()).rejects.toThrow(/could not delete the local database/i);
  });

  it("is a no-op where there is no indexedDB at all", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(deleteBrowserDatabase()).resolves.toBeUndefined();
  });
});
