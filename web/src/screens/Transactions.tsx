import { useCallback, useMemo, useState } from "react";
import { m } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { newEntityID } from "@ledger/client/net/client";
import type { Txn } from "@ledger/client/replay/state";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Dialog, DialogFooter } from "../components/ui/Dialog";
import { Input } from "../components/ui/Field";
import { Switch } from "../components/ui/Switch";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { Pressable } from "../components/ui/Pressable";
import { useToast } from "../components/Toast";
import { ProjectionTxnRow } from "../components/transactions/ProjectionTxnRow";
import { ProjectionFilterBar } from "../components/transactions/ProjectionFilterBar";
import { AlertTriangle, ListOrdered, Search, SlidersHorizontal } from "../components/ui/PixelIcon";
import { useFirstReveal } from "../hooks/useFirstReveal";
import { DUR, EASE_OUT } from "../lib/motion";
import { formatMinor } from "../lib/minorMoney";
import { fire } from "../lib/feedback";
import { deckCategories } from "../v2/reviewDeck";
import {
  categorizeOps,
  categoryIsUsable,
  ruleTargetOf,
  type ReviewSource,
} from "../v2/sources/review";
import {
  EMPTY_FILTERS,
  filtersActive,
  txnAmountLabel,
  txnTotals,
  type TxnFilters,
  type TxnFlag,
  type TxnSource,
} from "../v2/sources/transactions";
import { useCategoryChoices, useReviewSource, useTxnFacets, useTxnList, useTxnSource, v2Keys } from "../v2/queries";
import { useWriter, type Writer } from "../v2/writer";

/**
 * The transaction list, on the local projection.
 *
 * # What this screen lost coming off v1's HTTP API
 *
 * The list, its search, its filters and its totals all read
 * `v2/sources/transactions.ts`, which reads the SQLite projection. Everything
 * that was a WRITE against a v1 endpoint is gone from this screen rather than
 * stubbed — archive/restore, split, rename-merchant, link-refund,
 * add-transaction, view-source-email and the CSV export all POSTed or GETed
 * routes `ledgerd` does not serve. In v2 each of those is an *op* authored
 * through the outbox, and only the ops that exist are offered; a swipe action
 * that looked live and silently did nothing would be worse than its absence.
 *
 * # Categorising, and why it had to live here too
 *
 * Opening a row opens a category sheet, and that is the one write this screen
 * does have. It is not a convenience: the review deck is fed by the
 * `needs_review` lane, and a template-tier parse is *trusted*, so it is never
 * flagged — the operator's own DIB alert matched `dib.card.v1` with no empty
 * capture groups. A cleanly parsed transaction was therefore visible on this
 * screen and categorisable on none.
 *
 * The ops are authored by `sources/review.ts`'s `categorizeOps`, the same
 * function the deck commits through, so there is one answer to "what does a
 * categorisation record" rather than two that drift.
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

export function Transactions({ from, to, source: injected, reviewSource: injectedReview, writer: injectedWriter }: {
  from?: string;
  to?: string;
  /** Test seam: a source over a projection this test built. */
  source?: TxnSource;
  /** Test seam: the source the category sheet reads its grid, rules and versions from. */
  reviewSource?: ReviewSource;
  /** Test seam: a writer that records what the screen would append. */
  writer?: Writer;
}) {
  const source = useTxnSource(injected);
  const reviewSource = useReviewSource(injectedReview);
  const writer = useWriter(injectedWriter);
  const qc = useQueryClient();
  const toast = useToast();
  const choices = useCategoryChoices(reviewSource);
  const [editing, setEditing] = useState<Txn | null>(null);
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

  /**
   * Records one categorisation.
   *
   * The parent version comes from a FRESH read of the projection plus whatever
   * this device has already queued for the row — never from `txn`, which is the
   * object the list rendered and can be minutes old. An op naming a stale parent
   * is a fork against yourself, and inside one millisecond the later op is the
   * one replay discards. The deck does exactly this, deliberately; so does this.
   */
  const commit = useCallback(
    async (txn: Txn, category: string, makeRule: boolean): Promise<void> => {
      if (reviewSource === null || writer === null) return;
      const head = await reviewSource.version(txn.id);
      writer.enqueueMany(
        categorizeOps({
          txn,
          category,
          makeRule,
          // A row the projection no longer knows about cannot be categorised at
          // a guessed version; its own version is the only defensible fallback.
          projectedVersion: head ?? txn.version,
          pending: writer.pending,
          rules: choices.data?.rules ?? [],
          newID: newEntityID,
        }),
      );
      setEditing(null);
      await qc.invalidateQueries({ queryKey: v2Keys.all });
      // Not awaited: the ops are already durable — `Client.emit` commits before
      // it returns — and a list that stalled on the network would be unusable
      // exactly where this app is used.
      writer.flush().catch(() => {
        toast.show({ message: "Saved on this device — it will sync when you're back online" });
      });
    },
    [reviewSource, writer, choices.data, qc, toast],
  );

  /**
   * The names the sheet offers.
   *
   * `deckCategories` is the deck's own grid builder: this user's categories
   * first, then the default mapping's names for the buckets they have not
   * filled, so a new account's sheet is not empty. Reused rather than rebuilt so
   * the two screens never offer different vocabularies for the same log.
   */
  const categoryNames = useMemo(
    () => deckCategories(choices.data?.categories ?? []).map((c) => c.Name),
    [choices.data],
  );

  // No writer, no local ledger to append to — so the rows do not open a sheet
  // at all. A control that answered and dropped the answer is the failure this
  // screen's header is about.
  const canCategorize = reviewSource !== null && writer !== null;

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
                    <ProjectionTxnRow
                      txn={t}
                      onOpen={canCategorize ? (row) => { fire("selection"); setEditing(row); } : undefined}
                    />
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

      {editing !== null && (
        <CategorySheet
          txn={editing}
          categories={categoryNames}
          onClose={() => setEditing(null)}
          onSave={(category, makeRule) => void commit(editing, category, makeRule)}
        />
      )}
    </div>
  );
}

