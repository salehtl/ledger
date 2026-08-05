import { describe, expect, test } from "bun:test";
import { bunDriver, type SqlDriver } from "@ledger/client/store/driver.ts";
import { ensureProjection, PROJECTION_VERSION } from "@ledger/client/replay/projection.ts";
import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { sqliteDictionarySource, type DictionaryWriter } from "./source.ts";

type Round = { version: string; entries: unknown[]; removed: unknown[] };

/** A fetch that RECORDS the URL it was called with. The cursor test needs it. */
function feed(rounds: Round[]): { fetch: (input: RequestInfo | URL) => Promise<Response>; urls: string[] } {
  const urls: string[] = [];
  let round = 0;
  return {
    urls,
    fetch: async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const body = rounds[Math.min(round++, rounds.length - 1)]!;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

const TWO_ROUNDS: Round[] = [
  {
    version: "1",
    entries: [
      { pattern: "market", match: "contains", category: "general" },
      { pattern: "city market", match: "exact", category: "groceries" },
    ],
    removed: [],
  },
  { version: "2", entries: [], removed: [{ pattern: "city market", match: "exact", category: "groceries" }] },
];

/**
 * A projection the candidate pass will accept, with rows chosen to separate the
 * three exclusions from each other: two live uncategorized rows that a
 * different entry resolves, one row the user has already categorized, one
 * unparsed row and one superseded row.
 */
function seedProjection(db: SqlDriver): void {
  ensureProjection(db);
  db.prepare(
    "INSERT INTO projection_meta (id, version, cursor_hot, cursor_cold, home_currency, complete) VALUES (1, ?, '0', '0', 'AED', 1)",
  ).run(PROJECTION_VERSION);
  const insert = db.prepare(
    "INSERT INTO txn (id, ingest_id, amount_minor, currency, direction, posted_at, merchant_raw, last4, category, needs_review, provenance, amount_home_minor, unparsed, tier, parse_error, superseded_by, possible_duplicate_of, duplicate_disposition, verified_origin_domain, version) " +
      "VALUES (?, 'i', '100', 'AED', 'debit', '2026-08-01T00:00:00Z', ?, '', ?, ?, 'p', NULL, ?, 'template', NULL, ?, NULL, NULL, NULL, ?)",
  );
  //         id      merchant          category      needs_review unparsed superseded version
  insert.run("t-new", "City Market", null, 1, 0, null, 3);
  insert.run("t-oth", "Corner Market", null, 0, 0, null, 5);
  insert.run("t-mine", "City Market", "Dining", 0, 0, null, 2);
  insert.run("t-unp", "", null, 1, 1, null, 1);
  insert.run("t-sup", "City Market", null, 0, 0, "t-new", 1);
}

function recorder(): DictionaryWriter & { specs: OpSpec[] } {
  const specs: OpSpec[] = [];
  return { specs, pending: [], enqueueMany: (s) => specs.push(...s) };
}

describe("device dictionary", () => {
  test("persists deltas, removes retractions, and matches exact before contains", async () => {
    const db = bunDriver(":memory:");
    const f = feed(TWO_ROUNDS);
    const source = sqliteDictionarySource({ db, server: "https://ledger.test", token: () => "session", submitter: { submit: async () => {} }, fetch: f.fetch });
    await source.sync();
    expect(source.version()).toBe(1n);
    expect(source.categoryFor("City Market")).toBe("groceries");
    await source.sync();
    expect(source.version()).toBe(2n);
    expect(source.categoryFor("City Market")).toBe("general");
    db.close();
  });

  /**
   * The mutation this closes: pinning the request to `?since=0` left the old
   * suite green, because its fetch stub ignored its arguments and switched on a
   * call counter. The cursor was measured in local state and never on the wire,
   * so a client that re-downloaded the whole dictionary on every launch forever
   * passed.
   */
  test("sends the stored cursor on the wire, not just in local state", async () => {
    const db = bunDriver(":memory:");
    const f = feed(TWO_ROUNDS);
    const source = sqliteDictionarySource({ db, server: "https://ledger.test", token: () => "session", submitter: { submit: async () => {} }, fetch: f.fetch });
    await source.sync();
    await source.sync();
    expect(f.urls).toEqual(["https://ledger.test/api/v1/dictionary?since=0", "https://ledger.test/api/v1/dictionary?since=1"]);

    // And a fresh source over the SAME database resumes from disk rather than
    // from anything this object remembers.
    const g = feed([{ version: "7", entries: [], removed: [] }]);
    const resumed = sqliteDictionarySource({ db, server: "https://ledger.test", token: () => "session", submitter: { submit: async () => {} }, fetch: g.fetch });
    await resumed.sync();
    expect(g.urls).toEqual(["https://ledger.test/api/v1/dictionary?since=2"]);
    db.close();
  });

  test("a failed sync throws with the HTTP status attached, so the 401 policy can see it", async () => {
    const db = bunDriver(":memory:");
    const source = sqliteDictionarySource({ db, server: "https://ledger.test", token: () => "session", submitter: { submit: async () => {} }, fetch: async () => new Response("", { status: 401 }) });
    const err = await source.sync().then(() => null, (e: unknown) => e);
    expect((err as { status?: unknown }).status).toBe(401);
    db.close();
  });

  test("re-categorizes only rows that are still uncategorized", async () => {
    const db = bunDriver(":memory:");
    seedProjection(db);
    const writer = recorder();
    const source = sqliteDictionarySource({ db, server: "https://ledger.test", token: () => "session", submitter: { submit: async () => {} }, writer, fetch: feed(TWO_ROUNDS).fetch });
    await source.sync();

    const report = await source.recategorize();
    expect(report.scanned).toBe(2);
    expect(report.proposed).toBe(2);

    // Two rows, two DIFFERENT entries: `t-new` matches the exact entry and
    // `t-oth` only the contains one. One row could not tell a per-row decision
    // apart from one category applied to everything.
    expect(writer.specs.map((s) => [(s.entity as { id: string }).id, (s.payload as { category: string }).category])).toEqual([
      ["t-new", "groceries"],
      ["t-oth", "general"],
    ]);

    // The user's own decision, the unparsed row and the superseded row are all
    // untouched, and each for its own reason.
    const touched = new Set(writer.specs.map((s) => (s.entity as { id: string }).id));
    expect(touched.has("t-mine")).toBe(false);
    expect(touched.has("t-unp")).toBe(false);
    expect(touched.has("t-sup")).toBe(false);

    // `needs_review` is carried through, never cleared: a crowd-proposed
    // category is not the user confirming the row.
    expect(writer.specs.map((s) => (s.payload as { needs_review: boolean }).needs_review)).toEqual([true, false]);
    // The parent version is the row's own head, read at emit time.
    expect(writer.specs.map((s) => s.parentVersion)).toEqual([3, 5]);
    db.close();
  });

  test("re-categorization does nothing at all without a usable projection", async () => {
    const db = bunDriver(":memory:");
    const writer = recorder();
    const source = sqliteDictionarySource({ db, server: "https://ledger.test", token: () => "session", submitter: { submit: async () => {} }, writer, fetch: feed(TWO_ROUNDS).fetch });
    await source.sync();
    expect(await source.recategorize()).toEqual({ scanned: 0, proposed: 0, chunks: 0 });
    expect(writer.specs).toEqual([]);
    db.close();
  });

  test("hands every submission to the submitter it was built with", async () => {
    const db = bunDriver(":memory:");
    const seen: unknown[] = [];
    const source = sqliteDictionarySource({ db, server: "https://ledger.test", token: () => "session", submitter: { submit: async (e) => { seen.push(e); } }, fetch: feed(TWO_ROUNDS).fetch });
    await source.submit({ pattern: "city market", match: "exact", category: "groceries" });
    expect(seen).toEqual([{ pattern: "city market", match: "exact", category: "groceries" }]);
    db.close();
  });
});
