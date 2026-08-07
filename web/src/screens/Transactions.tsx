import { useMemo, useState } from "react";
import { m } from "motion/react";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Field";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { Pressable } from "../components/ui/Pressable";
import { ProjectionTxnRow } from "../components/transactions/ProjectionTxnRow";
import { ProjectionFilterBar } from "../components/transactions/ProjectionFilterBar";
import { AlertTriangle, ListOrdered, Search, SlidersHorizontal } from "../components/ui/PixelIcon";
import { useFirstReveal } from "../hooks/useFirstReveal";
import { DUR, EASE_OUT } from "../lib/motion";
import { formatMinor } from "../lib/minorMoney";
import { fire } from "../lib/feedback";
import {
  EMPTY_FILTERS,
  filtersActive,
  txnTotals,
  type TxnFilters,
  type TxnFlag,
  type TxnSource,
} from "../v2/sources/transactions";
import { useTxnFacets, useTxnList, useTxnSource } from "../v2/queries";

/**
 * The transaction list, on the local projection.
 *
 * # What this screen lost coming off v1's HTTP API
 *
 * The list, its search, its filters and its totals all read
 * `v2/sources/transactions.ts`, which reads the SQLite projection. Everything
 * that was a WRITE against a v1 endpoint is gone from this screen rather than
 * stubbed — categorize, archive/restore, split, rename-merchant, link-refund,
 * add-transaction, view-source-email and the CSV export all POSTed or GETed
 * routes `ledgerd` does not serve. In v2 each of those is an *op* authored
 * through the outbox, which Task 9 wires up starting with categorize; a swipe
 * action that looked live and silently did nothing would be worse than its
 * absence.
 *
 * The one filter that changed meaning is the segmented control's fourth
 * segment: v1 had "Archived", and there is no archive op, so the segments are
 * All / Review / Confirmed / Couldn't read — the last being the `unparsed`
 * lane, which §2's drop policy guarantees exists and which v1 had nowhere to
 * show.
 *
 * # The window grows from the top, it does not page from the bottom
 *
 * `listTransactions` is keyset-paged, and this screen asks for one page whose
 * limit grows by {@link PAGE} when the user asks for more, capped at
 * {@link MAX_ROWS}. Re-reading N rows from local SQLite is cheap and it keeps
 * the rendered list a pure function of one query key — the alternative, cursor
 * state accumulated across renders, is the shape whose off-by-one lost exactly
 * one row per page in the native port.
 */
const PAGE = 50;
/** The memory bound. The native list's `MAX_RETAINED_TXNS`, for the same reason. */
const MAX_ROWS = 150;

type Segment = "all" | "needs_review" | "confirmed" | "unparsed";
const SEGMENTS = [
  { value: "all" as const, label: "All" },
  { value: "needs_review" as const, label: "Review" },
  { value: "confirmed" as const, label: "Confirmed" },
  { value: "unparsed" as const, label: "Unread" },
];
const SEGMENT_FLAG: Record<Segment, TxnFlag | null> = {
  all: null,
  needs_review: "needs_review",
  confirmed: "confirmed",
  unparsed: "unparsed",
};

