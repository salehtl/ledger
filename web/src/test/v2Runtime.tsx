/**
 * A `V2Runtime` a test can mount the real tree inside.
 *
 * # Why this is not "just a fixture"
 *
 * Before Task 10, `AppShell.test.tsx` rendered the shell with no gate above it.
 * Every screen under it therefore took its `source === null` branch — the
 * disconnected state — so the most integrated test in the suite asserted
 * against the one configuration production cannot produce, and asserted nothing
 * about the configuration it always has. That is not a stricter-hook problem,
 * it is a test-shape problem, and this file is the fix: the shell and its
 * screens now mount over a real projection inside a real context, exactly as
 * `BootGate` renders them.
 *
 * The driver is a REAL `SqlDriver` from `projectionFixture` — rows folded from
 * ops by `fold` and written by `project` — so a screen that reached for a v1
 * HTTP route could not satisfy the assertions; the data simply is not there.
 */

import type { ReactNode } from "react";

import type { SqlDriver } from "@ledger/client/store/driver";

import { V2Provider, type V2Runtime } from "../v2/BootGate";
import { IDLE_PROGRESS, SyncCoordinator, type SyncStatus } from "../v2/engine";
import { emptyFacts, type OnboardingFacts } from "../v2/onboarding";
import type { V2Handle } from "../v2/session";
import { fakeEngine } from "./engineDouble";

export interface FakeRuntimeOptions {
  driver: SqlDriver;
  facts?: Partial<OnboardingFacts>;
  sessionToken?: string | null;
  /** Overrides on the status the tree reads — `progress`, `fault`, the stamp. */
  sync?: Partial<SyncStatus>;
  haltReason?: string | null;
  signOut?: () => Promise<void>;
}

export interface FakeRuntime {
  runtime: V2Runtime;
  /** Every trigger `sync.run` was called with, in order. */
  runs: string[];
}

export function fakeRuntime(opts: FakeRuntimeOptions): FakeRuntime {
  const runs: string[] = [];
  const coordinator = new SyncCoordinator(fakeEngine({ halted: opts.haltReason ?? null }));

  const handle = {
    driver: opts.driver,
    signedIn: () => true,
    signOut: opts.signOut ?? (async () => {}),
    close: () => {},
    enrol: async () => {},
    client: {
      get userId() {
        return "u_1";
      },
      get sessionToken() {
        return opts.sessionToken === undefined ? "tok" : opts.sessionToken;
      },
      get writerId() {
        return "web-1";
      },
      state: () => ({ txns: new Map(), homeCurrency: opts.facts?.homeCurrency ?? "AED" }),
    },
  } as unknown as V2Handle;

  const sync: SyncStatus = {
    progress: IDLE_PROGRESS,
    fault: null,
    lastCompletedAt: null,
    run: async (trigger: string) => {
      runs.push(trigger);
    },
    clear: () => {},
    ...opts.sync,
  } as SyncStatus;

  return {
    runs,
    runtime: {
      handle,
      coordinator,
      sync,
      userId: "u_1",
      facts: { ...emptyFacts(), hasSession: true, accountId: "u_1", keysReady: true, homeCurrency: "AED", ...opts.facts },
    },
  };
}

/** The tree, inside the context `BootGate` would have put it in. */
export function WithV2({ runtime, children }: { runtime: V2Runtime; children: ReactNode }) {
  return <V2Provider value={runtime}>{children}</V2Provider>;
}
