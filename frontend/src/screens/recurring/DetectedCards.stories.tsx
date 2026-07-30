import type { Meta, StoryObj } from "@storybook/react-vite";
import { DetectedCards } from "./DetectedCards";
import type { Schedule } from "./api";
import type { Category } from "../../api/types";

const categories: Category[] = [
  { ID: 5, Name: "Subscriptions", Kind: "spending", Bucket: "want", IsActive: true },
  { ID: 7, Name: "Utilities", Kind: "spending", Bucket: "need", IsActive: true },
];

function proposal(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 1,
    merchant: "netflix.com",
    label: "",
    amount_fils: 5600,
    tolerance_pct: 10,
    interval_days: 30,
    next_due: "2026-08-07",
    direction: "debit",
    category_id: 5,
    account_id: null,
    source: "detected",
    status: "proposed",
    last_matched_tx_id: null,
    last_amount_fils: null,
    missed: false,
    price_change: false,
    provenance: { count: 3, avg_interval_days: 30, last_amounts_fils: [5600, 5600, 5600], tx_ids: [10, 50, 90] },
    created_at: "2026-07-29T10:00:00Z",
    updated_at: "2026-07-29T10:00:00Z",
    ...overrides,
  };
}

const meta = {
  title: "Recurring/DetectedCards",
  component: DetectedCards,
  parameters: {
    docs: {
      description: {
        component:
          "Detector proposals as confirm/dismiss triage cards. The provenance line " +
          "(\"seen 3× every ~30 days at 56.00\") is the tap target for the mined transactions; " +
          "Confirm stays tonal so a stack of cards never becomes a stack of vermilion plates.",
      },
    },
  },
  args: {
    categories,
    onConfirm: () => {},
    onDismiss: () => {},
    onShowMatches: () => {},
  },
} satisfies Meta<typeof DetectedCards>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Proposals: Story = {
  args: {
    proposals: [
      proposal(),
      proposal({ id: 2, merchant: "dewa", category_id: 7, amount_fils: 48915, provenance: { count: 3, avg_interval_days: 30, last_amounts_fils: [46730, 51240, 48915], tx_ids: [3, 40, 80], price_stepped: true } }),
    ],
  },
};

export const IncomeProposal: Story = {
  args: {
    proposals: [
      proposal({ id: 3, merchant: "salary acme gulf llc", direction: "credit", category_id: null, amount_fils: 2_650_000, provenance: { count: 3, avg_interval_days: 30, last_amounts_fils: [2_650_000], tx_ids: [7, 44, 88] } }),
    ],
  },
};

export const Busy: Story = {
  args: { proposals: [proposal()], busyId: 1 },
};
