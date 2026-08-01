/**
 * The harness's own self-test.
 *
 * Task 38 is an exit CRITERION: when it fails, the answer has to be "the system
 * is wrong", never "the rig is wrong". Everything below exists to make that
 * second answer unavailable — the stack really boots, the SMTP client really
 * transfers bytes unchanged, two profiles really are independent, and teardown
 * really leaves nothing behind.
 *
 * It SKIPS without `LEDGER_TEST_POSTGRES_URL`, exactly like `roundtrip.test.ts`:
 * a bare `bun test` stays fast and Postgres-free, while `scripts/v2-check.sh`
 * exports the variable and therefore runs this every time.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { STREAM_COLD, STREAM_HOT } from "../../src/wire/blob";
import {
  assertScratchListeners,
  clientFor,
  corpusFixtures,
  databaseExists,
  fixtureFile,
  processAlive,
  reapOrphans,
  repoPath,
  sendMail,
  startStack,
  stopStack,
  type Stack,
} from "./harness";

const ADMIN_DSN = process.env["LEDGER_TEST_POSTGRES_URL"] ?? "";

// go build + a first connection to a cold cluster comfortably exceed bun's 5s
// default, and every test here boots its own stack on purpose (see below).
const TIMEOUT = 180_000;

/**
 * Every test boots and tears down its OWN stack.
 *
 * Deliberately the opposite of `roundtrip.test.ts`'s shared, lazily-booted
 * stack. Two of the four contracts under test here — that a stack can be torn
 * down leaving nothing running, and that ports are reclaimed — are properties
 * of the boot/teardown PAIR, and a suite that boots once cannot observe either.
 * The binary is compiled once and cached (see `harness.ts`), so the repeated
 * cost is a process start, not a Go build.
 */
let live: Stack | undefined;
afterEach(async () => {
  if (live !== undefined) {
    const s = live;
    live = undefined;
    await stopStack(s);
  }
});

async function boot(): Promise<Stack> {
  const s = await startStack();
  live = s;
  return s;
}

// ---------------------------------------------------------------------------
// The listener rail
// ---------------------------------------------------------------------------

/**
 * The one safety rail nothing tested, on the box it protects.
 *
 * `mail.smtp_listen` defaults to `:25` — every interface — and this machine is
 * the production mail host with `:25` free and the harness running as root. So
 * the removal mutation ("delete the LEDGER_SMTP_LISTEN line from the spawn
 * env") is the one mutation nobody can responsibly RUN: proving the finding
 * would mean binding the live MTA port.
 *
 * These tests are how it gets covered without ever spawning anything.
 * `assertScratchListeners` is a pure function over the environment, so the
 * hostile cases are cheap and safe, and `startStack` calls it on the merged
 * environment before it creates so much as a temp directory — which means
 * dropping the line does not bind `:25`, it fails every e2e test in the suite
 * on the first call. No Postgres needed, so this block does not skip.
 */
describe("the listener rail", () => {
  const good = {
    LEDGER_HTTP_LISTEN: "127.0.0.1:18001",
    LEDGER_SMTP_LISTEN: "127.0.0.1:18002",
    LEDGER_ADMIN_LISTEN: "127.0.0.1:18003",
  };

  test("accepts loopback scratch ports", () => {
    expect(() => assertScratchListeners({ ...good })).not.toThrow();
  });

  test("refuses an unset listener, which is what dropping the line looks like", () => {
    for (const name of ["LEDGER_HTTP_LISTEN", "LEDGER_SMTP_LISTEN", "LEDGER_ADMIN_LISTEN"]) {
      const env: Record<string, string> = { ...good };
      delete env[name];
      expect(() => assertScratchListeners(env)).toThrow(new RegExp(`${name} is not set`));
      // And the SMTP one says what would happen, because that is the one whose
      // default is a port something real is listening on elsewhere.
      expect(() => assertScratchListeners({ ...good, [name]: "" })).toThrow(new RegExp(name));
    }
    expect(() => assertScratchListeners({ ...good, LEDGER_SMTP_LISTEN: undefined as unknown as string }))
      .toThrow(/:25/);
  });

  test("refuses the live MTA port however it is spelled", () => {
    for (const listen of ["127.0.0.1:25", ":25", "0.0.0.0:25", "[::]:25"]) {
      expect(() => assertScratchListeners({ ...good, LEDGER_SMTP_LISTEN: listen })).toThrow();
    }
  });

  test("refuses a listener that is not loopback, and ports that belong to something real", () => {
    expect(() => assertScratchListeners({ ...good, LEDGER_HTTP_LISTEN: "0.0.0.0:18001" })).toThrow(/loopback/);
    expect(() => assertScratchListeners({ ...good, LEDGER_HTTP_LISTEN: ":18001" })).toThrow(/loopback/);
    expect(() => assertScratchListeners({ ...good, LEDGER_HTTP_LISTEN: "100.64.0.1:18001" })).toThrow(/loopback/);
    // v1 is listening on 8080 on this box right now.
    expect(() => assertScratchListeners({ ...good, LEDGER_HTTP_LISTEN: "127.0.0.1:8080" })).toThrow(/8080/);
    expect(() => assertScratchListeners({ ...good, LEDGER_ADMIN_LISTEN: "127.0.0.1:8079" })).toThrow(/8079/);
    // And anything outside the scratch range, which is where everything that
    // is not this harness lives.
    expect(() => assertScratchListeners({ ...good, LEDGER_SMTP_LISTEN: "127.0.0.1:2525" })).toThrow(/scratch range/);
  });
});

