/**
 * The Phase 1 exit-test harness: a real `ledgerd`, a real Postgres, real mail
 * over a real socket, and as many independent client profiles as a test wants.
 *
 * Task 38 asserts spec §5's exit criterion. That is a claim about the SYSTEM,
 * so when it fails the only acceptable conclusion is "the system is wrong" —
 * which means every part of the rig has to be either boring or proven. This
 * file is the boring part; `harness.test.ts` is the proof.
 *
 * # What it refuses to touch
 *
 * This box is the production server for v1 AND the intended host for v2, so a
 * harness that guesses a port wrong does not fail a test, it takes down
 * something real. Three rails, all load-bearing:
 *
 *   - **Never `:25`.** `mail.smtp_listen` DEFAULTS to `:25`, the live MTA port.
 *     `LEDGER_SMTP_LISTEN` is set on every spawn, unconditionally.
 *   - **Never `:8080`, never `:8443`, never `:8079`.** v1 owns the first;
 *     `config`'s own defaults own the other two, and a stack that took them
 *     would collide with a hand-started `ledgerd`. Every listener here is drawn
 *     from 18000–18999 and bound to `127.0.0.1`.
 *   - Both of the above are CHECKED, not merely done:
 *     {@link assertScratchListeners} runs on the merged spawn environment and
 *     throws before anything is created. Setting the variables was a habit with
 *     a comment on it and no test; now dropping one fails every e2e test
 *     immediately instead of binding the production mail port for 60 seconds.
 *   - **Never `/var/lib/ledger`, never the shared database.** Each stack
 *     creates and drops its OWN Postgres database inside the throwaway cluster
 *     `scripts/v2-check.sh` boots.
 *
 * # Boot and teardown
 *
 * `startStack()` compiles `cmd/ledgerd` once per process (cached), creates a
 * scratch database, spawns `serve --dev-auth --dns-fixtures …` on three scratch
 * loopback ports, and waits for `GET /api/v1/healthz` — which pings the pool,
 * so readiness means "the database answers", not merely "the router is
 * mounted".
 *
 * `stopStack()` SIGTERMs, waits, escalates to SIGKILL, and then VERIFIES the
 * process is gone before dropping the database and removing the scratch
 * directory. An exit test that leaves a `ledgerd` holding a socket on a
 * production box is a worse outcome than a failing assertion, so a stack that
 * will not die is an error rather than a warning.
 *
 * A suite that is itself killed cannot run any teardown at all, and Bun's test
 * runner fires no exit hook to lean on either (measured — see
 * {@link reapOrphans}). What covers that case is a sweep at STARTUP: the next
 * run kills any `ledgerd` of this harness's that has been reparented to init.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "../../src/net/client";
import { fileStore } from "../../src/store/store";
import { smtpSend, type SMTPReply } from "./smtp";

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

/** The repository root, from this file's own location. */
export function repoPath(...parts: string[]): string {
  return resolve(import.meta.dir, "../../..", ...parts);
}

/** A `.eml` (or `dns.json`) from the Task 2 fixture set. */
export function fixtureFile(name: string): string {
  return repoPath("internal/v2/origin/testdata", name);
}

/**
 * The recorded DNS every stack uses by default.
 *
 * DKIM and ARC verification then run OFFLINE and deterministically: no
 * resolver, no key rotation, no network flake presenting as a signature
 * failure. `--dns-fixtures` is refused off a loopback listener
 * (`config.EnableTestOnly`), which is what keeps it a test-only switch.
 */
export const DNS_FIXTURES = fixtureFile("dns.json");

const ADMIN_DSN = process.env["LEDGER_TEST_POSTGRES_URL"] ?? "";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

const PORT_LO = 18000;
const PORT_HI = 19000; // exclusive

/**
 * The listener environment variables every spawn must set, and the ports no
 * spawn may ever be pointed at. See {@link assertScratchListeners}.
 *
 * `mail.smtp_listen` DEFAULTS to `:25` — every interface, the live MTA port —
 * so LEDGER_SMTP_LISTEN is not one setting among three: it is the one whose
 * ABSENCE is dangerous rather than merely wrong.
 */
