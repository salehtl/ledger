/**
 * The narrow SQLite surface {@link sqliteStore} is written against, and the Bun
 * implementation of it.
 *
 * # Why the interface lives in `client/` and not in a client app
 *
 * `client/`'s whole test suite runs against the SQLite store (see
 * `LEDGER_CLIENT_STORE=sqlite` in `open.ts`), which is what makes a device's
 * persistence layer inherit Phase 1's test corpus instead of being a fresh,
 * untested surface. If the interface lived in the app, `client/` would have to
 * import from the app to run its own tests — the library depending on the
 * application. So the contract and the Bun driver are here, and each client
 * contributes exactly one function.
 *
 * # The client implementations
 *
 * `web/src/v2/db/driver.ts`'s `openBrowserDriver()` is that one function for
 * the PWA: sql.js (SQLite compiled to WASM) fronted by IndexedDB.
 *
 * The retired Expo client's `app/src/db/driver.ts` supplied `expoDriver(name)`
 * over `expo-sqlite` (`app/` was removed on 2026-08-10 and is preserved at tag
 * app-expo-final). Two obligations it had to meet do not show up in the type
 * signatures and bind any future driver over a native SQLite handle: a
 * statement prepared with `prepareSync` must be `finalizeSync()`d (so `close()`
 * finalizes the cache), and exactly ONE database handle may exist per database —
 * Phase 0's freeze was partly a native connection leaked per button press.
 */

import { Database } from "bun:sqlite";

// Installs the host `Platform`, for the same reason and in the same way as
// `store/file.ts` — see the long comment there. This module is host-only
// (`bun:sqlite`, above), and `engine.test.ts`'s spawned child imports it
// directly, so it is the second door a fresh Bun process can come through
// without touching `platform.ts`.
import "../platform";

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
