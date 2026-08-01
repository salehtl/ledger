/**
 * The round trip against a REAL `ledgerd`.
 *
 * Everything else in `client/` is checked against a fixture or a fake. This is
 * the one test where the bytes go over a socket to the Go server, through
 * Postgres, and come back — which is the only way to find out whether the two
 * halves of the protocol actually agree. Three of the defects it exists to
 * catch are invisible to a fake by construction: a wire field spelled
 * differently on each side, a signature the Go verifier computes over other
 * bytes, and an AAD the server rejects at a position the client thinks it
 * sealed for.
 *
 * # How the stack is booted, since the plan did not say
 *
 * The plan's step 4 is a pair of terminals a human drives. That is not a test.
 * What runs here instead:
 *
 *   - **Postgres comes from the gate.** `scripts/v2-check.sh` already boots one
 *     throwaway cluster and exports `LEDGER_TEST_POSTGRES_URL`, so this creates
 *     a scratch database in it with `psql` and drops it afterwards. When that
 *     variable is unset — a bare `bun test` — the whole file SKIPS, so the unit
 *     suite stays fast and needs no Postgres, while the gate runs this every
 *     time. A test that only runs when someone remembers is not a gate.
 *   - **`ledgerd` is compiled once** into a temp dir and spawned per suite, on
 *     a scratch loopback port. Never `:8080` (v1 owns it), never `:8443`, never
 *     a public interface — `config.validate` refuses the last one anyway.
 *   - **`--dev-auth`** supplies the identity. A real Apple token cannot be
 *     minted offline, so without it no authenticated endpoint is reachable at
 *     all from a test.
 *
 * Task 37 owns the reusable harness (`client/test/e2e/harness.ts`) and should
 * absorb the process handling below rather than rediscover it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkAll } from "../../src/invariants/check";
import { Client, HardStopError, decodeWireRow } from "../../src/net/client";
import { serializeState } from "../../src/replay/state";
import { fileStore } from "../../src/store/store";
import { STREAM_COLD, STREAM_HOT } from "../../src/wire/blob";

const ADMIN_DSN = process.env["LEDGER_TEST_POSTGRES_URL"] ?? "";
const REPO = resolve(import.meta.dir, "../../..");

/** The scratch database this suite owns, dropped in afterAll. */
const DB = `t_e2e_${process.pid}`;

let scratch = "";
let binary = "";
let proc: ChildProcess | undefined;
let baseURL = "";

function psql(dsn: string, sql: string): void {
  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-d", dsn, "-c", sql], { stdio: "pipe" });
}

/**
 * Swaps the database name in the admin DSN.
 *
 * Hand-rolled rather than `new URL()`: `pgtest` connects over a UNIX SOCKET, so
 * its DSN is `postgres://postgres@/postgres?host=/tmp/...`, whose authority has
 * a userinfo and an EMPTY host — and the WHATWG parser refuses that outright.
 * Go's `net/url` accepts it, which is why `pgtest.dsnForDatabase` can use it and
 * this cannot.
 */
function dsnFor(db: string): string {
  const q = ADMIN_DSN.indexOf("?");
  const base = q < 0 ? ADMIN_DSN : ADMIN_DSN.slice(0, q);
  const query = q < 0 ? "" : ADMIN_DSN.slice(q);
  const scheme = "postgres://";
  const slash = base.indexOf("/", scheme.length);
  if (!base.startsWith(scheme) || slash < 0) {
    throw new Error(`LEDGER_TEST_POSTGRES_URL is not a postgres:// URL with a database path: ${base}`);
  }
  return `${base.slice(0, slash + 1)}${db}${query}`;
}

