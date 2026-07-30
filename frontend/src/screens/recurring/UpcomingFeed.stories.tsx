import type { Meta, StoryObj } from "@storybook/react-vite";
import { UpcomingFeed, RecentlyPaidList } from "./UpcomingFeed";
import type { UpcomingItem } from "./api";

function item(overrides: Partial<UpcomingItem> = {}): UpcomingItem {
  return {
    id: 1,
    merchant: "netflix.com",
    label: "Netflix",
    amount_fils: 5600,
    tolerance_pct: 10,
    interval_days: 30,
    next_due: "2026-08-07",
    direction: "debit",
    category_id: 5,
    account_id: null,
    source: "detected",
    status: "active",
    last_matched_tx_id: 812,
    last_matched_at: "2026-07-07T21:03:00Z",
    last_amount_fils: 5600,
    missed: false,
    price_change: false,
    created_at: "2026-07-29T10:00:00Z",
    updated_at: "2026-07-29T10:00:00Z",
    due_in_days: 9,
    ...overrides,
  };
}

const meta = {
  title: "Recurring/UpcomingFeed",
  component: UpcomingFeed,
  parameters: {
    docs: {
      description: {
        component:
          "Next-N-days bill feed: due countdown, missed and price-change badges in ink " +
          "(labels carry the meaning, red stays rationed), a drift line that explains a " +
          "price change instead of making the user diff numbers.",
      },
    },
  },
  args: { onOpen: () => {} },
} satisfies Meta<typeof UpcomingFeed>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Feed: Story = {
  args: {
    items: [
      item({ id: 2, merchant: "dewa", label: "DEWA", amount_fils: 48915, due_in_days: -3, missed: true, next_due: "2026-07-26" }),
      item({ id: 3, merchant: "du telecom", label: "du", amount_fils: 42790, due_in_days: 2, price_change: true, last_amount_fils: 38900, next_due: "2026-07-31" }),
      item({ id: 1, due_in_days: 0, next_due: "2026-07-29" }),
      item({ id: 4, merchant: "spotify ae", label: "Spotify", amount_fils: 2399, due_in_days: 13, next_due: "2026-08-11" }),
    ],
  },
};

export const Empty: Story = { args: { items: [] } };

export const Paid: StoryObj = {
  render: () => (
    <RecentlyPaidList
      schedules={[
        item({ id: 5, merchant: "salary acme gulf llc", label: "Salary", direction: "credit", amount_fils: 2_650_000, last_amount_fils: 2_650_000, last_matched_at: "2026-07-25T07:01:00Z" }),
        item({ id: 1 }),
      ]}
      onOpenMatch={() => {}}
    />
  ),
};
