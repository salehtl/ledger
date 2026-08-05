import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunDriver, type SqlDriver } from "../store/driver";
import { fold, type LogEntry } from "./replay";
import { serializeState } from "./state";
import type { Op } from "../wire/op";
import {
  AUDIT_BUDGET_MS,
  AUDIT_EVERY_LAUNCHES,
  AUDIT_MAX_AGE_MS,
  auditBlocked,
  auditDue,
  auditOverdue,
  noteLaunch,
  readAuditState,
  runAudit,
  type AuditOptions,
  type DeviceConditions,
} from "./audit";
import { loadSnapshot, readEvents, saveSnapshot, serializeAppliedAtCursor, type LogBinding } from "./snapshot";

const open: SqlDriver[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function db(): SqlDriver {
  const d = bunDriver(join(mkdtempSync(join(tmpdir(), "ledger-audit-")), "test.db"));
  open.push(d);
  return d;
}

const op: Op = {
  v: 1, type: "home_currency_set", op_id: "op-1", authored_at: "2026-01-01T00:00:00Z",
  parent_version: null, payload: { currency: "AED" },
};
const log: LogEntry[] = [{ seq: 1n, writer_id: "dev-a", op }];
const binding: LogBinding = { tipAt: (seq) => seq === 1n ? "tip-1" : null, rows: () => 1 };
const eligible: DeviceConditions = { mainsPower: true, foreground: true, thermal: "nominal", busy: false };

function seeded(): { db: SqlDriver; state: ReturnType<typeof fold> } {
  const d = db();
  const state = fold(log);
  saveSnapshot(d, state, state.cursors, binding);
  return { db: d, state };
}

function options(state: ReturnType<typeof fold>, over: Partial<AuditOptions> = {}): AuditOptions {
  return {
    refold: async (_upTo, between) => {
      await between({ chunk: 1, rows: 1, total: 1, elapsedMs: 0 });
      return state;
    },
    conditions: () => eligible,
    binding,
    yield: async () => {},
    ...over,
  };
}

describe("periodic integrity audit", () => {
  test("eligibility rejects each unsafe condition independently", () => {
    expect(auditBlocked({ ...eligible, mainsPower: false })).toBe("on_battery");
    expect(auditBlocked({ ...eligible, foreground: false })).toBe("backgrounded");
    expect(auditBlocked({ ...eligible, thermal: "fair" })).toBe("thermal");
    expect(auditBlocked({ ...eligible, busy: true })).toBe("busy");
    expect(auditBlocked(eligible)).toBeNull();
  });

  test("launch and age triggers are persisted and reset by a successful audit", async () => {
    const { db: d, state } = seeded();
    for (let i = 0; i < AUDIT_EVERY_LAUNCHES; i++) noteLaunch(d);
    expect(auditDue(d, 1n, 100)).toBe("never_audited");
    const result = await runAudit(d, options(state, { now: () => 100 }));
    expect(result.outcome).toBe("ok");
    expect(readAuditState(d).launches).toBe(0);
    expect(auditDue(d, 1n, 100 + AUDIT_MAX_AGE_MS)).toBe("too_old");
    expect(auditDue(d, 2_001n, 100)).toBe("log_grew");
  });

  test("blocked audit does no refold and becomes visibly overdue", async () => {
    const { db: d, state } = seeded();
    let called = false;
    const result = await runAudit(d, options(state, {
      refold: async () => { called = true; return state; },
      conditions: () => ({ ...eligible, mainsPower: false }),
      now: () => 1_000,
    }));
    expect(result).toMatchObject({ outcome: "skipped", reason: "on_battery", chunks: 0 });
    expect(called).toBeFalse();
    expect(auditOverdue(d, 1_000 + 21 * 24 * 60 * 60 * 1000)).toBeTrue();
  });

  test("conditions are re-polled and cancellation abandons at a chunk boundary", async () => {
    const { db: d, state } = seeded();
    let checks = 0;
    const result = await runAudit(d, options(state, {
      conditions: () => (++checks === 1 ? eligible : { ...eligible, foreground: false }),
    }));
    expect(result).toMatchObject({ outcome: "abandoned", reason: "backgrounded", chunks: 1 });
    expect(loadSnapshot(d, binding)).not.toBeNull();
  });

  test("explicit user cancellation abandons at a chunk boundary", async () => {
    const { db: d, state } = seeded();
    const result = await runAudit(d, options(state, { cancelled: () => true }));
    expect(result).toMatchObject({ outcome: "abandoned", reason: "cancelled", chunks: 1 });
  });

  test("the default event-loop yield is awaited", async () => {
    const { db: d, state } = seeded();
    let resumed = false;
    let timerFired = false;
    const marker = setTimeout(() => { timerFired = true; }, 0);
    const opts = options(state, {
      refold: async (_upTo, between) => {
        await between({ chunk: 1, rows: 1, total: 1, elapsedMs: 0 });
        expect(timerFired).toBeTrue();
        resumed = true;
        return state;
      },
    });
    delete opts.yield;
    const result = await runAudit(d, opts);
    clearTimeout(marker);
    expect(result.outcome).toBe("ok");
    expect(resumed).toBeTrue();
  });

  test("budget uses an injected clock, not a flaky wall-clock assertion", async () => {
    const { db: d, state } = seeded();
    let now = 0;
    const result = await runAudit(d, options(state, {
      now: () => { now += AUDIT_BUDGET_MS + 1; return now; },
    }));
    expect(result).toMatchObject({ outcome: "abandoned", reason: "budget" });
  });

  test("a refold failure stays thrown and is durably visible as uncertified", async () => {
    const { db: d, state } = seeded();
    const failure = new Error("row decoder failed");
    await expect(runAudit(d, options(state, { refold: async () => { throw failure; } }))).rejects.toBe(failure);
    expect(readAuditState(d)).toMatchObject({ lastOutcome: "failed", lastDetail: "Error: row decoder failed" });
    expect(readEvents(d)[0]).toMatchObject({ kind: "audit_failed", detail: "Error: row decoder failed" });
  });

  test("a mismatch is a hard recorded finding and installs the re-folded truth", async () => {
    const { db: d } = seeded();
    const truth = fold(log);
    truth.homeCurrency = "USD";
    const result = await runAudit(d, options(truth));
    expect(result).toMatchObject({ outcome: "mismatch", reason: "digest_differs", state: truth });
    expect(readEvents(d).some((e) => e.kind === "audit_mismatch")).toBeTrue();
    const repaired = loadSnapshot(d, binding);
    expect(repaired).not.toBeNull();
    expect(serializeState(repaired!.state)).toBe(serializeState(truth));
    expect(readAuditState(d).lastOutcome).toBe("mismatch");
  });

  test("a short refold is a mismatch, never an ok comparison", async () => {
    const { db: d } = seeded();
    const short = fold([]);
    const result = await runAudit(d, options(short));
    expect(result).toMatchObject({ outcome: "mismatch", reason: "short_refold", state: short });
  });

  test("replacement-save refusal preserves mismatch and leaves no stale snapshot", async () => {
    const { db: d } = seeded();
    const truth = fold(log);
    truth.homeCurrency = "USD";
    const refusing: LogBinding = { tipAt: () => null, rows: () => 0 };
    const result = await runAudit(d, options(truth, { binding: refusing }));
    expect(result.outcome).toBe("mismatch");
    expect(loadSnapshot(d, binding)).toBeNull();
    expect(readAuditState(d).lastOutcome).toBe("mismatch");
  });

  test("audit compares the same-seq applied-op delivery set", async () => {
    const d = db();
    const second: Op = { ...op, type: "rate_set", op_id: "op-2", payload: { currency: "USD", rate_micro: "3672500" } };
    const sameSeq: LogEntry[] = [log[0]!, { seq: 1n, writer_id: "dev-a", op: second }];
    const truth = fold(sameSeq);
    saveSnapshot(d, truth, truth.cursors, binding);
    const wrong = serializeAppliedAtCursor(new Set(["op-1"]));
    const stateJSON = serializeState(truth);
    const { platform } = await import("../platform");
    const p = platform();
    const digest = p.toHex(p.sha256(new TextEncoder().encode(`${stateJSON}\u0000${wrong}`)));
    d.prepare("UPDATE fold_snapshot SET applied_json = ?, digest = ? WHERE id = 1").run(wrong, digest);
    expect(loadSnapshot(d, binding)?.state.appliedAtCursor).toEqual(new Set(["op-1"]));
    const result = await runAudit(d, options(truth));
    expect(result).toMatchObject({ outcome: "mismatch", reason: "digest_differs" });
    expect(loadSnapshot(d, binding)?.state.appliedAtCursor).toEqual(new Set(["op-1", "op-2"]));
  });

  test("audit treats a corrupt container digest as mismatch", async () => {
    const { db: d, state } = seeded();
    d.prepare("UPDATE fold_snapshot SET digest = ? WHERE id = 1").run("00".repeat(32));
    const result = await runAudit(d, options(state));
    expect(result).toMatchObject({ outcome: "mismatch", reason: "snapshot_corrupt" });
    expect(loadSnapshot(d, binding)).not.toBeNull();
  });
});
