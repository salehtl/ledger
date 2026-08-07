/**
 * The memory that covers the window between a push and the next sync.
 *
 * `Client.push` strips acked ops from `pending` and nothing on that path
 * projects, so for that whole window neither the outbox nor the projection knows
 * what this device just did. These are the properties that make remembering it
 * safe: the memory is read off the ops themselves, it is per-writer, and each
 * answer carries the version that will retire it.
 */

import { describe, expect, it } from "vitest";

import type { OpSpec } from "@ledger/client/outbox/outbox";
import type { Op } from "@ledger/client/wire/op";

import { authoredBy, recordAuthored } from "./authored";
import type { Writer } from "./writer";

function writerDouble(): Writer {
  return { pending: [] as readonly Op[], enqueueMany: () => undefined, flush: async () => undefined };
}

const specs: OpSpec[] = [
  {
    type: "txn_categorized",
    entity: { kind: "txn", id: "t1" },
    parentVersion: 3,
    payload: { category: "Groceries", needs_review: false },
  },
  {
    type: "rule_added",
    entity: { kind: "rule", id: "r1" },
    parentVersion: null,
    payload: { pattern: "carrefour", match: "exact", category: "Groceries", priority: 0 },
  },
];

describe("what this device authored", () => {
  it("records the answer and the rule from the ops that were enqueued", () => {
    const store = authoredBy(writerDouble());
    recordAuthored(store, "t1", specs);

    // `version` is the version the op PRODUCES, which is what expires the
    // answer once the projection reaches it.
    expect(store.answers.get("t1")).toEqual({ category: "Groceries", needs_review: false, version: 4 });
    expect(store.rules).toEqual([
      { pattern: "carrefour", match: "exact", category: "Groceries", priority: 0, version: 0 },
    ]);
  });

  it("keeps only the last answer for a row, and every rule ever queued", () => {
    const store = authoredBy(writerDouble());
    recordAuthored(store, "t1", specs);
    recordAuthored(store, "t1", [
      { type: "txn_categorized", entity: { kind: "txn", id: "t1" }, parentVersion: 4, payload: { category: "Dining", needs_review: false } },
    ]);

    expect(store.answers.get("t1")).toEqual({ category: "Dining", needs_review: false, version: 5 });
    // A correction does not retract the rule: `rule_added` is permanent, so
    // "this merchant already has a rule" only ever becomes MORE true.
    expect(store.rules).toHaveLength(1);
  });

  it("is one store per writer, and the same one every time", () => {
    const writer = writerDouble();
    expect(authoredBy(writer)).toBe(authoredBy(writer));
    // A second signed-in handle gets its own writer and must not inherit the
    // first's answers.
    expect(authoredBy(writerDouble()).answers.size).toBe(0);
  });

  it("ignores an op group it cannot read, rather than remembering a guess", () => {
    const store = authoredBy(writerDouble());
    recordAuthored(store, "t1", [
      { type: "txn_edited", entity: { kind: "txn", id: "t1" }, parentVersion: 1, payload: { merchant_raw: "X" } },
      { type: "rule_added", entity: { kind: "rule", id: "r2" }, parentVersion: null, payload: { pattern: 7 } },
    ]);
    expect(store.answers.size).toBe(0);
    expect(store.rules).toEqual([]);
  });
});
