import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IngestHealthBanner } from "./IngestHealthBanner";

function healthPayload(ingest: object | null) {
  return { status: "ok", db: "ok", ...(ingest ? { ingest } : {}) };
}

const warnIngest = {
  configured: true, count: 5, last_at: "2026-07-05T08:00:00Z",
  status: "warn", reasons: ["poll_stale"],
  last_poll_success_at: "2026-07-05T06:00:00Z",
  last_poll_attempt_at: "2026-07-05T09:00:00Z",
  consecutive_failures: 0, poll_interval_seconds: 60, silence_days: 3,
};

function renderBanner(payload: unknown, onView = () => {}) {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  ));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IngestHealthBanner onView={onView} />
    </QueryClientProvider>,
  );
}

beforeEach(() => sessionStorage.clear());

describe("IngestHealthBanner", () => {
  it("renders nothing when healthy", async () => {
    renderBanner(healthPayload({ ...warnIngest, status: "ok", reasons: [] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a warning and navigates on tap", async () => {
    const onView = vi.fn();
    renderBanner(healthPayload(warnIngest), onView);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/stuck|failing|no bank email/i);
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(onView).toHaveBeenCalled();
  });

  it("dismisses and stays dismissed for the same reasons", async () => {
    const view = renderBanner(healthPayload(warnIngest));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();
    // Re-mount with the same warn payload: still dismissed (sessionStorage).
    view.unmount();
    renderBanner(healthPayload(warnIngest));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reappears when the reason set changes", async () => {
    const view = renderBanner(healthPayload(warnIngest));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    view.unmount();
    renderBanner(healthPayload({ ...warnIngest, reasons: ["poll_stale", "mail_silent"] }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
