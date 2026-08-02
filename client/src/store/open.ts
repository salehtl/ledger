/**
 * How the CLI and the test suite choose a store — and the switch that runs the
 * WHOLE suite against SQLite.
 *
 * ```
 * cd client && bun test                              # file / mem store
 * cd client && LEDGER_CLIENT_STORE=sqlite bun test   # the same suite, SQLite-backed
 * ```
 *
 * That second run is the exit condition Task 5 is really about. The phone's
 * persistence layer is not a fresh, untested surface: it inherits Phase 1's
 * entire test corpus — every chain check, every re-fold, the two-device exit
 * scenario — because the only thing that changed is which `Store` those tests
 * construct. It is also what proves the `all()` → `range()` refactor in
 * `Client.check`/`materialize` changed no result.
 *
 * This module imports `bun:sqlite` (through `./driver`) and `node:fs` (through
 * `./file`), so it is HOST-ONLY. `app/` must not import it; a device builds its
 * store directly:
 *
 * ```ts
 * sqliteStore(expoDriver("ledger.db"), { secrets: keychainSecretStore() })
 * ```
 */

import { chmodSync } from "node:fs";
import { join } from "node:path";

import { bunDriver } from "./driver";
import { ensureStateDir, fileSecretStore, fileStore } from "./file";
import { sqliteStore } from "./sqlite";
import { memSecretStore, memStore, type Store } from "./store";

/** `sqlite` swaps every store below for {@link sqliteStore}. Anything else is the default. */
export function sqliteMode(): boolean {
  return process.env["LEDGER_CLIENT_STORE"] === "sqlite";
}

/**
 * A durable store for `profile` under `dir`.
 *
 * In SQLite mode the secrets go to a 0600 file beside the database rather than
 * into it — the CLI is many processes and has no keychain. The point of the
 * mode is that the DATABASE is provably free of them under the whole suite;
 * where the host-side stand-in puts them is not the claim.
 */
export function openStore(dir: string, profile: string, server?: string): Store {
  if (!sqliteMode()) return fileStore(dir, profile);
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error(`profile ${JSON.stringify(profile)} must match [A-Za-z0-9._-]+`);
  }
  // 0700 and ignoring itself, exactly as the file store leaves it: the database
  // holds the same log and the same public keys.
  ensureStateDir(dir);
  const path = join(dir, `${profile}.db`);
  const driver = bunDriver(path);
  // SQLite creates its file 0644 minus the umask, and gives the `-wal` and
  // `-shm` files the database's own mode — so this one chmod covers all three.
  // The database is not the keystore, but it is the whole financial log.
  chmodSync(path, 0o600);
  return sqliteStore(driver, {
    secrets: fileSecretStore(join(dir, `${profile}.secrets.json`)),
    ...(server === undefined ? {} : { server }),
  });
}

/** The non-durable store the unit tests use, in whichever mode is selected. */
export function openMemStore(server = ""): Store {
  if (!sqliteMode()) return memStore(server);
  return sqliteStore(bunDriver(":memory:"), { secrets: memSecretStore(), server });
}
