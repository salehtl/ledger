/**
 * The shell, mounted the way production mounts it: inside the v2 context, over
 * a real projection.
 *
 * # Why this test changed shape in Task 10
 *
 * It used to render `<AppShell />` bare, with `fetch` stubbed to return empty
 * v1 payloads. That made every screen underneath take its "your local ledger
 * isn't open" branch — so the most integrated test in the suite covered only the
 * configuration production never has, and none of the configuration it always
 * has. It also kept `AppShell`'s v1 pull-to-refresh path alive: the path existed
 * because this test needed it, and the warning it logged said as much.
 *
 * Now the shell asserts its own invariant with `useV2OrThrow`, this test
 * provides the runtime, and the fixture rows are the only place the numbers
 * below exist — a shell that reached for `/api/summary` could not satisfy them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SqlDriver } from "@ledger/client/store/driver";

import { MotionProvider } from "./MotionProvider";
import { ToastProvider } from "../components/Toast";
import { projectionWith } from "../test/projectionFixture";
import { fakeRuntime, WithV2 } from "../test/v2Runtime";
import { AppShell } from "./AppShell";

let db: SqlDriver;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  sessionStorage.clear();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ address: "u-abc@in.sirdab.ae" })));
  vi.stubGlobal("fetch", fetchMock);
  db = await projectionWith();
});

function wrap() {
  const { runtime, runs } = fakeRuntime({ driver: db, facts: { inboundAddress: "u-abc@in.sirdab.ae" } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <WithV2 runtime={runtime}>
            <AppShell />
          </WithV2>
        </ToastProvider>
      </QueryClientProvider>
    </MotionProvider>,
  );
  return { ...view, runs };
}

describe("AppShell", () => {
  it("routes only the projection-backed screens, and starts on Home", async () => {
    wrap();
    for (const name of [/^home$/i, /^transactions$/i, /review/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // Unrouted in v2: no op authors a plan, a project, a schedule, an account
    // balance or an insight, so none of these may be reachable from the shell.
    for (const name of [/^plan$/i, /^insights$/i, /^reports$/i, /^projects$/i, /^recurring$/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // Home is showing, and the figure comes from the projection this test built.
    expect(await screen.findByText("174.99")).toBeInTheDocument();
  });

  it("badges Review from the local projection, not from /api/transactions", async () => {
    wrap();
    // One `needs_review` row in the fixture.
    const review = await screen.findByRole("button", { name: /review, 1 need review/i });
    expect(review).toHaveTextContent("1");
  });

  it("switches screens when a tab is tapped", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /^transactions$/i }));
    expect(await screen.findByRole("heading", { name: /^transactions$/i })).toBeInTheDocument();
  });

  it("offers the period stepper only where a period means something", async () => {
    wrap();
    // Home sums the whole log and Review is a state rather than a period —
    // both said so in their own headers. A control that changes nothing is
    // worse than an absent one.
    expect(screen.queryByRole("button", { name: /\d{4}/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^transactions$/i }));
    const label = await screen.findByRole("button", { name: /\d{4}/ });
    fireEvent.click(label);
    expect(await screen.findByText(/choose period/i)).toBeInTheDocument();
  });

  it("pulls to SYNC, not to refetch a v1 endpoint", async () => {
    const { runs } = wrap();
    await screen.findByRole("button", { name: /^home$/i });

    const main = screen.getByRole("main");
    fireEvent.touchStart(main, { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.touchMove(main, { touches: [{ clientX: 0, clientY: 400 }] }); // past threshold
    fireEvent.touchEnd(main);

    await waitFor(() => {
      expect(runs).toContain("refresh");
    });
  });

  it("opens Settings from the gear, showing the v2 surface rather than v1's hub", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /^settings$/i }));
    expect(await screen.findByRole("heading", { name: /^settings$/i })).toBeInTheDocument();
    expect(await screen.findByTestId("settings-inbound-address")).toHaveTextContent("u-abc@in.sirdab.ae");
    // v1's hub rows must not be here: every one of them reads a route ledgerd
    // does not serve.
    expect(screen.queryByText(/budget & income/i)).toBeNull();
    expect(screen.queryByText(/ai & api usage/i)).toBeNull();
  });

  it("reaches held mail from Settings — the surface onboarding hands off to", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /^settings$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /held mail/i }));
    expect(await screen.findByRole("heading", { name: /held mail/i })).toBeInTheDocument();
    // Backing out of held mail reveals Settings, which is still mounted.
    fireEvent.click(screen.getByRole("button", { name: /back from held mail/i }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /held mail/i })).toBeNull();
    });
    expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument();
  });

  it("touches no v1 HTTP route", async () => {
    wrap();
    await screen.findByText("174.99");
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => !u.startsWith("/api/v1/"))).toEqual([]);
  });

  it("refuses to render outside the gate rather than degrading to v1", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <MotionProvider>
          <QueryClientProvider client={qc}>
            <ToastProvider>
              <AppShell />
            </ToastProvider>
          </QueryClientProvider>
        </MotionProvider>,
      ),
    ).toThrow(/BootGate/);
    quiet.mockRestore();
  });
});
