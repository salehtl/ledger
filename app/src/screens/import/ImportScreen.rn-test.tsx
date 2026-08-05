import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ThemeProvider } from "../../app/Theme.tsx";
import { ImportScreen } from "./ImportScreen.tsx";

it("picks, maps the full surface, previews only 20, shows errors, and commits", async () => {
  const csv = ["Date,Merchant,Amount,Debit,Credit,Category", "bad,First,-1.00,,,Food", ...Array.from({ length: 24 }, (_, i) => `2026-08-03,M${i},-${i + 1}.00,,,Food`)].join("\n");
  const batches: number[] = [];
  await render(<ThemeProvider><ImportScreen pick={async () => ({ name: "statement.csv", text: csv })} io={{ enqueueMany: (ops) => batches.push(ops.length), newId: (() => { let n = 0; return () => `id-${++n}`; })(), yieldToUI: async () => {} }} /></ThemeProvider>);
  fireEvent.press(screen.getByText("Choose CSV file"));
  await waitFor(() => expect(screen.getByText("Preview (20 rows)")).toBeTruthy());
  expect(screen.getByText(/Row 1: invalid date/)).toBeTruthy();
  expect(screen.getByLabelText("Import currency")).toBeTruthy(); expect(screen.getByLabelText("Category aliases")).toBeTruthy();
  expect(screen.getByText("Skip zero amounts: No")).toBeTruthy(); expect(screen.getByText("Date format: 2006-01-02")).toBeTruthy();
  fireEvent.press(screen.getByText("Direction: signed amount"));
  await waitFor(() => expect(screen.getByText(/debit:/)).toBeTruthy()); expect(screen.getByText(/credit:/)).toBeTruthy();
  fireEvent.press(screen.getByText("Direction: debit and credit columns"));
  await waitFor(() => expect(screen.getByText("Direction: signed amount")).toBeTruthy());
  fireEvent.press(screen.getByText("Import"));
  await waitFor(() => expect(batches.reduce((a, b) => a + b, 0)).toBe(24));
});
