import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionProvider } from "../../app/MotionProvider";
import { ToastProvider } from "../../components/Toast";
import type { Envelope } from "../../api/types";
import { TargetSheet } from "./TargetSheet";

const envelope = {
  category_id: 3,
  category_name: "Groceries",
  bucket: "need",
  carryover_fils: 0,
  assigned_fils: 0,
  activity_fils: 0,
  available_fils: 0,
  overspent: false,
  overspend_debt_fils: 0,
} as unknown as Envelope;

function renderSheet(month = "2026-08", env: Envelope = envelope) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MotionProvider>
        <ToastProvider>
          <TargetSheet envelope={env} month={month} onClose={() => {}} />
        </ToastProvider>
      </MotionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TargetSheet", () => {
  it("says which month the target applies from, so a scoped edit isn't a surprise", () => {
    renderSheet("2026-08");
    expect(screen.getByText(/applies from aug 2026 onward/i)).toBeInTheDocument();
  });

  it("sends the month it is editing with the target", async () => {
    renderSheet("2026-08");
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const put = calls.find((c) => c[1]?.method === "PUT");
      expect(put, "expected a PUT to /api/targets").toBeTruthy();
      expect(JSON.parse(put![1].body)).toMatchObject({ month: "2026-08", amount_fils: 150000 });
    });
  });

  it("scopes removal to the month being edited", async () => {
    const withTarget = {
      ...envelope,
      target: { type: "set_aside", amount_fils: 150000, cadence: "monthly", still_needed_fils: 0 },
    } as unknown as Envelope;
    renderSheet("2026-08", withTarget);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const del = calls.find((c) => c[1]?.method === "DELETE");
      expect(del, "expected a DELETE to /api/targets").toBeTruthy();
      expect(String(del![0])).toContain("month=2026-08");
    });
  });
});
