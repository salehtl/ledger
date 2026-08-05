/**
 * The queue's state: what is on the deck, what the user just did, and what to
 * emit when they do something.
 *
 * Everything here that is a *decision* lives in `app/src/lib/review.ts` and is
 * tested under `bun test` without rendering anything. What is left is
 * sequencing — load, act, reload — and the two rules that make the sequencing
 * safe on a phone:
 *
 *  1. **Read the head before emitting.** The `parent_version` a confirm names
 *     comes from a fresh `version(id)` read plus whatever this device has
 *     already queued for that row, never from the card the user is looking at.
 *     A card can be minutes old; an op naming a stale parent is a fork against
 *     yourself, and inside one millisecond the *later* op is the one discarded.
 *  2. **The card leaves the deck on `enqueue`, not on `flush`.** `Client.emit`
 *     commits the op before it returns, so the answer is durable the moment the
 *     user gives it. Waiting for the network before advancing would make a
 *     queue that is used on a plane unusable, and waiting for the *fold* would
 *     be worse — the projection does not move until a sync, so the row would
 *     sit there flagged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Rule } from "@ledger/client/replay/state.ts";

import type { LaneCounts } from "../../db/reviewQueue.ts";
import {
  confirmOps,
  duplicateDispositionOp,
  isSettled,
  manualEntryOps,
  settledBy,
  undoConfirmOps,
  type Disposition,
  type ForkItem,
  type Lane,
  type ReviewItem,
  type ReviewMoney,
} from "../../lib/review.ts";
import type { ReviewDeps } from "./deps.ts";

const NO_COUNTS: LaneCounts = { needs_review: 0, unparsed: 0, duplicate: 0, forks: 0 };
const NO_MONEY: ReviewMoney = { counted: 0, excluded: 0, totalHomeMinor: 0n, awaitingRate: 0 };

/**
 * What the last action was, so it can be taken back.
 *
 * One deep, deliberately. A stack of undos over an append-only log means a
 * stack of compensating ops, each consuming a version, and a user who wanted
 * that wanted the transaction list rather than this deck.
 */
export type UndoEntry =
  | { kind: "confirm"; item: ReviewItem; previousCategory: string | null; label: string }
  | { kind: "dismiss"; key: string; item: ReviewItem | null; fork: ForkItem | null; lane: Lane; label: string };

export interface ManualEntryFields {
  amountMinor: bigint;
  currency: string;
  direction: "debit" | "credit";
  postedAt: string;
  merchantRaw: string;
  last4: string;
  category: string | null;
}