const LISTENER_VARS = ["LEDGER_HTTP_LISTEN", "LEDGER_SMTP_LISTEN", "LEDGER_ADMIN_LISTEN"] as const;
const FORBIDDEN_PORTS: Record<number, string> = {
  25: "the live MTA port, and this box is a production mail host",
  8080: "v1's ledger, running on this box right now",
  8443: "config's own default HTTPS listener",
  8079: "config's own default admin listener",
};

/** Ports handed out by THIS process, so two stacks in one suite cannot collide. */
const claimed = new Set<number>();

/**
 * Refuses to spawn a test server unless EVERY listener is a loopback scratch
 * port. Called by {@link startStack} on the fully-merged environment — after
 * `opts.env`, so a caller cannot override its way past it either.
 *
 * This is the harness's primary safety rail made enforceable instead of
 * remembered. Setting `LEDGER_SMTP_LISTEN` on every spawn was a line in
 * `startStack` with a comment on it and no test: delete the line and a
 * `bun test` binds `:25` on every interface — including the Tailscale one — on
 * a box where `:25` is free, where the harness runs as root, and which is the
 * production host. The failure is loud (readiness times out after 60s) but it
 * happens AFTER the bind.
 *
 * It is deliberately a positive rule — the value must be `127.0.0.1:<scratch>`
 * — rather than a blocklist of bad ports. A blocklist has to be right about
 * every future port; this has to be right about one address and one range, and
 * an unset variable fails it for the same reason a wrong one does. The
 * forbidden-port table exists only to make the error message name what was
 * nearly hit.
 *
 * @throws if any listener is unset, not loopback, or outside 18000–18999.
 */
export function assertScratchListeners(env: Record<string, string>): void {
  for (const name of LISTENER_VARS) {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(
        `${name} is not set by the harness: the spawned process would take it from the ` +
          `ambient shell or from ledgerd's own default, and mail.smtp_listen defaults to ` +
          `:25 on every interface. This harness runs on the production mail host; every ` +
          `listener must be an explicit loopback scratch port set right here.`,
      );
    }
    const m = /^127\.0\.0\.1:(\d+)$/.exec(value);
    if (m === null) {
      throw new Error(
        `${name}=${JSON.stringify(value)} is not a loopback scratch listener. ` +
          `A test server may only bind 127.0.0.1:${PORT_LO}-${PORT_HI - 1}.`,
      );
    }
    const port = Number(m[1]);
    const why = FORBIDDEN_PORTS[port];
    if (why !== undefined) {
      throw new Error(`${name} points at port ${port}: ${why}. Refusing to start.`);
    }
    if (port < PORT_LO || port >= PORT_HI) {
      throw new Error(
        `${name}=${value} is outside the scratch range ${PORT_LO}-${PORT_HI - 1}. ` +
          `Ports outside it belong to something real on this box.`,
      );
    }
  }
}

