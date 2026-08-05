import { NavigationContainer } from "@react-navigation/native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Navigation } from "./Navigation.tsx";
import { RuntimeProvider } from "./RuntimeProvider.tsx";
import { ThemeProvider } from "./Theme.tsx";
import type { AppRuntime } from "./runtime.ts";
import { EMPTY_FILTERS } from "../lib/transactions.ts";

it("mounts a complete returning account directly on Transactions with its runtime transaction source", async () => {
  const source = {
    list: () => ({ rows: [], next: null }), read: () => null, forks: () => [], facets: () => ({ categories: [], currencies: [] }),
    homeCurrency: () => "AED", edit: () => ({ ok: true, changed: false } as const), split: () => ({ ok: true, changed: false } as const),
    recomputeHome: () => ({ ok: false, error: "missing" } as const),
  };
  void EMPTY_FILTERS;
  const secrets = { get: (key: string) => key === "session_token" ? "held" : null, set: () => {} };
  const runtime = {
    client: { sessionToken: "held", userId: "user-1" }, secrets, txns: source,
    currencies: {
      read: () => ({ usable: true, homeCurrency: "AED", rates: [] }),
      setRate: () => ({ ok: false, error: "unused" } as const), unsetRate: () => ({ ok: false, error: "unused" } as const),
      recompute: () => ({ ok: false, error: "unused" } as const),
    },
    importIO: { enqueueMany: () => {}, newId: () => "new-id", yieldToUI: async () => {} },
    reprocess: { start: async (onProgress: (progress: { total: number; examined: number; emitted: number; unavailable: number }) => void) => {
      onProgress({ total: 1, examined: 1, emitted: 0, unavailable: 1 });
      return { total: 1, examined: 1, emitted: 0, unavailable: 1, cancelled: false };
    } },
    budget: { read: () => ({ usable: true, homeCurrency: "AED", buckets: { need: 100n, want: 50n, saving: 25n }, income: 1000n, unassigned: 0n, confirmedTransactions: 2, historyDays: 3, warming: true, excluded: { missingHomeRate: 1, unparsed: 1, unresolvedDuplicates: 0, sameDuplicates: 0 } }) },
    deviceIdentity: () => null,
    dispose: async () => {}, wipeAccount: async () => {},
  } as unknown as AppRuntime;
  const facts = { inboundAddress: "u@in.example", firstMailConfirmedAt: "2026-08-03T00:00:00Z", homeCurrency: "AED" };
  const bootstrapper = async () => ({ step: "ready", userId: "user-1", facts } as const);
  const mounted = await render(
    <ThemeProvider>
        <NavigationContainer>
          <RuntimeProvider runtime={runtime} bootstrapper={bootstrapper}>
            <Navigation />
          </RuntimeProvider>
        </NavigationContainer>
    </ThemeProvider>,
  );
  await waitFor(() => expect(screen.getByText("Transactions")).toBeTruthy());
  expect(screen.getByTestId("txn-search")).toBeTruthy();
  fireEvent.press(screen.getByTestId("open-currencies"));
  await waitFor(() => expect(screen.getByText("Currencies & FX")).toBeTruthy());
  expect(screen.getByText(/Home currency: AED/)).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Close currencies"));
  await waitFor(() => expect(screen.getByTestId("open-reprocess")).toBeTruthy());
  fireEvent.press(screen.getByTestId("open-reprocess"));
  await waitFor(() => expect(screen.getByText("Re-check past mail")).toBeTruthy());
  fireEvent.press(screen.getByText("Re-check mail"));
  await waitFor(() => expect(screen.getByText(/1 of 1 checked/)).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Close re-check"));
  await waitFor(() => expect(screen.getByTestId("open-budget")).toBeTruthy());
  fireEvent.press(screen.getByTestId("open-budget"));
  await waitFor(() => expect(screen.getByText("50 / 30 / 20")).toBeTruthy());
  expect(screen.getByTestId("budget-warming")).toBeTruthy();
  fireEvent.press(screen.getByTestId("budget-missing-rates"));
  await waitFor(() => expect(screen.getByText("Currencies & FX")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Close currencies"));
  await waitFor(() => expect(screen.getByText("Import a statement")).toBeTruthy());
  fireEvent.press(screen.getByText("Import a statement"));
  await waitFor(() => expect(screen.getByText("Import statement")).toBeTruthy());
  await mounted.unmount();
});
