/**
 * The review deck, on a real projection, with a writer that records.
 *
 * The projection is built the way the sync engine builds it — real ops, real
 * `fold`, real `project` — rather than by inserting rows, because a fixture that
 * performed the setup production performs is how Phase 1's exit test went green
 * over a production gap.
 *
 * **Every test here asserts `fetch` was never called.** That is not belt and
 * braces: `useV2()` returns null wherever the gate is absent, and a screen that
 * answered that by falling back to `/api/transactions` would look entirely
 * correct in a test while reading a different database over a protocol
 * `ledgerd` does not serve.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";
import { fold, INGEST_WRITER_ID, type LogEntry } from "@ledger/client/replay/replay";
import { project } from "@ledger/client/replay/projection";
import type { OpSpec } from "@ledger/client/outbox/outbox";
import type { Op } from "@ledger/client/wire/op";

import { MotionProvider } from "../app/MotionProvider";
import { ToastProvider } from "../components/Toast";
import { openBrowserDriver } from "../v2/db/driver";
import { sqlReviewSource, type ReviewSource } from "../v2/sources/review";
import { v2Keys } from "../v2/queries";
import type { Writer } from "../v2/writer";
import { Review } from "./Review";

let seq = 0n;
function entry(op: Op, writer = INGEST_WRITER_ID): LogEntry {
  seq += 1n;
  return { op, seq, writer_id: writer };
}

function ingested(id: string, n: number, merchant: string, amount: string): LogEntry {
  return entry({
    v: 1,
    type: "txn_ingested",
    op_id: `op-${id}`,
    authored_at: "2026-07-01T00:00:00.000Z",
    entity: { kind: "txn", id },
    parent_version: null,
    ingest_id: n.toString(16).padStart(64, "0"),
    payload: {
      amount_minor: amount,
      currency: "AED",
      direction: "debit",
      posted_at: `2026-07-1${n}T08:00:00Z`,
      merchant_raw: merchant,
      last4: "3701",
      category: null,
      needs_review: true,
      tier: "template",
    },
  });
}

async function projection(): Promise<ReviewSource> {
  const db = await openBrowserDriver(`review-screen-${crypto.randomUUID()}`);
  await project(
    db,
    fold([
      entry({
        v: 1,
        type: "home_currency_set",
        op_id: "op-home",
        authored_at: "2026-07-01T00:00:00.000Z",
        parent_version: null,
        payload: { currency: "AED" },
      }),
      ingested("t1", 1, "CARREFOUR HYPERMARKET", "25000"),
      ingested("t2", 2, "SPINNEYS", "8800"),
      // A settled row, so "all caught up" cannot pass by the queue being empty.
      entry({
        v: 1,
        type: "txn_ingested",
        op_id: "op-t3",
        authored_at: "2026-07-01T00:00:00.000Z",
        entity: { kind: "txn", id: "t3" },
        parent_version: null,
        ingest_id: (3).toString(16).padStart(64, "0"),
        payload: {
          amount_minor: "1000",
          currency: "AED",
          direction: "debit",
          posted_at: "2026-07-09T08:00:00Z",
          merchant_raw: "LULU",
          last4: "",
          category: "Groceries",
          needs_review: false,
          tier: "template",
        },
      }),
    ]),
  );
  return sqlReviewSource(db);
}

/**
 * A row the template read cleanly — nothing uncertain, so never flagged — with
 * or without a category.
 *
 * This is the shape the operator's real DIB transaction has, and the one that
 * used to belong to no lane at all.
 */
function clean(id: string, n: number, merchant: string, amount: string, category: string | null): LogEntry {
  return entry({
    v: 1,
    type: "txn_ingested",
    op_id: `op-${id}`,
    authored_at: "2026-07-01T00:00:00.000Z",
    entity: { kind: "txn", id },
    parent_version: null,
    ingest_id: n.toString(16).padStart(64, "0"),
    payload: {
      amount_minor: amount,
      currency: "AED",
      direction: "debit",
      posted_at: `2026-07-0${n}T08:00:00Z`,
      merchant_raw: merchant,
      last4: "3701",
      category,
      needs_review: false,
      tier: "template",
    },
  });
}

