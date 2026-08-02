#!/usr/bin/env bun
/**
 * `bun run cli <command>` — the headless client's command surface.
 *
 * ```
 * cli login             --server <url> --idp apple|google --id-token <jwt>
 *                       # or LEDGER_CLIENT_ID_TOKEN — argv is world-readable in `ps`
 * cli enroll            --writer <id> [--sign-with <other-writer-id>]
 *                       [--pubkey <b64>]   # enrol a PEER's key, signed by --sign-with
 *                       [--keygen-only]    # create this device's key, print its public half
 * cli pull              [--stream hot|cold] [--limit n]     # default: hot only
 * cli pull-cold-hashes  [--limit n]                        # cold only; refuses --stream
 * cli replay                                                # fold, print a summary
 * cli check             [--stream hot|cold] [--json]        # exit 1 on any hard stop
 * cli emit              --type <op_type> --json '<payload>'
 *                       [--entity txn:<id>] [--parent <n>] [--ingest-id <hex>]
 * cli checkpoint                                            # over every roster head
 * cli push                                                  # batch, pad, upload, sync
 * cli state             [--json]
 * ```
 *
 * Global flags: `--server <url>`, `--state-dir <path>` (default `./.ledger-client`),
 * `--profile <name>` (default `default`).
 *
 * # Why `--profile` and not "one file per user"
 *
 * Two devices on ONE account are the exit test's whole configuration, and they
 * differ in every field the state file holds — their writer key, their cursors,
 * their pinned heads. See `store/store.ts`.
 *
 * # Exit codes
 *
 * 0 success, 1 a hard stop or a failed command, 2 usage. `check` exits 1 when
 * any violation is a `hard_stop` and 0 otherwise — notices are PRINTED and never
 * suppressed, which is the whole of `I14_forks_surfaced` (a reader who sees the
 * line only when it is non-empty cannot tell a clean sync from a broken
 * reporting path).
 */

import { INVARIANT_IDS, type Violation } from "../invariants/check";
import { surface } from "../invariants/surface";
import { Client, HardStopError, newEntityID, stateToJSON, summarize, unbase64 } from "../net/client";
import { Outbox } from "../outbox/outbox";
import { openStore } from "../store/open";
import { STREAM_COLD, STREAM_HOT, type Stream } from "../wire/blob";

interface Args {
  command: string;
  flags: Map<string, string>;
  bools: Set<string>;
}

/**
 * Which flags take no value, per command.
 *
 * `--json` is the one that has to be per-command: the plan's contract spells
 * `emit --type <t> --json '<payload>'` and `state --json`, so the same spelling
 * is a VALUE on one command and a switch on the others. Resolving it globally
 * would mean either `emit` losing its payload or `state --json` swallowing the
 * next flag, and both are silent.
 */
function boolFlagsFor(command: string): ReadonlySet<string> {
  const base = command === "emit" ? ["help"] : ["json", "help"];
  return new Set(command === "enroll" ? [...base, "keygen-only"] : base);
}

/**
 * Parses `<command> [--flag value | --switch]…`.
 *
 * **The command is positional and FIRST**, exactly as `ledgerd <mode> [flags]`
 * requires. That rule is not stylistic: which flags take a value depends on the
 * command (see {@link boolFlagsFor}), so the command has to be known before the
 * flags are read. A first draft took "the first token that is not a flag",
 * which reads the VALUE of a leading flag as the command — `--profile b state`
 * ran the command `b` — and then parsed every flag under the wrong rules.
 */
export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const first = argv[0];
  const command = first !== undefined && !first.startsWith("--") ? first : "";
  const boolFlags = boolFlagsFor(command);
  for (let i = command === "" ? 0 : 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      throw new UsageError(`unexpected argument ${JSON.stringify(a)}: the command comes first`);
    }
    const name = a.slice(2);
    if (boolFlags.has(name)) {
      bools.add(name);
      continue;
    }
    const value = argv[i + 1];
    // A flag whose value is missing must not silently swallow the NEXT flag:
    // `--type --entity txn:1` would otherwise emit an op of type "--entity".
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
    i++;
  }
  return { command, flags, bools };
}

class UsageError extends Error {}

