/**
 * The banks a user has declared, over the local projection.
 *
 * # Why this reads the projection and not the folded `State`
 *
 * Every screen in this app reads the SQLite projection; the folded `State` only
 * exists inside the sync engine's process. `boot.ts` is the one exception — it
 * asks the client for the state directly, because it runs before any screen —
 * and that difference is exactly why `banks` had to reach the projection at all
 * (`client/src/replay/projection.ts`, `PROJECTION_VERSION` 6): until it did,
 * Settings could not see a bank the user had declared.
 *
 * # Retiring, not deleting
 *
 * There is no delete op. `active: false` is a declaration that says "stop
 * counting me as banking here", and the row stays, so a bank removed and later
 * re-added is one keyed record rather than two half-histories.
 *
 * # What removing a bank does NOT do, stated here because the UI must say it
 *
 * It does not stop mail arriving, it does not untrust a sender, and it does not
 * delete a transaction. The sender allowlist is a separate, server-side table
 * (`sender_allowlist`), written by the quarantine trust decision and read by
 * `internal/v2/origin/` — which is forbidden from consulting declared banks at
 * all. This list routes the waitlist and drives the UI, and nothing else.
 *
 * # Framework-free
 *
 * Over a `SqlDriver`, like every other source here.
 */

import { readBanks, projectionIsUsable } from "@ledger/client/replay/projection";
import type { SqlDriver } from "@ledger/client/store/driver";

import { normalizeBankName } from "../bank";

/** One declaration, as the log holds it. */
export interface DeclaredBank {
  bank: string;
  active: boolean;
}

/** What one authored change to a declaration looks like on the wire. */
export interface BankOpSpec {
  type: string;
  payload: unknown;
}

/** Every declaration the log holds, in fold order, RETIRED ONES INCLUDED. */
export function readDeclaredBanks(db: SqlDriver): DeclaredBank[] {
  return [...readBanks(db)].map(([bank, active]) => ({ bank, active }));
}

/** Only the ones the user still banks with — what the milestone and the UI ask for. */
export function activeBanks(declared: readonly DeclaredBank[]): string[] {
  return declared.filter((d) => d.active).map((d) => d.bank);
}

/**
 * The op one declaration authors — the whole record, never a patch.
 *
 * The name is folded with {@link normalizeBankName}, the same grammar the
 * server's waitlist enforces, for one reason: `bank_declared` is keyed on the
 * bank string, so "Dubai Islamic" and "dubai  islamic" would be two rows for one
 * bank and neither would retire the other. A name the grammar cannot store
 * THROWS rather than being written, because an op is permanent and a caller that
 * has not already validated its input is a caller with a bug — every UI path
 * here checks first and shows the rule.
 */
export function bankDeclaredOps(bank: string, active: boolean): BankOpSpec[] {
  const name = normalizeBankName(bank);
  if (!name.ok) throw new Error(name.reason);
  return [{ type: "bank_declared", payload: { bank: name.bank, active } }];
}

export interface BanksSource {
  read(): DeclaredBank[];
}

/**
 * `usable` is checked for the same reason the budget source checks it: a
 * projection written by an older build, or left half-written, must not be read
 * as fact. Empty is the safe answer — it renders as "you have not declared a
 * bank", which the next sync corrects, rather than as a list missing rows.
 */
export function sqlBanksSource(db: SqlDriver): BanksSource {
  return {
    read: () => (projectionIsUsable(db) ? readDeclaredBanks(db) : []),
  };
}
