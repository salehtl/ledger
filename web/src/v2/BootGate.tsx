/**
 * The boot gate: what is on the glass between opening the tab and using the
 * app, and the one screen that is allowed to refuse to go away.
 *
 * # It renders INSTEAD of the app, never over it
 *
 * There is no `fixed inset-0` overlay here, and no `Dialog`. Every non-`ready`
 * state replaces the tree, which is what makes "non-dismissable" structural
 * rather than a promise: there is nothing behind the wall to dismiss it back
 * to, no scrim to tap through, and no focus trap to get wrong. `components/
 * README.md`'s "every sheet/modal is a Dialog" rule is about surfaces layered
 * over the app; this is not one.
 *
 * # A halt is never a loading state
 *
 * `phase: "halted"` means the invariant checker found a chain break or a roster
 * problem — that what the server served does not hash to what it claims, or
 * that a writer is authoring without being vouched for. Rendering that as a
 * spinner would tell somebody their money app is "still loading" while it is in
 * fact refusing to trust its own records. It gets the whole screen, in both the
 * places it can arise: at boot ({@link BootState} `halted`) and at any later
 * sync ({@link SyncStatus.fault}, raised by `useSync`). Neither is dismissable
 * and neither offers a retry, because retrying is not what fixes either one.
 *
 * # The half-signed-in repair
 *
 * `session.ts`'s `ceremony` persists the session before it enrols this device
 * as a writer, so a network drop in between strands a user signed in with no
 * writer, where every write throws. `boot()` repairs that by calling
 * {@link V2Handle.enrol} before the first sync; when the repair itself fails,
 * the `unenrolled` wall says what is missing and — for the failures where
 * pressing again could plausibly work — offers the retry. The app is not usable
 * until it lands, deliberately: a half-set-up device that let you into the
 * product would look fine until the first edit.
 *
 * # One handle for the tab's lifetime — one engine per CLIENT
 *
 * Both are memoised at module scope rather than held in component state.
 * `SyncEngine`'s rule 2 is one SQLite connection for the app's lifetime, and
 * `StrictMode` mounts every effect twice in development — without the memo that
 * is two `openBrowserDriver` calls against one IndexedDB record and two engines
 * racing syncs on it, which is rule 3's fetch storm with a different cause.
 *
 * The two memos have DIFFERENT lifetimes, and that is the whole of {@link
 * engineFor}: the handle outlives every session, while an engine is only ever
 * as good as the `Client` it captured in its constructor. See that function.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { Button } from "../components/ui/Button";
import { PixelSpinner } from "../components/ui/PixelSpinner";

import type { Halt } from "@ledger/client/invariants/surface";
import type { Client } from "@ledger/client/net/client";

import { readAddress } from "./address";
import { IDB_NAME } from "./db/driver";
import { boot, handleDeps, type BootState } from "./boot";
import { haltFromReason } from "./halt";
import { startEngine, useSync, type SyncCoordinator, type SyncStatus } from "./engine";
import { ONBOARDING_LOCAL_KEY, type OnboardingFacts } from "./onboarding";
import { initV2, SECRET_WRITER_ID, webSecretStore, type V2Handle } from "./session";

/**
 * The profile: the key this app's bytes are stored under, and the secret-store
 * namespace.
 */
export const PROFILE = "ledger";

/**
 * The name of the IndexedDB database the driver keeps those bytes in.
 *
 * A SECOND name, and NOT the same string as {@link PROFILE}: the driver holds
 * one database with a record per profile inside it. Re-exported from the driver
 * rather than spelled again here, which is what it was before — two copies of a
 * magic string in two files, where deleting the profile name would have deleted
 * nothing and left a deleted account's whole op log on the device.
 */
export const BROWSER_DATABASE = IDB_NAME;

/**
 * Same-origin, in production and in `bun run dev` alike — the dev server
 * proxies `/api/v1` (see `vite.config.ts`) and `ledgerd` serves the bundle off
 * the same listener as the API in production, which is what lets WebAuthn run
 * with no CORS and no second hostname in `rp_origins`.
 */
