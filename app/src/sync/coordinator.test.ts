import { expect, test } from "bun:test";

import type { SyncProgress, SyncResult } from "@ledger/client/net/engine.ts";
import { SyncCoordinator } from "./coordinator.ts";

const idle: SyncProgress = { phase: "idle", rowsPulled: 0, rowsTotal: null, opsApplied: 0, chunk: 0 };

test("all trigger kinds join the engine's in-flight promise", () => {
  let calls = 0;
  let resolve!: (result: SyncResult) => void;
  const pending = new Promise<SyncResult>((done) => { resolve = done; });
  const engine = {
    progress: idle,
    sync: () => { if (calls === 0) calls++; return pending; },
    subscribe: () => () => {},
    halt: () => {},
  };
  const coordinator = new SyncCoordinator(engine);
  const runs = (["launch", "foreground", "refresh", "notification", "retry"] as const).map((t) => coordinator.run(t));
  expect(runs.every((run) => run === pending)).toBe(true);
  expect(calls).toBe(1);
  resolve({ pulled: 0, applied: 0, violations: [], halted: false });
});

test("forwards each trigger's sync options unchanged", async () => {
  const seen: unknown[] = [];
  const result: SyncResult = { pulled: 0, applied: 0, violations: [], halted: false };
  const engine = {
    progress: idle,
    sync: async (options?: unknown) => { seen.push(options); return result; },
    subscribe: () => () => {},
    halt: () => {},
  };
  const coordinator = new SyncCoordinator(engine);
  const options = { stream: "cold" as const, push: false };
  await coordinator.run("refresh", options);
  expect(seen).toEqual([options]);
  expect(seen[0]).toBe(options);
});