/** A projection whose only work is a row that needs a category. */
async function cleanProjection(): Promise<ReviewSource> {
  const db = await openBrowserDriver(`review-clean-${crypto.randomUUID()}`);
  await project(
    db,
    fold([
      entry({
        v: 1,
        type: "home_currency_set",
        op_id: "op-home",
        authored_at: "2026-07-01T00:00:00.000Z",
        parent_version: null,
        payload: { currency: "AED" },
      }),
      clean("c1", 4, "ADNOC", "12000", null),
      // The same row WITH a category. It is not a review item, and the deck
      // must never be handed it.
      clean("c2", 5, "LULU", "1000", "Groceries"),
    ]),
  );
  return sqlReviewSource(db);
}

interface Recorder extends Writer {
  queued: OpSpec[];
}

/**
 * A writer that behaves like the real `Outbox`, which means `pending` GROWS.
 *
 * The first version of this double kept `pending` frozen at whatever it was
 * constructed with. That made every test here pass for a reason outside this
 * screen: react-query's structural sharing keeps `feed.data`'s identity across a
 * refetch, so the `settledBy` memo never recomputed and the deck's consistency
 * rested on a library behaviour rather than on the code. `Client.emit` commits
 * the op before it returns and `Outbox.pending` is a live read of the client's
 * queue, so an enqueue that did not show up in `pending` is a double that cannot
 * reproduce the bug `settledBy` exists to prevent.
 *
 * The ops are built the way `Client.emitMany` builds them — the `OpSpec`'s
 * `parentVersion`/`entity` become the op's `parent_version`/`entity`, which is
 * exactly what `settledBy` and `nextParentVersion` read.
 */
function recorder(pending: Op[] = []): Recorder {
  const queued: OpSpec[] = [];
  let live: Op[] = [...pending];
  let n = 0;
  return {
    queued,
    get pending() {
      return live;
    },
    enqueueMany: (specs) => {
      queued.push(...specs);
      for (const spec of specs) {
        // REPLACED, not mutated: `Client.emitMany` does
        // `this.st.pending = [...previous, ...ops]`, so the array identity
        // changes on every enqueue. A double that pushed in place would hide
        // any memo that (wrongly or rightly) depends on that identity.
        live = [...live, {
          v: 1,
          type: spec.type as Op["type"],
          op_id: `emitted-${++n}`,
          authored_at: "2026-07-20T00:00:00.000Z",
          parent_version: spec.parentVersion ?? null,
          payload: spec.payload,
          ...(spec.entity === undefined ? {} : { entity: spec.entity }),
        }];
      }
    },
    flush: async () => undefined,
  };
}

/**
 * Returns the `QueryClient` as well as the render result, so a test can make the
 * feed re-read on its own terms — which is the only way to reproduce a sync that
 * lands while the user is looking at a card rather than after they answered it.
 */
function mount(source: ReviewSource, writer: Writer) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MotionProvider>
          <ToastProvider>
            <Review source={source} writer={writer} />
          </ToastProvider>
        </MotionProvider>
      </QueryClientProvider>,
    ),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setPlatform(webPlatform);
  seq = 0n;
  fetchMock = vi.fn(() => {
    throw new Error("this screen must never reach the network");
  });
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

