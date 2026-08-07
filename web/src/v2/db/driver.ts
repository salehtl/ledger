/**
 * The browser `SqlDriver`: sql.js (SQLite compiled to WASM) fronted by
 * IndexedDB persistence.
 *
 * # Async init, sync driver
 *
 * sql.js has to fetch (or, under Node, read) its WASM before anything can run,
 * and loading any prior bytes out of IndexedDB is async too — so
 * `openBrowserDriver` returns a `Promise`. Everything the promise resolves to
 * is synchronous, because `sqliteStore` (`client/src/store/sqlite.ts`) is
 * written against `SqlDriver`'s synchronous contract (see `driver.ts` in
 * `client/` — the doc comment there tables it against `expo-sqlite`'s own
 * sync API) and cannot be handed an async `exec`/`prepare`/`transaction`.
 *
 * # Persistence model
 *
 * sql.js keeps the whole database in WASM linear memory; nothing reaches disk
 * until `db.export()` is called. This driver exports and writes to IndexedDB
 * (database `ledger-v2`, object store `dbs`, key = the driver's `name`) on
 * four triggers: on demand via `flush()`; debounced 500ms after ANY mutation
 * — `exec()`, a prepared statement's `run()`, or a committed `transaction()`,
 * tracked by a driver-level `dirty` flag rather than only from `transaction()`
 * (an earlier version of this driver scheduled only from `transaction()`,
 * which meant `sqliteStore.save()` and `RowStore.prune()` — both of which
 * call `stmt.run` directly, never wrapped in `atomic()` — scheduled no
 * persistence at all); immediately on `visibilitychange` firing `"hidden"`
 * (the one moment a mobile Safari tab can be killed with no further warning);
 * and — because `close()` is otherwise a silent data-loss window for whatever
 * mutated in the preceding 500ms — a pending dirty write is flushed as part
 * of `close()` itself, synchronously exported before the underlying database
 * handle is torn down. None of these are exclusive — the debounce coalesces
 * bursts of writes, `flush()` lets a caller force a write it cares about
 * landing (e.g. before signing out), and the visibility/close paths are the
 * last-resort nets.
 *
 * # The in-memory fallback is not test scaffolding
 *
 * `indexedDB` is undefined in two real situations this driver must survive:
 * Safari private browsing on older versions (where the property itself is
 * absent) and this project's own test suite (jsdom implements neither
 * `indexedDB` nor a WASM fetch path). Newer Safari private-browsing *defines*
 * `indexedDB` but can still fail to open a connection or fail a write (quota,
 * or an internal restriction) — that path is not "undefined," so `loadBytes`/
 * `saveBytes` also catch a rejected IndexedDB operation and degrade to the
 * same in-memory `Map`, rather than letting the driver fail to open or a
 * write silently vanish. `openIdb` also handles `onblocked` (a stuck version
 * upgrade elsewhere) by rejecting rather than leaving the promise pending
 * forever, which would otherwise hang `openBrowserDriver` indefinitely.
 *
 * Rather than special-case any of these, the driver checks once for
 * `indexedDB` (and again on any IDB failure) and falls back to an in-process
 * `Map` keyed by name — which is exactly right for private browsing (nothing
 * should survive the tab closing) and happens to also be exactly what a test
 * needs (a `flush()`/`close()` + reopen round-trip with no real disk
 * involved). `driver.location` is prefixed `sqljs-memory:` rather than
 * `sqljs:` whenever this driver is running on the fallback, so a caller can
 * tell the session is ephemeral rather than assume real persistence it does
 * not have.
 *
 * KNOWN COVERAGE GAP: every test in this project runs under jsdom, which has
 * no `indexedDB` at all — so every existing test (`driver.test.ts`,
 * `store-conformance.test.ts`) exercises the in-memory fallback exclusively.
 * The real-IndexedDB path (`openIdb`/`idbLoad`/`idbSave`, including the
 * `onblocked`/error-degradation handling above) has zero test coverage as of
 * this task and needs a real-browser harness (e.g. `web/harness/`, WebKit or
 * Chromium) to close.
 *
 * # The bigint trap
 *
 * sql.js returns a JS `number` for every SQLite `INTEGER` column, silently
 * losing precision above 2^53. `client/src/store/sqlite.ts`'s `SCHEMA` and
 * `client/src/replay/projection.ts`'s `PROJECTION_SCHEMA` both declare every
 * column that can hold a seq, an amount, or any other unbounded counter as
 * `TEXT` — never `INTEGER` — for exactly this reason (their own doc comments
 * say so; `store/sqlite.ts` calls out `seq`, and `projection.ts`'s "Money is
 * TEXT" section calls out `amount_minor` et al.). That means this driver does
 * not need to intercept or re-encode integers itself: nothing sql.js hands
 * back through `stmt.getAsObject()` for those columns is ever an `INTEGER`.
 * `size_bucket`, `needs_review`, `version` and the like stay `INTEGER` on
 * purpose — they are small, bounded values, never a seq or a minor-unit amount.
 */