function bindable(port: number): boolean {
  try {
    const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * A free loopback port in 18000–18999, or the caller's explicit override.
 *
 * There is an unavoidable window between "this bound and released" and
 * "`ledgerd` bound it". The alternative — a fixed port per role — collides
 * silently whenever two runs overlap, which on a box that also serves
 * production is the worse failure. The scan starts at a pid-derived offset so
 * two concurrent `bun test` processes do not walk the range in lockstep.
 */
function scratchPort(envName: string): number {
  const override = process.env[envName];
  if (override !== undefined && override !== "") {
    const port = Number(override);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`${envName}=${JSON.stringify(override)} is not a usable port`);
    }
    // An override names ONE port, so a second stack in the same process cannot
    // have it. Refused loudly: the alternative is two servers racing for one
    // socket, where the loser's failure surfaces as an unrelated timeout.
    if (claimed.has(port)) {
      throw new Error(`${envName}=${port} is already in use by another stack in this process; unset it to run more than one`);
    }
    claimed.add(port);
    return port;
  }
  const span = PORT_HI - PORT_LO;
  const start = (process.pid * 13) % span;
  for (let i = 0; i < span; i++) {
    const port = PORT_LO + ((start + i) % span);
    if (claimed.has(port) || !bindable(port)) continue;
    claimed.add(port);
    return port;
  }
  throw new Error(`no free loopback port in ${PORT_LO}-${PORT_HI - 1}`);
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

function psql(dsn: string, sql: string): string {
  return execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-qtAX", "-d", dsn, "-c", sql], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

/**
 * Swaps the database name into the admin DSN.
 *
 * Hand-rolled rather than `new URL()`, for the reason `roundtrip.test.ts`
 * documents: `pgtest` connects over a UNIX socket, so its DSN has an EMPTY host
 * with a userinfo (`postgres://postgres@/postgres?host=/tmp/…`) and the WHATWG
 * parser rejects that outright.
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

/** Whether a database of this name exists in the scratch cluster. */
export function databaseExists(name: string): boolean {
  if (ADMIN_DSN === "") return false;
  const out = psql(ADMIN_DSN, `SELECT 1 FROM pg_database WHERE datname = '${name}'`);
  return out.trim() === "1";
}

// ---------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------

/**
 * Every harness binary lives under this prefix, which is what makes an orphan
 * from a crashed run identifiable later. See {@link reapOrphans}.
 */
const BIN_PREFIX = join(tmpdir(), "ledger-e2e-bin-");

let binDir = "";
let building: Promise<string> | undefined;

/**
 * Compiles `cmd/ledgerd` once per test process.
 *
 * Cached because a `go build` is seconds and every stack would otherwise pay
 * it. NOT cached across processes: a stale binary that passes an exit test is
 * the single most misleading outcome this harness could produce.
 */
function ledgerdBinary(): Promise<string> {
  building ??= (async () => {
    binDir = mkdtempSync(`${BIN_PREFIX}`);
    const bin = join(binDir, "ledgerd");
    execFileSync("go", ["build", "-o", bin, "./cmd/ledgerd"], { cwd: repoPath(), stdio: "pipe" });
    return bin;
  })();
  return building;
}

/** The parent pid of a live process, or 0. */
function parentOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 2 is the executable name IN PARENTHESES and may itself contain
    // spaces or parentheses, so the fields after it are found from the LAST
    // `)` rather than by splitting the whole line.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(after[1] ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * Kills `ledgerd` processes left behind by a CRASHED earlier run, and removes
 * their binaries.
 *
 * # Why this exists rather than an exit hook
 *
 * The obvious net is `process.on("exit")`. **Bun's test runner does not fire
 * it** — measured, not assumed: a handler registered in a `.test.ts` never ran
 * on a clean pass. Neither does Bun kill spawned children when it exits
 * (`Bun.spawn` and `node:child_process.spawn` were both checked; both children
 * survived and reparented to pid 1). So a suite killed with SIGKILL, or an
 * assertion that throws outside an `afterEach`, leaves a real server holding a
 * real socket on a box that also serves production. The hook is still
 * installed, because it DOES work for a plain `bun run` importing this module,
 * but nothing may depend on it.
 *
 * # Why it cannot kill a concurrent run's server
 *
 * Two conditions, both required. The executable must live under
 * {@link BIN_PREFIX}, so nothing outside this harness is ever a candidate — not
 * a hand-started `ledgerd`, and not v1's `ledger`. And its parent must be pid
 * 1, i.e. it has been REPARENTED TO INIT, which is precisely the definition of
 * "nobody is supervising this any more". A live sibling stack's server has a
 * live `bun` parent and is therefore never touched; `harness.test.ts` asserts
 * exactly that.
 *
 * @returns how many orphans were killed.
 */
export function reapOrphans(): number {
  if (!existsSync("/proc")) return 0; // Linux-only; this box is Linux.
  let killed = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let exe = "";
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      continue; // gone, or not ours to look at
    }
    if (!exe.startsWith(BIN_PREFIX) || parentOf(pid) !== 1) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed++;
    } catch {
      /* it exited between the readlink and the signal */
    }
  }
  // Stale binaries — ~13 MB each, one per test PROCESS, and nothing else ever
  // deletes them. Skipped while any live process is running out of the
  // directory, and skipped while it is recent, which together cover the only
  // real hazard: a concurrent run that has built its binary but has not spawned
  // from it yet. That gap is a `go build`, so five minutes is two orders of
  // magnitude of headroom, and the cost of being wrong is a sibling's ENOENT
  // rather than anything silent.
  const inUse = new Set(usedBinaries());
  for (const s of liveStacks) inUse.add(s.binary);
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const name of readdirSync(tmpdir())) {
    const dir = join(tmpdir(), name);
    if (!dir.startsWith(BIN_PREFIX) || dir === binDir || inUse.has(join(dir, "ledgerd"))) continue;
    try {
      if (statSync(dir).mtimeMs > cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* another run removed it first */
    }
  }
  return killed;
}

