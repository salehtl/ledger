import type { Client } from "@ledger/client/net/client.ts";
import { clearSession, mayWipeLocalData } from "../auth/session.ts";
import type { AppRuntime } from "./runtime.ts";

export type BootstrapState =
  | { step: "opening" }
  | { step: "signed_out" }
  | { step: "onboarding"; userId: string; facts?: Awaited<ReturnType<AppRuntime["onboardingFacts"]>> }
  | { step: "ready"; userId: string; facts: Awaited<ReturnType<AppRuntime["onboardingFacts"]>> }
  | { step: "halted"; reason: string }
  | { step: "fatal"; error: Error };

/** The synchronous, persisted portion of bootstrap. Server facts refine onboarding to ready later. */
export function persistedBootstrap(client: Pick<Client, "sessionToken" | "userId">): BootstrapState {
  if (client.sessionToken === null) return { step: "signed_out" };
  try {
    return { step: "onboarding", userId: client.userId };
  } catch (error) {
    return { step: "fatal", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export async function bootstrapRuntime(
  runtime: AppRuntime,
  deps: { refresh?: () => Promise<void>; wipe: () => Promise<void> },
): Promise<BootstrapState> {
  const persisted = persistedBootstrap(runtime.client);
  if (persisted.step !== "onboarding") return persisted;
  let state: BootstrapState;
  try {
    await (deps.refresh?.() ?? runtime.coordinator.run("launch").then(() => {}));
    await runtime.runAudit();
    const facts = await runtime.onboardingFacts();
    state =
      facts.inboundAddress !== null && facts.firstMailConfirmedAt !== null && facts.homeCurrency !== null
        ? { step: "ready", userId: persisted.userId, facts }
        : { ...persisted, facts };
  } catch (error) {
    const forced = await classify(runtime, deps, error);
    return forced ?? { step: "fatal", error: error instanceof Error ? error : new Error(String(error)) };
  }
  /**
   * The dictionary refresh runs AFTER the state is decided, and its failure is
   * a non-event.
   *
   * It used to be awaited inside the block above, which made a merchant-name
   * refinement decide whether the application starts: a server hiccup, an
   * offline launch or a hard-to-decode response all produced "Ledger could not
   * safely open this account." A 401 is still a 401 — `sync()` attaches
   * `status`, so the sign-out policy applies here exactly as it does to every
   * other call — but anything else leaves the state above untouched and the
   * device runs on the dictionary it already has.
   */
  try {
    await runtime.dictionary.sync();
    await runtime.dictionary.recategorize();
  } catch (error) {
    const forced = await classify(runtime, deps, error);
    if (forced !== null) return forced;
  }
  return state;
}

/**
 * The two failures that are about the ACCOUNT rather than about one call: the
 * account is gone (wipe) and the session is not valid (sign out). Null means
 * "not one of those", and the caller decides what that means for it.
 */
async function classify(
  runtime: AppRuntime,
  deps: { wipe: () => Promise<void> },
  error: unknown,
): Promise<BootstrapState | null> {
  if (mayWipeLocalData(error)) {
    await deps.wipe();
    return { step: "signed_out" };
  }
  if (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 401) {
    clearSession(runtime.secrets);
    return { step: "signed_out" };
  }
  return null;
}
