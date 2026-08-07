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
 * (database `ledger-v2`, object store `dbs`, key = the driver's `name`) in
 * three cases: on demand via `flush()`, debounced 500ms after any
 * `transaction()` completes, and immediately on `visibilitychange` firing
 * `"hidden"` (the one moment a mobile Safari tab can be killed with no further
 * warning). None of these are exclusive — the debounce coalesces bursts of
 * writes, `flush()` lets a caller force a write it cares about landing (e.g.
 * before signing out), and the visibility handler is the last-resort net.
 *
 * # The in-memory fallback is not test scaffolding
 *
 * `indexedDB` is undefined in two real situations this driver must survive:
 * Safari private browsing (where the property either throws on access or
 * silently refuses writes, depending on version) and this project's own test
 * suite (jsdom implements neither `indexedDB` nor a WASM fetch path). Rather
 * than special-case either, the driver checks once for `indexedDB` and falls
 * back to an in-process `Map` keyed by name — which is exactly right for
 * private browsing (nothing should survive the tab closing) and happens to
 * also be exactly what a test needs (a `flush()` + reopen round-trip with no
 * real disk involved).
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
 * The in-memory fallback for when `indexedDB` is unavailable — see the module
 * doc's "in-memory fallback" section. Module-scoped (not per-driver) so that
 * closing and reopening a driver by the same name, without ever touching real
 * IndexedDB, still round-trips — the same shape a real `indexedDB` gives for
 * free via its own on-disk persistence.
 */
const memoryBytes = new Map<string, Uint8Array>();

/** True under Node (this project's test runner). See the module doc. */
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

async function loadBytes(name: string): Promise<Uint8Array | null> {
  if (!hasIndexedDb()) return memoryBytes.get(name) ?? null;
  return idbLoad(name);
}

async function saveBytes(name: string, bytes: Uint8Array): Promise<void> {
  if (!hasIndexedDb()) {
    memoryBytes.set(name, bytes);
    return;
  }
  await idbSave(name, bytes);
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
  const priorBytes = await loadBytes(name);
  const db: Database = new SQL.Database(priorBytes ?? undefined);

  const held = new Set<Statement>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const persistNow = async (): Promise<void> => {
    if (closed) return;
    await saveBytes(name, db.export());
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void persistNow();
    }, FLUSH_DEBOUNCE_MS);
  };

  const onHidden = (): void => {
    if (document.visibilityState === "hidden") void persistNow();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onHidden);
  }

  // `transaction` is not re-entrant (see `SqlDriver.transaction`'s own
  // contract); `sqliteStore` never nests one anyway, but this driver still
  // refuses to pretend BEGIN/COMMIT compose, since sql.js has no savepoint
  // helper for it to fall back on.
  let inTransaction = false;

  const driver: SqlDriver & { flush(): Promise<void> } = {
    location: `sqljs:${name}`,

    exec(sql: string): void {
      db.exec(sql);
    },

    prepare(sql: string): SqlStatement {
      const raw = db.prepare(sql);
      held.add(raw);
      const stmt: HeldStatement = {
        raw,
        run(...args: unknown[]): void {
          raw.run(args as (string | number | Uint8Array | null)[]);
        },
        all(...args: unknown[]): unknown[] {
          raw.bind(args as (string | number | Uint8Array | null)[]);
          const rows: unknown[] = [];
          while (raw.step()) rows.push(raw.getAsObject());
          raw.reset();
          return rows;
        },
      };
      return stmt;
    },

    transaction<T>(fn: () => T): T {
      if (inTransaction) return fn();
      inTransaction = true;
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        inTransaction = false;
        scheduleFlush();
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
      for (const raw of held) raw.free();
      held.clear();
      db.close();
    },

    flush: persistNow,
  };

  return driver;
}
