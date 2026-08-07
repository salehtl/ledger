/**
 * What the swipe deck is shown, built from the projection.
 *
 * The deck, the card, the rails and the category sheet are v1 components and
 * they stay exactly as they are — the design is frozen and this task changes
 * only the deck's feed and its commit action. That leaves one job: turning a
 * {@link ReviewItem} into the shape those components read, which is what this
 * module is, and it is a pure function with its own test rather than a lump of
 * `useMemo` inside the screen.
 *
 * # Money never becomes a `number` on the way through
 *
 * `api/types`' `Txn.AmountFils` is a JS `number` because v1's JSON is. v2 money
 * is `int64` minor units carried as `bigint` from `replay/state.ts` onward, and
 * converting it to get it through a display component is exactly what the
 * project forbids — so the adapted row carries **no amount at all** (`0`, and
 * nothing reads it) and the hero is handed over pre-formatted as an
 * `AmountDisplay`, formatted from the `bigint` by `lib/minorMoney`.
 *
 * # The synthetic `ID`, and why it is not a position
 *
 * v1 identifies a row by an autoincrement integer; v2 by a ULID. The deck uses
 * `Txn.ID` for its React key, its skip set and — through the undo toast, which
 * holds the card object it committed — for resolving an answer minutes after it
 * was given. So the id has to mean the same transaction for as long as the
 * screen is up.
 *
 * It was a position in the feed, and that was wrong in two ways that look
 * identical from the outside. Positions renumber whenever the feed changes:
 * when the settled filter removes a confirmed row, and — the one that survives
 * any amount of care about filter order — when a **sync folds the confirmed row
 * out of the lane while the undo toast is still up**, which is the ordinary
 * production window, not an edge case. Either way `byCard.get(card.ID)` resolves
 * a *different* transaction, and the undo silently authors against it.
 *
 * {@link cardIdSource} therefore assigns an id per transaction id, once, for the
 * screen's lifetime. A card's id never moves, whatever happens to the feed
 * underneath it.
 *
 * # There is no bucket taxonomy in v2, so one is supplied
 *
 * A v2 category is a free string; the four rails are Need / Want / Save /
 * Transfer. {@link deckCategories} places each of the user's own categories in
 * the bucket `sources/budget.ts` already maps it to — the SAME table the 50/30/20
 * screen sums by, so a card sorted under Need lands in the Need total — and
 * seeds each bucket with that table's own names so a new account's rails are not
 * empty. `Transfer` and `Income` are ordinary category strings; there is no
 * transfer *status* in the op vocabulary, and inventing one here would be a
 * control that reads as an exclusion and is not.
 */

import type { Txn as ProjectionTxn } from "@ledger/client/replay/state";

import type { Category, Txn as ApiTxn } from "../api/types";
import type { AmountDisplay } from "../components/swipe/SwipeCard";
import { formatMinor, signedMinor } from "../lib/minorMoney";
import { DEFAULT_BUDGET_MAPPING, type BudgetBucket } from "./sources/budget";
import { REVIEW_REASON_COPY, type ReviewItem } from "./sources/review";

/** One card: what the deck renders, and the item it stands for. */
export interface DeckRow {
  card: ApiTxn;
  item: ReviewItem;
  amount: AmountDisplay;
  reason: string;
}

/**
 * The hero, formatted from `bigint`.
 *
 * The figure shown is the home-currency snapshot when there is one, because that
 * is the number the budget will count. When there is none the native amount is
 * shown and the label says so — v1's bug was a hero that fell back to the native
 * amount while the label still said AED, so a GBP 45.00 charge read as AED 45.00
 * at 48px.
 */
