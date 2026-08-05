import { render, screen } from "@testing-library/react-native";
import { ThemeProvider } from "../../app/Theme.tsx";
import { BudgetScreen } from "./BudgetScreen.tsx";
import type { BudgetSnapshot, BudgetSource } from "./source.ts";

/**
 * The screen-level proof for Task 21's re-critic finding: `data.usable`
 * gating "written, tested green, never wired" (AGENT-RULES defect shape 2).
 * `source.test.ts` proves `sqlBudgetSource` computes `usable` correctly; this
 * file proves the SCREEN actually branches on it through a real render, not
 * just that the field exists on the snapshot type.
 */

const USABLE: BudgetSnapshot = {
  usable: true,
  homeCurrency: "AED",
  buckets: { need: 50000n, want: 30000n, saving: 20000n },
  income: 100000n,
  unassigned: 0n,
  confirmedTransactions: 20,
  historyDays: 30,
  warming: false,
  excluded: { missingHomeRate: 0, unparsed: 0, unresolvedDuplicates: 0, sameDuplicates: 0 },
};

function source(view: BudgetSnapshot): BudgetSource {
  return { read: () => view };
}

it("a usable projection renders the real buckets, not the rebuilding notice", async () => {
  await render(
    <ThemeProvider>
      <BudgetScreen source={source(USABLE)} nowMs={0} onCurrencies={() => {}} onImport={() => {}} onClose={() => {}} />
    </ThemeProvider>,
  );
  expect(screen.queryByTestId("budget-rebuilding")).toBeNull();
  expect(screen.getByText("Needs · 50%")).toBeTruthy();
});

it("an unusable projection — e.g. a stale version left by ensureProjection's migration, or an interrupted project() — renders the rebuilding notice instead of zeros presented as fact", async () => {
  // This is the exact shape the recritic measured (W7/W8): a split
  // transaction with a real frozen home amount, but the projection is not
  // usable, so `sqlBudgetSource` returns zeroed buckets. The regression this
  // test guards against is the screen rendering those zeros as if they were
  // real spending with no disclosure anywhere on screen.
  const unusable: BudgetSnapshot = {
    usable: false,
    homeCurrency: "AED",
    buckets: { need: 0n, want: 0n, saving: 0n },
    income: 0n,
    unassigned: 0n,
    confirmedTransactions: 0,
    historyDays: 0,
    warming: false,
    excluded: { missingHomeRate: 0, unparsed: 0, unresolvedDuplicates: 0, sameDuplicates: 0 },
  };
  await render(
    <ThemeProvider>
      <BudgetScreen source={source(unusable)} nowMs={0} onCurrencies={() => {}} onImport={() => {}} onClose={() => {}} />
    </ThemeProvider>,
  );
  expect(screen.getByTestId("budget-rebuilding")).toBeTruthy();
  // Nothing that could read as a real total is on screen: no bucket cards, no
  // income line, no "0" money presented as the user's spending.
  expect(screen.queryByText("Needs · 50%")).toBeNull();
  expect(screen.queryByText(/Income context/)).toBeNull();
});