import type { SqlDriver, SqlStatement } from "@ledger/client/store/driver";
import initSqlJs, { type Database, type Statement } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

const IDB_NAME = "ledger-v2";
const IDB_STORE = "dbs";
const FLUSH_DEBOUNCE_MS = 500;

/**
 * The in-memory fallback for when `indexedDB` is unavailable or fails — see
 * the module doc's "in-memory fallback" section. Module-scoped (not
 * per-driver) so that closing and reopening a driver by the same name,
 * without ever touching real IndexedDB, still round-trips — the same shape a
 * real `indexedDB` gives for free via its own on-disk persistence.
 */
const memoryBytes = new Map<string, Uint8Array>();

/**
 * Whether this environment implements `indexedDB` at all. `false` under
 * Node (this project's test runner, via jsdom) and on older Safari private
 * browsing; `true` does not by itself guarantee an open or a write will
 * succeed — see `loadBytes`/`saveBytes` for the fallback that also covers
 * that case.
 */
function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error as Error);
    // Without this, a version-change request blocked by another open
    // connection leaves the promise pending forever rather than settling —
    // this project only ever opens version 1, so it is a rare race (e.g. two
    // tabs racing the very first open), but a hang is a worse failure mode
    // than a fast rejection into the in-memory fallback below.
    req.onblocked = () => reject(new Error("indexedDB open blocked by a pending version change"));
  });
}

async function idbLoad(name: string): Promise<Uint8Array | null> {
  const db = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(name);
      req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
      req.onerror = () => reject(req.error as Error);
    });
  } finally {
    db.close();
  }
}

async function idbSave(name: string, bytes: Uint8Array): Promise<void> {
  const db = await openIdb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(bytes, name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
      tx.onabort = () => reject(tx.error as Error);
    });
  } finally {
    db.close();
  }
}

/**
 * Loads prior bytes for `name`, degrading to the in-memory fallback both when
 * `indexedDB` is absent and when a present `indexedDB` fails (private
 * browsing quirks, `onblocked`, quota). `noteDegraded` is called in the
 * latter two cases so the caller can mark the driver's `location` as
 * ephemeral — see the module doc.
 */
async function loadBytes(name: string, noteDegraded: () => void): Promise<Uint8Array | null> {
  if (!hasIndexedDb()) {
    noteDegraded();
    return memoryBytes.get(name) ?? null;
  }
  try {
    return await idbLoad(name);
  } catch {
    noteDegraded();
    return memoryBytes.get(name) ?? null;
  }
}

/** The save-side counterpart of {@link loadBytes}. */
async function saveBytes(name: string, bytes: Uint8Array, noteDegraded: () => void): Promise<void> {
  if (!hasIndexedDb()) {
    noteDegraded();
    memoryBytes.set(name, bytes);
    return;
  }
  try {
    await idbSave(name, bytes);
  } catch {
    noteDegraded();
    memoryBytes.set(name, bytes);
  }
}

/**
 * True under Node — this project's test runner and, incidentally, `bun
 * ledger`'s own CLI process if it were ever to import this module (it is not
 * meant to). sql.js's Node build locates its own WASM relative to its own
 * `dist/` directory when `locateFile` is left unset, which is the correct
 * behaviour there; a Vite-fingerprinted asset URL (this module's `wasmUrl`)
 * is a web server path with no meaning to `fs.readFileSync`, and passing it
 * under Node is what breaks vitest (see driver.test.ts's own comment).
 */
function isNode(): boolean {
  return typeof process !== "undefined" && process.versions?.node !== undefined;
}

/**
 * A `SqlStatement` plus the sql.js handle it owns, so `close()` can free
 * every statement a caller forgot to (`expo-sqlite` requires the equivalent;
 * see `client/src/store/driver.ts`'s doc comment).
 */
interface HeldStatement extends SqlStatement {
  readonly raw: Statement;
}

/**
 * Opens (or creates) a browser-persisted SQLite database named `name`.
 *
 * The returned driver satisfies `SqlDriver` and adds `flush()`, an explicit
 * "persist now" a caller can await — e.g. before navigating away from a
 * screen that just wrote something worth not losing to the 500ms debounce.
 */