export function deckAmount(t: ProjectionTxn, homeCurrency: string | null): AmountDisplay {
  const credit = t.direction === "credit";
  const direction = t.direction === "credit" ? "credit" : t.direction === "debit" ? "debit" : "";
  const home = t.amount_home_minor;
  const converted = home !== null && homeCurrency !== null && homeCurrency !== "" && t.currency !== homeCurrency;
  const shown = home === null ? t.amount_minor : home;
  const shownCurrency = home === null ? t.currency : (homeCurrency ?? t.currency);
  const { text } = signedMinor(direction, shown);
  const note =
    home === null && t.currency !== "" && homeCurrency !== null && t.currency !== homeCurrency
      ? `no ${homeCurrency} rate yet`
      : converted
        ? `${t.currency} ${formatMinor(t.amount_minor)}`
        : null;
  return {
    text,
    label: `${credit ? "Received" : "Spent"} · ${shownCurrency === "" ? "—" : shownCurrency}`,
    note,
    credit,
  };
}

/**
 * One review item as the card reads it.
 *
 * Every field is either real or deliberately inert. `AmountFils` is `0` and
 * `Currency` empty because {@link deckAmount} supplies the hero; `Source` is
 * `""` rather than `"email"` so the card offers no "view source email" link,
 * which would open a v1 route `ledgerd` does not serve.
 */
export function deckCard(item: ReviewItem, id: number): ApiTxn {
  const t = item.txn;
  return {
    ID: id,
    PostedAt: t.posted_at,
    AmountFils: 0,
    AmountAedFils: null,
    Currency: "",
    Direction: t.direction,
    MerchantRaw: t.merchant_raw === "" ? "Unreadable message" : t.merchant_raw,
    Status: "needs_review",
    Confidence: 0,
    Source: "",
    CategoryID: null,
    CategoryName: t.category ?? "",
    Bucket: "",
    Kind: "",
    BucketSnapshot: "",
    Last4: t.last4,
  };
}

/**
 * Hands out the numeric card id for a transaction, and keeps handing out the
 * same one.
 *
 * A closure rather than a pure `(items) => ids` function because the property
 * that matters is *memory*: an id has to survive the row leaving the feed
 * entirely, which no function of the current feed can do. The screen holds one
 * of these in a ref for as long as it is mounted.
 *
 * Ids start at 1 because `SwipeCard` keys on them and 0 is falsy in enough
 * places to be worth not finding out about.
 */
export function cardIdSource(): (txnID: string) => number {
  const seen = new Map<string, number>();
  return (txnID: string): number => {
    const known = seen.get(txnID);
    if (known !== undefined) return known;
    const next = seen.size + 1;
    seen.set(txnID, next);
    return next;
  };
}

export function deckRows(
  items: readonly ReviewItem[],
  homeCurrency: string | null,
  idFor: (txnID: string) => number,
): DeckRow[] {
  return items.map((item) => ({
    card: deckCard(item, idFor(item.txn.id)),
    item,
    amount: deckAmount(item.txn, homeCurrency),
    reason: REVIEW_REASON_COPY[item.reason].title,
  }));
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** The bucket a v2 category string sorts into, or `want` when nothing maps it. */
export function bucketOf(category: string): BudgetBucket {
  return DEFAULT_BUDGET_MAPPING.categories[category.toLowerCase()] ?? "want";
}

/** What a category the user has never used yet is titled in the grid. */
function titleCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * The category grid, in the shape the panel reads.
 *
 * The user's own categories first (they arrive most-used-first from
 * `topCategories`), then the default mapping's names for any bucket the user has
 * not filled, so no rail opens onto an empty sheet. `Transfer` and `Income` are
 * the two the grid cannot derive: the panel shows `Kind: "excluded"` behind the
 * Transfer rail and `Kind: "income"` for a credit.
 */
export function deckCategories(names: readonly string[]): Category[] {
  const out: Category[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: string, bucket: string): void => {
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) return;
    seen.add(key);
    out.push({ ID: out.length + 1, Name: name, Kind: kind, Bucket: bucket, IsActive: true, Color: "" });
  };
  for (const name of names) add(name, "spending", bucketOf(name));
  for (const [name, bucket] of Object.entries(DEFAULT_BUDGET_MAPPING.categories)) {
    add(titleCase(name), "spending", bucket);
  }
  add("Income", "income", "");
  add("Transfer", "excluded", "");
  return out;
}