function req(args: Args, name: string): string {
  const v = args.flags.get(name);
  if (v === undefined) throw new UsageError(`--${name} is required`);
  return v;
}

function stream(args: Args, fallback: Stream): Stream {
  const v = args.flags.get("stream");
  if (v === undefined) return fallback;
  if (v !== STREAM_HOT && v !== STREAM_COLD) throw new UsageError(`--stream must be hot or cold, got ${JSON.stringify(v)}`);
  return v;
}

function limit(args: Args): number | undefined {
  const v = args.flags.get("limit");
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--limit must be a positive integer, got ${JSON.stringify(v)}`);
  return n;
}

/**
 * `--parent <n>`, refused unless it is an exact non-negative integer.
 *
 * `Number("2.5")` and `Number("abc")` both reach `validateOp`, which refuses
 * them — but as "parent_version is 2.5", after the op has been half built. The
 * wire carries `parent_version` as a raw JSON number, so this is also the one
 * field where a value past 2^53 is representable in Go and not here; refusing
 * it at the edge names the flag rather than the field.
 */
function parentVersion(args: Args): number | undefined {
  const v = args.flags.get("parent");
  if (v === undefined) return undefined;
  if (!/^[0-9]+$/.test(v)) throw new UsageError(`--parent must be a non-negative integer, got ${JSON.stringify(v)}`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new UsageError(`--parent ${v} is outside the range a JSON number carries exactly`);
  }
  return n;
}

/** `txn:abc` -> `{kind: "txn", id: "abc"}`; `txn:new` mints an id. */
function entity(args: Args): { kind: string; id: string } | undefined {
  const v = args.flags.get("entity");
  if (v === undefined) return undefined;
  const at = v.indexOf(":");
  if (at < 1 || at === v.length - 1) throw new UsageError(`--entity must be <kind>:<id>, got ${JSON.stringify(v)}`);
  const kind = v.slice(0, at);
  const id = v.slice(at + 1);
  return { kind, id: id === "new" ? newEntityID() : id };
}

const USAGE = `bun run cli <command> [flags]

  login             --server <url> --idp apple|google --id-token <token>
                    (or LEDGER_CLIENT_ID_TOKEN, which stays out of the process table)
  enroll            --writer <id> [--sign-with <writer-id>] [--pubkey <base64>]
                    [--keygen-only]
  pull              [--stream hot|cold] [--limit <n>]
  pull-cold-hashes  [--limit <n>]
  replay
  check             [--stream hot|cold] [--json]
  emit              --type <op_type> --json '<json>' [--entity <kind>:<id>]
                    [--parent <n>] [--ingest-id <64 hex>]
  checkpoint
  push
  state             [--json]

global           --server <url> --state-dir <path> --profile <name>`;

function printViolations(violations: readonly Violation[], asJSON: boolean): number {
  const stops = violations.filter((v) => v.severity === "hard_stop");
  const notices = violations.filter((v) => v.severity === "notice");
  // The same classification the phone renders (`invariants/surface.ts`), printed
  // here because this CLI is the only client that exists today — a halt lane
  // whose only consumer is a test is the "written, tested green, never wired"
  // shape this project has paid for six times. `unreadable` is not passed: it
  // would mean re-folding the whole log for a banner whose count the `I15`
  // notice already carries.
  const ui = surface({ violations });
  if (asJSON) {
    console.log(JSON.stringify({ checked: INVARIANT_IDS.length, violations, surface: ui }, null, 2));
  } else {
    console.log(
      `invariants: ${INVARIANT_IDS.length} checked, ${stops.length} hard stop${stops.length === 1 ? "" : "s"}, ` +
        `${notices.length} notice${notices.length === 1 ? "" : "s"}`,
    );
    // Both lists are printed in full, always. A checker whose output is
    // suppressed when it is boring is a checker nobody can distinguish from a
    // broken one.
    // The `kind` is printed where there is one, because a single id can cover
    // conditions an operator must act on differently — I11's benign "the roster
    // grew" and its adversarial "the server is withholding rows" are the same
    // id and the same severity, and the whole of the difference is here.
    const label = (v: Violation): string => (v.kind === undefined ? v.id : `${v.id} (${v.kind})`);
    for (const v of stops) console.log(`  HARD STOP  ${label(v)}: ${v.detail}`);
    for (const v of notices) console.log(`  notice     ${label(v)}: ${v.detail}`);

    // What a person is shown, under what an operator is shown. The halt is the
    // full-screen, non-dismissable state on the phone; here it is the block a
    // human reads instead of seventeen ids.
    if (ui.halt !== null) {
      console.log("");
      console.log(`  ${ui.halt.title.toUpperCase()}  [${ui.halt.kind}, sync stopped]`);
      console.log(`  ${ui.halt.body}`);
      if (ui.halt.action !== null) console.log(`  → ${ui.halt.action}`);
      for (const h of ui.halts.slice(1)) console.log(`  (also: ${h.title} [${h.kind}])`);
    }
    if (ui.notices.length > 0) {
      console.log("");
      console.log(`  Integrity (${ui.badge} needing attention)`);
      for (const n of ui.notices) {
        console.log(`    ${n.routine ? "routine  " : "         "}${n.title} — ${n.count}`);
      }
    }
  }
  return stops.length === 0 ? 0 : 1;
}

export async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "" || args.command === "help" || args.bools.has("help")) {
    console.log(USAGE);
    return args.command === "" ? 2 : 0;
  }

  const dir = args.flags.get("state-dir") ?? "./.ledger-client";
  const profile = args.flags.get("profile") ?? "default";
  const store = openStore(dir, profile);
  const server = args.flags.get("server");
  const client = new Client({ store, ...(server === undefined ? {} : { server }) });

  switch (args.command) {
    case "login": {
      // `--id-token` lands in the process table, where every user on the box can
      // read it. Harmless for a `dev:` token and a real credential for a genuine
      // JWT, so the environment is offered as the alternative and is preferred
      // when both are present.
      const fromEnv = process.env["LEDGER_CLIENT_ID_TOKEN"];
      const token = fromEnv !== undefined && fromEnv !== "" ? fromEnv : req(args, "id-token");
      const userID = await client.login(req(args, "idp"), token);
      console.log(`signed in as ${userID}; state in ${store.location}`);
      return 0;
    }
    case "enroll": {
      const writer = req(args, "writer");
      const signWith = args.flags.get("sign-with");
      const pubkey = args.flags.get("pubkey");
      if (args.bools.has("keygen-only")) {
        // The joining device's half of a pairing: create the key, keep it here,
        // and print only the PUBLIC half for an already-enrolled device to
        // enrol on this one's behalf. There is deliberately no way to print the
        // private half — a key that can be exported is a key that will be.
        console.log(Buffer.from(client.ensureWriterKey(writer)).toString("base64"));
        return 0;
      }
      await client.enroll(writer, {
        ...(signWith === undefined ? {} : { signWith }),
        // Strict, like every other decode on this path. `Buffer.from(s,
        // "base64")` ignores characters outside the alphabet, so a typo'd key
        // comes back SHORT and plausible — and enrols a writer whose private
        // half nobody holds, permanently, in an append-only roster.
        ...(pubkey === undefined ? {} : { publicKey: unbase64(pubkey, "--pubkey") }),
      });
      const how =
        pubkey !== undefined
          ? ` (a peer's key, signed by ${String(signWith)})`
          : signWith === undefined
            ? " (self-signed bootstrap)"
            : ` (signed by ${signWith})`;
      console.log(`enrolled writer ${writer}${how}`);
      return 0;
    }
    case "pull": {
      const l = limit(args);
      const report = await client.pull({ stream: stream(args, STREAM_HOT), ...(l === undefined ? {} : { limit: l }) });
      console.log(
        `pulled ${report.rows} ${report.stream} row(s) over ${report.pages} page(s); ` +
          `cursor ${report.cursor}${report.complete ? " (caught up)" : ""}`,
      );
      return printViolations(report.violations, args.bools.has("json"));
    }
    case "pull-cold-hashes": {
      if (args.flags.has("stream")) {
        throw new UsageError(
          "pull-cold-hashes takes no --stream: it is cold-only. Pinning a HOT head from the hash list " +
            "puts it ahead of the hot bodies, and the next `pull` verifies those against it — an unclearable " +
            "chain break. See Client.pullColdHashes.",
        );
      }
      const l = limit(args);
      const out = await client.pullColdHashes({ ...(l === undefined ? {} : { limit: l }) });
      console.log(`pinned ${out.pinned} new cold blob hash(es)`);
      for (const [key, head] of [...out.heads].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        console.log(`  ${key} @ ${head.counter} ${Buffer.from(head.hash).toString("hex")}`);
      }
      return 0;
    }
    case "replay": {
      const { ops, state } = client.materialize();
      console.log(
        JSON.stringify(
          summarize(ops, { hot: client.cursor(STREAM_HOT), cold: client.cursor(STREAM_COLD) }, state.unreadable.length),
          null,
          2,
        ),
      );
      return 0;
    }
    case "check": {
      return printViolations(await client.checkOnline(stream(args, STREAM_HOT)), args.bools.has("json"));
    }
    case "emit": {
      const raw = req(args, "json");
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        throw new UsageError(`--json is not valid JSON: ${(err as Error).message}`);
      }
      const parent = parentVersion(args);
      const ingestId = args.flags.get("ingest-id");
      const ent = entity(args);
      const op = client.emit({
        type: req(args, "type"),
        payload,
        ...(ent === undefined ? {} : { entity: ent }),
        ...(parent === undefined ? {} : { parentVersion: parent }),
        ...(ingestId === undefined ? {} : { ingestId }),
      });
      console.log(`pending ${op.type} ${op.op_id}${op.entity === undefined ? "" : ` on ${op.entity.kind}:${op.entity.id}`}`);
      return 0;
    }
    case "checkpoint": {
      // Syncs first: a checkpoint that attested genesis for every chain it had
      // not happened to look at would satisfy I11's coverage while asserting
      // nothing. See Client.checkpoint.
      const op = await client.checkpoint();
      const heads = (op.payload as { heads: { writer_id: string; stream: string; counter: string }[] }).heads;
      console.log(`pending writer_checkpoint ${op.op_id} over ${heads.length} (writer x stream) head(s)`);
      for (const h of heads) console.log(`  ${h.writer_id}|${h.stream} @ ${h.counter}`);
      return 0;
    }
    case "push": {
      // Through the outbox, not `client.push()` directly: one push is one
      // upload, and an upload claims at most 8 chain positions, so a backlog
      // bigger than that needs the page loop. A CLI that sent one page and
      // reported success would leave the rest queued and say nothing.
      const outbox = new Outbox(client);
      const report = await outbox.flush();
      if (report.stopped === "offline") {
        console.error(
          `push stopped after ${report.pages} page(s) with ${report.queued} op(s) still queued: ` +
            `${report.offlineCause?.message ?? "unknown"}`,
        );
        return 1;
      }
      if (report.blobs === 0) {
        console.log("nothing to push");
        return 0;
      }
      console.log(
        `pushed ${report.sent} op(s) in ${report.blobs} blob(s) across ${report.pages} page(s)` +
          `${report.queued === 0 ? "" : `, ${report.queued} still queued`}`,
      );
      return 0;
    }
    case "state": {
      const state = client.state();
      if (args.bools.has("json")) {
        console.log(JSON.stringify(stateToJSON(state), null, 2));
        return 0;
      }
      console.log(`home currency: ${state.homeCurrency ?? "(unset)"}`);
      console.log(`transactions:  ${state.txns.size} (${state.liveByIngestID.size} live)`);
      console.log(`rules:         ${state.rules.size}`);
      console.log(`rates:         ${state.rates.size}`);
      console.log(`checkpoints:   ${state.checkpoints.length} head(s)`);
      console.log(`forks:         ${state.forks.length}`);
      console.log(`anomalies:     ${state.anomalies.length}`);
      console.log(`unreadable:    ${state.unreadable.length}`);
      return 0;
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(args.command)}`);
  }
}

// `import.meta.main` is false when this module is imported by a test, so the
// CLI is testable as a function without spawning a process.
if (import.meta.main) {
  try {
    process.exit(await run(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n`);
      console.error(USAGE);
      process.exit(2);
    }
    if (err instanceof HardStopError) {
      console.error("sync stopped — nothing was persisted over the uncertified page:");
      for (const v of err.violations.filter((v) => v.severity === "hard_stop")) console.error(`  ${v.id}: ${v.detail}`);
      process.exit(1);
    }
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}