/**
 * Pick a category for one transaction, and optionally rule on the merchant.
 *
 * Local to this screen rather than shared: `components/transactions/
 * CategorizeSheet.tsx` is v1's, typed on `api/types`' `Txn` whose money is a
 * `number` of fils, and it fetches projects from a v1 route. Mapping the
 * projection's `bigint` into it would be a `Number()` on money, which is the one
 * thing this codebase will not do.
 *
 * The current category is preselected, so re-categorising reads as a change
 * rather than a blank form.
 */
function CategorySheet({ txn, categories, onClose, onSave }: {
  txn: Txn;
  categories: readonly string[];
  onClose: () => void;
  onSave: (category: string, makeRule: boolean) => void;
}) {
  const [picked, setPicked] = useState<string | null>(txn.category);
  const [makeRule, setMakeRule] = useState(true);
  const amount = txnAmountLabel(txn);
  // The row's own category may predate the grid (a rule wrote it, or it came
  // from an import), and a sheet that could not show the current answer would
  // look like it had none.
  const options = useMemo(() => {
    const known = txn.category;
    if (known === null || categories.some((c) => c.toLowerCase() === known.toLowerCase())) return categories;
    return [known, ...categories];
  }, [categories, txn.category]);

  // Offered only when a rule could actually be written: `ruleTargetOf` is null
  // when the merchant string is too short to carry an `exact` pattern, and the
  // switch must not promise something `categorizeOps` would then drop.
  const ruleable = ruleTargetOf(txn.merchant_raw) !== null;
  const usable = picked !== null && categoryIsUsable(picked);

  return (
    <Dialog title="Categorize" onClose={onClose}>
      <p className="mb-3 truncate text-sm text-muted">
        {txn.merchant_raw === "" ? "—" : txn.merchant_raw} · <span className="tnum">{amount.text}</span>
        {txn.currency === "" ? "" : ` ${txn.currency}`}
      </p>

      <div className="flex flex-wrap gap-2">
        {options.map((name) => {
          const selected = picked === name;
          return (
            <Pressable
              key={name}
              aria-pressed={selected}
              onClick={() => setPicked(selected ? null : name)}
              className={`min-h-11 px-3.5 rounded-[var(--radius)] text-sm font-medium inline-flex items-center transition-colors ${
                selected ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg"
              }`}
            >
              {name}
            </Pressable>
          );
        })}
      </div>

      {ruleable && (
        <label className="my-4 flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0">Always use this category for “{txn.merchant_raw}”</span>
          <Switch checked={usable && makeRule} disabled={!usable} onChange={(e) => setMakeRule(e.target.checked)} />
        </label>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {/* Disabled until a category is chosen: clearing one back to
            uncategorised is a `txn_categorized` with a null payload, and this
            screen does not offer it, so the button must not look like it does. */}
        <Button
          variant="primary"
          disabled={!usable}
          onClick={() => { if (picked !== null && usable) onSave(picked, makeRule && ruleable); }}
        >
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
