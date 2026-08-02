/**
 * The narrow SQLite surface {@link sqliteStore} is written against, and the Bun
 * implementation of it.
 *
 * # Why the interface lives in `client/` and not in `app/`
 *
 * `client/`'s whole test suite runs against the SQLite store (see
 * `LEDGER_CLIENT_STORE=sqlite` in `open.ts`), which is what makes the phone's
 * persistence layer inherit Phase 1's test corpus instead of being a fresh,
 * untested surface. If the interface lived in `app/`, `client/` would have to
 * import from `app/` to run its own tests — the library depending on the
 * application. So the contract and the Bun driver are here, and `app/`
 * contributes exactly one function.
 *
 * # The React Native implementation
 *
 * `app/src/db/driver.ts`'s `expoDriver(name)` is that one function. It is NOT
 * written here, because `app/` does not exist yet (Task 3 builds it) and code
 * that cannot be run is the defect shape this project has hit repeatedly. What
 * it has to do is entirely mechanical, and every API it needs is confirmed
 * present in `expo-sqlite@16.0.10`'s own type declarations:
 *
 * | this interface        | `expo-sqlite@16.0.10`                                    |
 * |-----------------------|----------------------------------------------------------|
 * | open                  | `openDatabaseSync(name)` (`build/SQLiteDatabase.d.ts:322`) |
 * | `exec`                | `db.execSync(source)` (`:135`)                             |
 * | `prepare`             | `db.prepareSync(source)` (`:151`)                          |
 * | `SqlStatement.run`    | `stmt.executeSync(params)` / `db.runSync(sql, params)` (`:249`) |
 * | `SqlStatement.all`    | `stmt.executeSync(params).getAllSync()` (`build/SQLiteStatement.d.ts:208`) |
 * | `transaction`         | `db.withTransactionSync(task)` (`:190`)                    |
 * | `close`               | `db.closeSync()`                                           |
 *
 * Two obligations that do not show up in the type signatures: a statement
 * prepared with `prepareSync` must be `finalizeSync()`d (so `close()` finalizes
 * the cache), and exactly ONE `openDatabaseSync` handle may exist per database —
 * Phase 0's freeze was partly a native connection leaked per button press.
 */

import { Database } from "bun:sqlite";

/** A prepared statement. Parameters are positional `?`, never named. */
export interface SqlStatement {
  run(...args: unknown[]): void;
  all(...args: unknown[]): unknown[];
}

export interface SqlDriver {
  /** A human-readable location, for {@link Store.location}. */
  readonly location: string;
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /**
   * Runs `fn` inside one transaction, committing on return and rolling back on
   * a throw. Not re-entrant: `expo-sqlite`'s `withTransactionSync` does not
   * nest, so nothing here may nest either.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * `bun:sqlite`. Used by `client/`'s tests and the CLI — never on a device.
 *
 * This module is the ONLY one under `client/src/store/` that imports a host
 * runtime. `sqlite.ts` imports it with `import type` only, so a bundler that
 * cannot resolve `bun:sqlite` never has to: the store is reachable from
 * Hermes, the driver is not.
 */
export function bunDriver(path: string): SqlDriver {
  const db = new Database(path, { create: true });
  // WAL survives a kill mid-write; the file store's temp-file-and-rename is the
  // same property bought a different way.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return {
    location: path,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        run: (...args) => {
          st.run(...(args as never[]));
        },
        all: (...args) => st.all(...(args as never[])) as unknown[],
      };
    },
    transaction: <T,>(fn: () => T): T => db.transaction(fn)() as T,
    close: () => db.close(),
  };
}
