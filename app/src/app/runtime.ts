import { Client, newEntityID } from "@ledger/client/net/client.ts";
import { closeSharedDriver, sharedDriver, SyncEngine, type SyncEngineOptions } from "@ledger/client/net/engine.ts";
import { Outbox } from "@ledger/client/outbox/outbox.ts";
import { sqliteStore } from "@ledger/client/store/sqlite.ts";
import type { SqlDriver } from "@ledger/client/store/driver.ts";
import type { SecretStore, Store } from "@ledger/client/store/store.ts";

import { sqliteReviewSource, type ReviewSource } from "../db/reviewQueue.ts";
import { sqlTxnSource, type TxnSource } from "../screens/transactions/source.ts";
import { SyncCoordinator } from "../sync/coordinator.ts";
import { auditDue, noteLaunch } from "@ledger/client/replay/audit.ts";
import type { DeviceConditions } from "@ledger/client/replay/audit.ts";
import { createQuarantineSource, type QuarantineSource } from "../screens/quarantine/source.ts";
import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { sqlCurrencySource, type CurrencySource } from "../screens/currencies/source.ts";
import type { ImportIO } from "../screens/import/workflow.ts";
import { RollingColdSync } from "../sync/cold.ts";
import { sqliteColdBodyIndex } from "../db/coldIndex.ts";
import { fetchTemplates } from "../sync/templates.ts";
import { reprocessCold, type ReprocessCandidate, type ReprocessProgress, type ReprocessResult } from "../sync/reprocess.ts";
import { EMPTY_FILTERS } from "../lib/transactions.ts";
import { sqlBudgetSource, type BudgetSource } from "../screens/budget/source.ts";
import { SampleSource, waitlistSource, type WaitlistSource } from "../samples/source.ts";
import { dictionarySubmitter } from "../dictionary/submission.ts";
import { sqliteDictionarySource, type DictionarySource } from "../dictionary/source.ts";
import type { RawMessageSource } from "../screens/review/deps.ts";
import { deviceIdentity, type DeviceIdentity } from "../security/model.ts";

export const PRODUCT_DATABASE = "ledger.db";

export interface RuntimeDeps {
  server: string;
  openDriver: (name: string) => SqlDriver;
  secrets: SecretStore;
  fetch?: typeof fetch;
  yieldToUI?: SyncEngineOptions["yield"];
  newId?: () => string;
  onDisposed?: (runtime: AppRuntime) => void;
  deleteDatabase?: (name: string) => Promise<void>;
  purgeSecrets?: (writerIds: readonly string[]) => Promise<void>;
  auditConditions?: () => DeviceConditions;
}

export interface AppRuntime {
  readonly server: string;
  readonly db: SqlDriver;
  readonly secrets: SecretStore;
  readonly store: Store;
  readonly client: Client;
  readonly outbox: Outbox;
  readonly sync: SyncEngine;
  readonly coordinator: SyncCoordinator;
  readonly txns: TxnSource;
  readonly review: ReviewSource;
  readonly quarantine: QuarantineSource;
  readonly currencies: CurrencySource;
  readonly importIO: ImportIO;
  readonly reprocess: { start(onProgress: (p: ReprocessProgress) => void, cancelled: () => boolean): Promise<ReprocessResult> };
  readonly budget: BudgetSource;
  readonly waitlist: WaitlistSource;
  readonly samples: SampleSource;
  readonly rawMessages: RawMessageSource;
  readonly dictionary: DictionarySource;
  readonly accountEpoch: number;
  readonly newId: () => string;
  deviceIdentity(): DeviceIdentity | null;
  dispose(): Promise<void>;
  wipeAccount(): Promise<void>;
  runAudit(): Promise<void>;
  onboardingFacts(): Promise<{ inboundAddress: string | null; firstMailConfirmedAt: string | null; homeCurrency: string | null }>;
  commitOnboardingOps(ops: readonly OpSpec[]): Promise<void>;
}

let activeRuntime: AppRuntime | null = null;
let activeIdentity: { server: string; secrets: SecretStore } | null = null;

