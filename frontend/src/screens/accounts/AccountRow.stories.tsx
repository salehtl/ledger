import type { Meta, StoryObj } from "@storybook/react-vite";
import { AccountRow } from "./AccountRow";
import type { AccountBalanceSummary } from "../../lib/reconcile";
import { Card } from "../../components/ui/Card";

const NOW = new Date("2026-07-29T12:00:00Z");

function acct(over: Partial<AccountBalanceSummary> = {}): AccountBalanceSummary {
  return {
    account_id: 1,
    name: "ENBD Current",
    bank: "Emirates NBD",
    last4: "3921",
    kind: "budget",
    has_checkin: true,
    anchor_fils: 800000,
    anchor_as_of: "2026-07-25T10:00:00Z",
    anchor_source: "checkin",
    activity_since_fils: -55000,
    txn_count: 2,
    computed_fils: 745000,
    ...over,
  };
}

const meta = {
  title: "Accounts/AccountRow",
  component: AccountRow,
  parameters: {
    docs: {
      description: {
        component:
          "One account line: name + live computed balance (last check-in anchor ± signed activity " +
          "since), then bank · last4 and the anchor's freshness — every balance answers 'as of " +
          "when?'. A never-checked-in account shows a muted em dash, not a fake zero. The whole " +
          "row opens the account detail.",
      },
    },
  },
  args: { onOpen: () => {}, now: NOW },
  decorators: [(S) => <Card className="!p-0 max-w-md"><S /></Card>],
} satisfies Meta<typeof AccountRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CheckedIn: Story = { args: { account: acct() } };
export const CreditCard: Story = {
  args: {
    account: acct({
      account_id: 2,
      name: "ENBD Credit Card",
      last4: "7104",
      anchor_fils: -20000,
      activity_since_fils: -103000,
      txn_count: 9,
      computed_fils: -123000,
    }),
  },
};
export const NeverCheckedIn: Story = {
  args: {
    account: acct({
      account_id: 3,
      name: "DIB Savings",
      bank: "Dubai Islamic Bank",
      last4: "5566",
      has_checkin: false,
      anchor_fils: undefined,
      anchor_as_of: undefined,
      computed_fils: undefined,
      txn_count: undefined,
    }),
  },
};
export const Tracking: Story = {
  args: {
    account: acct({
      account_id: 4,
      name: "Sarwa Portfolio",
      bank: "Sarwa",
      last4: "9001",
      kind: "tracking",
      anchor_fils: 5250000,
      activity_since_fils: 0,
      txn_count: 0,
      computed_fils: 5250000,
      anchor_as_of: "2026-07-01T10:00:00Z",
    }),
  },
};
export const ZeroBalance: Story = {
  args: {
    account: acct({ account_id: 5, name: "Spare card", computed_fils: 0, anchor_fils: 0, txn_count: 0 }),
  },
};
