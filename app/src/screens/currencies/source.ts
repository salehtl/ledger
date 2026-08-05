import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { ensureProjection, projectionIsUsable, readMeta } from "@ledger/client/replay/projection.ts";
import type { SqlDriver } from "@ledger/client/store/driver.ts";
import { parseDecimal } from "@ledger/client/wire/op.ts";
import type { Op } from "@ledger/client/wire/op.ts";
import { readTxn } from "../../lib/transactions.ts";
import { nextParentVersion } from "../../lib/review.ts";
import { rateSetOp, rateUnsetOp, recomputeHomeOp, type RateAge, rateAge } from "../../lib/fxUi.ts";

export interface CurrencyRateRow {
  currency: string;
  rateMicro: bigint | null;
  updatedAt: string;
  age: RateAge;
  pending: number;
}
export interface CurrencyView { usable: boolean; homeCurrency: string | null; rates: CurrencyRateRow[] }
export type FxAction = { ok: true; op: OpSpec } | { ok: false; error: string };
export interface CurrencySource {
  read(nowMs: number): CurrencyView;
  setRate(currency: string, draft: string): FxAction;
  unsetRate(currency: string): FxAction;
  recompute(txnId: string): FxAction;
}

export interface CurrencyWriter { enqueue(op: OpSpec): void; readonly pending: readonly Op[] }

export function sqlCurrencySource(db: SqlDriver, writer: CurrencyWriter): CurrencySource {
  ensureProjection(db);
  const emit = (op: OpSpec): FxAction => { writer.enqueue(op); return { ok: true, op }; };
  return {
    read(nowMs) {
      const meta = readMeta(db);
      if (meta === null || !projectionIsUsable(db)) return { usable: false, homeCurrency: meta?.homeCurrency ?? null, rates: [] };
      const pending = new Map<string, number>();
      for (const raw of db.prepare(
        "SELECT currency, COUNT(*) AS count FROM txn WHERE superseded_by IS NULL AND unparsed = 0 AND amount_home_minor IS NULL GROUP BY currency",
      ).all()) {
        const row = raw as Record<string, unknown>;
        pending.set(String(row["currency"]), Number(row["count"]));
      }
      const rates = db.prepare("SELECT currency, rate_micro, updated_at FROM rate WHERE currency <> ? ORDER BY currency").all(meta.homeCurrency)
        .map((raw): CurrencyRateRow => {
          const row = raw as Record<string, unknown>;
          const currency = String(row["currency"]);
          const updatedAt = String(row["updated_at"]);
          return { currency, rateMicro: row["rate_micro"] === null ? null : parseDecimal(String(row["rate_micro"])), updatedAt, age: rateAge(updatedAt, nowMs), pending: pending.get(currency) ?? 0 };
        });
      for (const [currency, count] of pending) {
        if (currency !== meta.homeCurrency && !rates.some((r) => r.currency === currency)) {
          rates.push({ currency, rateMicro: null, updatedAt: "", age: { label: "never", days: 0, stale: false }, pending: count });
        }
      }
      rates.sort((a, b) => a.currency.localeCompare(b.currency));
      return { usable: true, homeCurrency: meta.homeCurrency, rates };
    },
    setRate(currency, draft) {
      const ccy = currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(ccy)) return { ok: false, error: "Currency must be a 3-letter code." };
      if (ccy === readMeta(db)?.homeCurrency) return { ok: false, error: "The home currency always uses 1.000000." };
      const planned = rateSetOp(ccy, draft);
      return planned.ok ? emit(planned.op) : planned;
    },
    unsetRate(currency) {
      const ccy = currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(ccy)) return { ok: false, error: "Currency must be a 3-letter code." };
      if (ccy === readMeta(db)?.homeCurrency) return { ok: false, error: "The home currency rate cannot be removed." };
      return emit(rateUnsetOp(ccy));
    },
    recompute(txnId) {
      const txn = readTxn(db, txnId);
      if (txn === null || txn.superseded_by !== null || txn.unparsed) return { ok: false, error: "This transaction cannot be recomputed." };
      const home = readMeta(db)?.homeCurrency;
      let rate: bigint | null = txn.currency === home ? 1_000_000n : null;
      if (rate === null) {
        const raw = db.prepare("SELECT rate_micro FROM rate WHERE currency = ?").all(txn.currency)[0] as Record<string, unknown> | undefined;
        if (raw?.["rate_micro"] != null) rate = parseDecimal(String(raw["rate_micro"]));
      }
      if (rate === null) return { ok: false, error: `Add a ${txn.currency} rate first.` };
      return emit(recomputeHomeOp(txn, rate, nextParentVersion(txn.id, txn.version, writer.pending)));
    },
  };
}
