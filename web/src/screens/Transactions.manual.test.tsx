/**
 * Adding and correcting a transaction by hand, from the list screen.
 *
 * Same contract as the rest of this screen's tests: the projection is built from
 * real ops through `fold` + `project`, and `fetch` is never called — a screen
 * that quietly POSTed to v1's `/api/transactions` would pass a test that only
 * looked at the DOM.
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
import { projectionWith } from "../test/projectionFixture";
import { sqlReviewSource } from "../v2/sources/review";
import { sqlTxnSource } from "../v2/sources/transactions";
import type { Writer } from "../v2/writer";
import { Transactions } from "./Transactions";

interface Recorder extends Writer {
  queued: OpSpec[];
}

/**
 * The writer double the other list tests use. `clearOnFlush` is what the REAL
 * push does: `client.ts` strips the acked ops from `pending`, and nothing on
 * that path projects — so between the ack and the next sync the outbox is empty
 * while the projection is still stale.
 */
function recorder(opts: { clearOnFlush?: boolean } = {}): Recorder {
  const queued: OpSpec[] = [];
  let live: Op[] = [];
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
            authored_at: "2026-08-09T00:00:00.000Z",
            parent_version: spec.parentVersion ?? null,
            payload: spec.payload,
            ...(spec.entity === undefined ? {} : { entity: spec.entity }),
          },
        ];
      }
    },
    flush: async () => {
      if (opts.clearOnFlush === true) live = [];
    },
  };
}

function mount(db: SqlDriver, writer: Writer) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <Transactions source={sqlTxnSource(db)} reviewSource={sqlReviewSource(db)} writer={writer} />
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

async function openAddSheet() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add transaction" }));
  await screen.findByRole("dialog");
  return user;
}

describe("adding a transaction by hand", () => {
  it("authors a client-side txn_ingested with a random 64-hex ingest id and no origin claim", async () => {
    const writer = recorder();
    mount(await projectionWith(), writer);
    const user = await openAddSheet();

    await user.type(screen.getByLabelText("Amount"), "12.50");
    await user.type(screen.getByLabelText("Merchant"), "CORNER COFFEE");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(writer.queued).toHaveLength(1));
    const spec = writer.queued[0]!;
    expect(spec.type).toBe("txn_ingested");
    expect(spec.parentVersion).toBeNull();
    expect(spec.ingestId).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.payload).toMatchObject({
      amount_minor: "1250",
      currency: "AED",
      direction: "debit",
      merchant_raw: "CORNER COFFEE",
      tier: "none",
      unparsed: false,
      entry_method: "manual",
    });
    expect(spec.payload).not.toHaveProperty("verified_origin_domain");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives two identical entries two different ingest ids", async () => {
    const writer = recorder();
    mount(await projectionWith(), writer);

    for (let i = 0; i < 2; i++) {
      const user = await openAddSheet();
      await user.type(screen.getByLabelText("Amount"), "12.50");
      await user.type(screen.getByLabelText("Merchant"), "CORNER COFFEE");
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(writer.queued).toHaveLength(i + 1));
    }
    // A content hash of identical fields would make these equal, and replay
    // answers a repeated ingest id by DROPPING the op as `duplicate_ingest`.
    expect(writer.queued[0]!.ingestId).not.toBe(writer.queued[1]!.ingestId);
    expect(writer.queued[0]!.entity!.id).not.toBe(writer.queued[1]!.entity!.id);
  });

  it("shows the new row while the projection is still stale, and keeps it after the push ack", async () => {
    // `clearOnFlush` empties `pending` the way a real ack does. Anything derived
    // from the outbox alone disappears in that window; the row must not.
    const writer = recorder({ clearOnFlush: true });
    mount(await projectionWith(), writer);
    const user = await openAddSheet();

    await user.type(screen.getByLabelText("Amount"), "12.50");
    await user.type(screen.getByLabelText("Merchant"), "CORNER COFFEE");
    await user.click(screen.getByRole("button", { name: "Add" }));

    // It is in no SQLite table — the fixture never folded it — so this can only
    // be the optimistic copy.
    expect(await screen.findByText("CORNER COFFEE")).toBeInTheDocument();
    await waitFor(() => expect(writer.pending).toHaveLength(0));
    expect(screen.getByText("CORNER COFFEE")).toBeInTheDocument();
    expect(screen.getByText("Added by you")).toBeInTheDocument();
  });

  it("refuses an empty amount in words rather than saving a zero", async () => {
    const writer = recorder();
    mount(await projectionWith(), writer);
    const user = await openAddSheet();

    const amount = screen.getByLabelText("Amount") as HTMLInputElement;
    await user.type(amount, "40");
    await user.clear(amount);

    // The springback: with a `number` behind this field, `Number("")` is 0 and
    // the 0 is rendered straight back, so the field cannot be emptied at all.
    expect(amount.value).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent("How much was it?");

    await user.type(screen.getByLabelText("Merchant"), "CORNER COFFEE");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(writer.queued).toHaveLength(0);
    expect(await screen.findByRole("alert")).toHaveTextContent("How much was it?");
  });
});

describe("correcting a hand-typed transaction", () => {
  it("opens the whole row, edits what txn_edited owns, and locks the money", async () => {
    const writer = recorder();
    mount(await projectionWith(), writer);
    let user = await openAddSheet();
    await user.type(screen.getByLabelText("Amount"), "12.50");
    await user.type(screen.getByLabelText("Merchant"), "CORNER COFEE");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText("CORNER COFEE");

    user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open CORNER COFEE" }));
    await screen.findByRole("dialog");
    // The typo sheet, not the categorizer: a hand-typed row opens as a whole row.
    expect(screen.getByRole("heading", { name: "Edit transaction" })).toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toBeDisabled();
    expect(screen.getByLabelText("Currency")).toBeDisabled();
    expect(screen.getByLabelText("Type")).toBeDisabled();

    const merchant = screen.getByLabelText("Merchant");
    await user.clear(merchant);
    await user.type(merchant, "CORNER COFFEE");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writer.queued).toHaveLength(2));
    const edit = writer.queued[1]!;
    expect(edit.type).toBe("txn_edited");
    expect(edit.payload).toEqual({ merchant_raw: "CORNER COFFEE" });
    // The list shows the correction straight away, not after the next sync.
    expect(await screen.findByText("CORNER COFFEE")).toBeInTheDocument();
  });

  it("appends nothing when the sheet is saved unchanged", async () => {
    const writer = recorder();
    mount(await projectionWith(), writer);
    const user = await openAddSheet();
    await user.type(screen.getByLabelText("Amount"), "12.50");
    await user.type(screen.getByLabelText("Merchant"), "CORNER COFFEE");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText("CORNER COFFEE");

    await user.click(screen.getByRole("button", { name: "Open CORNER COFFEE" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writer.queued).toHaveLength(1);
  });

  it("leaves a bank row on the categorizer", async () => {
    const writer = recorder();
    mount(await projectionWith(), writer);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open CARREFOUR" }));

    expect(await screen.findByRole("heading", { name: "Categorize" })).toBeInTheDocument();
  });
});
