/**
 * The real gate for Task 3: not the driver in isolation, but `sqliteStore`
 * (`client/src/store/sqlite.ts`) running over it — the surface the local-first
 * engine actually touches. `client/`'s own `store.test.ts` exercises the same
 * contract against `bunDriver` and `memStore`/`fileStore`, but it is a
 * `bun:test` file and cannot run under vitest, so this is the subset of that
 * contract specific to the driver this task adds: a fresh store loads empty, a
 * save survives a reopen by the same name, and an appended row round-trips
 * through the chunked read path (`eachRowChunk`) rather than through any
 * driver-internal shortcut.
 */
import { describe, expect, it } from "vitest";
import { sqliteStore } from "@ledger/client/store/sqlite";
import { eachRowChunk, emptyClientState, memSecretStore, type WireRow } from "@ledger/client/store/store";
import { STREAM_HOT } from "@ledger/client/wire/blob";
import { openBrowserDriver } from "./driver";

function wireRow(seq: bigint): WireRow {
  return {
    seq: seq.toString(10),
    stream: STREAM_HOT,
    writer_id: "dev-a",
    writer_counter: seq.toString(10),
    type_flag: "edit",
    size_bucket: 1024,
    blob_hash: "a1".repeat(32),
    prev_hash: "b2".repeat(32),
    created_at: "2026-08-01T00:00:00.000Z",
    blob: "QUJDRA==",
  };
}

describe("sqliteStore over openBrowserDriver", () => {
  it("load() on a fresh store returns empty client state", async () => {
    const driver = await openBrowserDriver(`conformance-fresh-${crypto.randomUUID()}`);
    const store = sqliteStore(driver, { secrets: memSecretStore(), server: "http://server.test" });
    expect(store.load()).toEqual(emptyClientState("http://server.test"));
    driver.close();
  });

  it("save() then reopening the driver by the same name reloads the mutation", async () => {
    const name = `conformance-mutate-${crypto.randomUUID()}`;
    const secrets = memSecretStore();

    const driver1 = await openBrowserDriver(name);
    const store1 = sqliteStore(driver1, { secrets, server: "http://server.test" });
    const state = store1.load();
    state.server = "http://mutated.test";
    store1.save(state);
    await driver1.flush();
    driver1.close();

    const driver2 = await openBrowserDriver(name);
    const store2 = sqliteStore(driver2, { secrets, server: "http://server.test" });
    expect(store2.load().server).toBe("http://mutated.test");
    driver2.close();
  });

  it("rows(\"hot\").append() round-trips a WireRow through eachRowChunk", async () => {
    const driver = await openBrowserDriver(`conformance-rows-${crypto.randomUUID()}`);
    const store = sqliteStore(driver, { secrets: memSecretStore() });
    const row = wireRow(1n);

    store.rows().append(STREAM_HOT, [row]);

    const seen: WireRow[] = [];
    eachRowChunk(store.rows(), STREAM_HOT, (chunk) => {
      for (const r of chunk) seen.push(r);
    });
    expect(seen).toEqual([row]);

    driver.close();
  });

  // Regression for the round-2 CRITICAL: sql.js's `Database.export()` frees
  // every statement it has ever prepared and reopens a fresh connection.
  // `sqliteStore` prepares its statements ONCE at construction
  // (client/src/store/sqlite.ts's `stmts`) and reuses those exact objects for
  // its whole lifetime — so the driver's 500ms debounced auto-persist, which
  // calls `db.export()` internally, used to invalidate every one of them:
  //
  //   store.save({...s, server: "http://dev-1.test"}); // schedules the debounce
  //   await sleep(700);                                 // export runs, frees every statement
  //   store.save({...s, server: "http://dev-2.test"});  // -> Error: Statement closed
  //
  // This is the exact shape: write, wait past the debounce so the export
  // actually runs, then write AGAIN through the SAME store (so the SAME
  // `SqlStatement` objects `sqliteStore` prepared at construction are reused)
  // and assert the second write succeeds and lands. A test that only reads
  // after the flush (as the earlier "save() then reopen" test above does)
  // does not exercise this — the bug is specifically in writing again through
  // an already-exported store, in the same process, without ever reopening.
  it(
    "a second save() through the same store succeeds after the debounced auto-persist has fired",
    async () => {
      const driver = await openBrowserDriver(`conformance-debounce-${crypto.randomUUID()}`);
      const store = sqliteStore(driver, { secrets: memSecretStore(), server: "http://server.test" });

      const first = store.load();
      first.server = "http://dev-1.test";
      store.save(first); // schedules the 500ms debounce; not awaited, not flushed

      // Past the 500ms debounce, so the auto-persist (db.export() + IDB/memory
      // write) has actually run by the time we write again.
      await new Promise((resolve) => setTimeout(resolve, 700));

      const second = store.load();
      second.server = "http://dev-2.test";
      // Before the fix: throws sql.js's own "Statement closed", because the
      // debounced export freed `stmts.writeState`/`stmts.readState` out from
      // under `sqliteStore` and nothing re-prepared them.
      expect(() => store.save(second)).not.toThrow();

      expect(store.load().server).toBe("http://dev-2.test");

      driver.close();
    },
    2000,
  );
});
