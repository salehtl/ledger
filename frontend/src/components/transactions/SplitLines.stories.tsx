import type { Meta, StoryObj } from "@storybook/react-vite";
import { SplitLines } from "./SplitLines";
import { Card } from "../ui/Card";

const categories = {
  1: { name: "Groceries", bucket: "need", kind: "spending" },
  2: { name: "Dining", bucket: "want", kind: "spending" },
  3: { name: "Salary", bucket: "", kind: "income" },
};

const meta = {
  title: "Transactions/SplitLines",
  component: SplitLines,
  parameters: {
    docs: {
      description: {
        component:
          "The split-line stack: one calm row per line — category dot and mono label, the user's " +
          "note beneath, the amount in the figures column, in the parent transaction's currency. " +
          "Pure display: the list row folds it behind an expander, the detail sheet shows it open. " +
          "Lines always sum exactly to the parent, so no totals row repeats the parent's amount.",
      },
    },
  },
  args: { currency: "AED", categories },
  decorators: [(S) => <Card className="max-w-md"><S /></Card>],
} satisfies Meta<typeof SplitLines>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TwoWay: Story = {
  args: {
    splits: [
      { ID: 1, TransactionID: 42, CategoryID: 1, AmountFils: 7500, Note: "household" },
      { ID: 2, TransactionID: 42, CategoryID: 2, AmountFils: 4500 },
    ],
  },
};

export const CreditWithIncomeLine: Story = {
  args: {
    splits: [
      { ID: 1, TransactionID: 42, CategoryID: 3, AmountFils: 500000 },
      { ID: 2, TransactionID: 42, CategoryID: 1, AmountFils: 2500, Note: "refunded delivery" },
    ],
  },
};

export const ForeignParent: Story = {
  args: {
    currency: "USD",
    splits: [
      { ID: 1, TransactionID: 42, CategoryID: 1, AmountFils: 700 },
      { ID: 2, TransactionID: 42, CategoryID: 2, AmountFils: 309 },
    ],
  },
};

export const WithoutCategoryLookup: Story = {
  args: {
    categories: undefined,
    splits: [
      { ID: 1, TransactionID: 42, CategoryID: 1, AmountFils: 7500 },
      { ID: 2, TransactionID: 42, CategoryID: 2, AmountFils: 4500 },
    ],
  },
};
