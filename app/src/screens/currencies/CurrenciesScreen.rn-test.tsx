import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ThemeProvider } from "../../app/Theme.tsx";
import { CurrenciesScreen } from "./CurrenciesScreen.tsx";
import type { CurrencySource, CurrencyView, FxAction } from "./source.ts";

function source(view: CurrencyView) {
  const calls: string[] = [];
  const result = (name: string): FxAction => { calls.push(name); return { ok: true, op: { type: name, payload: {} } }; };
  const value: CurrencySource = { read: () => view, setRate: (c, d) => d === "" ? { ok: false, error: "Enter a rate." } : result(`set:${c}:${d}`), unsetRate: (c) => result(`unset:${c}`), recompute: () => ({ ok: false, error: "unused" }) };
  return { value, calls };
}

it("renders stale and missing rates, refuses empty, and exposes add/remove controls", async () => {
  const fake = source({ usable: true, homeCurrency: "AED", rates: [
    { currency: "EUR", rateMicro: null, updatedAt: "", age: { label: "never", days: 0, stale: false }, pending: 2 },
    { currency: "USD", rateMicro: 3_672_500n, updatedAt: "2026-06-01T00:00:00.000Z", age: { label: "62d ago", days: 62, stale: true }, pending: 0 },
  ] });
  await render(<ThemeProvider><CurrenciesScreen source={fake.value} now={() => 0} /></ThemeProvider>);
  expect(screen.getByText("62d ago · stale")).toBeTruthy(); expect(screen.getByText("2 transactions waiting for a rate")).toBeTruthy();
  fireEvent.press(screen.getByText("Add rate")); await waitFor(() => expect(screen.getByRole("alert").props.children).toBe("Enter a rate."));
  fireEvent.changeText(screen.getByLabelText("EUR exchange rate"), "4.125");
  await waitFor(() => expect(screen.getByLabelText("EUR exchange rate").props.value).toBe("4.125"));
  fireEvent.press(screen.getByText("Add rate"));
  fireEvent.press(screen.getByText("Remove"));
  await waitFor(() => expect(fake.calls).toEqual(["set:EUR:4.125", "unset:USD"]));
});
