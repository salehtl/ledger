/**
 * Categorising from the transaction list.
 *
 * # The gap this covers
 *
 * `txn_categorized` worked from the day it landed, but the only screen that
 * authored it was the review deck, and the deck is fed by the `needs_review`
 * lane. A template-tier parse is trusted and never flagged — the operator's own
 * DIB alert matched `dib.card.v1` with no empty capture groups — so a cleanly
 * parsed transaction could be *seen* on this screen and categorised on none.
 *
 * The rows here are therefore the ones the deck cannot reach: `needs_review = 0`,
 * one with no category and one already categorised.
 *
 * Same contract as the rest of this screen's tests: the projection is built from
 * real ops through `fold`+`project`, and `fetch` is never called.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { OpSpec } from "@ledger/client/outbox/outbox";
import type { SqlDriver } from "@ledger/client/store/driver";
import type { Op } from "@ledger/client/wire/op";

import { MotionProvider } from "../app/MotionProvider";
import { ToastProvider } from "../components/Toast";
import { FIXTURE_ROWS, projectionWith } from "../test/projectionFixture";
import { sqlReviewSource, type ReviewSource } from "../v2/sources/review";
import { sqlTxnSource } from "../v2/sources/transactions";
import type { Writer } from "../v2/writer";
import { Transactions } from "./Transactions";

/**
 * The row the live bug was about: template-parsed, trusted, uncategorised — and
 * so invisible to the review deck.
 */
const TRUSTED_UNCATEGORISED = {
  id: "t7",
  amount: "2500",
  posted_at: "2026-08-07T10:00:00Z",
  merchant: "DIB CARD PURCHASE",
  category: null,
  needs_review: false,
};

interface Recorder extends Writer {
  queued: OpSpec[];
}

/**
 * The same writer double `Review.test.tsx` uses, and for the same reason: the
 * real `Outbox.pending` GROWS as ops are queued (`Client.emitMany` REPLACES the
 * array), and `nextParentVersion` reads it. A double whose `pending` never moved
 * would make a second edit in one session look correct while forking in
 * production.
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
        live = [
          ...live,
          {
            v: 1,
            type: spec.type as Op["type"],
            op_id: `emitted-${++n}`,
            authored_at: "2026-08-07T00:00:00.000Z",
            parent_version: spec.parentVersion ?? null,
            payload: spec.payload,
            ...(spec.entity === undefined ? {} : { entity: spec.entity }),
          },
        ];
      }
    },
    flush: async () => undefined,
  };
}

function mount(db: SqlDriver, writer: Writer, review?: ReviewSource) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <Transactions source={sqlTxnSource(db)} reviewSource={review ?? sqlReviewSource(db)} writer={writer} />
        </ToastProvider>
      </QueryClientProvider>
    </MotionProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => {
    throw new Error("this screen must never reach the network");
  });
  vi.stubGlobal("fetch", fetchMock);
});

async function openSheetFor(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: `Open ${name}` }));
  await screen.findByRole("dialog");
  return user;
}

describe("categorising from the transaction list", () => {
  it("offers a category on a row the review deck can never show", async () => {
    const writer = recorder();
    mount(await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]), writer);
    const user = await openSheetFor("DIB CARD PURCHASE");

    await user.click(screen.getByRole("button", { name: "groceries" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writer.queued.length).toBeGreaterThan(0));
    expect(writer.queued[0]).toMatchObject({
      type: "txn_categorized",
      entity: { kind: "txn", id: "t7" },
      // The version the projection holds for an ingested row, read fresh.
      parentVersion: 1,
      payload: { category: "groceries", needs_review: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the parent version from the projection, never from the rendered row", async () => {
    // THE assertion. The row this screen rendered carries version 1. If the
    // commit takes its parent from that object it is naming a version that may
    // be minutes old, which is a fork against yourself — and inside one
    // millisecond the later op is the one replay discards.
    const db = await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]);
    const base = sqlReviewSource(db);
    const writer = recorder();
    mount(db, writer, { ...base, version: async () => 9 });
    const user = await openSheetFor("DIB CARD PURCHASE");

    await user.click(screen.getByRole("button", { name: "groceries" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writer.queued.length).toBeGreaterThan(0));
    expect(writer.queued[0]!.parentVersion).toBe(9);
  });

  it("writes the merchant rule with the categorisation, in one enqueue", async () => {
    const writer = recorder();
    mount(await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]), writer);
    const user = await openSheetFor("DIB CARD PURCHASE");

    await user.click(screen.getByRole("button", { name: "groceries" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Both ops in the SAME group: an app killed between two flushes would leave
    // a categorised transaction with no rule, and the merchant would ask again.
    await waitFor(() => expect(writer.queued.length).toBe(2));
    expect(writer.queued[1]).toMatchObject({
      type: "rule_added",
      // `subjectOf`'s canonical form, so the rule is tested against the string
      // the categorizer matches on rather than the prettier one on screen.
      payload: { pattern: "dib card purchase", match: "exact", category: "groceries", priority: 0 },
    });
  });

  it("writes no rule when the user turns the option off", async () => {
    const writer = recorder();
    mount(await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]), writer);
    const user = await openSheetFor("DIB CARD PURCHASE");

    await user.click(screen.getByRole("button", { name: "groceries" }));
    await user.click(screen.getByRole("checkbox", { name: /Always use this category/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writer.queued.length).toBe(1));
    expect(writer.queued[0]!.type).toBe("txn_categorized");
  });

  it("re-categorises a transaction that already has a category", async () => {
    // `txn_categorized` supersedes by parent version, so a category is a
    // correction like any other — nothing about the op requires the row to be
    // uncategorised, and a screen that refused would leave a wrong category
    // permanent.
    const writer = recorder();
    mount(await projectionWith(FIXTURE_ROWS), writer);
    const user = await openSheetFor("CARREFOUR");

    // The current category is preselected, so this reads as a change rather
    // than a blank form.
    expect(screen.getByRole("button", { name: "groceries" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "entertainment" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writer.queued.length).toBeGreaterThan(0));
    expect(writer.queued[0]).toMatchObject({
      type: "txn_categorized",
      entity: { kind: "txn", id: "t1" },
      parentVersion: 1,
      payload: { category: "entertainment", needs_review: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not offer a categorisation it could not record", async () => {
    // No writer means no local ledger to append to. The row still renders; what
    // it no longer does is open a sheet, rather than opening one that silently
    // drops the answer.
    const db = await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MotionProvider>
        <QueryClientProvider client={qc}>
          <ToastProvider>
            <Transactions source={sqlTxnSource(db)} reviewSource={sqlReviewSource(db)} />
          </ToastProvider>
        </QueryClientProvider>
      </MotionProvider>,
    );
    expect(await screen.findByText("DIB CARD PURCHASE")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open DIB CARD PURCHASE" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