/**
 * A loopback port nothing is listening on. Bun hands one out and it is released
 * before ledgerd claims it, so there is a window in which another process could
 * take it; the alternative is a hard-coded port that collides with a parallel
 * run of this same suite, which is worse and silent.
 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (port === 0) throw new Error("could not obtain a scratch port");
  return port;
}

async function waitReady(url: string, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`ledgerd exited with ${proc.exitCode} before it was ready`);
    try {
      // Unauthenticated: a 401 proves the router is up and the session
      // middleware is mounted, which is more than a 200 on a health endpoint
      // would prove (there is no health endpoint until Task 37).
      const res = await fetch(`${url}/api/v1/writers`);
      if (res.status === 401) return;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(100);
  }
  throw new Error("ledgerd did not become ready");
}

function clientFor(profile: string): Client {
  return new Client({ store: fileStore(join(scratch, "state"), profile), server: baseURL });
}

/**
 * A logged-in client on its OWN account, with its own state file.
 *
 * Every test gets a fresh `dev:<name>` subject, which the server upserts into a
 * distinct user. That is not tidiness: the first version of this suite shared
 * one account and one profile across all eight tests, so each one silently
 * depended on what the ones before it had left behind — running a single test
 * with `-t` failed with an empty log, and a failure in the third cascaded into
 * three more. A suite whose tests cannot be run alone is a suite that misleads
 * exactly when someone is debugging it.
 *
 * Two devices on ONE account (the pairing test) is the one case that needs two
 * profiles against the same subject, and it asks for that explicitly.
 */
async function accountFor(name: string, profile = name): Promise<Client> {
  const c = clientFor(profile);
  await c.login("apple", `dev:${name}`);
  return c;
}

const hard = (v: { severity: string }[]): unknown[] => v.filter((x) => x.severity === "hard_stop");

// `go build` plus initdb-warm Postgres take longer than bun's 5s default, so
// every test in the suite gets a generous budget; the suite is a handful of
// round trips, so a real hang still fails in well under a minute.
const TIMEOUT = 120_000;

/**
 * Boots the stack ONCE, lazily.
 *
 * Not `beforeAll`: bun's typed signature takes no timeout, and `go build` plus
 * a first connection to a cold cluster comfortably exceed the 5s default. Every
 * test awaits this and carries TIMEOUT itself, so the budget covers the setup
 * that actually runs inside it.
 */
let booting: Promise<void> | undefined;
function ensureStack(): Promise<void> {
  booting ??= boot();
  return booting;
}

async function boot(): Promise<void> {
  scratch = mkdtempSync(join(tmpdir(), "ledger-e2e-"));
  psql(ADMIN_DSN, `CREATE DATABASE ${DB}`);
  binary = join(scratch, "ledgerd");
  execFileSync("go", ["build", "-o", binary, "./cmd/ledgerd"], { cwd: REPO, stdio: "pipe" });

  const port = freePort();
  // `serve` also starts the SMTP receiver (Task 24), and mail.smtp_listen
  // defaults to ":25" — the real, public, production port on the box this suite
  // runs on. It MUST be overridden here: without it this test either binds port
  // 25 on a live host (when run as root) or fails to boot at all (when not).
  const smtpPort = freePort();
  baseURL = `http://127.0.0.1:${port}`;
  proc = spawn(binary, ["serve", "--dev-auth"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LEDGER_MAIL_DOMAIN: "example.test",
      LEDGER_PG_DSN: dsnFor(DB),
      LEDGER_HTTP_LISTEN: `127.0.0.1:${port}`,
      LEDGER_SMTP_LISTEN: `127.0.0.1:${smtpPort}`,
    },
  });
  proc.stderr?.on("data", (b: Buffer) => {
    if (process.env["LEDGER_E2E_VERBOSE"] !== undefined) process.stderr.write(b);
  });
  await waitReady(baseURL, proc);
}

