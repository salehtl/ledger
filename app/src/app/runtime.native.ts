import { deleteLedgerDatabase, expoDriver } from "../db/driver.ts";
import { keychainSecretStore, purgeAsync } from "../auth/native.ts";
import { keychainNames } from "../auth/keys.ts";
import { AppState } from "react-native";
import { serverURL } from "./config.ts";
import { createRuntime, type AppRuntime } from "./runtime.ts";
import { expoNotificationTaps } from "../push/native.ts";
import { installNotificationTapHandling } from "../push/service.ts";

let singleton: AppRuntime | null = null;
let notificationTapUnsubscribe: (() => void) | null = null;

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
    const runtime = singleton;
    // Consumes a cold-start notification response (the tap that launched a
    // terminated app) as well as subsequent live taps, both routed through
    // the same "notification" sync trigger. installNotificationTapHandling
    // owns de-duplication between the two sources.
    void installNotificationTapHandling(
      expoNotificationTaps(),
      () => runtime.coordinator.run("notification"),
      (error) => { console.warn("push: live notification sync failed", error); },
    ).then((unsubscribe) => {
      if (singleton === runtime) notificationTapUnsubscribe = unsubscribe;
      else unsubscribe();
    }).catch((error: unknown) => {
      console.warn("push: notification tap handling failed to install", error);
    });
  }
  return singleton;
}

/** Test/development teardown. Account deletion uses the later wipe coordinator. */
export async function disposeProductionRuntime(): Promise<void> {
  notificationTapUnsubscribe?.();
  notificationTapUnsubscribe = null;
  await singleton?.dispose();
}
