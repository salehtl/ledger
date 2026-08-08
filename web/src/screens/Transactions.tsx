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
import { emptyDraft, ManualTxnSheet } from "../components/transactions/ManualTxnSheet";
import { Fab } from "../components/ui/Fab";
import { AlertTriangle, ListOrdered, Plus, Search, SlidersHorizontal } from "../components/ui/PixelIcon";
import { useFirstReveal } from "../hooks/useFirstReveal";
import { DUR, EASE_OUT } from "../lib/motion";
import { formatMinor } from "../lib/minorMoney";
import { fire } from "../lib/feedback";
import { authoredBy, recordAuthored } from "../v2/authored";
import { deckCategories } from "../v2/reviewDeck";
import {
  categorizeOps,
  categoryIsUsable,
  existingRuleCategory,
  pendingCategories,
  pendingRules,
  ruleTargetOf,
  withPendingCategory,
  type ReviewSource,
} from "../v2/sources/review";
import {
  draftOf,
  EMPTY_FILTERS,
  filtersActive,
  manualEditOps,
  manualTxnOps,
  matchesFilters,
  newIngestID,
  txnAmountLabel,
  txnTotals,
  type ManualDraft,
  type TxnFilters,
  type TxnFlag,
  type TxnSource,
} from "../v2/sources/transactions";
import { useCategoryChoices, useHomeCurrency, useReviewSource, useTxnFacets, useTxnList, useTxnSource, v2Keys } from "../v2/queries";
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
 * # Adding one by hand
 *
 * The Fab authors a client-side `txn_ingested` — the same op the mail pipeline
 * writes, deliberately, because nothing in that payload is ingest-only and a new
 * op type would cost `SCHEMA_VERSION` 4, which hard-stops a v3 device's entire
 * sync. `v2/sources/transactions.ts` holds the reasoning and the payload.
 *
 * The row cannot claim to be a bank row: `provenance` is derived in `replay.ts`
 * from `writer_id === INGEST_WRITER_ID`, never from a payload, and the server
 * refuses the ingest writer id on the client upload path. It therefore carries
 * "Added by you", which is the positive half of a signal that used to be an
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
  /** The manual sheet: a new row, an existing one being corrected, or closed. */
  const [manual, setManual] = useState<{ mode: "add" | "edit"; txn: Txn | null } | null>(null);
  const [manualError, setManualError] = useState("");
  // Bumped when this screen authors something, because the store it authors
  // into is mutated in place and React cannot see that on its own.
  const [authoredTick, setAuthoredTick] = useState(0);
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

  /**
   * The page, showing the answers this device has already given.
   *
   * The projection does not move until a sync folds, so a row categorised
   * moments ago still reads `Uncategorized` in SQLite. The deck hides that by
   * taking the card off the pile; a list cannot.
   *
   * TWO sources, because neither covers the whole life of an answer:
   *
   *  - `writer.pending` is durable and survives the tab being killed, but only
   *    until the push. `Client.push` strips the acked ops and nothing on that
   *    path projects, so `pending` empties while the projection is still stale.
   *  - {@link authoredBy} remembers what this screen authored for as long as the
   *    writer lives, which covers exactly that window, and each answer expires
   *    the moment the projected row reaches the version its op produces.
   *
   * The pending half is layered second so that after a reload — where the store
   * is gone and the outbox is not — the durable record is the one that speaks.
   *
   * `writer.pending` and not `writer`: `Client.emitMany` REPLACES the array
   * while the outbox object is memoised for the tab's lifetime, so a memo keyed
   * on the writer would never recompute. `authoredTick` is the same problem for
   * the store, which is mutated in place: it is a dependency with no other job.
   */
  const authored = useMemo(() => (writer === null ? null : authoredBy(writer)), [writer]);
  const answered = useMemo(
    () => new Map([...(authored?.answers ?? []), ...pendingCategories(writer?.pending ?? [])]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- authoredTick is the store's change signal
    [authored, authoredTick, writer?.pending],
  );
  /**
   * The page, plus the rows this device created that the projection has not
   * folded yet.
   *
   * A manual entry is durable the moment `enqueueMany` returns, and invisible
   * until the next sync projects — the window `authored.ts` documents. For a
   * categorisation that window is a wrong label for a few seconds; for a create
   * it is the row simply not being there, which reads as the app having dropped
   * what was just typed. A user's answer to that is to type it again, and
   * because the ingest id is random rather than a content hash, the second entry
   * is a second real transaction.
   *
   * Filtered through {@link matchesFilters} rather than pinned to the top, so a
   * new row obeys the same period, segment, chips and search as every other row
   * — an optimistic row that ignored the filters would be the list lying about
   * what it is showing. Dropped as soon as the projection can produce the row
   * itself, by id.
   */
  const rows = useMemo(() => {
    const page = (list.data?.rows ?? []).map((t) => withPendingCategory(t, answered));
    const held = authored?.created;
    if (held === undefined || held.size === 0) return page;
    const known = new Set(page.map((t) => t.id));
    const extra = [...held.values()]
      .map((t) => withPendingCategory(t, answered))
      .filter((t) => !known.has(t.id) && matchesFilters(t, filters));
    if (extra.length === 0) return page;
    // The list's own order, newest first, with `id` as the tiebreak `posted_at`
    // is not unique enough to be.
    return [...page, ...extra].sort((a, b) =>
      a.posted_at === b.posted_at ? (a.id < b.id ? 1 : -1) : a.posted_at < b.posted_at ? 1 : -1,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- authoredTick is the store's change signal
  }, [list.data, answered, authored, authoredTick, filters]);
  /**
   * Every rule this device knows about.
   *
   * Three places, because a rule passes through three states before the
   * projection has it: queued in the outbox, pushed but not yet folded back
   * (only {@link authoredBy} remembers those), and folded. A rule missing from
   * this list is a rule the sheet would offer to write a second time, and a
   * second `exact` rule on one pattern is permanent and decided by the
   * alphabet.
   */
  const knownRules = useMemo(
    () => [...(choices.data?.rules ?? []), ...(authored?.rules ?? []), ...pendingRules(writer?.pending ?? [])],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- authoredTick is the store's change signal
    [choices.data, authored, authoredTick, writer?.pending],
  );
  const totals = useMemo(() => txnTotals(rows), [rows]);
  const homeCurrency = useHomeCurrency(source);
  /**
   * What the manual sheet's currency picker offers: the home currency first,
   * then every currency already on the account. An account with one currency
   * gets a one-item picker rather than a list of every ISO code, which is the
   * whole point of drawing this from facets instead of a table.
   */
  const currencyChoices = useMemo(
    () => [...new Set([homeCurrency ?? "", ...(facets.data?.currencies ?? [])].filter((c) => c !== ""))],
    [homeCurrency, facets.data],
  );
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
      if (reviewSource === null || writer === null || authored === null) return;
      const head = await reviewSource.version(txn.id);
      const specs = categorizeOps({
        txn,
        category,
        makeRule,
        // A row the projection no longer knows about cannot be categorised at
        // a guessed version; its own version is the only defensible fallback.
        projectedVersion: head ?? txn.version,
        pending: writer.pending,
        // Every rule this device knows about, from all three places one can
        // be: folded into the projection, queued in the outbox, or already
        // pushed but not yet folded back. `confirmOps` dedupes the write-back
        // against what it is given, and a rule missing from that list is a
        // second rule for the merchant — which is permanent.
        rules: knownRules,
        newID: newEntityID,
      });
      writer.enqueueMany(specs);
      // Recorded from the ops themselves, so the screen cannot claim something
      // the log will not say. This is what survives the push emptying `pending`.
      recordAuthored(authored, txn.id, specs);
      setAuthoredTick((n) => n + 1);
      setEditing(null);
      await qc.invalidateQueries({ queryKey: v2Keys.all });
      // Not awaited: the ops are already durable — `Client.emit` commits before
      // it returns — and a list that stalled on the network would be unusable
      // exactly where this app is used.
      writer.flush().catch(() => {
        toast.show({ message: "Saved on this device — it will sync when you're back online" });
      });
    },
    [reviewSource, writer, authored, knownRules, qc, toast],
  );

  /**
   * Records a hand-typed transaction, or a correction to one.
   *
   * The ops are enqueued as ONE group, and remembered from the SPECS rather than
   * from the sheet's own variables, so the screen cannot show something the log
   * will not say. The flush is not awaited: `Client.emit` has already committed
   * the op, and a sheet that stalled on the network would be unusable in exactly
   * the places this app is used.
   */
  const saveManual = useCallback(
    async (mode: "add" | "edit", txn: Txn | null, draft: ManualDraft): Promise<void> => {
      if (writer === null || authored === null) return;
      let specs;
      let id: string;
      if (mode === "add") {
        const built = manualTxnOps({
          draft,
          // sha256 of a fresh random UUID. NEVER a hash of the fields: two
          // identical coffees on one day are two coffees, and a content hash
          // would make the second a `duplicate_ingest` anomaly that drops it.
          ingestID: newIngestID(),
          newID: newEntityID,
        });
        if (!built.ok) { setManualError(built.reason); return; }
        specs = built.specs;
        id = built.id;
      } else {
        if (txn === null) return;
        id = txn.id;
        // A fresh read of the projection, plus what this device has queued —
        // never `txn.version`, which is the object the list rendered and can be
        // minutes old. An op naming a stale parent forks against yourself.
        const head = reviewSource === null ? null : await reviewSource.version(txn.id);
        specs = manualEditOps({ txn, draft, projectedVersion: head ?? txn.version, pending: writer.pending });
        // Nothing the op owns changed. Closing without appending is the honest
        // answer; an op that consumes a version and asserts nothing is a fork
        // risk against the user's own second device.
        if (specs.length === 0) { setManual(null); setManualError(""); return; }
      }
      writer.enqueueMany(specs);
      recordAuthored(authored, id, specs);
      setAuthoredTick((n) => n + 1);
      setManual(null);
      setManualError("");
      await qc.invalidateQueries({ queryKey: v2Keys.all });
      writer.flush().catch(() => {
        toast.show({ message: "Saved on this device — it will sync when you're back online" });
      });
    },
    [writer, authored, reviewSource, qc, toast],
  );

  /**
   * The names the sheet offers.
   *
   * `deckCategories` is the deck's own grid builder: this user's categories
   * first, then the default mapping's names for the buckets they have not
   * filled, so a new account's sheet is not empty. Reused rather than rebuilt so
   * the two screens never offer different vocabularies for the same log.
   */
  /**
   * The user's definitions, read once for the whole screen.
   *
   * The sheet's grid, the rows' bucket stripes and the filter chips' dots are
   * all answers to "which bucket is this category in", and they must be the
   * SAME answer the 50/30/20 read gives — `layeredMapping` underneath both.
   * Memoised so the identity is stable: `ProjectionTxnRow` memoises on it, and
   * a fresh `[]` every render would recompute a mapping per row per render.
   */
  const categoryDefs = useMemo(() => choices.data?.categoryDefs ?? [], [choices.data]);
  const categoryNames = useMemo(
    () => deckCategories(choices.data?.categories ?? [], categoryDefs).map((c) => c.Name),
    [choices.data, categoryDefs],
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
          categoryDefs={categoryDefs}
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
                      categoryDefs={categoryDefs}
                      // A hand-typed row opens the sheet that made it — the
                      // whole row, not just its category, because the typo a
                      // user needs to fix is usually the merchant or the day.
                      // A bank row has nothing a `txn_edited` should be
                      // second-guessing, so it opens the categorizer.
                      onOpen={
                        canCategorize
                          ? (row) => {
                              fire("selection");
                              setManualError("");
                              if (row.provenance === "user") setManual({ mode: "edit", txn: row });
                              else setEditing(row);
                            }
                          : undefined
                      }
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

      {/* Only when there is somewhere to append to. A create button with no
          writer would take an entry and drop it, which is the failure this
          screen's header is about. */}
      {writer !== null && (
        <Fab
          icon={Plus}
          label="Add transaction"
          onClick={() => { setManualError(""); setManual({ mode: "add", txn: null }); }}
        />
      )}

      {manual !== null && (
        <ManualTxnSheet
          mode={manual.mode}
          initial={manual.txn === null ? emptyDraft(homeCurrency ?? "AED") : draftOf(manual.txn)}
          categories={categoryNames}
          currencies={currencyChoices}
          error={manualError}
          onClose={() => { setManual(null); setManualError(""); }}
          onSave={(draft) => void saveManual(manual.mode, manual.txn, draft)}
        />
      )}

      {editing !== null && (
        <CategorySheet
          txn={editing}
          categories={categoryNames}
          ruledTo={existingRuleCategory(editing.merchant_raw, knownRules)}
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
 *
 * # The rule write-back is offered ONCE per merchant, and off by default on a
 * correction
 *
 * `rule_added` is permanent — there is no delete and no edit op — and two
 * `exact` rules on one pattern at one priority are resolved by comparing the
 * category strings' code points. So a second rule does not replace the first; it
 * hands the merchant to whichever category sorts first, forever, which is the
 * exact opposite of what a user correcting a category meant. Hence: the switch
 * defaults OFF when the row already has a category, and does not appear at all
 * once a rule for this merchant exists ({@link ruledTo}). Replacing a rule would
 * need an op the fold does not have.
 */
function CategorySheet({ txn, categories, ruledTo, onClose, onSave }: {
  txn: Txn;
  categories: readonly string[];
  /** The category an `exact` rule already sends this merchant to, materialised or queued. */
  ruledTo: string | null;
  onClose: () => void;
  onSave: (category: string, makeRule: boolean) => void;
}) {
  const [picked, setPicked] = useState<string | null>(txn.category);
  // A first answer proposes the rule; a correction does not, because there is
  // no way to take the first rule back.
  const [makeRule, setMakeRule] = useState(txn.category === null);
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

      {ruleable && ruledTo === null && (
        <label className="my-4 flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0">Always use this category for “{txn.merchant_raw}”</span>
          <Switch checked={usable && makeRule} disabled={!usable} onChange={(e) => setMakeRule(e.target.checked)} />
        </label>
      )}

      {/* Stated rather than silently omitted, and it says only what is true: a
          rule exists, and this change is about this transaction. It does not
          offer to change the rule, because no op can. */}
      {ruledTo !== null && (
        <p className="my-4 text-sm text-muted">
          A rule already files “{txn.merchant_raw}” under {ruledTo}. This change applies to this transaction only.
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {/* Disabled until a category is chosen: clearing one back to
            uncategorised is a `txn_categorized` with a null payload, and this
            screen does not offer it, so the button must not look like it does. */}
        <Button
          variant="primary"
          disabled={!usable}
          onClick={() => { if (picked !== null && usable) onSave(picked, makeRule && ruleable && ruledTo === null); }}
        >
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
