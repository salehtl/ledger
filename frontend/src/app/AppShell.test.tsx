import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { AppShell } from "./AppShell";

const warnIngest = {
  configured: true, count: 5, last_at: "2026-07-05T08:00:00Z",
  status: "warn", reasons: ["poll_stale"],
  last_poll_success_at: "2026-07-05T06:00:00Z",
  last_poll_attempt_at: "2026-07-05T09:00:00Z",
  consecutive_failures: 0, poll_interval_seconds: 60, silence_days: 3,
};

beforeEach(() => {
  sessionStorage.clear();
  // Every screen hits the API on mount; return empty payloads.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/summary")) return new Response(JSON.stringify({ period: "2026-06", income: 0, month_progress: 0, buckets: [], recent: [] }));
    if (url.includes("/api/health")) return new Response(JSON.stringify({ status: "ok", db: "ok", ingest: warnIngest }));
    if (url.includes("/api/events")) return new Response("");
    return new Response("[]");
  }));
  // EventSource isn't in jsdom; stub it so useLiveEvents doesn't throw.
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} set onerror(_v: unknown) {} });
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><ToastProvider><AppShell /></ToastProvider></QueryClientProvider>,
  );
}

describe("AppShell", () => {
  it("shows five tabs and starts on Home", async () => {
    wrap();
    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /transactions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /insights/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
  });

  it("opens the Review screen under the persistent TopBar", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    // TopBar renders the active screen's title as the page heading and keeps the scope control.
    expect(await screen.findByRole("heading", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\d{4}/ })).toBeInTheDocument(); // month label still present
  });

  it("switches screens when a tab is tapped", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    // The TopBar renders the active screen's title as the page heading.
    expect(await screen.findByRole("heading", { name: /settings/i })).toBeInTheDocument();
  });

  it("exposes the global period control and opens the picker", async () => {
    wrap();
    // The TopBar shows the current month as a tappable label; tapping opens the sheet.
    const label = screen.getByRole("button", { name: /\d{4}/ }); // e.g. "Jun 2026"
    fireEvent.click(label);
    expect(await screen.findByText(/choose period/i)).toBeInTheDocument();
  });

  it("refetches data when the user pulls down from the top", async () => {
    wrap();
    await screen.findByRole("button", { name: /home/i });
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    const summaryCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/summary")).length;
    await waitFor(() => expect(summaryCalls()).toBeGreaterThan(0));
    const before = summaryCalls();

    const main = screen.getByRole("main");
    fireEvent.touchStart(main, { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.touchMove(main, { touches: [{ clientX: 0, clientY: 400 }] }); // past threshold
    fireEvent.touchEnd(main);

    await waitFor(() => expect(summaryCalls()).toBeGreaterThan(before));
  });

  it("does not replay a stale settings deep-link after closing and reopening Settings", async () => {
    wrap();
    // Tap the ingest warning banner: opens the Settings overlay straight into the Email ingest drill-in.
    fireEvent.click(await screen.findByRole("button", { name: /ingest details/i }));
    expect(await screen.findByRole("heading", { name: /email ingest/i })).toBeInTheDocument();

    // Back out of the drill-in, then out of Settings entirely.
    fireEvent.click(screen.getByRole("button", { name: /back from email ingest/i }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /email ingest/i })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /back from settings/i }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /^settings$/i })).toBeNull());

    // Reopen via the TopBar gear: the stale intent must not replay — hub, not the drill-in.
    fireEvent.click(screen.getByRole("button", { name: /^settings$/i }));
    expect(await screen.findByRole("heading", { name: /^settings$/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /email ingest/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /back from email ingest/i })).toBeNull();
  });

  it("opens the Projects overlay from the Settings hub without switching tabs, and unmounts it on close", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    await screen.findByRole("heading", { name: /^settings$/i });

    fireEvent.click(await screen.findByText(/^projects$/i));
    expect(await screen.findByRole("heading", { name: /^projects$/i })).toBeInTheDocument();
    // Still on the Settings tab underneath — opening Projects must not switch tabs.
    expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /back from projects/i }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /^projects$/i })).toBeNull());
  });
});
