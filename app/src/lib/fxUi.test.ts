import { expect, test } from "bun:test";
import { formatRateMicro, parseRateDraft, rateAge, recomputeHomeOp } from "./fxUi.ts";
import type { Txn } from "@ledger/client/replay/state.ts";

test("rate drafts refuse empty and excess precision without rounding", () => {
  expect(parseRateDraft("")).toEqual({ ok: false, error: "Enter a rate." });
  expect(parseRateDraft("3.6725001").ok).toBe(false);
  expect(parseRateDraft("3.6725")).toEqual({ ok: true, micro: 3_672_500n });
  expect(formatRateMicro(3_672_500n)).toBe("3.6725");
});

test("rate age becomes stale only after thirty complete days", () => {
  const updated = "2026-06-01T00:00:00.000Z";
  const at30 = Date.parse("2026-07-01T00:00:00.000Z");
  expect(rateAge(updated, at30)).toEqual({ label: "30d ago", days: 30, stale: false });
  expect(rateAge(updated, at30 + 86_400_000).stale).toBe(true);
});

test("recompute emits the explicit frozen home amount, never a live-rate pointer", () => {
  const txn = { id: "t1", version: 4, amount_minor: 101n } as Txn;
  expect(recomputeHomeOp(txn, 1_500_000n)).toEqual({
    type: "txn_edited", entity: { kind: "txn", id: "t1" }, parentVersion: 4,
    payload: { amount_home_minor: "152" },
  });
});
