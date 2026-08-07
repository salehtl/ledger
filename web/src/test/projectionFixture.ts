/**
 * A real projection, built the way production builds one, for screen tests.
 *
 * The rows are folded from ops with `fold` and written with `project` — the two
 * functions the sync engine itself calls — rather than INSERTed by hand. A
 * fixture that performs setup production is supposed to perform is how Phase
 * 1's exit test went green over a production gap.
 *
 * It exists so a screen test can assert against data that could only have come
 * from the projection: if a rewired screen ever reaches for the v1 HTTP API
 * instead, these amounts and merchants simply are not there, and the test fails
 * rather than passing on a plausible-looking fallback.
 */
import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";
import { project } from "@ledger/client/replay/projection";
import { fold, INGEST_WRITER_ID } from "@ledger/client/replay/replay";
import type { LogEntry } from "@ledger/client/replay/replay";
import type { SqlDriver } from "@ledger/client/store/driver";
import type { Op } from "@ledger/client/wire/op";

import { openBrowserDriver } from "../v2/db/driver";

export interface FixtureRow {
  id: string;
  amount: string;
  currency?: string;
  direction?: "debit" | "credit";
  posted_at: string;
  merchant: string;
  category?: string | null;
  needs_review?: boolean;
  /** No tier read this message: amount `0`, currency and direction empty. */
  unparsed?: boolean;
}

/**
 * The default set, hostile in the shape v1's harness proved finds bugs: a
 * confirmed need and a confirmed want, an income credit, a foreign row with no
 * rate (so `amount_home_minor` stays null), a row awaiting review, and a
 * message no tier could read.
 */
export const FIXTURE_ROWS: FixtureRow[] = [
  { id: "t1", amount: "12500", posted_at: "2026-08-01T08:00:00Z", merchant: "CARREFOUR", category: "groceries" },
  { id: "t2", amount: "4999", posted_at: "2026-08-02T09:00:00Z", merchant: "NETFLIX", category: "entertainment" },
  { id: "t3", amount: "900000", direction: "credit", posted_at: "2026-08-03T09:00:00Z", merchant: "SALARY", category: "salary" },
  { id: "t4", amount: "1009", currency: "USD", posted_at: "2026-08-04T10:00:00Z", merchant: "GITHUB", category: "shopping" },
  { id: "t5", amount: "3000", posted_at: "2026-08-05T10:00:00Z", merchant: "SPINNEYS", category: null, needs_review: true },
  { id: "t6", amount: "0", posted_at: "2026-08-06T10:00:00Z", merchant: "", unparsed: true },
];

function hex(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/**
 * Opens a fresh in-memory database and projects `rows` into it.
 *
 * The home currency is AED, so AED rows freeze a home-currency snapshot and the
 * USD row — for which no rate is ever set — deliberately does not.
 */
export async function projectionWith(rows: readonly FixtureRow[] = FIXTURE_ROWS): Promise<SqlDriver> {
  setPlatform(webPlatform);
  let seq = 0n;
  const entry = (op: Op): LogEntry => {
    seq += 1n;
    return { op, seq, writer_id: INGEST_WRITER_ID };
  };
  const log: LogEntry[] = [
    entry({
      v: 1,
      type: "home_currency_set",
      op_id: "op-home",
      authored_at: "2026-07-01T00:00:00.000Z",
      parent_version: null,
      payload: { currency: "AED" },
    }),
    ...rows.map((r, i) =>
      entry({
        v: 1,
        type: "txn_ingested",
        op_id: `op-${r.id}`,
        authored_at: "2026-08-06T00:00:00.000Z",
        entity: { kind: "txn", id: r.id },
        parent_version: null,
        ingest_id: hex(i + 1),
        payload: r.unparsed
          ? {
              amount_minor: "0",
              currency: "",
              direction: "",
              posted_at: r.posted_at,
              merchant_raw: "",
              last4: "",
              category: null,
              needs_review: true,
              unparsed: true,
              tier: "none",
            }
          : {
              amount_minor: r.amount,
              currency: r.currency ?? "AED",
              direction: r.direction ?? "debit",
              posted_at: r.posted_at,
              merchant_raw: r.merchant,
              last4: "1234",
              category: r.category ?? null,
              needs_review: r.needs_review ?? false,
              tier: "template",
            },
      }),
    ),
  ];

  const db = await openBrowserDriver(`fixture-${crypto.randomUUID()}`);
  await project(db, fold(log));
  return db;
}
