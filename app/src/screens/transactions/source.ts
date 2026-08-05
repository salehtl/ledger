/**
 * The seam between the transaction screens and the device's SQLite.
 *
 * # Why the screens do not take a `SqlDriver`
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * A `TxnSource` can be a plain object in a test, so a render test needs neither
 * `expo-sqlite` (a native module `jest-expo` cannot execute) nor a real
 * database. That is convenience.
 *
 * The other reason is that **there is no live database in the app yet.** The
 * projection is written by `SyncEngine`, which Task 8 constructs from a `Client`
 * and a server base URL that this repo deliberately does not record — the same
 * gap `auth/native.ts` reports as `backend: null`. So `Transactions` renders
 * with `source: null` today and says so on the glass, exactly as the sign-in
 * screen renders its Google button disabled with the reason on it. When Task 8
 * lands, {@link sqlTxnSource} is handed the one open driver and nothing in the
 * screens changes.
 *
 * The alternative — opening a second `expo-sqlite` connection here — is the
 * Phase 0 freeze: `openDatabaseSync` leaked a native connection per press and
 * the build hit >500 MB RSS. `openLedgerDatabase` is the only handle, and this
 * file does not call it.
 */

import { readMeta } from "@ledger/client/replay/projection.ts";
import type { ForkNotice, Txn } from "@ledger/client/replay/state.ts";
import type { Op } from "@ledger/client/wire/op.ts";
import type { SqlDriver } from "@ledger/client/store/driver.ts";

import {
  listTransactions,
  readForkNoticesFor,
  readTxn,
  type TxnFilters,
  type TxnPage,
  type TxnPageOptions,
} from "../../lib/transactions.ts";
import {
  commitSplit,
  commitTxnEdit,
  type CommitResult,
  type EditDeps,
  type SplitDraftLine,
  type TxnEditDraft,
} from "../../lib/txnEdit.ts";
import { sqlCurrencySource, type FxAction } from "../currencies/source.ts";

/** The chip values a filter strip can offer, drawn from what is actually here. */
export interface TxnFacets {
  /** Includes `null` when some live row is uncategorized. */
  categories: (string | null)[];
  currencies: string[];
}

export interface TxnSource {
  list(filters: TxnFilters, opts: TxnPageOptions): TxnPage;
  read(id: string): Txn | null;
  forks(id: string): ForkNotice[];
  facets(): TxnFacets;
  homeCurrency(): string | null;
  edit(id: string, draft: TxnEditDraft): CommitResult;
  split(id: string, lines: readonly SplitDraftLine[]): CommitResult;
  recomputeHome(id: string): FxAction;
}

/**
 * A source over the projection.
 *
 * `enqueue` is `Outbox.enqueue` in production — it validates and persists the op
 * before it returns, so an edit the user has seen accepted survives the app
 * being killed on the next line — and `newId` is `ulid`. Both are injected
 * rather than imported so this module stays free of the app's dependencies and
 * runnable under `bun test`.
 */
export function sqlTxnSource(db: SqlDriver, io: Pick<EditDeps, "enqueue" | "newId"> & { readonly pending?: readonly Op[] }): TxnSource {
  const deps: EditDeps = { db, enqueue: io.enqueue, newId: io.newId };
  const currencies = sqlCurrencySource(db, { enqueue: io.enqueue, get pending() { return io.pending ?? []; } });
  return {
    list: (filters, opts) => listTransactions(db, filters, opts),
    read: (id) => readTxn(db, id),
    forks: (id) => readForkNoticesFor(db, id),
    facets(): TxnFacets {
      // Bounded by the number of distinct categories and currencies, not by the
      // log's length, so this is one small query rather than a pass over the
      // table. A filter strip that had to scan 3,683 rows to know what to offer
      // would be the read-all shape wearing a different hat.
      const categories = db
        .prepare("SELECT DISTINCT category FROM txn WHERE superseded_by IS NULL ORDER BY category")
        .all()
        .map((r) => {
          const v = (r as Record<string, unknown>)["category"];
          return v === null ? null : String(v);
        });
      const currencies = db
        .prepare("SELECT DISTINCT currency FROM txn WHERE superseded_by IS NULL AND currency <> '' ORDER BY currency")
        .all()
        .map((r) => String((r as Record<string, unknown>)["currency"]));
      return { categories, currencies };
    },
    homeCurrency: () => readMeta(db)?.homeCurrency ?? null,
    edit: (id, draft) => commitTxnEdit(deps, id, draft),
    split: (id, lines) => commitSplit(deps, id, lines),
    recomputeHome: (id) => currencies.recompute(id),
  };
}