export async function openBrowserDriver(name: string): Promise<SqlDriver & { flush(): Promise<void> }> {
  const SQL = await initSqlJs(isNode() ? {} : { locateFile: () => wasmUrl });

  // Whether this driver has fallen back to the in-memory store, for
  // `location` — see the module doc's "in-memory fallback" section. Starts
  // at whatever `loadBytes` discovers on open (unavailable, or a failed
  // open/read) and can flip true later if a write degrades too; it never
  // flips back, since a driver that has proven it cannot trust `indexedDB`
  // has no way to know a later attempt would succeed, and claiming real
  // persistence again would be the misleading state this flag exists to rule
  // out.
  let usingMemory = false;
  const noteDegraded = (): void => {
    usingMemory = true;
  };

  const priorBytes = await loadBytes(name, noteDegraded);
  const db: Database = new SQL.Database(priorBytes ?? undefined);

  const held = new Set<Statement>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  // Set by any mutation, cleared once it has been exported and handed to
  // `saveBytes`. Driving `close()`'s "persist what's pending" step off this
  // flag (rather than off "is a flush timer currently armed") is what makes
  // close() correct even if it runs in the same tick a mutation scheduled its
  // debounce: the flag is set synchronously by the mutation itself.
  let dirty = false;

  const persistNow = async (): Promise<void> => {
    if (closed || !dirty) return;
    dirty = false;
    await saveBytes(name, db.export(), noteDegraded);
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void persistNow();
    }, FLUSH_DEBOUNCE_MS);
  };

  /** Called by every mutation path: `exec`, a statement's `run`, and a committed `transaction`. */
  const markDirty = (): void => {
    dirty = true;
    scheduleFlush();
  };

  const onHidden = (): void => {
    if (document.visibilityState === "hidden") void persistNow();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onHidden);
  }

  // `transaction` is not re-entrant (see `SqlDriver.transaction`'s own
  // contract: `expo-sqlite`'s `withTransactionSync` does not nest either).
  // sql.js has no savepoint helper to fall back on for a real nested
  // BEGIN/COMMIT, so a re-entrant call is refused outright rather than
  // silently joining the outer transaction, which would be a passing test
  // today and a wrong-on-the-day-someone-relies-on-it bug tomorrow.
  let inTransaction = false;

  const driver: SqlDriver & { flush(): Promise<void> } = {
    // A getter, not a plain field: `usingMemory` can flip true after open
    // (a write degrading mid-session), and `location` should reflect that
    // the moment it happens rather than freeze the answer from open time.
    get location(): string {
      return `${usingMemory ? "sqljs-memory" : "sqljs"}:${name}`;
    },

    exec(sql: string): void {
      db.exec(sql);
      markDirty();
    },

    prepare(sql: string): SqlStatement {
      const raw = db.prepare(sql);
      held.add(raw);
      const stmt: HeldStatement = {
        raw,
        run(...args: unknown[]): void {
          raw.run(args as (string | number | Uint8Array | null)[]);
          markDirty();
        },
        all(...args: unknown[]): unknown[] {
          raw.bind(args as (string | number | Uint8Array | null)[]);
          const rows: unknown[] = [];
          try {
            while (raw.step()) rows.push(raw.getAsObject());
          } finally {
            // In a `finally` so a SQL error mid-iteration still resets the
            // statement — otherwise the bound-parameter buffers sql.js
            // allocated for this call leak until the next `bind()` reclaims
            // them, and the statement is left unusable for its next caller.
            raw.reset();
          }
          return rows;
        },
      };
      return stmt;
    },

    transaction<T>(fn: () => T): T {
      if (inTransaction) {
        throw new Error("SqlDriver.transaction is not re-entrant (nested transaction() call)");
      }
      inTransaction = true;
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        markDirty();
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // A ROLLBACK can itself fail — e.g. SQLite already auto-rolled the
          // transaction back for a reason like SQLITE_FULL before `fn`'s
          // throw even reached here — and that secondary failure must not
          // replace the caller's original error, which is what's actually
          // informative.
        }
        throw err;
      } finally {
        inTransaction = false;
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onHidden);
      }
      // Export BEFORE freeing statements/closing `db`: a pending debounced
      // write must not be silently discarded just because nobody called
      // `flush()` first. The export itself is synchronous (sql.js copies the
      // WASM heap into a `Uint8Array` immediately); only the destination
      // write can be async, so it is fired without awaiting — `close()` is
      // synchronous per `SqlDriver`, `saveBytes`'s in-memory-fallback path
      // (this project's tests, and the case this matters most for: private
      // browsing, where nothing should outlive the tab anyway) completes
      // synchronously within that call, and a real IndexedDB write is
      // best-effort beyond that point, same as it would be on an abrupt tab
      // kill regardless of what this function does.
      if (dirty) {
        const bytes = db.export();
        dirty = false;
        void saveBytes(name, bytes, noteDegraded);
      }
      for (const raw of held) raw.free();
      held.clear();
      db.close();
    },

    flush: persistNow,
  };

  return driver;
}
