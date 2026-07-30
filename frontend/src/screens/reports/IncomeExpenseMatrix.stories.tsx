import type { Meta, StoryObj } from "@storybook/react-vite";
import { IncomeExpenseMatrix } from "./IncomeExpenseMatrix";
import type { IncomeExpenseResponse } from "../../lib/reports";
import { Card } from "../../components/ui/Card";

const threeMonths: IncomeExpenseResponse = {
  months: ["2026-05", "2026-06", "2026-07"],
  rows: [
    { category_id: 2, name: "Salary", kind: "income", by_month_fils: [2650000, 2650000, 2650000], total_fils: 7950000, avg_fils: 2650000 },
    { category_id: 9, name: "Freelance", kind: "income", by_month_fils: [0, 145000, 0], total_fils: 145000, avg_fils: 48333 },
    { category_id: 5, name: "Groceries", kind: "spending", by_month_fils: [212400, 189900, 174350], total_fils: 576650, avg_fils: 192216 },
    { category_id: 6, name: "Dining out", kind: "spending", by_month_fils: [98750, 132000, 87600], total_fils: 318350, avg_fils: 106116 },
    { category_id: 7, name: "Rent", kind: "spending", by_month_fils: [850000, 850000, 850000], total_fils: 2550000, avg_fils: 850000 },
    { category_id: 8, name: "Transport", kind: "spending", by_month_fils: [45210, 51600, 38900], total_fils: 135710, avg_fils: 45236 },
  ],
  net_by_month_fils: [1443640, 1571500, 1499150],
};

const deficit: IncomeExpenseResponse = {
  months: ["2026-06", "2026-07"],
  rows: [
    { category_id: 2, name: "Salary", kind: "income", by_month_fils: [900000, 900000], total_fils: 1800000, avg_fils: 900000 },
    { category_id: 7, name: "Rent", kind: "spending", by_month_fils: [850000, 850000], total_fils: 1700000, avg_fils: 850000 },
    { category_id: 5, name: "Groceries", kind: "spending", by_month_fils: [212400, 189900], total_fils: 402300, avg_fils: 201150 },
  ],
  net_by_month_fils: [-162400, -139900],
};

const meta = {
  title: "Reports/IncomeExpenseMatrix",
  component: IncomeExpenseMatrix,
  parameters: {
    docs: {
      description: {
        component:
          "Category rows × months on TanStack Table, inside the component's own two-axis " +
          "scroll container capped at 60vh (the page never pans). The category column stays " +
          "sticky through horizontal scroll and the month header row through vertical scroll, " +
          "so mid-table positions keep both labels and month context. Income block first, then " +
          "spending, a net row at the bottom, average/total at the far end; months print " +
          "newest-first so the phone viewport opens on the months that matter. Every money cell " +
          "is a 36px-dense drill target to the exact transactions behind the figure.",
      },
    },
  },
  args: { onDrillCell: () => {}, onDrillRow: () => {}, onDrillMonth: () => {} },
  decorators: [(S) => <Card className="!p-0 max-w-md"><div className="py-2"><S /></div></Card>],
} satisfies Meta<typeof IncomeExpenseMatrix>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeMonths: Story = { args: { data: threeMonths } };

export const DeficitMonths: Story = { args: { data: deficit } };

export const Empty: Story = {
  args: { data: { months: [], rows: [], net_by_month_fils: [] } },
};
