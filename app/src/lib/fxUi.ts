import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { convert } from "@ledger/client/replay/fx.ts";
import type { Txn } from "@ledger/client/replay/state.ts";
import { parseInstantMs } from "@ledger/client/wire/op.ts";

const MAX_I64 = 9_223_372_036_854_775_807n;
const RATE = /^(?:0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

export type RateDraftResult =
  | { ok: true; micro: bigint }
  | { ok: false; error: string };

/** Parses home units per one foreign unit without ever passing through Number. */
export function parseRateDraft(draft: string): RateDraftResult {
  const value = draft.trim();
  if (value === "") return { ok: false, error: "Enter a rate." };
  const match = RATE.exec(value);
  if (match === null) {
    return { ok: false, error: "Use a positive decimal with no more than 6 decimal places." };
  }
  const [whole = "", fraction = ""] = value.split(".");
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micro <= 0n) return { ok: false, error: "Rate must be greater than zero." };
  if (micro > MAX_I64) return { ok: false, error: "Rate is too large." };
  return { ok: true, micro };
}

export function formatRateMicro(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString(10).padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString(10) : `${whole}.${fraction}`;
}

export interface RateAge { label: string; days: number; stale: boolean }

export function rateAge(updatedAt: string, nowMs: number): RateAge {
  const elapsed = Math.max(0, nowMs - parseInstantMs(updatedAt));
  const days = Math.floor(elapsed / 86_400_000);
  return { label: days === 0 ? "today" : `${days}d ago`, days, stale: days > 30 };
}

export function rateSetOp(currency: string, draft: string): { ok: false; error: string } | { ok: true; micro: bigint; op: OpSpec } {
  const parsed = parseRateDraft(draft);
  if (!parsed.ok) return parsed;
  return { ...parsed, op: { type: "rate_set", payload: { currency, rate_micro: parsed.micro.toString(10) } } };
}

export function rateUnsetOp(currency: string): OpSpec {
  return { type: "rate_unset", payload: { currency } };
}

export function recomputeHomeOp(txn: Txn, rateMicro: bigint, parentVersion = txn.version): OpSpec {
  return {
    type: "txn_edited",
    entity: { kind: "txn", id: txn.id },
    parentVersion,
    payload: { amount_home_minor: convert(txn.amount_minor, rateMicro).toString(10) },
  };
}