export function Transactions({ from, to, source: injected }: {
  from?: string;
  to?: string;
  /** Test seam: a source over a projection this test built. */
  source?: TxnSource;
}) {
  const source = useTxnSource(injected);
  const [segment, setSegment] = useState<Segment>("all");
  const [search, setSearch] = useState("");
  const [chips, setChips] = useState<TxnFilters>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  // One filter value, assembled from the three controls that contribute to it.
  // The screen never builds SQL; `buildTxnQuery` is the only thing that does,
  // and every value in it is a bound parameter.
  const filters: TxnFilters = useMemo(() => {
    const flag = SEGMENT_FLAG[segment];
    return {
      ...chips,
      flags: flag === null ? chips.flags : [...chips.flags.filter((f) => f !== flag), flag],
      query: search,
      from: from ?? "",
      to: to ?? "",
    };
  }, [chips, segment, search, from, to]);

  const list = useTxnList(source, filters, limit);
  const facets = useTxnFacets(source);
  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const totals = useMemo(() => txnTotals(rows), [rows]);
  const firstReveal = useFirstReveal(rows.length > 0);
  const activeChips = filtersActive(chips);

  // No v2 runtime and no injected source. NOT a v1 fallback — see Home.tsx's
  // header for why there is no correct one.
  if (source === null) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Your local ledger isn't open"
        hint="This screen reads the copy of your ledger on this device. Reopen the app to reconnect."
      />
    );
  }

  const more = list.data?.next !== null && rows.length < MAX_ROWS;

  return (
    <div className="space-y-3 pb-8">
      <SegmentedControl
        fullWidth
        value={segment}
        onChange={(v) => { setSegment(v); setLimit(PAGE); }}
        // No count badge here: BottomNav already carries the needs-review
        // number permanently, and inside an equal-width four-segment control
        // the badge squeezed this label down to "Revi…".
        options={SEGMENTS}
      />

      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <Input
            icon={Search}
            type="search"
            enterKeyHint="search"
            autoCorrect="off"
            placeholder="Search merchant…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setLimit(PAGE); }}
          />
        </div>
        <Pressable
          onClick={() => { fire("selection"); setFilterOpen((o) => !o); }}
          aria-expanded={filterOpen}
          aria-label="Filters"
          className={`shrink-0 min-h-11 min-w-11 px-3 inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] border ${
            activeChips > 0 ? "border-accent/30 bg-accent/10 text-fg" : "border-border bg-surface text-muted"
          }`}
        >
          <SlidersHorizontal size={16} aria-hidden />
          {activeChips > 0 && <span className="tnum text-xs font-semibold">{activeChips}</span>}
        </Pressable>
      </div>

      {(activeChips > 0 || filterOpen) && (
        <ProjectionFilterBar
          filters={chips}
          facets={facets.data ?? { categories: [], currencies: [] }}
          open={filterOpen}
          onChange={(f) => { setChips(f); setLimit(PAGE); }}
        />
      )}

      {list.isError ? (
        <EmptyState icon={AlertTriangle} title="Couldn't read your ledger" hint="Reopen the app to try again." />
      ) : list.isPending ? (
        <Skeleton rows={8} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ListOrdered} title="No transactions" hint="Try a different period, filter, or search." />
      ) : (
        <>
          <div className="flex items-center justify-between px-1">
            <p className="text-sm text-muted">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>
            {/* The home-currency total, and only over rows that carry a frozen
                snapshot. §3.7's null rate is a waiting state, not a zero, so
                the rows it left out are named rather than absorbed. */}
            {totals.home.debit > 0n && (
              <p className="text-sm text-muted tnum">
                {formatMinor(totals.home.debit)} spent
                {totals.home.unconverted > 0 ? ` · ${totals.home.unconverted} unconverted` : ""}
              </p>
            )}
          </div>
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {rows.map((t, i) => (
                <m.li
                  key={t.id}
                  // See Home.tsx's recent list for the full reasoning:
                  // `initial={false}` on a refetch is what keeps this one-shot;
                  // the 0.24s ceiling reproduces the retired
                  // `.stagger-item:nth-child(n+7)` cap — which matters far more
                  // here, where the list runs to a hundred rows; and the
                  // entrance is transform-only so that a feature bundle still
                  // in flight cannot leave the entire list invisible.
                  initial={firstReveal ? { y: 8 } : false}
                  animate={{ y: 0 }}
                  transition={{ duration: DUR.sheet, ease: EASE_OUT, delay: Math.min(i * 0.04, 0.24) }}
                >
                  <div className="px-4">
                    <ProjectionTxnRow txn={t} />
                  </div>
                </m.li>
              ))}
            </ul>
          </Card>
          {more && (
            <Pressable
              onClick={() => { fire("selection"); setLimit((n) => Math.min(n + PAGE, MAX_ROWS)); }}
              className="w-full min-h-11 flex items-center justify-center rounded-[var(--radius)] border border-border bg-surface text-sm font-medium"
            >
              Show older
            </Pressable>
          )}
          {!more && list.data?.next !== null && (
            <p className="text-xs text-muted text-center">
              Showing the most recent {MAX_ROWS}. Narrow the period or the search to see further back.
            </p>
          )}
        </>
      )}
    </div>
  );
}
