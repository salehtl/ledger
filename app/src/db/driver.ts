/**
 * `expoDriver` — the one function `app/` contributes to the store.
 *
 * `client/src/store/driver.ts` owns the `SqlDriver` contract and the `bun:sqlite`
 * implementation, and `client/src/store/sqlite.ts` owns `sqliteStore`, because
 * `client/`'s whole suite runs against the SQLite store
 * (`LEDGER_CLIENT_STORE=sqlite`) and the library must not depend on the app to
 * run its own tests. What is left for the device is this adapter.
 *
 * # The two rules that are not in the type signatures
 *
 * **One connection.** `openDatabaseSync` caches by name, but the Phase 0 build
 * that hit >500 MB RSS and froze leaked a native connection per button press
 * anyway (`useNewConnection`, or a second call after `closeSync`). The handle
 * is cached in this module and `openLedgerDatabase` is the only way to get one,
 * so "one connection" is a property of the module rather than of every caller.
 *
 * **Statements are finalized.** `prepareSync` allocates a native statement that
 * `expo-sqlite` will not collect for you. Every prepared statement is kept in a
 * cache here and finalized in `close()`.
 *
 * # What is NOT verified on this box
 *
 * Nothing in this file has been executed. `expo-sqlite`'s sync API is a native
 * module: there is no Metro, no simulator and no Mac here, so this is checked
 * against `expo-sqlite@16.0.10`'s own type declarations (which `bun run
 * typecheck` enforces) and against the same version's documented semantics —
 * not against a running SQLite. What discharges that is Task 5 Step 4's
 * contract suite, `client/src/store/store.test.ts`, re-run on the device
 * against this driver: 63 tests that already pass against `bunDriver` and
 * `memStore`, so a divergence here shows up as a red test rather than as a
 * corrupt log. Until that run exists, treat this as unproven.
 */

import * as SQLite from "expo-sqlite";

import type { SqlDriver, SqlStatement } from "@ledger/client/store/driver.ts";

/**
 * The single handle. `expo-sqlite` caches by name internally too, but that
 * cache is keyed on options and a caller passing `useNewConnection` would slip
 * past it — this one cannot be slipped past, because nothing else in `app/`
 * calls `openDatabaseSync`.
 */
let handle: { name: string; db: SQLite.SQLiteDatabase } | null = null;

/** Opens (or returns) the one database connection this process may hold. */
export function openLedgerDatabase(name: string): SQLite.SQLiteDatabase {
  if (handle !== null) {
    if (handle.name !== name) {
      throw new Error(`sqlite: a connection to ${JSON.stringify(handle.name)} is already open; close it before opening ${JSON.stringify(name)}`);
    }
    return handle.db;
  }
  const db = SQLite.openDatabaseSync(name);
  handle = { name, db };
  return db;
}

/** Drops the cached handle. Exported for `close()` and for tests. */
function forgetHandle(): void {
  handle = null;
}

/**
 * The `SqlDriver` over `expo-sqlite`'s synchronous API.
 *
 * Parameters are positional `?` only, matching `bunDriver` and the contract.
 */
export function expoDriver(name: string): SqlDriver {
  const db = openLedgerDatabase(name);

  // WAL survives a kill mid-write. `bunDriver` sets the same two pragmas; a
  // store whose durability depends on which driver opened it would be a
  // property the shared contract suite cannot see.
  db.execSync("PRAGMA journal_mode = WAL");
  db.execSync("PRAGMA foreign_keys = ON");

  const prepared: SQLite.SQLiteStatement[] = [];
  let closed = false;

  const requireOpen = () => {
    if (closed) throw new Error("sqlite: driver is closed");
  };

  return {
    location: name,

    exec(sql: string): void {
      requireOpen();
      db.execSync(sql);
    },

    prepare(sql: string): SqlStatement {
      requireOpen();
      const st = db.prepareSync(sql);
      prepared.push(st);
      return {
        run(...args: unknown[]): void {
          requireOpen();
          // `executeSync` leaves the cursor open on the underlying statement.
          // Resetting is not optional: the next `executeSync` on the same
          // prepared statement throws if the cursor was left mid-result.
          const r = st.executeSync(args as SQLite.SQLiteBindParams);
          r.resetSync();
        },
        all(...args: unknown[]): unknown[] {
          requireOpen();
          const r = st.executeSync(args as SQLite.SQLiteBindParams);
          const rows = r.getAllSync() as unknown[];
          r.resetSync();
          return rows;
        },
      };
    },

    /**
     * `withTransactionSync` takes a `() => void`, so the result is carried out
     * through a closure. A throw inside `task` rolls back and propagates, which
     * is the behaviour `Store.transaction` depends on — a rolled-back `save`
     * must store neither rows nor cursor.
     *
     * Not re-entrant, exactly as `bunDriver` is not: `withTransactionSync` does
     * not nest.
     */
    transaction<T>(fn: () => T): T {
      requireOpen();
      const carried: { value?: T } = {};
      db.withTransactionSync(() => {
        carried.value = fn();
      });
      if (!("value" in carried)) throw new Error("sqlite: transaction body did not run");
      return carried.value as T;
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const st of prepared) {
        try {
          st.finalizeSync();
        } catch {
          // A statement finalized by `closeSync` is not an error worth
          // masking the close over.
        }
      }
      prepared.length = 0;
      db.closeSync();
      forgetHandle();
    },
  };
}
