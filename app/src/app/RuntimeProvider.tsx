import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { AppRuntime } from "./runtime.ts";
import { productionRuntime } from "./runtime.native.ts";
import { bootstrapRuntime, type BootstrapState } from "./bootstrap.ts";

interface RuntimeValue { runtime: AppRuntime; bootstrap: BootstrapState; wipeAccount(): Promise<void>; retryBootstrap(): void }
const RuntimeContext = createContext<RuntimeValue | null>(null);

export function RuntimeProvider({ children, runtime, factory = productionRuntime, bootstrapper = bootstrapRuntime }: { children: ReactNode; runtime?: AppRuntime; factory?: () => AppRuntime; bootstrapper?: typeof bootstrapRuntime }) {
  const [held, setHeld] = useState<AppRuntime>(() => runtime ?? factory());
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ step: "opening" });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /**
   * The only sanctioned way to erase this account.
   *
   * `AppRuntime.wipeAccount()` closes the shared SQLite driver, deletes the
   * database and purges the writer secrets - which leaves the held runtime
   * dead. Bootstrap always replaced it; account deletion (Navigation's
   * DeleteAccount route) called `runtime.wipeAccount()` directly and did not,
   * so after a successful deletion the sign-in screen it returned to held a
   * runtime whose driver was closed and could not sign anybody back in. One
   * wipe path, one replacement.
   *
   * A test-supplied `runtime` prop is never replaced: `factory` is the
   * production one and would open real native modules.
   */
  const wipeAccount = useCallback(async () => {
    await held.wipeAccount();
    if (runtime === undefined && mounted.current) setHeld(factory());
  }, [held, factory, runtime]);
  /**
   * Runs bootstrap again, from the start.
   *
   * The one thing bootstrap can now fail on that a user can genuinely fix is
   * device enrolment — offline, or a server that was down for the minute they
   * launched. Without a way to re-run, `unenrolled` would be a wall with a
   * "try again" that could only mean "force-quit the app", and re-running on a
   * timer would be the silent forever-retry the task forbids. So it is a
   * counter, bumped by a press, and by nothing else.
   */
  const [attempt, setAttempt] = useState(0);
  const retryBootstrap = useCallback(() => {
    setBootstrap({ step: "opening" });
    setAttempt((n) => n + 1);
  }, []);
  useEffect(() => {
    let live = true;
    void bootstrapper(held, { wipe: wipeAccount }).then((state) => { if (live) setBootstrap(state); });
    return () => { live = false; };
    // `attempt` is the retry trigger and is deliberately unused in the body.
  }, [held, bootstrapper, wipeAccount, attempt]);
  return <RuntimeContext.Provider value={{ runtime: held, bootstrap, wipeAccount, retryBootstrap }}>{children}</RuntimeContext.Provider>;
}

/** Re-runs launch bootstrap. See {@link RuntimeProvider}. */
export function useBootstrapRetry(): () => void {
  const value = useContext(RuntimeContext);
  if (value === null) throw new Error("useBootstrapRetry must be used inside RuntimeProvider");
  return value.retryBootstrap;
}

/** The account-erasing wipe, which also replaces the runtime it just killed. */
export function useAccountWipe(): () => Promise<void> {
  const value = useContext(RuntimeContext);
  if (value === null) throw new Error("useAccountWipe must be used inside RuntimeProvider");
  return value.wipeAccount;
}

export function useRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) throw new Error("useRuntime must be used inside RuntimeProvider");
  return runtime.runtime;
}

export function useBootstrap(): BootstrapState {
  const value = useContext(RuntimeContext);
  if (value === null) throw new Error("useBootstrap must be used inside RuntimeProvider");
  return value.bootstrap;
}
