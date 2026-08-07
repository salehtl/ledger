import { useState } from "react";
import type { Txn } from "@ledger/client/replay/state";
import { Pill } from "../ui/Pill";
import { Pressable } from "../ui/Pressable";
import { ChevronDown, ChevronRight } from "../ui/PixelIcon";
import { bucketColor } from "../../lib/insights";
import { formatMinor } from "../../lib/minorMoney";
import { DEFAULT_BUDGET_MAPPING } from "../../v2/sources/budget";
import { txnAmountLabel, txnCategoryLabel, txnMarkers } from "../../v2/sources/transactions";

/**
 * One calm transaction line, read from the local projection.
 *
 * # Why this is a second component and not a widened `TransactionRow`
 *
 * `TransactionRow` is typed on v1's `api/types` `Txn`, where every amount is a
 * `number` of fils. The projection's `Txn` (`client/src/replay/state.ts`)
 * carries `bigint` minor units *because* a `number` cannot hold an `int64`, so
 * mapping one into the other means a `Number()` on money — the single thing
 * this codebase will not do. The markup, the classes, the 44px target and the
 * wrap-don't-clip meta line are copied verbatim: same row, different type.
 *
 * The v1 row stays where it is until Task 10 unroutes the screens that use it.
 *
 * What is deliberately absent versus v1: the project chip (no project op) and
 * the status pill's "archived" state (no archive op). The markers that DO have
 * data behind them — provenance, needs-review, possible-duplicate, superseded,
 * split — come from `txnMarkers`, which is spec §3.3(b)'s requirement that a
 * server-ingested row be distinguishable from a user-authored one.
 */
export function ProjectionTxnRow({ txn, onOpen }: { txn: Txn; onOpen?: (t: Txn) => void }) {
  const [expanded, setExpanded] = useState(false);
  const amount = txnAmountLabel(txn);
  const split = txn.splits.length > 0;
  const merchant = txn.merchant_raw;
  const meta = [txnCategoryLabel(txn), txn.posted_at.slice(0, 10)].join(" · ");
  // The stripe colour comes from the SAME category→bucket mapping the 50/30/20
  // read uses, so a row's hue and Home's buckets cannot disagree.
  const bucket = txn.category === null ? undefined : DEFAULT_BUDGET_MAPPING.categories[txn.category.toLowerCase()];
  // Only the markers a row can act on belong in the line; provenance is on the
  // detail, not here, or every single row carries the same pill.
  const pills = txnMarkers(txn).filter((mk) => mk.kind === "needs_review" || mk.kind === "unparsed" || mk.kind === "possible_duplicate");

  return (
    <div>
      <Pressable
        onClick={() => onOpen?.(txn)}
        aria-label={`Open ${merchant || "transaction"}`}
        className="w-full text-left flex items-center gap-3 py-3"
      >
        <span
          aria-hidden
          className="w-1 self-stretch rounded-[var(--radius)] shrink-0"
          style={{ background: bucket ? bucketColor(bucket) : "var(--color-border)" }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <p className="line-clamp-2 break-words text-sm font-medium leading-5 tracking-[-0.01em]" title={merchant || undefined}>
              {merchant || "—"}
            </p>
            {/* With no home-currency rate there is no converted figure to show.
                Printing the native amount in the home column understated a GBP
                charge by a factor of five in v1; the native tag and the "no
                rate" pill below carry the truth instead. */}
            <span
              className={`tnum font-medium leading-5 shrink-0 ${amount.unreadable ? "text-muted" : ""}`}
              style={amount.flow === "in" ? { color: "var(--color-good)" } : undefined}
              title={amount.flow === "in" ? "Money in" : amount.flow === "out" ? "Money out" : "Nothing could be read"}
            >
              {amount.text}
            </span>
          </div>
          {/* Wraps rather than clips: at 320px the pills squeezed this line
              until the date fell off the end, which is the one thing on it the
              user cannot reconstruct from anywhere else. */}
          <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="font-mono text-[10px] tracking-[0.04em] text-muted truncate min-w-0">{meta}</p>
            <div className="flex items-center gap-1.5 shrink-0">
              {txn.currency !== "" && <span className="tnum text-xs text-muted">{txn.currency}</span>}
              {!txn.unparsed && txn.amount_home_minor === null && <Pill>no home rate</Pill>}
              {pills.map((mk) => (
                <Pill key={mk.kind} tone={mk.kind === "needs_review" ? "attention" : "muted"}>
                  {mk.label}
                </Pill>
              ))}
            </div>
          </div>
        </div>
      </Pressable>

      {split && (
        <div className="pl-4 pb-2">
          <Pressable
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
            className="min-h-11 -ml-1.5 px-1.5 inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.04em] text-muted rounded-[var(--radius)]"
          >
            {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            {expanded ? "Hide parts" : `Show ${txn.splits.length} part${txn.splits.length === 1 ? "" : "s"}`}
          </Pressable>
          {expanded && (
            <ul className="mt-1 space-y-1">
              {txn.splits.map((s, i) => (
                <li key={`${s.category}-${i}`} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate">{s.category}</span>
                  <span className="tnum text-muted">{formatMinor(s.amount_minor)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
