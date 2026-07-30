import type { Meta, StoryObj } from "@storybook/react-vite";
import { DiscrepancyCard } from "./DiscrepancyCard";
import type { CheckinResult } from "../../lib/reconcile";

function result(over: Partial<CheckinResult> = {}): CheckinResult {
  return {
    account_id: 1,
    stated_fils: 727000,
    expected_fils: 745000,
    delta_fils: -18000,
    since: "2026-07-25T10:00:00Z",
    txn_count: 4,
    unconverted_count: 0,
    first_checkin: false,
    balance_id: 12,
    unparsed: [],
    ...over,
  };
}

const meta = {
  title: "Accounts/DiscrepancyCard",
  component: DiscrepancyCard,
  parameters: {
    docs: {
      description: {
        component:
          "The check-in mismatch report: the delta between what the bank says and what the ledger " +
          "expected, then candidate causes in concreteness order — retained emails that produced no " +
          "transaction (nothing is ever silently dropped), foreign rows awaiting an FX rate, and the " +
          "cash/ATM gap. One tap writes the delta off as an adjustment transaction.",
      },
    },
  },
  args: { onAdjust: () => {}, onKeep: () => {} },
  decorators: [(S) => <div className="max-w-md"><S /></div>],
} satisfies Meta<typeof DiscrepancyCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ShortWithReceipts: Story = {
  args: {
    result: result({
      unconverted_count: 1,
      unparsed: [
        {
          id: 88,
          received_at: "2026-07-27T09:00:00Z",
          from_addr: "alerts@emiratesnbd.com",
          subject: "Debit card purchase alert",
          parse_error: "no amount found",
        },
        {
          id: 91,
          received_at: "2026-07-26T14:30:00Z",
          from_addr: "alerts@emiratesnbd.com",
          subject: "Account transaction notification",
        },
      ],
    }),
  },
};
export const MoreThanExpected: Story = {
  args: { result: result({ stated_fils: 749200, delta_fils: 4200 }) },
};
export const CashOnly: Story = {
  args: { result: result({ stated_fils: 735500, delta_fils: -9500 }) },
};
export const AdjustPending: Story = {
  args: { result: result(), adjustPending: true },
};
