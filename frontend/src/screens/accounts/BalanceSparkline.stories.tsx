import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card } from "../../components/ui/Card";
import { sparklinePoints, type BalancePoint } from "../../lib/reconcile";
import { BalanceSparkline } from "./BalanceSparkline";

function history(balances: number[]): BalancePoint[] {
  // Newest first, like the wire; sparklinePoints reverses to oldest → newest.
  return balances.map((balance_fils, i) => ({
    id: balances.length - i,
    account_id: 1,
    as_of: `2026-0${7 - Math.floor(i / 28)}-${String(28 - (i % 28)).padStart(2, "0")}T10:00:00Z`,
    balance_fils,
    source: "checkin",
    created_at: "2026-07-25T10:00:00Z",
  }));
}

const meta = {
  title: "Accounts/BalanceSparkline",
  component: BalanceSparkline,
  parameters: {
    docs: {
      description: {
        component:
          "The balance-history sparkline: one dithered ink column per balance point, oldest → " +
          "newest, heights normalized to the window's min..max. Monochrome ink — history is neither " +
          "a bucket (no hue) nor a budget state (no ramp). Rendered aria-hidden; the caller prints " +
          "the low/high/since caption in visible text beside it.",
      },
    },
  },
  decorators: [(S) => <Card className="max-w-md"><S /></Card>],
} satisfies Meta<typeof BalanceSparkline>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Rising: Story = {
  args: { points: sparklinePoints(history([800000, 600000, 700000, 400000, 350000, 300000])) },
};
export const Flat: Story = {
  args: { points: sparklinePoints(history([500000, 500000, 500000, 500000])) },
};
export const SinglePoint: Story = {
  args: { points: sparklinePoints(history([745000])) },
};