/** Builds the complete account-scoped graph over exactly one shared driver. */
export function createRuntime(deps: RuntimeDeps): AppRuntime {
  if (activeRuntime !== null) {
    if (activeIdentity?.server !== deps.server || activeIdentity.secrets !== deps.secrets) {
      throw new Error("an account runtime is already active; dispose it before changing server or secret store");
    }
    return activeRuntime;
  }
  const db = sharedDriver(PRODUCT_DATABASE, () => deps.openDriver(PRODUCT_DATABASE));
  const store = sqliteStore(db, { secrets: deps.secrets, server: deps.server });
  const client = new Client({ store, server: deps.server, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  const outbox = new Outbox(client);
  const sync = new SyncEngine(client, db, ...(deps.yieldToUI === undefined ? [] : [{ yield: deps.yieldToUI }]));
  const coordinator = new SyncCoordinator(sync);
  const txns = sqlTxnSource(db, { enqueue: outbox.enqueue.bind(outbox), newId: deps.newId ?? newEntityID, get pending() { return outbox.pending; } });
  const review = sqliteReviewSource(db);
  const quarantine = createQuarantineSource({
    server: deps.server,
    token: () => client.sessionToken,
    ...(deps.fetch === undefined ? {} : { fetch: (request) => deps.fetch!(request) }),
    sync: () => coordinator.run("refresh"),
  });
  const currencies = sqlCurrencySource(db, outbox);
  const budget = sqlBudgetSource(db);
  const importIO: ImportIO = {
    enqueueMany: (specs) => { outbox.enqueueMany(specs); },
    newId: deps.newId ?? newEntityID,
    yieldToUI: deps.yieldToUI ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
  };
  const cold = new RollingColdSync({ client, rows: client.rows(), index: sqliteColdBodyIndex(db) });
  const waitlist = deps.fetch === undefined ? waitlistSource(deps.server, () => client.sessionToken) : waitlistSource(deps.server, () => client.sessionToken, deps.fetch);
  const samples = new SampleSource({ server: deps.server, token: () => client.sessionToken, cold, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  const submitter = deps.fetch === undefined ? dictionarySubmitter(deps.server, () => client.sessionToken) : dictionarySubmitter(deps.server, () => client.sessionToken, deps.fetch);
  // `writer: outbox` is what makes the dictionary a *re-categorizer* rather than
  // a store: `recategorize()` emits `txn_categorized` for rows that still have
  // no category, which is plan Task 20 Step 2 and the only reason a published
  // entry ever reaches a transaction.
  const dictionary = sqliteDictionarySource({ db, server: deps.server, token: () => client.sessionToken, submitter, writer: outbox, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  const rawMessages: RawMessageSource = { async read(ingestID) { const bytes = await cold.fetchBody(ingestID); return bytes === null ? null : { text: new TextDecoder().decode(bytes), receivedAt: new Date().toISOString() }; } };
  let templateVersion = 0n;
  const templates = new Map<string, Awaited<ReturnType<typeof fetchTemplates>>["templates"][number]>();
  const reprocess = {
    async start(onProgress: (p: ReprocessProgress) => void, cancelled: () => boolean): Promise<ReprocessResult> {
      const page = await fetchTemplates({ server: deps.server, token: client.sessionToken, since: templateVersion, ...(deps.fetch === undefined ? {} : { fetch: (r) => deps.fetch!(r) }) });
      for (const id of page.removed) templates.delete(id);
      for (const item of page.templates) templates.set(item.id, item);
      templateVersion = page.version;
      const candidates: ReprocessCandidate[] = [];
      let after = null;
      for (;;) {
        if (cancelled()) return { examined: 0, emitted: 0, skipped: 0, unavailable: 0, total: candidates.length, cancelled: true };
        const page = txns.list(EMPTY_FILTERS, { limit: 250, after });
        for (const txn of page.rows) if (txn.unparsed && (txn.tier === "none" || txn.tier === "heuristic")) candidates.push({ txn, verifiedDomain: txn.verified_origin_domain ?? null });
        if (page.next === null) break;
        after = page.next;
      }
      try {
        return await reprocessCold({ candidates: () => candidates, cold: async (id, stop) => ({ verified: true, body: await cold.fetchBody(id, stop) }), templates: [...templates.values()].map((t) => t.definition), enqueue: outbox.enqueue.bind(outbox), newId: deps.newId ?? newEntityID, yieldToUI: importIO.yieldToUI, cancelled, onProgress });
      } finally { cold.prune(); }
    },
  };
  noteLaunch(db);
  let disposed = false;

  const shutDown = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await sync.quiesce("runtime disposed");
    closeSharedDriver(PRODUCT_DATABASE);
    if (activeRuntime === runtime) {
      activeRuntime = null;
      activeIdentity = null;
    }
    deps.onDisposed?.(runtime);
  };
  const runtime: AppRuntime = Object.freeze({
    server: deps.server,
    db,
    secrets: deps.secrets,
    store,
    client,
    outbox,
    sync,
    coordinator,
    txns,
    review,
    quarantine,
    currencies,
    importIO,
    reprocess,
    budget,
    waitlist,
    samples,
    rawMessages,
    dictionary,
    accountEpoch: 0,
    newId: deps.newId ?? newEntityID,
    deviceIdentity: () => deviceIdentity(store.load()),
    async dispose(): Promise<void> {
      await shutDown();
    },
    async wipeAccount(): Promise<void> {
      const writerIds = [...store.load().writers.keys()];
      await shutDown();
      await deps.deleteDatabase?.(PRODUCT_DATABASE);
      await deps.purgeSecrets?.(writerIds);
    },
    async runAudit(): Promise<void> {
      if (auditDue(db, client.cursor("hot"), Date.now()) === null) return;
      await sync.audit(deps.auditConditions ?? (() => ({ mainsPower: false, foreground: true, thermal: "nominal", busy: false })));
    },
    async onboardingFacts() {
      const state = client.state();
      let inboundAddress: string | null = null;
      if (client.sessionToken !== null) {
        const response = await (deps.fetch ?? fetch)(new Request(new URL("/api/v1/address", deps.server), { headers: { authorization: `Bearer ${client.sessionToken}` } }));
        if (!response.ok) throw Object.assign(new Error(`address refresh failed: ${response.status}`), { status: response.status, code: "" });
        const body = await response.json() as { address?: unknown };
        if (typeof body.address !== "string" || body.address === "") throw new Error("address refresh returned no address");
        inboundAddress = body.address;
      }
      const first = [...state.txns.values()].sort((a, b) => a.posted_at.localeCompare(b.posted_at))[0];
      return { inboundAddress, firstMailConfirmedAt: first?.posted_at ?? null, homeCurrency: state.homeCurrency };
    },
    async commitOnboardingOps(ops: readonly OpSpec[]): Promise<void> {
      outbox.enqueueMany(ops);
      await coordinator.run("refresh");
    },
  });
  activeRuntime = runtime;
  activeIdentity = { server: deps.server, secrets: deps.secrets };
  return runtime;
}
