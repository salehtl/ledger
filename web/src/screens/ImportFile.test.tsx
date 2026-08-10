/**
 * The import screen, driven the way a person drives it.
 *
 * The op layer's own contract is held in `v2/sources/importFile.test.ts`; what
 * is asserted here is that the SCREEN cannot get past a bad file, and that the
 * ops it hands the writer are the ones the preview promised. `fetch` throws
 * throughout: nothing on this path may reach the network, because the whole
 * claim of the feature is that the file stays on the device.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";
import type { OpSpec } from "@ledger/client/outbox/outbox";

import { MotionProvider } from "../app/MotionProvider";
import type { Writer } from "../v2/writer";
import { ImportFile } from "./ImportFile";

interface Recorder extends Writer {
  queued: OpSpec[];
  flushes: number;
}

function recorder(): Recorder {
  const queued: OpSpec[] = [];
  const r: Recorder = {
    queued,
    flushes: 0,
    pending: [],
    enqueueMany: (specs) => void queued.push(...specs),
    flush: async () => {
      r.flushes += 1;
    },
  };
  return r;
}

const GOOD =
  "Date,Description,Amount,Category\r\n" +
  "2026-08-03,CORNER COFFEE,-12.50,Eating out\r\n" +
  "2026-08-04,SALARY,9000.00,\r\n";

const BAD =
  "Date,Description,Amount\r\n" +
  "2026-08-03,CORNER COFFEE,-12.50\r\n" +
  "not-a-date,CARREFOUR,-9.00\r\n";

function mount(writer: Writer, text: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const bytes = new TextEncoder().encode(text);
  return render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ImportFile writer={writer} readFile={async () => bytes} />
      </QueryClientProvider>
    </MotionProvider>,
  );
}

/** Hands the screen a file. The bytes come from `readFile`, so the name is decoration. */
async function choose(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.upload(screen.getByTestId("import-file"), new File(["x"], "statement.csv", { type: "text/csv" }));
  await screen.findByTestId("import-preview");
  return user;
}

beforeEach(() => {
  setPlatform(webPlatform);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("importing must never reach the network");
    }),
  );
});

describe("a file with a row that cannot be read", () => {
  it("refuses the whole batch — the button is disabled and NO op is authored", async () => {
    const writer = recorder();
    mount(writer, BAD);
    await choose();

    expect(screen.getByTestId("import-problems")).toHaveTextContent("Row 2");
    const button = screen.getByTestId("import-commit");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Nothing to import yet");
    expect(writer.queued).toHaveLength(0);
  });

  it("says nothing will be imported, rather than offering the good rows", async () => {
    mount(recorder(), BAD);
    await choose();
    expect(screen.getByText("Nothing will be imported until these are fixed.")).toBeInTheDocument();
  });
});

describe("a file that reads cleanly", () => {
  it("previews the rows and the totals before anything is authored", async () => {
    const writer = recorder();
    mount(writer, GOOD);
    await choose();

    const preview = screen.getByTestId("import-preview");
    expect(preview).toHaveTextContent("2 rows ready");
    expect(preview).toHaveTextContent("CORNER COFFEE");
    expect(preview).toHaveTextContent("Out AED 12.50");
    expect(preview).toHaveTextContent("In AED 9,000.00");
    // Read, previewed, and still not written: consent comes first.
    expect(writer.queued).toHaveLength(0);
  });

  it("authors one txn_ingested per row on confirm, with the audit trail attached", async () => {
    const writer = recorder();
    mount(writer, GOOD);
    const user = await choose();

    await user.click(screen.getByTestId("import-commit"));
    await waitFor(() => expect(writer.queued).toHaveLength(2));

    for (const spec of writer.queued) {
      expect(spec.type).toBe("txn_ingested");
      expect(spec.ingestId).toMatch(/^[0-9a-f]{64}$/);
      const payload = spec.payload as Record<string, unknown>;
      expect(payload["entry_method"]).toBe("import");
      expect(payload["source_file_sha256"]).toMatch(/^[0-9a-f]{64}$/);
      expect(payload).not.toHaveProperty("verified_origin_domain");
    }
    expect((writer.queued[0]?.payload as Record<string, unknown>)["source_row_index"]).toBe(1);
    expect((writer.queued[1]?.payload as Record<string, unknown>)["source_row_index"]).toBe(2);
    // Money is a decimal STRING, never a JSON number.
    expect((writer.queued[0]?.payload as Record<string, unknown>)["amount_minor"]).toBe("1250");
    await screen.findByTestId("import-done");
  });

  it("does not offer the same batch twice", async () => {
    const writer = recorder();
    mount(writer, GOOD);
    const user = await choose();
    await user.click(screen.getByTestId("import-commit"));
    await screen.findByTestId("import-done");
    // The preview is gone with the file, so a second tap cannot re-author it.
    expect(screen.queryByTestId("import-preview")).not.toBeInTheDocument();
    expect(writer.queued).toHaveLength(2);
  });

  it("changing the column mapping re-validates before it re-offers", async () => {
    const writer = recorder();
    mount(writer, GOOD);
    const user = await choose();

    // Point "Amount" at the description column: every row stops being money.
    await user.selectOptions(screen.getByLabelText("Amount"), "Description");
    await waitFor(() => expect(screen.getByTestId("import-commit")).toBeDisabled());
    expect(writer.queued).toHaveLength(0);
  });
});
