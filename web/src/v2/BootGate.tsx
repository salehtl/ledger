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
 * # One handle, one engine, for the tab's lifetime
 *
 * Both are memoised at module scope rather than held in component state.
 * `SyncEngine`'s rule 2 is one SQLite connection for the app's lifetime, and
 * `StrictMode` mounts every effect twice in development — without the memo that
 * is two `openBrowserDriver` calls against one IndexedDB record and two engines
 * racing syncs on it, which is rule 3's fetch storm with a different cause.
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

import { readAddress } from "./address";
import { boot, handleDeps, HALT_WITHOUT_REASON, type BootState } from "./boot";
import { startEngine, useSync, type SyncCoordinator, type SyncStatus } from "./engine";
import { ONBOARDING_LOCAL_KEY, type OnboardingFacts } from "./onboarding";
import { initV2, SECRET_WRITER_ID, webSecretStore, type V2Handle } from "./session";

/** The IndexedDB database name AND the secret-store namespace. */
export const PROFILE = "ledger";

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

const engines = new WeakMap<V2Handle, SyncCoordinator>();

function engineFor(handle: V2Handle): SyncCoordinator {
  const held = engines.get(handle);
  if (held !== undefined) return held;
  const made = startEngine(handle);
  engines.set(handle, made);
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
 * The runtime, or null.
 *
 * Nullable rather than throwing, because v1 screens and their tests still mount
 * without a gate around them (Tasks 8–10 retire them) and a hook that threw
 * would make the gate a hard dependency of every one of them a task early.
 */
export function useV2(): V2Runtime | null {
  return useContext(V2Context);
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
  /** Task 7's onboarding walk. `facts` is where it resumes from. */
  onboarding?: (props: { handle: V2Handle; facts: OnboardingFacts; done: () => void }) => ReactElement;
  /** Injected by tests. Defaults to the memoised {@link openV2}. */
  open?: () => Promise<V2Handle>;
  /** Injected by tests. Defaults to {@link wipeLocalData}. */
  wipe?: (handle: V2Handle) => Promise<void>;
  /** Injected by tests. `GET /api/v1/address`. */
  address?: (handle: V2Handle) => Promise<string | null>;
  /**
   * Injected by tests. Defaults to the memoised {@link engineFor} — which
   * builds a real {@link SyncEngine}, and so runs the projection's DDL against
   * the real driver.
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
  engine = engineFor,
}: BootGateProps) {
  const [handle, setHandle] = useState<V2Handle | null>(null);
  const [coordinator, setCoordinator] = useState<SyncCoordinator | null>(null);
  const [state, setState] = useState<BootState>({ step: "opening" });
  // Bumped by "try again" and by a slot reporting it is done; every increment
  // re-runs boot from the top, which is the only way to re-derive the facts.
  const [attempt, setAttempt] = useState(0);
  const sync = useSync(coordinator);

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
        const c = io.current.engine(h);
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

  const again = useCallback(() => {
    setState({ step: "opening" });
    setAttempt((n) => n + 1);
  }, []);

  // A halt raised by a LATER sync outranks whatever the boot state says: the
  // app underneath is showing a projection the engine has stopped standing
  // behind.
  //
  // Two conditions, deliberately. `fault` is what a `run()` through this hook
  // observed, and carries the violations. The PHASE is the engine's own flag
  // and catches the case no `run()` can report: `SyncEngine.halt(reason)`
  // called from somewhere else — the Integrity screen, a future background
  // task — which publishes `halted` with nobody awaiting a promise. The rule is
  // that a halted phase is never on screen as anything but this, so it is read
  // directly rather than inferred.
  if (sync.fault !== null) {
    return <HaltWall reason={sync.fault.reason} violations={sync.fault.violations.map(codeOf)} />;
  }
  if (sync.progress.phase === "halted") {
    return <HaltWall reason={coordinator?.haltReason ?? HALT_WITHOUT_REASON} violations={[]} />;
  }

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
      return onboarding({ handle, facts: state.facts, done: again });

    case "halted":
      return <HaltWall reason={state.reason} violations={state.violations.map(codeOf)} />;

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
      return (
        <V2Context.Provider value={{ handle, coordinator, sync, userId: state.userId, facts: state.facts }}>
          {children}
        </V2Context.Provider>
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
 * The one screen with no way out.
 *
 * `role="alert"` rather than `role="status"`: this is not progress, and a
 * screen reader must interrupt for it. There is deliberately no retry — a chain
 * break is not repaired by asking again, and a button that implied it was would
 * be the same lie as the spinner.
 */
function HaltWall({ reason, violations }: { reason: string; violations: readonly string[] }) {
  return (
    <Wall>
      <div role="alert" className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-bad">Syncing has stopped</h1>
        <p className="text-sm leading-relaxed">
          ledger checks that every record it receives matches what your devices signed for, and this check did not
          pass. It has stopped syncing rather than show you figures it cannot stand behind. Nothing on this device
          was changed or lost.
        </p>
        <p className="text-sm leading-relaxed text-muted">
          This is not something to fix from here, and reopening the app will not clear it.
        </p>
        <p className="text-xs font-mono break-words border border-border rounded-[var(--radius)] p-3 bg-surface-2">
          {reason}
        </p>
        {violations.length > 0 && (
          <ul className="text-xs font-mono text-muted flex flex-col gap-1">
            {violations.map((code) => (
              <li key={code}>{code}</li>
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

function codeOf(v: unknown): string {
  const c = (v as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : String(c ?? "");
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
 * Best-effort by construction. A `deleteDatabase` that stays blocked (another
 * tab holding the same database open) must not stop the secrets from being
 * cleared — the session token is the part that matters most and it is gone
 * either way.
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
  try {
    if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase("ledger-v2");
  } catch {
    // A blocked or refused delete leaves data behind; the session is still gone.
  }
  if (typeof location !== "undefined" && typeof location.reload === "function") location.reload();
}
