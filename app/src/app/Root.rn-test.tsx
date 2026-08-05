/**
 * The boundary is WIRED, not merely written.
 *
 * `ErrorBoundary.rn-test.tsx` proves the component catches a real
 * money-guard throw out of `BudgetScreen`. That is worth nothing on its own if
 * nothing in the shipped tree renders it — "written, tested green, never wired"
 * is the shape that has produced six defects on this project, and a boundary is
 * an especially easy one to leave dangling because everything looks fine until
 * the day something throws.
 *
 * So this renders the REAL `Root` — the component `index.ts` hands to
 * `registerRootComponent` — with a throw planted below it, and asserts the
 * fallback is on screen. The throw is planted by replacing `RuntimeProvider`,
 * which is the first thing under `ThemedContainer` and is where a bootstrap
 * failure would come from; nothing else in `Root` is mocked, so what is
 * exercised is the real provider order and the real placement of the boundary
 * inside it.
 */

import { render, screen } from "@testing-library/react-native";

import { Root } from "./Root.tsx";

const BOOM = "the store could not be opened";

/**
 * The library's own jest mock, which supplies window metrics.
 *
 * Not a convenience: the real `SafeAreaProvider` renders NOTHING until it has
 * measured, and `initialWindowMetrics` is null under jest, so an unmocked
 * `Root` renders an empty `RNCSafeAreaProvider` and this test would pass or
 * fail for reasons that have nothing to do with the boundary. Everything below
 * `SafeAreaProvider` -- `ThemeProvider`, the boundary, `ThemedContainer` -- is
 * the real thing.
 */
jest.mock("react-native-safe-area-context", () => (require("react-native-safe-area-context/jest/mock") as { default: unknown }).default);

jest.mock("./RuntimeProvider.tsx", () => ({
  RuntimeProvider: () => { throw new Error(BOOM); },
  useRuntime: () => null,
  useBootstrap: () => ({ step: "opening" }),
  useAccountWipe: () => async () => {},
}));

/** React logs a caught render error; expected here, not a failure. */
function quietConsole() {
  const real = console.error;
  console.error = () => {};
  return () => { console.error = real; };
}

it("Root catches a render throw from below and shows the recovery screen", async () => {
  const restore = quietConsole();
  try {
    await render(<Root />);
    expect(screen.getByTestId("app-error-boundary")).toBeTruthy();
    expect(String(screen.getByTestId("app-error-detail").props.children)).toContain(BOOM);
    // Themed, which is what putting the boundary UNDER `ThemeProvider` buys:
    // an unthemed fallback would throw on `useTheme` and take the app down with
    // exactly the blank screen it exists to prevent.
    expect(screen.getByText("Something went wrong")).toBeTruthy();
  } finally {
    restore();
  }
});