export interface ReviewQueue {
  lane: Lane;
  setLane: (lane: Lane) => void;
  items: ReviewItem[];
  forks: ForkItem[];
  counts: LaneCounts;
  money: ReviewMoney;
  categories: string[];
  loading: boolean;
  /** A failure the user has to know about — a flush that could not be retried. */
  error: string | null;
  dismissError: () => void;
  undo: UndoEntry | null;
  confirm: (item: ReviewItem, category: string | null) => Promise<void>;
  skip: (item: ReviewItem) => void;
  dismiss: (item: ReviewItem, answer: Disposition) => Promise<void>;
  acknowledgeFork: (fork: ForkItem) => Promise<void>;
  saveManualEntry: (item: ReviewItem, fields: ManualEntryFields) => Promise<void>;
  performUndo: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useReviewQueue(deps: ReviewDeps): ReviewQueue {
  const { source, writer } = deps;
  const [lane, setLane] = useState<Lane>("needs_review");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [forks, setForks] = useState<ForkItem[]>([]);
  const [counts, setCounts] = useState<LaneCounts>(NO_COUNTS);
  const [money, setMoney] = useState<ReviewMoney>(NO_MONEY);
  const [categories, setCategories] = useState<string[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  /**
   * Cards answered in this session, remembered only so the deck advances
   * before a sync. It is a *cache* of what {@link settledBy} derives from the
   * outbox — never the source of truth, because a set in component state does
   * not survive the app being killed and the ops do.
   */
  const [answered, setAnswered] = useState<string[]>([]);

  /** Guards against two loads racing; the later one wins. */
  const loadToken = useRef(0);

  const reload = useCallback(async () => {
    if (source === null) return;
    const token = ++loadToken.current;
    setLoading(true);
    try {
      const [c, page, f, m, cats, rs] = await Promise.all([
        source.counts(),
        lane === "forks" ? Promise.resolve<ReviewItem[]>([]) : source.page(lane),
        source.forks(),
        source.money(lane),
        source.categories(),
        source.rules(),
      ]);
      if (token !== loadToken.current) return;
      setCounts(c);
      setItems(page);
      setForks(f);
      setMoney(m);
      setCategories(cats);
      setRules(rs);
    } catch (err) {
      if (token === loadToken.current) setError(messageOf(err));
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [source, lane]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * The deck: settled cards removed, skipped cards moved to the back.
   *
   * A skip is not an answer — nothing is emitted and nothing is stored — so the
   * card comes back at the end of the session's deck rather than disappearing.
   * "I'll deal with it later" has to mean later, not never.
   */
  const visible = useMemo(() => {
    const settlement = settledBy(writer?.pending ?? []);
    const answeredSet = new Set(answered);
    const live = items.filter((i) => !answeredSet.has(i.key) && !isSettled(i.txn, settlement));
    const skippedSet = new Set(skipped);
    return [...live.filter((i) => !skippedSet.has(i.key)), ...live.filter((i) => skippedSet.has(i.key))];
  }, [items, skipped, answered, writer]);

  const push = useCallback(
    async (specs: Parameters<NonNullable<typeof writer>["enqueueMany"]>[0]) => {
      if (writer === null) throw new Error("no writer: this build has no sync client yet");
      writer.enqueueMany(specs);
      // Not awaited into the UI path — the ops are already durable. A failure
      // surfaces as a banner; the deck does not stall on the network.
      writer.flush().catch((err: unknown) => setError(messageOf(err)));
    },
    [writer],
  );

  const confirm = useCallback(
    async (item: ReviewItem, category: string | null) => {
      if (source === null || writer === null) return;
      try {
        const head = await source.version(item.txn.id);
        const specs = confirmOps({
          txn: item.txn,
          category,
          // A row the projection no longer knows about cannot be confirmed at a
          // guessed version; its own version is the only defensible fallback.
          projectedVersion: head ?? item.txn.version,
          pending: writer.pending,
          rules,
          newID: deps.newID,
        });
        await push(specs);
        setAnswered((a) => [...a, item.key]);
        setUndo({ kind: "confirm", item, previousCategory: item.txn.category, label: "Confirmed" });
      } catch (err) {
        setError(messageOf(err));
      }
    },
    [source, writer, rules, deps.newID, push],
  );

  const saveManualEntry = useCallback(
    async (item: ReviewItem, fields: ManualEntryFields) => {
      if (writer === null) return;
      try {
        await push(manualEntryOps({ txn: item.txn, newID: deps.newID, ...fields }));
        setAnswered((a) => [...a, item.key]);
        // No undo offered: the compensating op would be a second supersede of
        // the same message, which is a real transaction in the log rather than
        // a retraction. The transactions screen edits it.
        setUndo(null);
      } catch (err) {
        setError(messageOf(err));
      }
    },
    [writer, deps.newID, push],
  );

  const dismiss = useCallback(
    async (item: ReviewItem, answer: Disposition) => {
      if (source === null) return;
      try {
        if (item.lane === "duplicate") {
          if (writer === null) throw new Error("no writer: this build has no sync client yet");
          const head = await source.version(item.txn.id);
          const disposition = answer === "duplicate_confirmed" ? "same" : "different";
          await push([duplicateDispositionOp({ txn: item.txn, projectedVersion: head ?? item.txn.version, pending: writer.pending, disposition })]);
        }
        await source.dismiss(item.key, item.lane, answer);
        setAnswered((a) => [...a, item.key]);
        setUndo({
          kind: "dismiss",
          key: item.key,
          item,
          fork: null,
          lane: item.lane,
          label: answer === "duplicate_confirmed" ? "Marked as a duplicate" : answer === "not_transaction" ? "Marked as not a transaction" : "Kept both",
        });
        await reload();
      } catch (err) {
        setError(messageOf(err));
      }
    },
    [source, writer, push, reload],
  );

  const acknowledgeFork = useCallback(
    async (fork: ForkItem) => {
      if (source === null) return;
      try {
        await source.dismiss(fork.key, "forks", "acknowledged");
        setUndo({ kind: "dismiss", key: fork.key, item: null, fork, lane: "forks", label: "Dismissed" });
        await reload();
      } catch (err) {
        setError(messageOf(err));
      }
    },
    [source, reload],
  );

  const skip = useCallback((item: ReviewItem) => {
    setSkipped((s) => (s.includes(item.key) ? s : [...s, item.key]));
    setUndo(null);
  }, []);

  const performUndo = useCallback(async () => {
    const u = undo;
    if (u === null) return;
    setUndo(null);
    try {
      if (u.kind === "confirm") {
        if (source === null || writer === null) return;
        const head = await source.version(u.item.txn.id);
        await push(
          undoConfirmOps({
            // The row as it was BEFORE the confirm — that is what the
            // compensating op restores.
            txn: { ...u.item.txn, category: u.previousCategory },
            projectedVersion: head ?? u.item.txn.version,
            pending: writer.pending,
          }),
        );
        setAnswered((a) => a.filter((k) => k !== u.item.key));
      } else {
        if (source === null) return;
        if (u.lane === "duplicate" && u.item !== null) {
          if (writer === null) return;
          const head = await source.version(u.item.txn.id);
          await push([duplicateDispositionOp({ txn: u.item.txn, projectedVersion: head ?? u.item.txn.version, pending: writer.pending, disposition: null })]);
        }
        await source.restore(u.key);
        setAnswered((a) => a.filter((k) => k !== u.key));
        await reload();
      }
    } catch (err) {
      setError(messageOf(err));
    }
  }, [undo, source, writer, push, reload]);

  return {
    lane,
    setLane,
    items: visible,
    forks,
    counts,
    money,
    categories,
    loading,
    error,
    dismissError: () => setError(null),
    undo,
    confirm,
    skip,
    dismiss,
    acknowledgeFork,
    saveManualEntry,
    performUndo,
    reload,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
