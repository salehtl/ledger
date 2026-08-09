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
import { AppShell, type AppShellProps } from "./AppShell";

let db: SqlDriver;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  sessionStorage.clear();
  // The shell's default setup-list dismissal store is localStorage; a
  // dismissal leaked from one test would blank the list in the next.
  localStorage.clear();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ address: "u-abc@in.sirdab.ae" })));
  vi.stubGlobal("fetch", fetchMock);
  db = await projectionWith();
});

function wrap(shellProps: AppShellProps = {}) {
  const { runtime, runs } = fakeRuntime({ driver: db, facts: { inboundAddress: "u-abc@in.sirdab.ae" } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <WithV2 runtime={runtime}>
            <AppShell {...shellProps} />
          </WithV2>
        </ToastProvider>
      </QueryClientProvider>
    </MotionProvider>,
  );
  return { ...view, runs };
}

/** A durable-enough store for one test: the same shape the shell defaults to. */
function memorySecrets() {
  const held = new Map<string, string>();
  return {
    get: (k: string) => held.get(k) ?? null,
    set: (k: string, v: string | null) => {
      if (v === null) held.delete(k);
      else held.set(k, v);
    },
  };
}

describe("AppShell", () => {
  it("routes only the projection-backed screens, and starts on Home", async () => {
    wrap();
    for (const name of [/^home$/i, /^transactions$/i, /^insights$/i, /review/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // Unrouted in v2: no op authors a plan, a project, a schedule or an account
    // balance, so none of these may be reachable from the shell. Insights IS
    // routed — every figure on it is a sum over `txn_*` ops (Task 4).
    for (const name of [/^plan$/i, /^reports$/i, /^projects$/i, /^recurring$/i]) {
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
    // both say so in their own headers. A control that changes nothing is
    // worse than an absent one. Transactions and Insights are both bounded by
    // a month, so both get it.
    expect(screen.queryByRole("button", { name: /\d{4}/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^transactions$/i }));
    const label = await screen.findByRole("button", { name: /\d{4}/ });
    fireEvent.click(label);
    expect(await screen.findByText(/choose period/i)).toBeInTheDocument();
  });

  it("routes Insights to the projection, with no v1 report tiles behind it", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /^insights$/i }));
    // The lens picker only renders once the projection read has resolved, so
    // finding it proves the screen is live on the local data. The fixture's
    // own figures are asserted in `screens/Insights.test.tsx`, which pins the
    // month; here the shell hands it whatever month it is today.
    expect(await screen.findByText(/analyze by/i)).toBeInTheDocument();
    expect(screen.queryByText(/Net worth|Age of money/)).toBeNull();
    expect(screen.queryByText(/your local ledger isn't open/i)).toBeNull();
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

  it("carries the setup list on the home screen, and its mail line opens held mail", async () => {
    wrap({ secrets: memorySecrets() });
    // The fixture facts leave banks and forwarding undone and mail unarrived,
    // so the list and the quiet waiting line are both on home.
    expect(await screen.findByText(/finish setting up/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting for your first bank email/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /see what is waiting/i }));
    expect(await screen.findByRole("heading", { name: /held mail/i })).toBeInTheDocument();
  });

  it("opens Settings from a setup task — where every skipped step is finishable", async () => {
    wrap({ secrets: memorySecrets() });
    fireEvent.click(await screen.findByTestId("setup-task-banks_declared"));
    expect(await screen.findByRole("heading", { name: /^settings$/i })).toBeInTheDocument();
  });

  it("dismisses the setup list for good — closing Settings does not bring it back", async () => {
    wrap({ secrets: memorySecrets() });
    await screen.findByText(/finish setting up/i);
    fireEvent.click(screen.getByRole("button", { name: /hide this/i }));
    expect(screen.queryByText(/finish setting up/i)).toBeNull();
    // The shell remounts the list when an overlay closes (so a dismissal made
    // in Settings lands here too) — a dismissal must survive that remount, or
    // it was never a dismissal.
    fireEvent.click(screen.getByRole("button", { name: /^settings$/i }));
    await screen.findByRole("heading", { name: /^settings$/i });
    fireEvent.click(screen.getByRole("button", { name: /back from settings/i }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /^settings$/i })).toBeNull();
    });
    expect(screen.queryByText(/finish setting up/i)).toBeNull();
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
