/**
 * The review queue, on the local projection.
 *
 * # What changed, and what deliberately did not
 *
 * The deck is the same deck. The gesture, the four rails, the fly-out, the ghost
 * card, the category sheet and the undo toast are untouched — the design is
 * frozen, and this screen changes exactly two things: where the cards come from
 * and what answering one does.
 *
 *  - **The feed** is `v2/sources/review.ts`'s `DECK_LANES` — the flagged rows
 *    and the ones with no category — over SQLite, not
 *    `GET /api/transactions?status=needs_review`. There is no `fetch` on this
 *    screen at all, and its test asserts that.
 *  - **The commit** appends a `txn_categorized` op (plus, first time for a
 *    merchant, a `rule_added`) through the outbox. `Client.emit` commits before
 *    it returns, so the card leaves the deck the moment the user answers rather
 *    than when the network agrees — a queue used on a plane has to work.
 *
 * # The queue is not period-scoped, and used to pretend to be
 *
 * v1 filtered this by the shell's scope selector, which meant a transaction that
 * needed a look last month vanished from the queue when the month rolled over —
 * silently, into a list nobody was going to open. "Needs review" is a state, not
 * a period. The scope selector still governs Home, Transactions and Insights;
 * it does not govern this.
 *
 * # Why a confirmed card does not come back on the next refetch
 *
 * The projection only moves when a sync folds new ops, so for the whole of an
 * offline session every row the user has confirmed is still `needs_review = 1`
 * in SQLite. `settledBy`/`isSettled` read the outbox — the durable record of
 * what the user has already answered — and take those rows off the deck. A `Set`
 * in component state would do the same until the tab was killed, and would then
 * hand the user thirty cards they had already sorted.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { newEntityID } from "@ledger/client/net/client";

import { AlertTriangle, CheckCircle2, Inbox } from "../components/ui/PixelIcon";
import { PixelSpinner } from "../components/ui/PixelSpinner";
import { Pressable } from "../components/ui/Pressable";
import { EmptyState } from "../components/EmptyState";
import { SwipeDeck } from "../components/swipe/SwipeDeck";
import { useToast } from "../components/Toast";
import type { Category, Txn as ApiTxn } from "../api/types";
import { loadSwipeConfig } from "../lib/swipe";
import { formatMinor } from "../lib/minorMoney";
import { cardIdSource, deckCategories, deckRows, type DeckRow } from "../v2/reviewDeck";
import { useHomeCurrency, useReviewFeed, useReviewSource, useTxnSource, v2Keys } from "../v2/queries";
import {
  categorizeOps,
  DECK_LANES,
  isSettled,
  settledBy,
  undoConfirmOps,
  type ReviewSource,
} from "../v2/sources/review";
import { useWriter, type Writer } from "../v2/writer";

export interface ReviewProps {
  /** Opens the held-mail lane. Absent hides the entry point. */
  onOpenQuarantine?: () => void;
  /** Test seam: a source over a projection the test built. */
  source?: ReviewSource;
  /** Test seam: a writer that records what the screen would append. */
  writer?: Writer;
}