describe("Review", () => {
  it("feeds the deck from the projection without touching the network", async () => {
    mount(await projection(), recorder());
    // Newest first, and only the front card is rendered: SPINNEYS is on the
    // 12th, CARREFOUR on the 11th. The settled row is in neither.
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.queryByText("LULU")).not.toBeInTheDocument();
    expect(screen.getByText("Remaining")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prints the amount from the projection's bigint, not a converted number", async () => {
    mount(await projection(), recorder());
    // 8800 fils, frozen at the identity rate for the home currency.
    expect(await screen.findByText("−88.00")).toBeInTheDocument();
    expect(screen.getByText("Spent · AED")).toBeInTheDocument();
  });

  it("authors a txn_categorized and a merchant rule when a card is sorted", async () => {
    const user = userEvent.setup();
    const writer = recorder();
    mount(await projection(), writer);
    await screen.findByText("SPINNEYS");

    await user.click(screen.getByRole("button", { name: /Need — sort this transaction/ }));
    await user.click(await screen.findByRole("button", { name: "Groceries" }));

    await waitFor(() => expect(writer.queued.length).toBe(2));
    expect(writer.queued[0]).toMatchObject({
      type: "txn_categorized",
      entity: { kind: "txn", id: "t2" },
      // The projection's version, not the card's guess.
      parentVersion: 1,
      payload: { category: "Groceries", needs_review: false },
    });
    expect(writer.queued[1]).toMatchObject({
      type: "rule_added",
      payload: { match: "exact", category: "Groceries", priority: 0 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("undoes a confirm with a compensating op that does not fork against itself", async () => {
    const user = userEvent.setup();
    const writer = recorder();
    mount(await projection(), writer);
    await screen.findByText("SPINNEYS");

    await user.click(screen.getByRole("button", { name: /Need — sort this transaction/ }));
    await user.click(await screen.findByRole("button", { name: "Groceries" }));
    await waitFor(() => expect(writer.queued.length).toBe(2));

    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(writer.queued.length).toBe(3));

    // The log is append-only: this is a compensating op, not a deletion, and the
    // rule write-back is deliberately NOT retracted.
    expect(writer.queued.map((s) => s.type)).toEqual(["txn_categorized", "rule_added", "txn_categorized"]);
    expect(writer.queued[2]).toMatchObject({
      type: "txn_categorized",
      entity: { kind: "txn", id: "t2" },
      payload: { category: null, needs_review: true },
    });
    // THE assertion. The confirm named parent 1; the projection has not folded,
    // so it still says 1. An undo naming 1 as well would be a true concurrent
    // fork against the user's own confirm — and inside one millisecond, or on a
    // tie, the LATER op is the one replay discards, so the undo would silently
    // vanish and the queue would show a fork notice for a fork nobody made.
    expect(writer.queued[0]!.parentVersion).toBe(1);
    expect(writer.queued[2]!.parentVersion).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("undoes the transaction the user confirmed when a sync folds it out mid-toast", async () => {
    // THE production window, not an edge case: `commit` invalidates, the lane is
    // re-read, and a sync that landed in between can have folded the confirmed
    // row out of `needs_review` — all while the undo toast is still on screen.
    //
    // Two things have to survive that, and both were broken before this test:
    //
    //  1. Card ids were POSITIONS in the feed, so the surviving row inherited
    //     the confirmed row's id and `undo` authored against the wrong
    //     transaction. (With nothing surviving it is the same mechanism ending
    //     in a silent early return instead.)
    //  2. The deck was keyed on the feed's content, so the changed page
    //     remounted it — which resets its index and drops the `commitRef` the
    //     toast's Undo resolves against, i.e. the deck destroyed its own undo.
    const user = userEvent.setup();
    const writer = recorder();
    const base = await projection();
    let reads = 0;
    const folding: ReviewSource = {
      ...base,
      page: async (lane, opts) => {
        const rows = await base.page(lane, opts);
        // Only the flagged lane is counted: the deck reads several lanes per
        // pass, and `reads` has to go on meaning "how many times THIS lane was
        // asked for" or the assertion below stops being about the sync.
        if (lane !== "needs_review") return rows;
        // First read is the deck's; every read after it is the post-confirm one.
        return ++reads === 1 ? rows : rows.filter((r) => r.txn.id !== "t2");
      },
    };
    mount(folding, writer);
    await screen.findByText("SPINNEYS");

    await user.click(screen.getByRole("button", { name: /Need — sort this transaction/ }));
    await user.click(await screen.findByRole("button", { name: "Groceries" }));
    await waitFor(() => expect(writer.queued.length).toBe(2));
    // The lane really did change underneath the toast.
    await waitFor(() => expect(reads).toBeGreaterThan(1));

    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(writer.queued.length).toBe(3));

    // (1) The compensating op names t2 — what the user actually confirmed — and
    // not t1, the row that survived the fold and would have inherited its id.
    expect(writer.queued[2]).toMatchObject({
      type: "txn_categorized",
      entity: { kind: "txn", id: "t2" },
      payload: { needs_review: true },
    });
    expect(screen.queryByText(/Too late to undo/)).not.toBeInTheDocument();

    // (2) The deck did not remount, and this is how that is visible from
    // outside it: undo puts the card BACK at the front — `restoreCard` sets the
    // deck's index to the one the commit was made at. A deck keyed on the
    // feed's CONTENT re-mounts when the sync changes the page, and then
    // `restoreCard` is talking to an instance React has already thrown away:
    // the op is undone, but the card never returns, the index is back at zero
    // and every skip made this session is gone. The undo would quietly mean
    // less than it said.
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still resolves the NEXT card after a sync folds the confirmed one out", async () => {
    // The other half of the same window, and the half the undo path cannot
    // check: the toast holds the callbacks it was created with, so an undo
    // resolves through the card map AS IT WAS AT COMMIT TIME whatever happens
    // afterwards. Sorting the next card goes through the CURRENT one.
    //
    // The deck's frozen list still holds the card it was handed for t1. If ids
    // are positions, t1 is renumbered into the id the folded row had; if
    // `byCard` is rebuilt from the current page, it has forgotten both. Either
    // way the lookup misses, `commit` throws "the deck committed a card this
    // screen does not hold", and the deck tells the user "Couldn't save".
    const user = userEvent.setup();
    const writer = recorder();
    const base = await projection();
    let reads = 0;
    const folding: ReviewSource = {
      ...base,
      page: async (lane, opts) => {
        const rows = await base.page(lane, opts);
        if (lane !== "needs_review") return rows;
        return ++reads === 1 ? rows : rows.filter((r) => r.txn.id !== "t2");
      },
    };
    mount(folding, writer);
    await screen.findByText("SPINNEYS");

    await user.click(screen.getByRole("button", { name: /Need — sort this transaction/ }));
    await user.click(await screen.findByRole("button", { name: "Groceries" }));
    await waitFor(() => expect(writer.queued.length).toBe(2));
    await waitFor(() => expect(reads).toBeGreaterThan(1));

    // The deck has advanced to CARREFOUR, whose card id was minted from a page
    // that no longer exists.
    await user.click(await screen.findByRole("button", { name: /Want — sort this transaction/ }));
    await user.click(await screen.findByRole("button", { name: "Dining" }));
    // Four, not three: CARREFOUR is a merchant this user has not ruled on, so
    // its confirmation carries a write-back rule too.
    await waitFor(() => expect(writer.queued.length).toBe(4));
    expect(writer.queued[2]).toMatchObject({
      type: "txn_categorized",
      entity: { kind: "txn", id: "t1" },
      payload: { category: "Dining", needs_review: false },
    });
    expect(screen.queryByText(/Couldn't save/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the transaction ON THE CARD when the sync landed BEFORE the answer", async () => {
    // The half of the window the other two cannot reach, and the reason they
    // cannot: the undo toast holds the `onUndo` it was handed at commit time, so
    // a `byCard` that goes wrong AFTER the commit is never consulted, and a test
    // that folds the page mid-toast is answered out of a closure that is still
    // correct. Both fixes could be reverted and such a test would stay green.
    //
    // A sync does not wait for the user to answer. It can just as easily land
    // while the card is under their thumb — and then the page has renumbered
    // BEFORE the commit, so the lookup the commit itself makes is the wrong one.
    // With positional ids the deck's frozen card 1 (SPINNEYS/t2) resolves to
    // whatever is first in the NEW page (CARREFOUR/t1), and both the confirm and
    // the undo are authored against a transaction the user never saw.
    const user = userEvent.setup();
    const writer = recorder();
    const base = await projection();
    let folded = false;
    const folding: ReviewSource = {
      ...base,
      page: async (lane, opts) => {
        const rows = await base.page(lane, opts);
        if (lane !== "needs_review" || !folded) return rows;
        return rows.filter((r) => r.txn.id !== "t2");
      },
      // Not decoration. The counts line is rendered from the SAME query pass as
      // the page, so it is the one thing in the DOM that can prove the screen
      // re-rendered on the folded page — without it this test would pass by
      // asserting against a re-read nobody had awaited, which is exactly the
      // "check that cannot fail" this test exists to replace.
      counts: async () => ({ ...(await base.counts()), unparsed: folded ? 1 : 0 }),
    };
    const { qc } = mount(folding, writer);
    await screen.findByText("SPINNEYS");

    folded = true;
    await act(async () => {
      await qc.invalidateQueries({ queryKey: v2Keys.all });
    });
    await screen.findByText(/couldn't be read/);
    // The deck did not re-freeze: the card the user is looking at is still t2,
    // which is the whole reason the lookup has to survive the renumbering.
    expect(screen.getByText("SPINNEYS")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Need — sort this transaction/ }));
    await user.click(await screen.findByRole("button", { name: "Groceries" }));
    await waitFor(() => expect(writer.queued.length).toBe(2));
    expect(writer.queued[0]).toMatchObject({
      type: "txn_categorized",
      entity: { kind: "txn", id: "t2" },
      payload: { category: "Groceries" },
    });

    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(writer.queued.length).toBe(3));
    expect(writer.queued[2]).toMatchObject({
      type: "txn_categorized",
      entity: { kind: "txn", id: "t2" },
      payload: { category: null, needs_review: true },
    });
    expect(screen.queryByText(/Couldn't save/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a card the outbox has already answered off the deck", async () => {
    const answered: Op[] = [
      {
        v: 1,
        type: "txn_categorized",
        op_id: "queued-1",
        authored_at: "2026-07-20T00:00:00.000Z",
        entity: { kind: "txn", id: "t2" },
        parent_version: 1,
        payload: { category: "Groceries", needs_review: false },
      },
    ];
    mount(await projection(), recorder(answered));
    // The projection still says `needs_review = 1` for t2 — nothing has folded —
    // so without `settledBy` the user would be handed a card they already sorted.
    expect(await screen.findByText("CARREFOUR HYPERMARKET")).toBeInTheDocument();
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
  });

  it("puts a cleanly-parsed transaction with no category on the deck", async () => {
    // The operator's bug: a DIB message the template read with every capture
    // group filled, so `needs_review` is false and it is in no other lane. The
    // queue said "All caught up" over it and offered no way to categorise it.
    mount(await cleanProjection(), recorder());
    expect(await screen.findByText("ADNOC")).toBeInTheDocument();
    expect(screen.queryByText("All caught up")).not.toBeInTheDocument();
    // The same row WITH a category is not a review item.
    expect(screen.queryByText("LULU")).not.toBeInTheDocument();
    // And the card says the true thing about it: it was read fine, it just has
    // no category. Nothing about signatures or encodings.
    expect(screen.getByText("Needs a category")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets the deck answer it, through the one categorisation author", async () => {
    const user = userEvent.setup();
    const writer = recorder();
    mount(await cleanProjection(), writer);
    await screen.findByText("ADNOC");

    await user.click(screen.getByRole("button", { name: /Need — sort this transaction/ }));
    await user.click(await screen.findByRole("button", { name: "Groceries" }));

    await waitFor(() => expect(writer.queued.length).toBe(2));
    expect(writer.queued[0]).toMatchObject({
      type: "txn_categorized",
      entity: { kind: "txn", id: "c1" },
      parentVersion: 1,
      payload: { category: "Groceries", needs_review: false },
    });
    // The same op group the flagged lane authors — `categorizeOps`, not a
    // second author bolted on for this lane.
    expect(writer.queued[1]).toMatchObject({ type: "rule_added", payload: { match: "exact", category: "Groceries" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the queue is clear only when it is", async () => {
    const source = await projection();
    const empty: ReviewSource = {
      ...source,
      page: async () => [],
      counts: async () => ({ needs_review: 0, unparsed: 0, duplicate: 0, uncategorized: 0, forks: 0 }),
    };
    mount(empty, recorder());
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call a failed read an empty queue", async () => {
    const source = await projection();
    const broken: ReviewSource = {
      ...source,
      counts: async () => {
        throw new Error("projection unreadable");
      },
    };
    mount(broken, recorder());
    expect(await screen.findByText("Couldn't read your review queue")).toBeInTheDocument();
    expect(screen.queryByText("All caught up")).not.toBeInTheDocument();
  });
});
