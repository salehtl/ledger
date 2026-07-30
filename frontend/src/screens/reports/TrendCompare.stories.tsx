import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrendCompare } from "./TrendCompare";
import { yoyRows, yoySummary } from "../../lib/reports";
import type { MonthlyTotal } from "../../api/types";
import { Card } from "../../components/ui/Card";

/** Deterministic trend history ending 2026-07, `months` long. */
function history(months: number): MonthlyTotal[] {
  return Array.from({ length: months }, (_, k) => {
    const i = months - 1 - k;
    const d = new Date(Date.UTC(2026, 6 - i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    // A gentle seasonal wobble so the two years differ visibly.
    const spent = 1_500_000 + ((k * 7919) % 11) * 65_000 + (k % 5) * 40_000;
    return { period, spent, income: 2_650_000 };
  });
}

const NOW = "2026-07";
const fullRows = yoyRows(history(24), NOW);
const partialRows = yoyRows(history(16), NOW);
const firstYearRows = yoyRows(history(6), NOW);

const meta = {
  title: "Reports/TrendCompare",
  component: TrendCompare,
  parameters: {
    docs: {
      description: {
        component:
          "The 24-month trend folded into a year-over-year compare: trailing 12 months, each " +
          "paired with the same calendar month a year earlier. Two dithered bars per month on one " +
          "shared scale — this year in ink, the year before in low-emphasis ink (separated on " +
          "lightness, not hue). Prior-year months outside the data honestly say 'no record' " +
          "instead of drawing a fake zero. Every row drills to that month's transactions.",
      },
    },
  },
  args: { onDrillMonth: () => {} },
  decorators: [(S) => <Card className="max-w-md"><S /></Card>],
} satisfies Meta<typeof TrendCompare>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TwoFullYears: Story = {
  args: { rows: fullRows, summary: yoySummary(fullRows) },
};

export const PartialPriorYear: Story = {
  args: { rows: partialRows, summary: yoySummary(partialRows) },
};

export const FirstYear: Story = {
  args: { rows: firstYearRows, summary: yoySummary(firstYearRows) },
};