export function Review({ onOpenQuarantine, source: injectedSource, writer: injectedWriter }: ReviewProps) {
  const [config] = useState(loadSwipeConfig);
  const source = useReviewSource(injectedSource);
  const writer = useWriter(injectedWriter);
  const qc = useQueryClient();
  const toast = useToast();
  const homeCurrency = useHomeCurrency(useTxnSource());

  /**
   * Both lanes the deck can answer, dealt flagged-first.
   *
   * `uncategorized` is here because the deck already answers exactly its
   * question. A template-tier parse with every capture group filled is never
   * `needs_review`, so a real transaction with no category used to belong to no
   * lane at all — the queue said "All caught up" over a row nothing had filed,
   * and there was no way to categorise it from this screen. The card, the
   * gesture and the commit are unchanged; only the feed grew.
   */
  const feed = useReviewFeed(source, DECK_LANES);

  /**
   * Every row the lane page returned, adapted, in the page's own order.
   *
   * The settled filter is applied AFTER this and never to it.
   */
  const page = useMemo(() => feed.data?.items ?? [], [feed.data]);

  /**
   * Card ids, stable per transaction for as long as this screen is mounted.
   *
   * Not positions. A position renumbers whenever the feed changes — when the
   * settled filter drops a confirmed row, and, unavoidably, when a sync folds
   * that row out of the lane while the undo toast is still up. Both make
   * `byCard.get(card.ID)` resolve a *different* transaction, and `undo` would
   * then author a compensating op against a row the user never touched.
   */
  const idFor = useRef(cardIdSource()).current;
  const allRows = useMemo(() => deckRows(page, homeCurrency, idFor), [page, homeCurrency, idFor]);

  /**
   * Every card this screen has ever handed the deck, by id — **cumulative**.
   *
   * A `Map` rebuilt from the current page would forget a row the moment a sync
   * folded it out, and forgetting is not a safe default here: `undo` early-returns
   * on a miss (there is nothing sensible to do with an id it cannot resolve), so
   * the user's undo would quietly do nothing at the exact moment the sync they
   * were waiting for arrived. The deck outlives the feed, so the lookup has to
   * as well.
   *
   * It grows with the number of distinct cards seen in one sitting, which is
   * bounded by the queue the user is working through, and is dropped when the
   * screen unmounts.
   */
  const cards = useRef(new Map<number, DeckRow>()).current;
  const byCard = useMemo(() => {
    for (const r of allRows) cards.set(r.card.ID, r);
    return cards;
  }, [allRows, cards]);

  /**
   * What the deck is handed: the page minus what the outbox has already
   * answered.
   *
   * `writer.pending` is read rather than `writer`, because `Client.emitMany`
   * REPLACES the array (`this.st.pending = [...previous, ...ops]`) while the
   * outbox object itself is memoised for the tab's lifetime — a memo keyed on
   * the writer would never recompute, and the filter would only ever be correct
   * by accident of react-query's structural sharing.
   */
  const rows = useMemo(() => {
    const settlement = settledBy(writer?.pending ?? []);
    return allRows.filter((r) => !isSettled(r.item.txn, settlement));
  }, [allRows, writer?.pending]);
  const categories = useMemo(
    () => deckCategories(feed.data?.categories ?? [], feed.data?.categoryDefs ?? []),
    [feed.data],
  );

  /**
   * Appends one answer.
   *
   * The parent version comes from a FRESH read of the projection plus whatever
   * this device has already queued for that row — never from the card, which can
   * be minutes old. An op naming a stale parent is a fork against yourself, and
   * inside one millisecond the later op is the one discarded.
   */
  const commit = useCallback(
    async (card: ApiTxn, category: Category, makeRule: boolean): Promise<void> => {
      const row = byCard.get(card.ID);
      if (row === undefined) throw new Error("the deck committed a card this screen does not hold");
      if (source === null || writer === null) throw new Error("no local ledger is open");
      const head = await source.version(row.item.txn.id);
      const specs = categorizeOps({
        txn: row.item.txn,
        category: category.Name,
        // The sheet's "remember this merchant" switch. Dropping the spec rather
        // than not asking for it keeps the rule's shape in one place — see
        // `categorizeOps`, which the transaction list's sheet also authors
        // through.
        makeRule,
        // A row the projection no longer knows about cannot be confirmed at a
        // guessed version; its own version is the only defensible fallback.
        projectedVersion: head ?? row.item.txn.version,
        pending: writer.pending,
        rules: feed.data?.rules ?? [],
        newID: newEntityID,
      });
      writer.enqueueMany(specs);
      await qc.invalidateQueries({ queryKey: v2Keys.all });
      // Not awaited: the ops are already durable, and a deck that stalled on the
      // network would be unusable exactly where this queue is used.
      writer.flush().catch(() => {
        toast.show({ message: "Saved on this device — it will sync when you're back online" });
      });
    },
    [byCard, source, writer, feed.data, qc, toast],
  );

  const undo = useCallback(
    async (card: ApiTxn): Promise<void> => {
      const row = byCard.get(card.ID);
      if (row === undefined || source === null || writer === null) return;
      const head = await source.version(row.item.txn.id);
      // The log is append-only, so this is a compensating op rather than a
      // deletion: the row goes back to the category it had and back to
      // `needs_review`, and both ops stay in the log forever.
      writer.enqueueMany(
        undoConfirmOps({
          txn: row.item.txn,
          projectedVersion: head ?? row.item.txn.version,
          pending: writer.pending,
        }),
      );
      await qc.invalidateQueries({ queryKey: v2Keys.all });
      writer.flush().catch(() => undefined);
    },
    [byCard, source, writer, qc],
  );

  const counts = feed.data?.counts;
  const money = feed.data?.money;

  // No v2 runtime and nothing injected. NOT a v1 fallback — see `Home.tsx`'s
  // header for why there is no correct one.
  if (source === null || writer === null) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Your local ledger isn't open"
        hint="This screen reads the copy of your ledger on this device. Reopen the app to reconnect."
      />
    );
  }

  return (
    // flex-1, not a min-h floor: AppShell's content wrapper is a full-height
    // flex column, so the deck takes exactly the space that's there.
    <div className="flex flex-1 flex-col min-h-0">
      {feed.isPending && (
        <div className="flex-1 flex items-center justify-center py-16">
          <PixelSpinner size={36} role="status" aria-label="Loading transactions" className="text-muted" />
        </div>
      )}

      {/* A failed read is not an empty queue. Without this, a broken projection
          rendered "All caught up" — telling you your queue was clear when it had
          simply failed to load. */}
      {feed.isError && (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't read your review queue"
            hint="The copy of your ledger on this device could not be read. Reopen the app to try again."
          />
        </div>
      )}

      {!feed.isPending && !feed.isError && rows.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
          <CheckCircle2 size={48} className="text-fg" />
          {/* The same words the deck uses when you finish sorting — one state,
              one name, whether you cleared it just now or arrived to nothing. */}
          <h2 className="text-xl font-semibold text-fg">All caught up</h2>
          <p className="text-muted">Nothing is waiting for a decision.</p>
        </div>
      )}

      {!feed.isPending && !feed.isError && rows.length > 0 && (
        <SwipeDeck
          // NO `key`. `SwipeDeck` freezes its list at mount by design — a
          // refetch must not shift the index under the user's thumb — and the
          // key is the only thing that can force it to re-freeze. Every
          // content-derived key tried here was wrong in the same way: it moved
          // when the outbox grew, or when a sync folded the confirmed row out
          // of the lane, and a remount resets the index AND drops the deck's
          // `commitRef`, which is the undo the toast is at that moment
          // offering. So the deck mounts once per visit to this screen, which
          // is what freezing at mount already meant. Work that arrives mid-
          // session is on the next visit; the counts below say it is there.
          transactions={rows.map((r) => r.card)}
          categories={categories}
          config={config}
          onCommit={commit}
          onUndo={undo}
          amountOf={(t) => byCard.get(t.ID)?.amount ?? { text: "—", label: "" }}
          reasonOf={(t) => byCard.get(t.ID)?.reason ?? ""}
        />
      )}

      {/*
        The lanes this deck cannot answer, stated rather than hidden.

        An unparsed message needs typing in and a duplicate notice needs a
        yes/no — two questions the confirm deck cannot ask, and whose ops
        (`txn_superseded`, `txn_duplicate_disposition`) this task does not wire.
        §2 forbids anything sitting silently unhandled, so the count is on the
        glass even though the control for it is not built yet.
      */}
      {counts !== undefined && (counts.unparsed > 0 || counts.duplicate > 0 || counts.forks > 0) && (
        <p className="mt-3 px-1 text-center text-xs text-muted">
          {[
            counts.unparsed > 0 ? `${counts.unparsed} couldn't be read` : null,
            counts.duplicate > 0 ? `${counts.duplicate} possible duplicate${counts.duplicate === 1 ? "" : "s"}` : null,
            counts.forks > 0 ? `${counts.forks} resolved edit${counts.forks === 1 ? "" : "s"}` : null,
          ]
            .filter((s): s is string => s !== null)
            .join(" · ")}
          {/* "visible in", not "reachable from": those rows can be FILTERED to
              in Transactions, but there is no control anywhere that answers
              them yet, and naming an action the code does not honour is the
              thing this line exists to avoid. */}
          {" — still waiting, visible in Transactions."}
        </p>
      )}

      {/* The money in the lane, and how much of it has no rate yet. A total
          printed without the second number is a total that is quietly short. */}
      {money !== undefined && money.counted > 0 && (
        <p className="mt-1 px-1 text-center text-xs text-muted tnum">
          {formatMinor(money.totalHomeMinor)} waiting
          {money.awaitingRate > 0 && `, plus ${money.awaitingRate} with no rate yet`}
        </p>
      )}

      {onOpenQuarantine !== undefined && (
        <Pressable
          onClick={onOpenQuarantine}
          className="mt-3 mx-auto flex min-h-11 items-center gap-2 px-3 text-sm font-medium text-fg underline underline-offset-2"
        >
          <Inbox size={16} aria-hidden />
          Held mail
        </Pressable>
      )}
    </div>
  );
}