describe.skipIf(ADMIN_DSN === "")("round trip against a real ledgerd", () => {
  afterAll(() => {
    if (proc !== undefined && proc.exitCode === null) {
      proc.kill("SIGTERM");
    }
    if (ADMIN_DSN !== "") {
      try {
        psql(ADMIN_DSN, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      } catch {
        /* the cluster may already be gone */
      }
    }
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  });

  test("--dev-auth exchanges a dev token for a session, and rejects a real-looking one", async () => {
    await ensureStack();
    const a = await accountFor("t1-devauth");
    const userID = a.userId;
    expect(userID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const res = await fetch(`${baseURL}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idp: "apple", id_token: "eyJhbGciOiJSUzI1NiJ9.e30.sig" }),
    });
    expect(res.status).toBe(401);
  }, TIMEOUT);

  test("the state file holding the writer key is 0600", async () => {
    await ensureStack();
    const a = await accountFor("t2-perms");
    await a.enroll("dev-a");
    expect(statSync(a.location).mode & 0o777).toBe(0o600);
  }, TIMEOUT);

  test("client-authored ops round-trip: emit, push, pull, replay, check", async () => {
    await ensureStack();
    const a = await accountFor("t3-roundtrip");
    await a.enroll("dev-a");

    a.emit({ type: "home_currency_set", payload: { currency: "AED" } });
    a.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    const pushed = await a.push();
    // One batched blob: the client always may batch, and three small ops share
    // one 1 KiB bucket. The auto-checkpoint rides along, because this client
    // has never checkpointed the roster it just read.
    expect(pushed.blobs).toBe(1);
    expect(pushed.ops).toBe(3);
    expect(pushed.checkpointed).toBe(true);
    expect(pushed.seqs).toEqual([1n]);

    // push self-syncs, so the ops are already folded at their server-assigned
    // positions. A second pull must therefore be a no-op rather than a
    // redelivery — foldBlobs throws on a blob redelivered at the same seq, so
    // this is the assertion that the cursor moved with the rows.
    const again = await a.pull();
    expect(again.rows).toBe(0);
    expect(again.complete).toBe(true);

    const state = a.state();
    expect(state.homeCurrency).toBe("AED");
    expect(state.rates.get("USD")).toBe(3672500n);
    // Four: {dev-a, ingest} x {hot, cold}. The server's own writer is on the
    // roster from the account's first sign-in, and a checkpoint names one head
    // per ROSTER writer — which is what gives the chain the user's mail lands
    // on an attested head at all.
    expect(state.checkpoints).toHaveLength(4);
    expect(state.checkpoints.map((c) => `${c.writer_id}|${c.stream}`).sort()).toEqual([
      "dev-a|cold", "dev-a|hot", "ingest|cold", "ingest|hot",
    ]);
    expect(a.cursor(STREAM_HOT)).toBe(1n);
    expect(a.cursor(STREAM_COLD)).toBe(0n);

    // The checker, over ops decoded from the blobs the chain accepted — the
    // whole point of the instrument.
    const violations = await a.checkOnline();
    expect(hard(violations)).toHaveLength(0);
    // I14 reports unconditionally, so the notice list is never empty.
    expect(violations.some((v) => v.id === "I14_forks_surfaced")).toBe(true);
  }, TIMEOUT);

  test("a second device: peer enrolment, the checkpoint bootstrap, and two-way convergence", async () => {
    await ensureStack();
    const a = await accountFor("t4-pair", "t4a");
    await a.enroll("dev-a");
    a.emit({ type: "home_currency_set", payload: { currency: "AED" } });
    await a.push();

    // The one place two profiles share a subject: two devices, one account.
    const b = clientFor("t4b");
    expect(await b.login("apple", "dev:t4-pair")).toBe(a.userId);

    // dev-b generates its own key and never exports the private half; dev-a
    // signs the registration for it. A session token alone cannot do this.
    const pubB = b.ensureWriterKey("dev-b");
    await a.enroll("dev-b", { signWith: "dev-a", publicKey: pubB });
    b.useWriter("dev-b");
    // `ingest` is on the roster too, from the first sign-in and before any mail.
    expect((await a.roster()).map((w) => w.writer_id).sort()).toEqual(["dev-a", "dev-b", "ingest"]);

    // CONTRACT: a multi-device account hard-stops until a checkpoint covering
    // the new writer lands. dev-a's existing checkpoint names only dev-a, so
    // dev-b cannot finish its first sync yet. That is the rule working.
    await expect(b.pull()).rejects.toThrow(/I11_roster_checkpoint/);
    expect(b.cursor(STREAM_HOT)).toBe(0n);

    // dev-a notices the roster moved and checkpoints without being asked.
    a.emit({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });
    const second = await a.push();
    expect(second.checkpointed).toBe(true);

    // CHECKPOINT_NAMES_THE_ROSTER: dev-b has authored nothing, so it is named
    // at counter 0 with the genesis hash. A checkpoint built from observed
    // chains could not name it at all, and the hard stop above would be
    // permanent with no checkpoint any device could emit able to clear it.
    const heads = a.state().checkpoints;
    expect(heads.map((h) => `${h.writer_id}|${h.stream}`).sort()).toEqual([
      "dev-a|cold",
      "dev-a|hot",
      "dev-b|cold",
      "dev-b|hot",
      "ingest|cold",
      "ingest|hot",
    ]);
    for (const h of heads.filter((x) => x.writer_id === "dev-b")) {
      expect(h.counter).toBe(0n);
      expect(h.hash).toBe("0".repeat(64));
    }

    // Now dev-b syncs cleanly.
    const pulled = await b.pull();
    expect(pulled.rows).toBe(2);
    expect(hard(pulled.violations)).toHaveLength(0);
    expect(b.state().rates.get("EUR")).toBe(3900000n);

    // dev-b authors, dev-a pulls, and both fold the same log to the same state.
    b.emit({ type: "rule_added", payload: { pattern: "CARREFOUR", match: "contains", category: "groceries", priority: 10 }, entity: { kind: "rule", id: "r1" } });
    const bPush = await b.push();
    expect(bPush.blobs).toBe(1);
    await a.pull();
    expect(serializeState(a.state())).toBe(serializeState(b.state()));
    expect(a.state().rules.get("r1")?.category).toBe("groceries");

    for (const c of [a, b]) expect(hard(await c.checkOnline())).toHaveLength(0);
  }, TIMEOUT);

  test("a writer whose key this device does not hold cannot be adopted", async () => {
    await ensureStack();
    const rogue = await accountFor("t5-rogue");
    // `ingest` is the server's own writer and its blobs carry the provenance
    // the UI labels "server-ingested"; the server refuses a device authoring
    // there (403). This device refuses one step earlier and for its own reason:
    // it holds no key for that writer, so it could not sign an enrolment for it
    // and must not chain blobs onto its counters either.
    expect(() => rogue.useWriter("ingest")).toThrow(/no key for writer/);
    // Nor for a peer it enrolled but does not hold, which is the case that
    // would silently fork the peer's chain by reusing its counters.
    expect(() => rogue.useWriter("dev-b")).toThrow(/no key for writer/);
  }, TIMEOUT);

  test("pull-cold-hashes works against a cold stream that is empty", async () => {
    await ensureStack();
    const a = await accountFor("t6-cold");
    const out = await a.pullColdHashes();
    // No mail has been ingested — the SMTP receiver is Task 24 — so there is
    // nothing to pin. It must be a clean no-op rather than an error, because
    // that is the state every account is in on its first day.
    expect(out.pinned).toBe(0);
    expect(a.pinnedHead("ingest", STREAM_COLD).counter).toBe(0n);
  }, TIMEOUT);

  test("the checker's own input is what the chain verified, not a parallel source", async () => {
    await ensureStack();
    // Its own preconditions, rather than whatever an earlier test left behind.
    const a = await accountFor("t7-checker");
    await a.enroll("dev-a");
    a.emit({ type: "home_currency_set", payload: { currency: "AED" } });
    a.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await a.push();

    const { state, ops } = a.materialize();
    // Every op the checker sees was decoded from a stored blob, so its op ids
    // are exactly the ids inside those blobs. Re-running checkAll by hand over
    // the same inputs must agree with the client's own answer.
    expect(ops.length).toBeGreaterThan(0);
    const byHand = checkAll({
      userId: a.userId,
      stream: STREAM_HOT,
      rows: a.rowsFor(STREAM_HOT).map((r) => decodeWireRow(r)),
      hashList: [],
      ops,
      state,
      roster: await a.roster(),
      pinnedHeads: new Map(),
      pinnedBlobHashes: new Map(),
      cursorBefore: 0n,
      next: a.cursor(STREAM_HOT),
    });
    expect(hard(byHand)).toHaveLength(0);
    expect(byHand.map((v) => v.id)).toEqual((await a.checkOnline()).map((v) => v.id));
  }, TIMEOUT);

  test("a hard stop is an error the CLI can exit 1 on, and it carries every violation", () => {
    // No stack: HardStopError is the type `cli` keys its exit code off, and its
    // shape is a property of the class rather than of any server.
    const err = new HardStopError([{ id: "I2_writer_counters", severity: "hard_stop", detail: "x" }]);
    expect(err.violations).toHaveLength(1);
    expect(err.message).toContain("I2_writer_counters");
  }, TIMEOUT);
});
