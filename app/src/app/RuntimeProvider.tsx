import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { AppRuntime } from "./runtime.ts";
import { productionRuntime } from "./runtime.native.ts";
import { bootstrapRuntime, type BootstrapState } from "./bootstrap.ts";

interface RuntimeValue { runtime: AppRuntime; bootstrap: BootstrapState }
const RuntimeContext = createContext<RuntimeValue | null>(null);

export function RuntimeProvider({ children, runtime, factory = productionRuntime, bootstrapper = bootstrapRuntime }: { children: ReactNode; runtime?: AppRuntime; factory?: () => AppRuntime; bootstrapper?: typeof bootstrapRuntime }) {
  const [held, setHeld] = useState<AppRuntime>(() => runtime ?? factory());
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ step: "opening" });
  useEffect(() => {
    let live = true;
    void bootstrapper(held, {
      wipe: async () => {
        await held.wipeAccount();
        if (runtime === undefined && live) setHeld(factory());
      },
    }).then((state) => { if (live) setBootstrap(state); });
    return () => { live = false; };
  }, [held, factory, runtime, bootstrapper]);
  return <RuntimeContext.Provider value={{ runtime: held, bootstrap }}>{children}</RuntimeContext.Provider>;
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