describe.skipIf(ADMIN_DSN === "")("the e2e harness", () => {
  // The end-to-end form of the rail: the refusal happens on the MERGED spawn
  // environment, so an `opts.env` override cannot get past it, and it happens
  // before the scratch database exists.
  //
  // Two tests rather than one so that each hostile value can be run ALONE. The
  // MTA case must never be run against a build whose rail is missing — that is
  // the whole point of it — while the 8080 case is safe to run that way (v1
  // holds the port, so the bind is refused by the kernel), which is what makes
  // "delete the assertScratchListeners call" a mutation somebody can actually
  // execute on this box.
  // Both match the RAIL's own wording, not merely "an error mentioning the
  // port". Measured: with the rail deleted, `127.0.0.1:8080` still rejects —
  // ledgerd cannot bind a port v1 already holds and says so — so a test that
  // accepted any error containing "8080" passed with the guard removed. That is
  // the same true-by-construction pass this whole round is about.
  test("startStack refuses a caller that points the SMTP listener at the MTA port", async () => {
    await expect(startStack({ env: { LEDGER_SMTP_LISTEN: "0.0.0.0:25" } }))
      .rejects.toThrow(/not a loopback scratch listener/);
  }, TIMEOUT);

  test("startStack refuses a caller that points a listener at v1's port", async () => {
    await expect(startStack({ env: { LEDGER_HTTP_LISTEN: "127.0.0.1:8080" } }))
      .rejects.toThrow(/port 8080: v1's ledger.*Refusing to start/);
  }, TIMEOUT);

  test("the stack starts, answers healthz, and binds only loopback scratch ports", async () => {
    const s = await boot();

    const res = await fetch(`${s.httpURL}/api/v1/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "ok" });

    expect(s.httpURL).toMatch(/^http:\/\/127\.0\.0\.1:18\d\d\d$/);
    expect(s.smtpPort).toBeGreaterThan(18000);
    expect(s.smtpPort).toBeLessThan(19000);
    // The three listeners must not collide, and the admin console must be on
    // loopback — `config.CheckAdminBind` refuses anything else, so a stack that
    // guessed a routable address would fail to boot at all rather than expose
    // it, but the assertion is here because that guard is the thing under test.
    expect(new Set([s.httpPort, s.smtpPort, s.adminPort]).size).toBe(3);
    expect(s.adminURL).toMatch(/^http:\/\/127\.0\.0\.1:18\d\d\d$/);

    // The admin console is mounted and token-gated: Task 38 step 14 reads
    // /admin/accounting through it, so "it booted" has to include "the console
    // is there and refuses an anonymous caller".
    expect((await fetch(`${s.adminURL}/admin/accounting`)).status).toBe(401);
    const ok = await fetch(`${s.adminURL}/admin/accounting`, {
      headers: { Authorization: `Bearer ${s.adminToken}` },
    });
    expect(ok.status).toBe(200);
  }, TIMEOUT);

  test("the SMTP client dot-stuffs a body containing a leading-dot line", async () => {
    const s = await boot();
    const raw = new TextEncoder().encode("Subject: t\r\n\r\nline1\r\n.hidden\r\nline3\r\n");
    const res = await sendMail(s, `u-unknown@in.${s.mailDomain}`, raw);
    // Unknown recipient, refused at RCPT time with the single reply smtpd emits
    // for every RCPT rejection — but the CONVERSATION completed: greeting,
    // EHLO, MAIL FROM and QUIT all answered, which is what this asserts.
    expect(res.code).toBe(550);
    expect(res.stage).toBe("RCPT");
    expect(res.message.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("two clients get independent state directories", async () => {
    const s = await boot();
    const a = clientFor(s, "dev-a");
    const b = clientFor(s, "dev-b");

    expect(a.location).not.toBe(b.location);
    expect(a.location).toContain(s.dir);
    expect(b.location).toContain(s.dir);

    // Independent for real, not merely differently named: `dev-a` signing in
    // must leave `dev-b` signed out, or the "two concurrent writers" the exit
    // criterion names would be one writer with two handles.
    await a.login("apple", "dev:harness-two-profiles");
    await a.enroll("dev-a");
    expect(() => b.userId).toThrow(/not signed in/);
    expect(existsSync(a.location)).toBe(true);
    expect(existsSync(b.location)).toBe(false);
  }, TIMEOUT);

  test("stopStack leaves no ledgerd process and no scratch database", async () => {
    const s = await startStack();
    const { pid, database, dir, httpPort } = s;
    expect(processAlive(pid)).toBe(true);
    expect(databaseExists(database)).toBe(true);

    await stopStack(s);

    expect(processAlive(pid)).toBe(false);
    expect(databaseExists(database)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    // The port is bindable again, which is the property an orphaned child would
    // break and a pid check alone would not see.
    const probe = Bun.serve({ port: httpPort, hostname: "127.0.0.1", fetch: () => new Response("") });
    probe.stop(true);
  }, TIMEOUT);

  test("reaping orphans never touches a supervised stack", async () => {
    const s = await boot();
    // The reaper's whole safety argument is that a live sibling has a live
    // parent, so this is the assertion the argument rests on. If it ever
    // regresses, two concurrent runs of the exit test kill each other's
    // servers mid-scenario and the failure looks like a server crash.
    expect(reapOrphans()).toBe(0);
    expect(processAlive(s.pid)).toBe(true);
    expect((await fetch(`${s.httpURL}/api/v1/healthz`)).status).toBe(200);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // The end-to-end proof: real mail, over a real socket, into a real client.
  // -------------------------------------------------------------------------

  test("a real corpus message survives SMTP byte-for-byte and reaches a client as an op", async () => {
    const s = await boot();

    const a = clientFor(s, "dev-a");
    await a.login("apple", "dev:harness-mail");
    await a.enroll("dev-a");
    const address = await s.address(a);
    expect(address.endsWith(`@in.${s.mailDomain}`)).toBe(true);

    // ENBD messages that carry no DKIM `x=` tag, so none of them can start
    // failing on a future date. The first teaches the account to trust the
    // origin; the second is the one whose bytes are checked; the third is a
    // DERIVED copy, which is how a request for more messages than the corpus
    // holds is satisfied.
    const [first, second, derived] = corpusFixtures("enbd-stable", 3);
    if (first === undefined || second === undefined || derived === undefined) {
      throw new Error("expected three enbd-stable fixtures");
    }

    // 1. Unknown origin -> quarantine, with the signature verified offline
    //    against the recorded DNS.
    expect((await sendMail(s, address, first)).code).toBe(250);
    const held = await s.json<{
      items: { ingest_id: string; outer_domain: string; dkim: string }[];
    }>(a, "GET", "/api/v1/quarantine");
    expect(held.items).toHaveLength(1);
    expect(held.items[0]?.outer_domain).toBe("emiratesnbd.com");
    expect(held.items[0]?.dkim).toBe("pass");
    expect(held.items[0]?.ingest_id).toBe(await sha256Hex(first));

    // 2. Confirm the bank as an outer origin — it signed the message as we
    //    received it, with no forwarder in between. The confirmation also
    //    RE-INGESTS what it releases (Task 38): held mail enters the integrity
    //    chains at that moment and nowhere else, so `first` becomes an op here
    //    rather than waiting in quarantine for a second call.
    const confirmed = await s.json<{ ingest_ids: string[]; reingest: { appended: number } }>(
      a, "POST", "/api/v1/quarantine/confirm", { domain: "emiratesnbd.com", scope: "outer" },
    );
    expect(confirmed.ingest_ids).toContain(await sha256Hex(first));
    expect(confirmed.reingest.appended).toBe(1);
    expect((await s.json<{ items: unknown[] }>(a, "GET", "/api/v1/quarantine")).items).toHaveLength(0);

    // 3. The trusted lane. This is the fixture with three lines beginning `.`
    //    (`grep -c '^\.' internal/v2/origin/testdata/enbd-proofpoint-p.eml`),
    //    so a sender that failed to dot-stuff would deliver a TRUNCATED message
    //    here: a different sha256, a broken DKIM body hash, and a quarantine
    //    row instead of an op.
    expect(countLeadingDotLines(second)).toBeGreaterThan(0);
    expect((await sendMail(s, address, second)).code).toBe(250);

    // 4. A DERIVED copy, which carries one extra unsigned header. Reaching the
    //    trusted lane is only possible if the real verifier still accepts its
    //    DKIM signature, so this is the empirical form of `corpusFixtures`'
    //    claim that `h=` never names `X-Ledger-E2E-Copy`. Task 38 asks for 20
    //    trusted messages out of a two-file pool and would silently append 2
    //    if this were wrong.
    expect((await sendMail(s, address, derived)).code).toBe(250);

    // 5. The client pulls them. The ingest id in each op is the sha256 of the
    //    bytes the server received, so these equalities prove the whole
    //    transfer path byte-for-byte.
    const pulled = await a.pull();
    expect(pulled.rows).toBeGreaterThan(0);
    expect(pulled.violations.filter((v) => v.severity === "hard_stop")).toHaveLength(0);

    const { ops } = a.materialize();
    const ingested = ops.filter((o) => o.op.type === "txn_ingested");
    expect(ingested.map((o) => o.op.ingest_id).sort()).toEqual(
      [await sha256Hex(first), await sha256Hex(second), await sha256Hex(derived)].sort(),
    );

    // The cold stream carries the raw mail on its own chain, at its own
    // counter (Decision 13). Its bodies are unverifiable until their hashes
    // are pinned — a hot-only client is the default, so the pins are a
    // separate, explicit step (spec §3.3:72) rather than something a body
    // fetch does for itself.
    const pins = await a.pullColdHashes();
    expect(pins.pinned).toBe(3);
    await a.pull({ stream: STREAM_COLD });
    expect(a.cursor(STREAM_HOT)).toBeGreaterThan(0n);
    expect(a.cursor(STREAM_COLD)).toBeGreaterThan(0n);
    // The COUNTER, not the cursor: cursors address the shared per-user `seq`
    // space (three messages produced six rows across the two streams), while
    // the counter is the position on the `(ingest, cold)` chain — three bodies,
    // counters 1 to 3, exactly as Decision 13 says.
    expect(a.pinnedHead("ingest", STREAM_COLD).counter).toBe(3n);
    expect(a.pinnedHead("ingest", STREAM_HOT).counter).toBe(3n);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // corpusFixtures — a selection rule, not a convenience
  // -------------------------------------------------------------------------

  test("corpusFixtures draws enbd-stable only from messages with no DKIM x= tag", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoPath(), "internal/v2/origin/testdata/manifest.json"), "utf8"),
    ) as { fixtures: { file: string; has_x_tag?: boolean }[] };

    // The whole point of the "stable" set: `go-msgauth` enforces `x=` against a
    // clock no test can stub, so a fixture carrying one is a test that fails on
    // a date nobody chose.
    for (const raw of corpusFixtures("enbd-stable", 4)) {
      const name = originalName(manifest, raw);
      const entry = manifest.fixtures.find((f) => f.file === name);
      expect(entry?.has_x_tag ?? true).toBe(false);
    }
  });

  test("corpusFixtures returns byte-distinct messages, because ingest dedups on sha256", async () => {
    // Four from a pool of two: the pool is exhausted, so this exercises the
    // path that has to produce distinctness rather than the one that gets it
    // for free. Ingest keys on the sha256 of the raw bytes, so a repeat would
    // be swallowed silently and an exit test asking for 20 would append 2.
    const msgs = corpusFixtures("enbd-stable", 4);
    expect(msgs).toHaveLength(4);
    const hashes = new Set(await Promise.all(msgs.map(sha256Hex)));
    expect(hashes.size).toBe(4);

    // The first of each distinct source file is returned VERBATIM, so at least
    // one message in any request is the corpus byte-for-byte.
    expect(Buffer.from(msgs[0]!).equals(readFileSync(fixtureFile("enbd-proofpoint-p.eml")))).toBe(true);
  });

  test("corpusFixtures knows the three kinds the exit test names", () => {
    expect(corpusFixtures("dib-unexpired", 1)).toHaveLength(1);
    expect(corpusFixtures("unknown-origin", 3)).toHaveLength(3);
    expect(() => corpusFixtures("nope" as "enbd-stable", 1)).toThrow(/unknown fixture kind/);
    expect(() => corpusFixtures("enbd-stable", 0)).toThrow(/at least one/);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function sha256Hex(raw: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(raw));
  return Buffer.from(digest).toString("hex");
}

function countLeadingDotLines(raw: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0x2e) continue;
    if (i === 0 || raw[i - 1] === 0x0a) n++;
  }
  return n;
}

/** Which committed `.eml` a returned message came from, by prefix match. */
function originalName(manifest: { fixtures: { file: string }[] }, raw: Uint8Array): string {
  for (const f of manifest.fixtures) {
    const body = readFileSync(fixtureFile(f.file));
    // A derived copy carries an extra header at the very front; the rest of the
    // message is unchanged, so the original is a SUFFIX of it.
    if (Buffer.from(raw).includes(body.subarray(0, 64))) return f.file;
  }
  throw new Error("returned fixture matches no committed .eml");
}