export const SERVER = "";

// ---------------------------------------------------------------------------
// The tab-lifetime singletons
// ---------------------------------------------------------------------------

let handleOnce: Promise<V2Handle> | null = null;

export function openV2(): Promise<V2Handle> {
  handleOnce ??= initV2(SERVER, { name: PROFILE });
  return handleOnce;
}

/**
 * Keyed on the **`Client`**, never on the handle.
 *
 * `SyncEngine` reads its client ONCE, in its constructor
 * (`client/src/net/engine.ts`), and `V2Handle.client` is a getter that hands
 * back a NEW `Client` every time a ceremony adopts a session (`session.ts`'s
 * `adoptSession` ends with `client = build()`). The handle, meanwhile, is
 * memoised for the tab's lifetime. So a cache keyed on the handle answers every
 * later question with an engine bound to a client that no longer exists.
 *
 * That is not theoretical: it is exactly what made re-authenticating in the
 * same tab impossible. A session expires → the sync `401`s → the gate re-runs
 * boot → `signed_out` → the user signs in on the sign-in slot, minting a fresh
 * client → `done()` re-runs boot → the handle is the same object, so the cache
 * returns the engine still holding the EXPIRED token → the launch sync `401`s →
 * boot classifies it as a session answer and clears the token the user just
 * minted → back to Welcome. Every attempt, until the tab is hard-reloaded.
 *
 * Keying on the client makes the cache's key the same identity the engine
 * captured, so the entry can only ever be returned while it is still valid, and
 * a rotated client cannot find a stale entry to hit. The stale coordinator dies
 * with the client that owned it — a `WeakMap`, so nothing has to remember to
 * evict it.
 */
const engines = new WeakMap<Client, SyncCoordinator>();

/**
 * The one engine for a handle's CURRENT client, built at most once.
 *
 * `build` is a seam and not a convenience: without it, the only way for a test
 * to hand the gate a fake engine was to replace this whole function, so the
 * memo — the code that actually runs in production — was covered by nothing.
 * Injecting the *builder* instead means every gate test drives the real cache.
 */
export function engineFor(handle: V2Handle, build: (h: V2Handle) => SyncCoordinator = startEngine): SyncCoordinator {
  const client = handle.client;
  const held = engines.get(client);
  if (held !== undefined) return held;
  const made = build(handle);
  engines.set(client, made);
  return made;
}

// ---------------------------------------------------------------------------
// The context the app reads
// ---------------------------------------------------------------------------

export interface V2Runtime {
  handle: V2Handle;
  coordinator: SyncCoordinator;
  sync: SyncStatus;
  userId: string;
  facts: OnboardingFacts;
}

const V2Context = createContext<V2Runtime | null>(null);

/**
 * The runtime, provided.
 *
 * Exported so a test can mount a screen — or the whole shell — in the SAME
 * configuration production uses, rather than in the one configuration
 * production never has. That distinction is the whole reason it exists: while
 * `AppShell.test.tsx` mounted the shell bare, every screen under it rendered its
 * "your local ledger isn't open" branch, so the suite's most integrated test
 * exercised only the branch that cannot happen and none of the ones that can.
 *
 * `BootGate` uses it too, so there is one Provider and not two.
 */
export function V2Provider({ value, children }: { value: V2Runtime; children: ReactNode }) {
  return <V2Context.Provider value={value}>{children}</V2Context.Provider>;
}

/**
 * The runtime, or null.
 *
 * Nullable rather than throwing, because v1 screens and their tests still mount
 * without a gate around them (Tasks 8–10 retire them) and a hook that threw
 * would make the gate a hard dependency of every one of them a task early.
 *
 * **Use {@link useV2OrThrow} in anything that reads the projection.** The
 * nullable version has one honest use — a v1 surface choosing between the two
 * worlds — and one dangerous one: a Task 8–10 screen that falls back to the v1
 * HTTP path when the gate is missing does not fail, it silently talks to
 * endpoints `ledgerd` does not serve, and every test passes.
 */
