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
  try {
    await (deps.refresh?.() ?? runtime.coordinator.run("launch").then(() => {}));
    await runtime.dictionary.sync();
    await runtime.runAudit();
    const facts = await runtime.onboardingFacts();
    return facts.inboundAddress !== null && facts.firstMailConfirmedAt !== null && facts.homeCurrency !== null
      ? { step: "ready", userId: persisted.userId, facts }
      : { ...persisted, facts };
  } catch (error) {
    if (mayWipeLocalData(error)) {
      await deps.wipe();
      return { step: "signed_out" };
    }
    if (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 401) {
      clearSession(runtime.secrets);
      return { step: "signed_out" };
    }
    return { step: "fatal", error: error instanceof Error ? error : new Error(String(error)) };
  }
}
