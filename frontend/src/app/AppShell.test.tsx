import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { AppShell } from "./AppShell";

beforeEach(() => {
  // Every screen hits the API on mount; return empty payloads.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/summary")) return new Response(JSON.stringify({ period: "2026-06", income: 0, month_progress: 0, buckets: [], recent: [] }));
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
  it("shows four tabs and starts on Home", async () => {
    wrap();
    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /transactions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /insights/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
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
    fireEvent.touchStart(main, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(main, { touches: [{ clientY: 400 }] }); // past threshold
    fireEvent.touchEnd(main);

    await waitFor(() => expect(summaryCalls()).toBeGreaterThan(before));
  });
});