export function useV2(): V2Runtime | null {
  return useContext(V2Context);
}

/**
 * The runtime, or a loud failure. For every screen backed by the projection.
 *
 * There is no correct fallback for those: without the gate there is no handle,
 * no engine and no projection, so "degrade to v1" means reading a different
 * database over a different protocol and calling it the same screen.
 */
export function useV2OrThrow(): V2Runtime {
  const runtime = useContext(V2Context);
  if (runtime === null) {
    throw new Error(
      "this screen reads the v2 projection and must be rendered inside <BootGate>; " +
        "there is no v1 fallback for it",
    );
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** A screen a later task fills in. An unfilled slot says whose it is. */
export type SlotRenderer = (props: { handle: V2Handle; done: () => void }) => ReactElement;

export interface BootGateProps {
  /** The app, rendered only once this device is signed in and set up. */
  children: ReactNode;
  /** Task 7's Welcome / passkey screens. */
  signIn?: SlotRenderer;
  /**
   * Task 7's onboarding walk. `facts` is where it resumes from.
   *
   * `sync` is handed over because the walk has a step that CANNOT finish
   * without one: the verification step waits for a re-ingested bank email to
   * reach the local log, and only a pull puts it there. Nothing else in the tree
   * pulls while onboarding is on screen — which is also why `onboarding` had to
   * join `ready` in the `useSync` condition below.
   */
  onboarding?: (props: {
    handle: V2Handle;
    facts: OnboardingFacts;
    done: () => void;
    sync: () => Promise<void>;
  }) => ReactElement;
  /** Injected by tests. Defaults to the memoised {@link openV2}. */
  open?: () => Promise<V2Handle>;
  /** Injected by tests. Defaults to {@link wipeLocalData}. */
  wipe?: (handle: V2Handle) => Promise<void>;
  /** Injected by tests. `GET /api/v1/address`. */
  address?: (handle: V2Handle) => Promise<string | null>;
  /**
   * How to BUILD an engine — not how to get one. Defaults to
   * {@link startEngine}, which constructs a real `SyncEngine` and so runs the
   * projection's DDL against the real driver.
   *
   * The gate always goes through {@link engineFor}, whatever this is, so the
   * memo and its key are exercised by every test rather than replaced by them.
   * Injecting the memo itself is what left the caching path — the only path
   * that runs in production — untested, and it held a bug for three rounds.
   */
  engine?: (handle: V2Handle) => SyncCoordinator;
}

export function BootGate({
  children,
  signIn,
  onboarding,
  open = openV2,
  wipe = wipeLocalData,
  address = addressOf,
  engine = startEngine,
}: BootGateProps) {
  const [handle, setHandle] = useState<V2Handle | null>(null);
  const [coordinator, setCoordinator] = useState<SyncCoordinator | null>(null);
  const [state, setState] = useState<BootState>({ step: "opening" });
  // Bumped by "try again" and by a slot reporting it is done; every increment
  // re-runs boot from the top, which is the only way to re-derive the facts.
  const [attempt, setAttempt] = useState(0);
  // The coordinator is handed to `useSync` only in the states where syncing is
  // safe — which is not the same as "only when the app is on screen".
  //
  // The state it must be withheld from is `unenrolled`, and the reason is
  // specific: with the trigger live there, a tab-switch syncs with no writer,
  // throws, and the retryable enrolment wall is replaced by an un-retryable halt
  // wall — the round-1 review reproduced exactly that. A device that cannot
  // author has no business syncing in the background.
  //
  // `onboarding` is on the other side of that line and is included
  // deliberately. By then `boot()` has already enrolled this device (step 1) and
  // already completed a launch sync (step 2), so both of the conditions that
  // made `unenrolled` dangerous are known to hold. It has to be included: the
  // verification step cannot finish until a pull lands the re-ingested bank
  // email in the local log, and withholding the coordinator here is what left
  // that step unable to complete at all.
  // A session that ended AFTER boot — expired, revoked, account deleted — is
  // handled by re-running boot rather than by signing out from here. `boot()`
  // reaches the same answer on its first call and classifies it once, in the one
  // place that owns whether a device erases itself. The ref breaks the ordering
  // knot: `again` is defined below because it needs `sync.clear`.
  const rebootRef = useRef<() => void>(() => {});
  const sync = useSync(state.step === "ready" || state.step === "onboarding" ? coordinator : null, {
    onSessionEnded: () => {
      rebootRef.current();
    },
  });

  // Held so the boot effect does not re-run when a caller re-creates one of
  // these inline, which is the ordinary way to pass a function prop.
  const io = useRef({ open, wipe, address, engine });
  io.current = { open, wipe, address, engine };

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const h = await io.current.open();
        if (!live) return;
        setHandle(h);
        if (!h.signedIn()) {
          setState({ step: "signed_out" });
          return;
        }
        // Through the memo, never around it: `engineFor` is what decides
        // whether the engine this boot uses is still bound to a live client,
        // and re-authenticating in the same tab depends on that answer.
        const c = engineFor(h, io.current.engine);
        setCoordinator(c);
        const next = await boot(
          handleDeps({
            handle: h,
            sync: () => c.run("launch"),
            haltReason: () => c.haltReason,
            secrets: webSecretStore(PROFILE),
            address: () => io.current.address(h),
            wipe: () => io.current.wipe(h),
          }),
        );
        if (live) setState(next);
      } catch (error) {
        // Opening the database is the one step with no `boot()` around it.
        if (live) setState({ step: "fatal", error: error instanceof Error ? error : new Error(String(error)) });
      }
    })();
    return () => {
      live = false;
    };
  }, [attempt]);

  // The halt currently in force, or null. COMPUTED here and APPLIED per branch
  // — never returned early, which is the shape round 1 got wrong: there it
  // outranked `unenrolled` and took away the one affordance that could repair
  // that account. It is applied in exactly the two states that sync.
  //
  // Two sources. `fault` is what a `run()` through the hook observed, and it
  // carries the violation class. The PHASE catches the case no `run()` can
  // report — an out-of-band `SyncEngine.halt(reason)`, which publishes `halted`
  // with nobody awaiting a promise.
  //
  // THE PHASE BRANCH REQUIRES A REASON, and that guard is the whole of it.
  // `SyncEngine.run` publishes `halted` and THEN rethrows — for a transport
  // failure exactly as for a chain break — and never resets `p` until the next
  // run starts. An ungated phase check therefore put the offline wall back up by
  // a second route, after round 1 had removed it from the boot path: `useSync`
  // correctly declined to raise a fault, the phase said `halted` anyway, and
  // with no reason to show it rendered the generic "your records did not check
  // out". An out-of-band `halt(reason)` always sets a reason; a rethrown
  // transport failure never does. That is the difference, and it is the only
  // reliable one available here.
  const haltReason = coordinator?.haltReason ?? null;
  const activeHalt =
    sync.fault ?? (sync.progress.phase === "halted" && haltReason !== null ? haltFromReason(haltReason) : null);

  const clearFault = sync.clear;
  const again = useCallback(() => {
    // Dropped before the re-boot, not after: a stale verdict left standing
    // would wall off the very state the retry was meant to reach.
    clearFault();
    setState({ step: "opening" });
    setAttempt((n) => n + 1);
  }, [clearFault]);
  rebootRef.current = again;

  switch (state.step) {
    case "opening":
      return (
        <Wall>
          <div className="flex flex-col items-center gap-3 text-muted" role="status">
            <PixelSpinner size={24} />
            <p className="text-sm">Opening ledger…</p>
          </div>
        </Wall>
      );

    case "signed_out":
      if (handle === null || signIn === undefined) return <Unbuilt what="Sign in" owner="Task 7" />;
      return signIn({ handle, done: again });

    case "unenrolled":
      return (
        <Wall>
          <Notice title={state.copy.title} body={state.copy.body} />
          {state.copy.retry && (
            <div>
              <Button variant="primary" onClick={again}>
                Try again
              </Button>
            </div>
          )}
        </Wall>
      );

    case "onboarding":
      if (handle === null || onboarding === undefined) return <Unbuilt what="Onboarding" owner="Task 7" />;
      // Onboarding syncs (see the `useSync` condition), so it can raise a halt,
      // so it has to be able to show one. Without this the step's own `sync()`
      // could record a fault that nothing ever rendered.
      //
      // ONLY THIS ONE CARRIES A CONTROL. Recovery is automatic either way — the
      // `visibilitychange` trigger clears the fault on the next successful sync
      // — but "automatic" is invisible, and a dead-looking screen part-way
      // through setting up an account is where you lose the person. In `ready`
      // the user has an app they have been using and `halt.action` is the
      // guidance; here they have neither, so they get the same affordance
      // `unenrolled` and `fatal` offer.
      if (activeHalt !== null) return <HaltWall halt={activeHalt} onRetry={again} />;
      return onboarding({
        handle,
        facts: state.facts,
        done: again,
        // `sync.run` rather than the coordinator directly, precisely because it
        // never rejects: a halt raised while onboarding is on screen is recorded
        // as a fault on the status this component already reads, so it reaches
        // the gate's own wall on the next render instead of being swallowed by
        // whichever step's `catch` happened to be awaiting.
        sync: () => sync.run("refresh"),
      });

    case "halted":
      return <HaltWall halt={state.halt} />;

    case "fatal":
      return (
        <Wall>
          <Notice
            title="ledger could not open this account"
            body="Nothing was lost — the records on this device were not changed. Reloading is safe."
            detail={state.error.message}
          />
          <div>
            <Button variant="primary" onClick={again}>
              Try again
            </Button>
          </div>
        </Wall>
      );

    case "ready":
      if (handle === null || coordinator === null) return null;
      // A halt raised by a LATER sync takes the screen from the app that was on
      // it: what is rendered behind is a projection the engine has stopped
      // standing behind. A successful sync clears it (see `useSync`), so coming
      // back online recovers on the next trigger with nothing to press.
      if (activeHalt !== null) return <HaltWall halt={activeHalt} />;
      return (
        <V2Provider value={{ handle, coordinator, sync, userId: state.userId, facts: state.facts }}>
          {children}
        </V2Provider>
      );
  }
}

