/**
 * The browser `SqlDriver`: sql.js (SQLite compiled to WASM) fronted by
 * IndexedDB persistence.
 *
 * `openBrowserDriver` is async only to initialise sql.js (fetching/reading the
 * WASM) and to load any prior bytes; the driver it hands back is fully
 * synchronous, which is what `sqliteStore` (`client/src/store/sqlite.ts`)
 * requires — see driver.ts's own comment for why.
 *
 * jsdom (this suite's environment) does not implement `indexedDB`, so every
 * test here exercises the in-memory fallback. That is not a gap: the brief
 * this driver was built against calls that fallback "production code, not
 * test scaffolding" — it is also what a browser falls back to in private
 * browsing, where `indexedDB` throws or is absent.
 */
import { describe, expect, it } from "vitest";
import { openBrowserDriver } from "./driver";

describe("openBrowserDriver", () => {
  it("round-trips a string, a bigint-as-TEXT, and a Uint8Array blob through prepared run/all", async () => {
    const driver = await openBrowserDriver(`driver-roundtrip-${crypto.randomUUID()}`);
    driver.exec(`
      CREATE TABLE t (
        id   TEXT PRIMARY KEY,
        big  TEXT NOT NULL,
        blob BLOB NOT NULL
      )
    `);
    const insert = driver.prepare("INSERT INTO t (id, big, blob) VALUES (?, ?, ?)");
    const bigSeq = 9223372036854775807n; // > 2^53; would corrupt as an sql.js INTEGER
    const blob = new Uint8Array([1, 2, 3, 250, 255]);
    insert.run("row-1", bigSeq.toString(10), blob);

    const select = driver.prepare("SELECT id, big, blob FROM t WHERE id = ?");
    const rows = select.all("row-1") as { id: string; big: string; blob: Uint8Array }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("row-1");
    expect(rows[0]?.big).toBe(bigSeq.toString(10));
    expect(BigInt(rows[0]?.big ?? "0")).toBe(bigSeq);
    expect(Array.from(rows[0]?.blob ?? [])).toEqual(Array.from(blob));

    driver.close();
  });

  it("rolls back a transaction on throw", async () => {
    const driver = await openBrowserDriver(`driver-rollback-${crypto.randomUUID()}`);
    driver.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    const insert = driver.prepare("INSERT INTO t (id) VALUES (?)");
    const count = driver.prepare("SELECT count(*) AS n FROM t");

    expect(() =>
      driver.transaction(() => {
        insert.run("a");
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect((count.all()[0] as { n: number }).n).toBe(0);

    driver.transaction(() => {
      insert.run("b");
    });
    expect((count.all()[0] as { n: number }).n).toBe(1);

    driver.close();
  });

  it("persists on flush() and reloads on reopen by the same name", async () => {
    const name = `driver-persist-${crypto.randomUUID()}`;
    const first = await openBrowserDriver(name);
    first.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    first.prepare("INSERT INTO t (id) VALUES (?)").run("only-row");
    await first.flush();
    first.close();

    const second = await openBrowserDriver(name);
    const rows = second.prepare("SELECT id FROM t").all() as { id: string }[];
    expect(rows).toEqual([{ id: "only-row" }]);
    second.close();
  });

  it("uses a fresh, empty database for a name never opened before", async () => {
    const driver = await openBrowserDriver(`driver-fresh-${crypto.randomUUID()}`);
    driver.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    const rows = driver.prepare("SELECT id FROM t").all();
    expect(rows).toEqual([]);
    driver.close();
  });
});
