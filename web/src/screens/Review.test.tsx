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
import { render, screen, waitFor } from "@testing-library/react";
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

function mount(source: ReviewSource, writer: Writer) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MotionProvider>
        <ToastProvider>
          <Review source={source} writer={writer} />
        </ToastProvider>
      </MotionProvider>
    </QueryClientProvider>,
  );
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

  it("says the queue is clear only when it is", async () => {
    const source = await projection();
    const empty: ReviewSource = {
      ...source,
      page: async () => [],
      counts: async () => ({ needs_review: 0, unparsed: 0, duplicate: 0, forks: 0 }),
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