// ---------------------------------------------------------------------------
// The walls
// ---------------------------------------------------------------------------

/**
 * Not `fixed inset-0`: this is the page, not a layer over it. `100svh` rather
 * than `100vh` so an iOS URL bar cannot push the action button under the fold.
 */
function Wall({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100svh] bg-bg text-fg overflow-y-auto">
      <div className="max-w-screen-sm mx-auto min-h-[100svh] flex flex-col justify-center gap-5 px-6 py-10">
        {children}
      </div>
    </div>
  );
}

function Notice({ title, body, detail }: { title: string; body: string; detail?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm leading-relaxed text-muted">{body}</p>
      {detail !== undefined && detail !== "" && (
        <p className="text-xs font-mono text-muted break-words border border-border rounded-[var(--radius)] p-3 bg-surface-2">
          {detail}
        </p>
      )}
    </div>
  );
}

/**
 * The one screen with no way out — in the LIBRARY's words.
 *
 * Every sentence comes from `invariants/surface.ts`'s `COPY`, unaltered, the
 * way `app/`'s `HaltBanner` renders it. That matters beyond consistency: those
 * strings are written per halt CLASS, they never claim to know more than the
 * check did, and each ends by saying what is still true — which is the thing a
 * person needs first from a full-screen stop. Round 1 hand-wrote a single
 * paraphrase here that asserted tampering and said reopening would not help,
 * then showed it to anyone who opened the app offline.
 *
 * `role="alert"` rather than `role="status"`: this is not progress, and a
 * screen reader must interrupt for it. No spinner, and by default no button
 * either: `halt.action` says what there is to do, in prose, because none of the
 * six is repaired by a control on this screen.
 *
 * `onRetry` is the ONE exception, and it is not a dismissal — it re-runs boot,
 * and lands right back here if the halt still holds. It exists for the
 * onboarding wall, where there is no app behind the screen to make "still
 * alive" obvious. See that call site.
 */
