import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { AppRuntime } from "./runtime.ts";
import { productionRuntime } from "./runtime.native.ts";
import { bootstrapRuntime, type BootstrapState } from "./bootstrap.ts";

interface RuntimeValue { runtime: AppRuntime; bootstrap: BootstrapState; wipeAccount(): Promise<void> }
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
  useEffect(() => {
    let live = true;
    void bootstrapper(held, { wipe: wipeAccount }).then((state) => { if (live) setBootstrap(state); });
    return () => { live = false; };
  }, [held, bootstrapper, wipeAccount]);
  return <RuntimeContext.Provider value={{ runtime: held, bootstrap, wipeAccount }}>{children}</RuntimeContext.Provider>;
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
