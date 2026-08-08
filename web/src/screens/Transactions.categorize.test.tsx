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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { OpSpec } from "@ledger/client/outbox/outbox";
import type { SqlDriver } from "@ledger/client/store/driver";
import type { Op } from "@ledger/client/wire/op";

import { MotionProvider } from "../app/MotionProvider";
import { ToastProvider } from "../components/Toast";
import { FIXTURE_ROWS, projectionWith } from "../test/projectionFixture";
import { sqlBudgetSource } from "../v2/sources/budget";
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
function recorder(pending: Op[] = [], opts: { clearOnFlush?: boolean } = {}): Recorder {
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
    // `clearOnFlush` is what the REAL push does and what the default double
    // does not: `Outbox.flush` calls `Client.push()`, `client.ts` strips the
    // sent ops from `st.pending` on the ack, and nothing there pulls or
    // projects — only `net/engine.ts` projects, on launch, `visibilitychange`
    // and pull-to-refresh. So between the ack and the next full sync the
    // outbox is EMPTY while the projection is still stale, and anything keyed
    // purely on `pending` evaporates in that window.
    flush: async () => {
      if (opts.clearOnFlush === true) live = [];
    },
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
    // ONE op. A correction must not also write a rule — see the next test.
    expect(writer.queued.length).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not write a contradicting rule when a category is corrected", async () => {
    // `rule_added` is permanent: there is no delete op and no edit op. Two
    // `exact` rules on one pattern at one priority are resolved by comparing the
    // categories' CODE POINTS (client/src/categorize/rules.ts), so a second rule
    // does not replace the first — it hands the merchant to whichever category
    // sorts first, forever. A user correcting a category would be silently
    // poisoning that merchant, and `rules.ts`'s promise that it never decides
    // between two categories a user could have distinguished would be false.
    const writer = recorder();
    mount(await projectionWith(FIXTURE_ROWS), writer);
    const user = await openSheetFor("CARREFOUR");

    // Off by default on a row that already has a category.
    expect(screen.getByRole("checkbox", { name: /Always use this category/ })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "entertainment" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writer.queued.length).toBe(1));
    expect(writer.queued.map((s) => s.type)).toEqual(["txn_categorized"]);
  });

  it("stops offering a rule once this merchant has one, queued or folded", async () => {
    // The offline loop that produces the contradiction: the first answer's
    // `rule_added` has not folded, so the projection still knows nothing about
    // it. The outbox does.
    const writer = recorder();
    mount(await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]), writer);
    let user = await openSheetFor("DIB CARD PURCHASE");
    await user.click(screen.getByRole("button", { name: "groceries" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writer.queued.length).toBe(2));

    user = await openSheetFor("DIB CARD PURCHASE");
    expect(screen.queryByRole("checkbox", { name: /Always use this category/ })).toBeNull();
    expect(screen.getByText(/A rule already files .* under groceries/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "entertainment" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    // A third op, and it is the categorisation — never a second rule.
    await waitFor(() => expect(writer.queued.length).toBe(3));
    expect(writer.queued[2]!.type).toBe("txn_categorized");
  });

  it("shows the answer on the row before the projection has folded it", async () => {
    // The projection only moves when a sync folds, so the row's SQLite category
    // is still null right after a save — offline, for the whole session. A user
    // who sees no change answers again, which is how two rules get written.
    const writer = recorder();
    mount(await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]), writer);
    const user = await openSheetFor("DIB CARD PURCHASE");
    // Its own row, by its own date: SPINNEYS is uncategorised too.
    expect(screen.getByText("Uncategorized · 2026-08-07")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "groceries" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The row now reads the answer the outbox holds — and the projection has
    // not been touched, which is what makes this the outbox talking.
    await waitFor(() => expect(screen.queryByText("Uncategorized · 2026-08-07")).toBeNull());
    expect(screen.getByText(/groceries · 2026-08-07/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the answer after the push empties the outbox, and still writes no second rule", async () => {
    // THE window, and it is the ONLINE path, i.e. the normal one. `flush`
    // succeeds, `pending` goes empty, and the projection has not folded
    // anything yet — nothing between push and the next sync projects. A screen
    // keyed purely on `pending` reverts the row to "Uncategorized" here, the
    // rule switch comes back defaulted ON because `txn.category` is null again,
    // and the user — seeing no change — answers again. That is two permanent
    // `exact` rules on one pattern, decided by the alphabet.
    const writer = recorder([], { clearOnFlush: true });
    mount(await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]), writer);
    let user = await openSheetFor("DIB CARD PURCHASE");
    await user.click(screen.getByRole("button", { name: "groceries" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writer.queued.length).toBe(2));

    // The push landed: the outbox is empty and the projection is untouched.
    await waitFor(() => expect(writer.pending.length).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    expect(await screen.findByText("groceries · 2026-08-07")).toBeInTheDocument();
    expect(screen.queryByText("Uncategorized · 2026-08-07")).toBeNull();

    user = await openSheetFor("DIB CARD PURCHASE");
    expect(screen.queryByRole("checkbox", { name: /Always use this category/ })).toBeNull();
    expect(screen.getByText(/A rule already files .* under groceries/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "entertainment" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writer.queued.length).toBe(3));
    // One rule for this merchant, ever.
    expect(writer.queued.filter((s) => s.type === "rule_added").length).toBe(1);
    expect(writer.queued[2]!.type).toBe("txn_categorized");
  });

  it("stops claiming an answer once the projection has folded it", async () => {
    // The other half of "do not claim more than you know". The remembered
    // answer is evidence only while the projection is BEHIND the version the
    // op produces; once the row is at or past it, the projection is the truth —
    // including when a peer's op won the fork and the category is not the one
    // this device asked for.
    const writer = recorder([], { clearOnFlush: true });
    const db = await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]);
    const source = sqlTxnSource(db);
    let folded = false;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MotionProvider>
        <QueryClientProvider client={qc}>
          <ToastProvider>
            <Transactions
              source={{
                ...source,
                list: (filters, opts) => {
                  const page = source.list(filters, opts);
                  if (!folded) return page;
                  // A sync folded a DIFFERENT answer at the version this
                  // device's op produced.
                  return {
                    ...page,
                    rows: page.rows.map((t) =>
                      t.id === "t7" ? { ...t, category: "shopping", needs_review: false, version: 2 } : t,
                    ),
                  };
                },
              }}
              reviewSource={sqlReviewSource(db)}
              writer={writer}
            />
          </ToastProvider>
        </QueryClientProvider>
      </MotionProvider>,
    );

    const user = await openSheetFor("DIB CARD PURCHASE");
    await user.click(screen.getByRole("button", { name: "groceries" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writer.pending.length).toBe(0));
    expect(await screen.findByText("groceries · 2026-08-07")).toBeInTheDocument();

    folded = true;
    await qc.invalidateQueries();
    // The projection is at the version this device's op produced, so the
    // remembered answer is spent and what the log actually holds is shown.
    expect(await screen.findByText("shopping · 2026-08-07")).toBeInTheDocument();
    expect(screen.queryByText("groceries · 2026-08-07")).toBeNull();
  });

  it("offers a category the user defined, and stops offering a retired one", async () => {
    const db = await projectionWith([...FIXTURE_ROWS, TRUSTED_UNCATEGORISED]);
    const define = (id: string, ord: number, name: string, active: number) =>
      db
        .prepare("INSERT INTO category (id,ord,name,kind,bucket,color,active) VALUES (?,?,?,'spending','need',NULL,?)")
        .run(id, ord, name, active);
    define("c1", 0, "Gym", 1);
    // "Groceries" is in the built-in seed, so retiring it proves a retirement
    // withholds a name the grid would otherwise supply itself.
    define("c2", 1, "Groceries", 0);

    mount(db, recorder());
    await openSheetFor("DIB CARD PURCHASE");

    expect(screen.getByRole("button", { name: "Gym" })).toBeInTheDocument();
    // Case-insensitive: the same name arrives from the user's history as
    // "groceries" and from the built-in seed as "Groceries", and a retirement
    // has to withhold both.
    expect(screen.queryByRole("button", { name: /^groceries$/i })).toBeNull();
    // …and the sheet did not lose the rest of the grid along with it.
    expect(screen.getByRole("button", { name: "Dining" })).toBeInTheDocument();
  });

  it("gives a user-defined category the SAME bucket the 50/30/20 read gives it", async () => {
    // The divergence this exists to forbid: Home counts "Gym" as a need
    // because `budgetMappingFor` layers the user's definitions over the
    // built-in table, and this row drew the grey no-bucket stripe because it
    // read `DEFAULT_BUDGET_MAPPING` directly. One transaction, two answers.
    //
    // Asserted on the HUE, not the maths — the maths already agreed.
    const db = await projectionWith([
      ...FIXTURE_ROWS,
      { id: "t8", amount: "5000", posted_at: "2026-08-08T10:00:00Z", merchant: "FITNESS FIRST", category: "Gym" },
    ]);
    db.prepare("INSERT INTO category (id,ord,name,kind,bucket,color,active) VALUES ('c1',0,'Gym','spending','need',NULL,1)").run();

    mount(db, recorder());
    const row = await screen.findByRole("button", { name: "Open FITNESS FIRST" });
    const stripe = row.querySelector("span[aria-hidden]");
    expect(stripe).not.toBeNull();
    expect((stripe as HTMLElement).style.background).toBe("var(--color-need)");

    // The same category on the same projection, through the budget read.
    expect(sqlBudgetSource(db).read(Date.parse("2026-08-20T00:00:00Z")).buckets.need).toBe(5000n + 12500n);
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
