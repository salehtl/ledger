import type { Meta, StoryObj } from "@storybook/react-vite";
import { MatchedTxnsSheet } from "./MatchedTxnsSheet";
import type { Txn } from "../../api/types";

function txn(overrides: Partial<Txn> = {}): Txn {
  return {
    ID: 10,
    PostedAt: "2026-07-07T21:03:00Z",
    AmountFils: 5600,
    AmountAedFils: null,
    Currency: "AED",
    Direction: "debit",
    MerchantRaw: "NETFLIX.COM AMSTERDAM",
    Status: "confirmed",
    Confidence: 1,
    Source: "template",
    CategoryID: 5,
    CategoryName: "Subscriptions",
    Bucket: "want",
    Kind: "spending",
    BucketSnapshot: "want",
    ...overrides,
  };
}

function index(...txns: Txn[]): Map<number, Txn> {
  return new Map(txns.map((t) => [t.ID, t]));
}

const meta = {
  title: "Recurring/MatchedTxnsSheet",
  component: MatchedTxnsSheet,
  parameters: {
    docs: {
      description: {
        component:
          "Evidence sheet: the transactions behind a schedule — a detected proposal's " +
          "mined occurrences, or the single transaction that paid a bill. Read-only " +
          "provenance (P8); acting on a transaction stays on the Transactions screen.",
      },
    },
  },
  args: {
    title: "Netflix",
    onClose: () => {},
  },
} satisfies Meta<typeof MatchedTxnsSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Rows: Story = {
  args: {
    txnIds: [10, 50, 90],
    txnsById: index(
      txn(),
      txn({ ID: 50, PostedAt: "2026-06-07T21:01:00Z" }),
      txn({ ID: 90, PostedAt: "2026-05-08T20:58:00Z", AmountFils: 5200 }),
    ),
  },
};

export const CreditMatch: Story = {
  args: {
    title: "Salary",
    txnIds: [7],
    txnsById: index(
      txn({ ID: 7, MerchantRaw: "ACME GULF LLC PAYROLL", Direction: "credit", AmountFils: 2_650_000, CategoryName: "", PostedAt: "2026-07-25T07:01:00Z" }),
    ),
  },
};

export const Empty: Story = {
  args: { txnIds: [10, 50], txnsById: index() },
};

export const Loading: Story = {
  args: { txnIds: [10, 50], txnsById: undefined, loading: true },
};

export const MissingSome: Story = {
  args: {
    txnIds: [10, 50, 999],
    txnsById: index(txn(), txn({ ID: 50, PostedAt: "2026-06-07T21:01:00Z" })),
  },
};