function HaltWall({ halt, onRetry }: { halt: Halt; onRetry?: () => void }) {
  return (
    <Wall>
      <div role="alert" className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-bad">{halt.title}</h1>
        <p className="text-sm leading-relaxed">{halt.body}</p>
        {halt.action !== null && <p className="text-sm leading-relaxed text-muted">{halt.action}</p>}
        {onRetry !== undefined && (
          <div>
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {halt.violations.length > 0 && (
          <ul data-testid="halt-detail" className="text-xs font-mono text-muted flex flex-col gap-1 break-words">
            {halt.violations.map((v, i) => (
              <li key={`${v.id}-${i}`}>
                {v.id}: {String(v.detail)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Wall>
  );
}

/**
 * A slot a later task owns, rendered rather than omitted — the shape
 * `OnboardingShell` set. A missing screen that renders nothing is the "written,
 * tested green, never wired" defect; one that names its owner is a to-do on the
 * glass.
 */
function Unbuilt({ what, owner }: { what: string; owner: string }) {
  return (
    <Wall>
      <Notice
        title={`${what} is not built yet`}
        body={`${owner} fills this slot. The gate reached it, so the wiring underneath is working — there is simply no screen here yet.`}
      />
    </Wall>
  );
}

// ---------------------------------------------------------------------------
// The IO the gate needs and nothing else owns yet
// ---------------------------------------------------------------------------

function addressOf(handle: V2Handle): Promise<string | null> {
  return readAddress(handle.client, { server: SERVER });
}

/**
 * Everything this account left on this device, gone — then a reload.
 *
 * Only ever reached from `410 account_deleted`. The reload is not cosmetic: the
 * handle and the engine are memoised for the tab's lifetime and both are dead
 * once their database is, so continuing in the same document would run the
 * sign-in screen against a closed driver.
 *
 * # The delete is AWAITED, and a failure THROWS
 *
 * The store is not account-bound — there is no `account_id` anywhere in
 * `client/src`, and the browser database is a fixed name (`ledger-v2`) holding a
 * record keyed by profile. So a half-wipe is not "some leftovers": it is the
 * deleted account's whole op log and projection, sitting under the name the next
 * sign-in on this browser will open.
 *
 * Round 1 fired `deleteDatabase` without awaiting it and reloaded immediately,
 * which loses the race in the two cases that matter — a delete blocked by a
 * second tab holding the connection, and one simply cut short by the navigation.
 * Secrets were cleared either way, so the reload landed on a clean-looking
 * sign-in over surviving data. Now: await `success`/`error`/`blocked`, throw on
 * anything but success, and **do not reload** — `boot`'s `classify` turns the
 * throw into a wall that says what happened, instead of a fresh sign-in that
 * hides it.
 *
 * `onblocked` is a rejection, not a wait. It fires when another tab still holds
 * the database open, and that tab is not going to close on its own; waiting
 * there is a hang, and the user can act on being told.
 */
export async function wipeLocalData(handle: V2Handle): Promise<void> {
  const secrets = webSecretStore(PROFILE);
  try {
    await handle.signOut();
  } catch {
    // Signing out writes through the store this is about to destroy.
  }
  for (const key of [ONBOARDING_LOCAL_KEY, SECRET_WRITER_ID]) secrets.set(key, null);
  handle.close();
  await deleteBrowserDatabase();
  if (typeof location !== "undefined" && typeof location.reload === "function") location.reload();
}

/** Resolves only when the database is actually gone. */
export function deleteBrowserDatabase(name = BROWSER_DATABASE): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(new Error(`could not delete the local database: ${String(request.error?.message ?? "unknown")}`));
    };
    request.onblocked = () => {
      reject(new Error("another ledger tab still has the local database open; close every other ledger tab"));
    };
  });
}