/** Executables under {@link BIN_PREFIX} that some live process is running. */
function usedBinaries(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const exe = readlinkSync(`/proc/${entry}/exe`);
      if (exe.startsWith(BIN_PREFIX)) out.push(exe);
    } catch {
      /* gone, or not ours to look at */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

export interface StackOptions {
  /**
   * Recorded TXT records for DKIM/ARC. Defaults to {@link DNS_FIXTURES}; `null`
   * uses real DNS, which no test should want.
   */
  dnsFixtures?: string | null;
  /** `--dev-auth`. Defaults to true; without it no authenticated route is reachable. */
  devAuth?: boolean;
  /** The mail domain every inbound address is derived from. */
  mailDomain?: string;
  /** Extra environment for the spawned process, applied last. */
  env?: Record<string, string>;
  /** Stream `ledgerd`'s stderr. Also enabled by `LEDGER_E2E_VERBOSE`. */
  verbose?: boolean;
}

/** Everything this process started and has not stopped. */
const liveStacks = new Set<Stack>();
let firstBoot = true;

/**
 * Runs once, before the first stack of the process.
 *
 * The exit hook is best-effort and documented as such in {@link reapOrphans}:
 * it works for a plain `bun run`, and Bun's test runner never fires it. The
 * reap is the part that actually holds, and it runs at STARTUP because that is
 * the one moment this process is guaranteed to reach.
 */
function installSafetyNets(): void {
  if (!firstBoot) return;
  firstBoot = false;
  reapOrphans();
  process.on("exit", () => {
    for (const s of liveStacks) s.killNow();
    if (binDir !== "") rmSync(binDir, { recursive: true, force: true });
  });
}

export class Stack {
  readonly httpURL: string;
  readonly adminURL: string;

  constructor(
    readonly dir: string,
    readonly database: string,
    readonly binary: string,
    readonly httpPort: number,
    readonly smtpPort: number,
    readonly adminPort: number,
    readonly adminToken: string,
    readonly mailDomain: string,
    readonly env: Record<string, string>,
    private readonly proc: ChildProcess,
    private readonly stderr: string[],
  ) {
    this.httpURL = `http://127.0.0.1:${httpPort}`;
    this.adminURL = `http://127.0.0.1:${adminPort}`;
  }

  /** Always loopback. Named separately so callers do not hard-code it. */
  get smtpHost(): string {
    return "127.0.0.1";
  }

  /** `@in.<domain>`, the suffix every inbound address ends with. */
  get inboundSuffix(): string {
    return `@in.${this.mailDomain}`;
  }

  get pid(): number {
    return this.proc.pid ?? 0;
  }

  /** Everything `ledgerd` has written to stderr, for diagnosing a failure. */
  log(): string {
    return this.stderr.join("");
  }

  /** A client with its own state directory. See {@link clientFor}. */
  client(profile: string): Client {
    return clientFor(this, profile);
  }

  /**
   * An authenticated JSON call as `c`, for the routes the {@link Client} class
   * does not wrap (address, quarantine, samples, account).
   *
   * The bearer token is read from the client's own state file rather than kept
   * beside it, so this cannot drift from what the client would actually send.
   */
  async json<T>(c: Client, method: string, path: string, body?: unknown): Promise<T> {
    const state = JSON.parse(readFileSync(c.location, "utf8")) as { session_token?: string | null };
    const token = state.session_token ?? "";
    if (token === "") throw new Error(`${c.location} holds no session token: call login first`);
    return await this.call<T>(method, path, token, body);
  }

  /** An admin-console call, with the bearer token this stack was started with. */
  async admin<T>(method: string, path: string, body?: unknown): Promise<T> {
    return await this.call<T>(method, path, this.adminToken, body, this.adminURL);
  }

  private async call<T>(method: string, path: string, token: string, body: unknown, base = this.httpURL): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  /** The caller's inbound address, minted on first read. */
  async address(c: Client): Promise<string> {
    const out = await this.json<{ address: string }>(c, "GET", "/api/v1/address");
    return out.address;
  }

  /**
   * Runs the same binary in another mode (`verify`, `parse-rate`, …) against
   * THIS stack's database, and returns its exit code and output rather than
   * throwing — a non-zero exit is a finding a test asserts on, not an accident.
   */
  run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const out = Bun.spawnSync([this.binary, ...args], {
      cwd: repoPath(),
      env: { ...process.env, ...this.env },
      // Named explicitly: with the defaults, `stderr` is typed as possibly
      // absent and the output a caller needs to read a `verify` finding out of
      // becomes unreachable.
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: out.exitCode,
      stdout: out.stdout.toString(),
      stderr: out.stderr.toString(),
    };
  }

  /**
   * Mints one single-use invite code against THIS stack's database, by running
   * the real `ledgerd mint-invite` — the same command the operator runs.
   *
   * Account CREATION is gated on a code (Phase 2, Decision 8), so every test
   * that signs a NEW subject in needs one. Minting it through the CLI rather
   * than an INSERT is the point: it is the only thing in the suite that proves
   * the mint → hand over → redeem loop works end to end, and an INSERT would
   * be the test performing setup that production is supposed to perform.
   *
   * Signing in to an account that already exists needs no code, so a second
   * profile on the same subject calls `login` with nothing.
   */
  mintInvite(note = "e2e"): string {
    const out = this.run(["mint-invite", "--note", note]);
    if (out.exitCode !== 0) {
      throw new Error(`ledgerd mint-invite exited ${out.exitCode}: ${out.stderr}`);
    }
    const code = out.stdout.trim();
    if (code === "") throw new Error(`ledgerd mint-invite printed no code (stderr: ${out.stderr})`);
    return code;
  }

  /** Last resort, from the process-exit hook. Synchronous and unconditional. */
  killNow(): void {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  /** @internal — used by {@link stopStack}. */
  child(): ChildProcess {
    return this.proc;
  }
}

/**
 * Boots a stack. The caller MUST pair it with {@link stopStack}.
 *
 * @throws if `LEDGER_TEST_POSTGRES_URL` is unset — there is no fallback to a
 * shared or default database on purpose. A harness that quietly reaches for
 * whatever cluster it can find is one delete away from a production incident.
 */
export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  if (ADMIN_DSN === "") {
    throw new Error("startStack needs LEDGER_TEST_POSTGRES_URL (scripts/v2-check.sh exports it)");
  }
  installSafetyNets();

  const binary = await ledgerdBinary();

  const database = `t_e2e_${process.pid}_${nextStackID++}`;
  const httpPort = scratchPort("LEDGER_E2E_HTTP_PORT");
  const smtpPort = scratchPort("LEDGER_E2E_SMTP_PORT");
  const adminPort = scratchPort("LEDGER_E2E_ADMIN_PORT");
  const adminToken = `e2e-${crypto.randomUUID()}`;
  const mailDomain = opts.mailDomain ?? "example.test";

  const env: Record<string, string> = {
    LEDGER_MAIL_DOMAIN: mailDomain,
    LEDGER_PG_DSN: dsnFor(database),
    LEDGER_HTTP_LISTEN: `127.0.0.1:${httpPort}`,
    // The rail. Without this the process inherits `:25` from the defaults —
    // and assertScratchListeners below refuses to spawn at all if it is ever
    // dropped, so this line is enforced rather than remembered.
    LEDGER_SMTP_LISTEN: `127.0.0.1:${smtpPort}`,
    LEDGER_ADMIN_LISTEN: `127.0.0.1:${adminPort}`,
    // Set unconditionally: with no token the console is not served AT ALL, and
    // Task 38 reads /admin/accounting through it.
    LEDGER_ADMIN_TOKEN: adminToken,
    // The dictionary's submitter HMAC — 32 random bytes as hex, which is the
    // form `dict` demands (it refuses anything else outright, so a placeholder
    // here fails the whole boot rather than degrading one route). Random per
    // stack, so no test can come to depend on a pinned key.
    LEDGER_DICT_HMAC_KEY: randomHex(32),
    ...(opts.env ?? {}),
  };
  // The rail, enforced. It runs on the MERGED environment — so `opts.env`
  // cannot override its way past it — and BEFORE the scratch directory and the
  // database exist, so a refusal leaves nothing behind to clean up.
  assertScratchListeners(env);

  const dir = mkdtempSync(join(tmpdir(), "ledger-e2e-"));
  mkdirSync(join(dir, "state"), { recursive: true, mode: 0o700 });
  psql(ADMIN_DSN, `CREATE DATABASE ${database}`);

  const args = ["serve"];
  if (opts.devAuth !== false) args.push("--dev-auth");
  const fixtures = opts.dnsFixtures === undefined ? DNS_FIXTURES : opts.dnsFixtures;
  if (fixtures !== null) {
    if (!existsSync(fixtures)) throw new Error(`dns fixtures not found: ${fixtures}`);
    args.push("--dns-fixtures", fixtures);
  }

  const stderr: string[] = [];
  const verbose = opts.verbose === true || process.env["LEDGER_E2E_VERBOSE"] !== undefined;
  const proc = spawn(binary, args, {
    cwd: repoPath(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  proc.stderr?.on("data", (b: Buffer) => {
    stderr.push(b.toString());
    if (verbose) process.stderr.write(b);
  });
  proc.stdout?.on("data", (b: Buffer) => {
    stderr.push(b.toString());
    if (verbose) process.stdout.write(b);
  });

  const stack = new Stack(
    dir, database, binary, httpPort, smtpPort, adminPort, adminToken, mailDomain, env, proc, stderr,
  );
  liveStacks.add(stack);
  try {
    await waitReady(stack);
  } catch (err) {
    await stopStack(stack);
    throw err;
  }
  return stack;
}

let nextStackID = 1;

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

/**
 * Waits for the HTTP listener AND the SMTP listener.
 *
 * Both, because they are separate goroutines with separate binds: a stack that
 * answered `/healthz` while its SMTP listener was still starting would fail a
 * mail delivery with `ECONNREFUSED` in whichever test happened to be first, and
 * that reads like a flake rather than a race.
 */
async function waitReady(s: Stack): Promise<void> {
  const proc = s.child();
  const deadline = Date.now() + 60_000;
  let http = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`ledgerd exited with ${proc.exitCode} before it was ready:\n${s.log()}`);
    }
    if (!http) {
      try {
        const res = await fetch(`${s.httpURL}/api/v1/healthz`);
        // 200 means the pool answered a ping, so migrations are done and the
        // database is reachable — a strictly stronger readiness signal than a
        // 401 from an authenticated route.
        http = res.status === 200;
      } catch {
        /* not listening yet */
      }
    }
    if (http && (await smtpReachable(s.smtpPort))) return;
    await Bun.sleep(100);
  }
  throw new Error(`ledgerd did not become ready in 60s:\n${s.log()}`);
}

async function smtpReachable(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data: () => {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops a stack and proves it stopped.
 *
 * SIGTERM (which `runServe` installs a handler for, so listeners close and
 * in-flight requests finish), then SIGKILL if it will not go, and then a
 * liveness check — because "we sent a signal" is not the same claim as "no
 * `ledgerd` is running", and only the second one is safe to make on this box.
 * The database is dropped and the scratch directory removed either way; a
 * process that survived SIGKILL throws AFTER the cleanup, so one stuck stack
 * does not also leak a database.
 */
export async function stopStack(s: Stack): Promise<void> {
  const proc = s.child();
  const pid = s.pid;
  let stuck = "";

  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGTERM");
    if (!(await waitExit(proc, 20_000))) {
      proc.kill("SIGKILL");
      if (!(await waitExit(proc, 5_000))) stuck = `ledgerd pid ${pid} survived SIGKILL`;
    }
  }
  // The child may be reaped while a grandchild (there is none today) or a
  // reused pid holds the name, so this is checked rather than assumed.
  if (stuck === "" && pid > 0 && processAlive(pid)) stuck = `ledgerd pid ${pid} is still alive after exit`;

  liveStacks.delete(s);
  for (const p of [s.httpPort, s.smtpPort, s.adminPort]) claimed.delete(p);

  try {
    // WITH (FORCE) terminates any connection the dying process had not yet
    // closed; without it a drop races the server's own shutdown and fails with
    // "database is being accessed by other users" perhaps one run in twenty.
    psql(ADMIN_DSN, `DROP DATABASE IF EXISTS ${s.database} WITH (FORCE)`);
  } catch (err) {
    if (stuck === "") stuck = `dropping ${s.database}: ${String(err)}`;
  }
  rmSync(s.dir, { recursive: true, force: true });

  if (stuck !== "") throw new Error(stuck);
}

function waitExit(proc: ChildProcess, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Whether a pid names a live process. Signal 0 tests without delivering. */
export function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which for this
    // harness's own child cannot happen — but reporting it as dead would be a
    // lie, so only ESRCH counts as gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * A client with its OWN state directory under the stack's scratch directory.
 *
 * `profile` names the state file and nothing else. It does NOT preselect a
 * writer: a `Client` whose `writerId` is set without the matching private key
 * would author blobs it cannot sign, so writer selection stays where the real
 * CLI puts it — `enroll(id)` for this device's own writer, `useWriter(id)`
 * for one whose key it already holds. Passing the intended writer id as the
 * profile is the convention (`clientFor(s, "dev-a")`), which is why the
 * parameter is named for it.
 */
export function clientFor(s: Stack, profile: string): Client {
  return new Client({ store: fileStore(join(s.dir, "state"), profile), server: s.httpURL });
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export type { SMTPReply, SMTPStage } from "./smtp";

/**
 * Delivers one message to this stack's SMTP receiver.
 *
 * See `smtp.ts` for why the sender is hand-written, and for the dot-stuffing
 * rule the committed corpus actually exercises.
 */
export async function sendMail(
  s: Stack,
  rcpt: string,
  raw: Uint8Array,
  opts: { from?: string } = {},
): Promise<SMTPReply> {
  return await smtpSend({
    host: s.smtpHost,
    port: s.smtpPort,
    rcpt,
    raw,
    ...(opts.from === undefined ? {} : { from: opts.from }),
  });
}

// ---------------------------------------------------------------------------
// Corpus fixtures
// ---------------------------------------------------------------------------

/**
 * The three populations the exit scenario draws from.
 *
 *   - `enbd-stable`   — ENBD messages with NO DKIM `x=` tag, directly signed by
 *                       the bank. The trusted lane.
 *   - `dib-unexpired` — a DIB message whose `x=` has not yet passed.
 *   - `unknown-origin`— Gmail-forwarded bank mail: the outer domain is a
 *                       forwarder, so it can only ever be confirmed by its
 *                       INNER origin (spec §3.2), which is what makes it the
 *                       quarantine-lane fixture.
 */
export type FixtureKind = "enbd-stable" | "dib-unexpired" | "unknown-origin";

interface ManifestEntry {
  file: string;
  kind: string;
  has_x_tag?: boolean;
  x_expires_at?: string;
}

let manifest: ManifestEntry[] | undefined;

function fixtures(): ManifestEntry[] {
  manifest ??= (
    JSON.parse(readFileSync(fixtureFile("manifest.json"), "utf8")) as { fixtures: ManifestEntry[] }
  ).fixtures;
  return manifest;
}

/**
 * Selects the committed `.eml` files for a kind, in a stable order.
 *
 * **Selection here is a correctness requirement, not a convenience.**
 * `go-msgauth` enforces DKIM's `x=` expiry against a clock no test can stub, so
 * a fixture carrying one is a test that begins failing on a date nobody chose.
 * `enbd-stable` is therefore defined by `has_x_tag === false` — a property read
 * from the manifest rather than trusted from a file name — and `dib-unexpired`
 * carries an explicit canary: once its `x=` passes, this throws with the date
 * instead of letting a DKIM failure be diagnosed as a crypto bug.
 */
function pool(kind: FixtureKind): ManifestEntry[] {
  const all = fixtures();
  let chosen: ManifestEntry[];
  switch (kind) {
    case "enbd-stable":
      chosen = all.filter((f) => f.kind === "enbd-dkim-noexpiry" && f.has_x_tag === false);
      break;
    case "dib-unexpired": {
      chosen = all.filter((f) => f.kind === "dib-dkim");
      for (const f of chosen) {
        const at = f.x_expires_at === undefined ? undefined : Date.parse(f.x_expires_at);
        if (at !== undefined && Number.isFinite(at) && at <= Date.now()) {
          throw new Error(
            `${f.file}'s DKIM signature expired at ${f.x_expires_at}: re-extract the fixture ` +
              `(internal/v2/corpus/cmd/extract-fixtures). This is the canary, not a crypto bug.`,
          );
        }
      }
      break;
    }
    case "unknown-origin":
      // Forwarded mail: the outer signer is the forwarder, never the bank.
      chosen = all.filter((f) => f.kind.startsWith("arc-"));
      break;
    default:
      throw new Error(`unknown fixture kind ${JSON.stringify(kind)}`);
  }
  if (chosen.length === 0) throw new Error(`no committed fixtures for kind ${JSON.stringify(kind)}`);
  return [...chosen].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * `n` messages of a kind, every one byte-distinct from the others.
 *
 * # Why distinctness is a hard requirement
 *
 * `ingest.IngestID` is the **sha256 of the raw bytes**, and it is the dedup
 * key. Handing the same file back twice is therefore not a redundant delivery,
 * it is a SILENTLY DISCARDED one: a caller asking for 20 messages would see 2
 * ops appended and no error anywhere.
 *
 * # How copies past the pool are made distinct
 *
 * The committed corpus holds a handful of files per kind, and the exit scenario
 * wants 20. Copies past the pool get one extra header, `X-Ledger-E2E-Copy`,
 * prepended above the existing block — the same position, and the same kind of
 * addition, a relay makes when it stamps a `Received:` line.
 *
 * That is safe for the signatures, which is the only reason it is acceptable
 * here: DKIM canonicalises exactly the header fields named in the signature's
 * own `h=` tag and RFC 6376 §5.4 requires a verifier to ignore every other
 * header, and no `h=` in this corpus names `X-Ledger-E2E-Copy`. The body is
 * untouched, so the body hash is unaffected. Header selection is also BOTTOM-UP
 * (RFC 6376 §5.4.2), so even a name collision at the top of the block would be
 * inert — measured, by mutating this to prepend a second `Subject:` and finding
 * every assertion still green.
 *
 * `harness.test.ts` proves the rule end-to-end rather than by argument: a
 * derived copy is delivered to a real `ledgerd` and must reach the TRUSTED
 * lane, which it can only do if the real verifier still accepts its signature.
 * Mutating this function to append ONE byte to the body — which the body hash
 * does cover — turns that assertion red.
 *
 * The first copy of each file is returned VERBATIM, so any request also
 * contains the corpus exactly as extracted.
 *
 * **This is a workaround for a small corpus, not the intended end state.**
 * `internal/v2/corpus/cmd/extract-fixtures` can write more real messages
 * (the snapshot holds 62 ENBD messages with no `x=` tag); when it does, `pool`
 * grows and the derived path stops being reached.
 */
export function corpusFixtures(kind: FixtureKind, n: number): Uint8Array[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`corpusFixtures needs at least one message, got ${n}`);
  const files = pool(kind);
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const entry = files[i % files.length]!;
    const raw = new Uint8Array(readFileSync(fixtureFile(entry.file)));
    const copy = Math.floor(i / files.length);
    out.push(copy === 0 ? raw : withCopyHeader(raw, i));
  }
  return out;
}

function withCopyHeader(raw: Uint8Array, k: number): Uint8Array {
  const header = new TextEncoder().encode(`X-Ledger-E2E-Copy: ${k}\r\n`);
  const out = new Uint8Array(header.length + raw.length);
  out.set(header, 0);
  out.set(raw, header.length);
  return out;
}
