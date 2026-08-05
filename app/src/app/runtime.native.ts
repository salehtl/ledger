import { deleteLedgerDatabase, expoDriver } from "../db/driver.ts";
import { keychainSecretStore, purgeAsync } from "../auth/native.ts";
import { keychainNames } from "../auth/keys.ts";
import { AppState } from "react-native";
import { serverURL } from "./config.ts";
import { createRuntime, type AppRuntime } from "./runtime.ts";

let singleton: AppRuntime | null = null;

export function productionRuntime(): AppRuntime {
  if (singleton === null) {
    singleton = createRuntime({
      server: serverURL(),
      openDriver: expoDriver,
      secrets: keychainSecretStore(),
      deleteDatabase: deleteLedgerDatabase,
      purgeSecrets: (writerIds) => purgeAsync(keychainNames(writerIds)),
      auditConditions: () => ({ mainsPower: true, foreground: AppState.currentState === "active", thermal: "nominal", busy: false }),
      onDisposed: (disposed) => {
        if (singleton === disposed) singleton = null;
      },
    });
  }
  return singleton;
}

/** Test/development teardown. Account deletion uses the later wipe coordinator. */
export async function disposeProductionRuntime(): Promise<void> {
  await singleton?.dispose();
}
