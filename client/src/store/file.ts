/**
 * The file-backed store: one JSON state file and one append-only rows file per
 * profile.
 *
 * # Why this still exists after Task 5
 *
 * The phone uses {@link sqliteStore}. This is the CLI instrument — `cli login`,
 * `cli pull`, the Phase 1 exit test — and those run as separate PROCESSES, so
 * "keep it in memory" is not available to them. It keeps the four properties
 * that made the original file store safe, and gains the one that Task 5 is
 * about:
 *
 *  - the directory is created 0700 and the state file written 0600, re-chmod'ed
 *    on every save, because a mode passed to `open` applies only at creation;
 *  - the state file is written to a temp file and renamed, so a crash cannot
 *    leave a truncated one;
 *  - the directory ignores ITSELF — `client/.gitignore` can only name the
 *    default `.ledger-client/`, while `--state-dir` takes any path, so a
 *    `.gitignore` containing `*` is written beside the files on every save.
 *    What they hold is an Ed25519 private key and a session bearer token;
 *  - **`save()` no longer writes the log.** The rows live in
 *    `<profile>.rows.jsonl`, one row per line, appended to and never rewritten
 *    by a save. That is the whole-state write, gone for this store too.
 *
 * The rows file is read whole on first use and held in memory, which is the
 * memory profile this store has always had and is precisely what a phone must
 * not do. That is not a gap being left open — it is the reason
 * {@link sqliteStore} exists.
 *
 * There is still no passphrase and no keychain here: this is a scratch artifact
 * for a test rig on a single-operator box. A product client must not reuse it;
 * Phase 2's key belongs in the platform keystore, which is what
 * {@link SecretStore} is for.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  arrayRowStore,
  decodeState,
  emptyClientState,
  encodeState,
  type ClientState,
  type RowStore,
  type SecretStore,
  type Store,
  type WireRow,
} from "./store";

/** 0600, and 0600 again after writing: the mode on `open` applies only at creation. */
function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function appendPrivate(path: string, text: string): void {
  // `openSync(..., "a", 0o600)` creates with the right mode; an existing file
  // from an older build is re-chmod'ed, same as the state file.
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  appendFileSync(path, text);
}

/**
 * Creates the state directory 0700 and makes it ignore ITSELF.
 *
 * `client/.gitignore` can only name the default `.ledger-client/`, while
 * `--state-dir` takes any path — including one inside a working tree, which the
 * manual runs in Phase 1's own task reports used. So the directory carries a
 * `.gitignore` containing `*`, written on every save rather than only on
 * create, so a directory that predates this still gets one.
 */
export function ensureStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(join(dir, ".gitignore"), "# ledger v2 client state: private keys and session tokens.\n*\n");
}

/**
 * A store backed by one JSON file plus one JSONL rows file per profile.
 *
 * The directory is created 0700 and both files 0600 — see the module doc for
 * what is in them.
 */
export function fileStore(dir: string, profile: string): Store {
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error(`profile ${JSON.stringify(profile)} must match [A-Za-z0-9._-]+`);
  }
  const path = join(dir, `${profile}.json`);
  const rowsPath = join(dir, `${profile}.rows.jsonl`);

  const readLines = (): WireRow[] => {
    let text: string;
    try {
      text = readFileSync(rowsPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: WireRow[] = [];
    for (const [n, line] of text.split("\n").entries()) {
      if (line === "") continue;
      try {
        out.push(JSON.parse(line) as WireRow);
      } catch (err) {
        // A half-written last line means a crash mid-append. It is NOT skipped:
        // a silently short log with a saved cursor above it is the one state in
        // which a missing row is undetectable.
        throw new Error(`${rowsPath}: line ${n + 1} is not JSON (${(err as Error).message})`);
      }
    }
    return out;
  };

  const rows = arrayRowStore({
    hydrate: readLines,
    onAppend: (_stream, accepted) => {
      ensureStateDir(dirname(rowsPath));
      appendPrivate(rowsPath, accepted.map((r) => `${JSON.stringify(r)}\n`).join(""));
    },
    // Pruning is the one operation that has to rewrite the file. It is Task
    // 10's cold window and runs at most once per sync, not once per command.
    // `remaining` is BOTH streams — one file holds both, and rewriting it from
    // the pruned stream alone would delete the other one.
    onPrune: (remaining) => {
      ensureStateDir(dirname(rowsPath));
      const tmp = `${rowsPath}.tmp`;
      writePrivate(tmp, remaining.map((r) => `${JSON.stringify(r)}\n`).join(""));
      renameSync(tmp, rowsPath);
    },
  });

  return {
    location: path,
    load(): ClientState {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyClientState();
        throw err;
      }
      return decodeState(JSON.parse(text) as unknown, path);
    },
    save(state: ClientState): void {
      ensureStateDir(dirname(path));
      const tmp = `${path}.tmp`;
      // The mode on write applies only when the file is CREATED, so an existing
      // temp file from a crashed run would keep whatever mode it had. Removed
      // first, then chmod'ed again after writing, so neither path can leave the
      // private key world-readable.
      try {
        unlinkSync(tmp);
      } catch {
        /* not there: the normal case */
      }
      writePrivate(tmp, JSON.stringify(encodeState(state), null, 2));
      renameSync(tmp, path);
    },
    rows: (): RowStore => rows,
    // Two files cannot be committed together without a journal, and this store
    // is not the one that needs it. What it does guarantee is the ORDER: the
    // row appends inside `fn` hit the disk before the state save does, so the
    // crash window leaves rows the cursor denies rather than a cursor claiming
    // rows that are gone. See `Store.transaction`.
    transaction: <T,>(fn: () => T): T => fn(),
  };
}

/**
 * A {@link SecretStore} in a 0600 JSON file beside the profile.
 *
 * This is what `LEDGER_CLIENT_STORE=sqlite` uses so the CLI's separate
 * processes can still find their session token, and it is emphatically NOT the
 * device implementation — a plain file is the third of the three objections
 * `client/README.md` raises against this client. It exists so that the SQLite
 * store's *database* can be proven free of secrets under the same test corpus
 * the file store runs.
 */
export function fileSecretStore(path: string): SecretStore {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  };
  return {
    get: (name) => read()[name] ?? null,
    set: (name, value) => {
      const all = read();
      if (value === null) delete all[name];
      else all[name] = value;
      ensureStateDir(dirname(path));
      writePrivate(path, JSON.stringify(all, null, 2));
    },
  };
}
