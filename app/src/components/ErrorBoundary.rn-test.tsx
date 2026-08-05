/**
 * The boundary, against the throw it was actually added for.
 *
 * Not a component that throws on cue — the real `BudgetScreen`, reading a real
 * `BudgetSource` whose money guard trips. `BudgetScreen.tsx` calls
 * `source.read(nowMs)` synchronously during render and `budget/source.ts`'s
 * `exact()` fails CLOSED by throwing when an aggregate does not come back as a
 * decimal integer. That guard is load-bearing and must keep its teeth; what
 * this file proves is that tripping it produces a message the user can read and
 * a control they can press, rather than the blank tree React gives you when a
 * render error reaches the top uncaught.
 */

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ThemeProvider } from "../app/Theme.tsx";
import { BudgetScreen } from "../screens/budget/BudgetScreen.tsx";
import type { BudgetSource } from "../screens/budget/source.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const GUARD = "budget total 12.5 is not an integer number of minor units";

/** A source whose read fails the way the money guard fails: by throwing. */
function trippingSource(): BudgetSource {
  return { read: () => { throw new Error(GUARD); } } as unknown as BudgetSource;
}

/** React logs a caught render error; it is expected here and not a failure. */
function quietConsole() {
  const real = console.error;
  console.error = () => {};
  return () => { console.error = real; };
}

it("catches a money-guard throw out of BudgetScreen's render and shows it", async () => {
  const restore = quietConsole();
  try {
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <ErrorBoundary>
            <BudgetScreen source={trippingSource()} nowMs={0} onCurrencies={() => {}} onImport={() => {}} onClose={() => {}} />
          </ErrorBoundary>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
    // On screen, not merely "did not crash the runner".
    expect(screen.getByTestId("app-error-boundary")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    // The guard's own sentence, which is the entire diagnostic for the one
    // person in this beta. Swallowing it would leave "something went wrong" and
    // nothing else.
    expect(String(screen.getByTestId("app-error-detail").props.children)).toContain(GUARD);
    // And the user is not stranded: there is something to press.
    expect(screen.getByTestId("app-error-retry")).toBeTruthy();
  } finally {
    restore();
  }
});

it("retry re-mounts the subtree, so a projection that finishes rebuilding recovers", async () => {
  const restore = quietConsole();
  try {
    // A flag rather than a call counter: React renders a failing subtree more
    // than once on its way to the boundary, so "throw the first N times" is not
    // the same statement as "the projection is still broken".
    let broken = true;
    const source = {
      read: () => {
        if (broken) throw new Error(GUARD);
        return { usable: false, warming: false, homeCurrency: null, income: 0n, unassigned: 0n, buckets: { need: 0n, want: 0n, saving: 0n }, excluded: { unresolvedDuplicates: 0, missingHomeRate: 0, unparsed: 0, sameDuplicates: 0 } };
      },
    } as unknown as BudgetSource;

    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <ErrorBoundary>
            <BudgetScreen source={source} nowMs={0} onCurrencies={() => {}} onImport={() => {}} onClose={() => {}} />
          </ErrorBoundary>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
    expect(screen.getByTestId("app-error-boundary")).toBeTruthy();

    // The local sync finishes and the projection becomes readable.
    broken = false;
    await act(async () => { fireEvent.press(screen.getByTestId("app-error-retry")); });

    // The real screen is back — and it is BudgetScreen's own honest "rebuilding"
    // state, not the boundary's.
    expect(screen.queryByTestId("app-error-boundary")).toBeNull();
    expect(screen.getByTestId("budget-rebuilding")).toBeTruthy();
  } finally {
    restore();
  }
});
