import type { Meta, StoryObj } from "@storybook/react-vite";
import { SplitSheet } from "./SplitSheet";
import type { Category } from "../../api/types";
import type { TxnDepth } from "../../lib/txSplit";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true, Color: "" },
  { ID: 2, Name: "Transport", Kind: "spending", Bucket: "need", IsActive: true, Color: "" },
  { ID: 3, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true, Color: "" },
  { ID: 4, Name: "Entertainment", Kind: "spending", Bucket: "want", IsActive: true, Color: "" },
  { ID: 5, Name: "Investments", Kind: "spending", Bucket: "saving", IsActive: true, Color: "" },
  { ID: 6, Name: "Salary", Kind: "income", Bucket: "", IsActive: true, Color: "" },
  { ID: 7, Name: "Transfers", Kind: "excluded", Bucket: "", IsActive: true, Color: "" },
];

function txn(over: Partial<TxnDepth> = {}): TxnDepth {
  return {
    ID: 42, PostedAt: "2026-07-10", AmountFils: 12000, AmountAedFils: 12000, Currency: "AED",
    Direction: "debit", MerchantRaw: "CARREFOUR CITY CENTRE", Status: "confirmed", Confidence: 0,
    Source: "email", CategoryID: 1, CategoryName: "Groceries", Bucket: "need", Kind: "spending",
    BucketSnapshot: "", ...over,
  };
}

const meta = {
  title: "Transactions/SplitSheet",
  component: SplitSheet,
  parameters: {
    docs: {
      description: {
        component:
          "Divide one transaction across categories, integer-fils exact in the parent's own " +
          "currency. Categories toggle on the bucket-grouped chip grid; each selected one becomes " +
          "a line with an amount and optional note, the remainder is live, and the last line can " +
          "absorb the rounding. Only categories the server would accept appear: spending for " +
          "debits, plus income for credits — excluded and inactive never. Saving with no lines " +
          "removes the split and returns the parent to the review queue, stated before it happens.",
      },
    },
  },
  args: { categories: cats, onSubmit: () => {}, onClose: () => {} },
} satisfies Meta<typeof SplitSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FreshDebit: Story = { args: { txn: txn() } };

export const EditingExistingSplit: Story = {
  args: {
    txn: txn({
      CategoryID: null, CategoryName: "", Bucket: "",
      Splits: [
        { ID: 1, TransactionID: 42, CategoryID: 1, AmountFils: 7500, Note: "household" },
        { ID: 2, TransactionID: 42, CategoryID: 3, AmountFils: 4500 },
      ],
    }),
  },
};

export const CreditWithIncome: Story = {
  args: {
    txn: txn({ Direction: "credit", MerchantRaw: "SALARY TRANSFER", CategoryID: null, CategoryName: "", Bucket: "" }),
  },
};

export const ForeignCurrencyParent: Story = {
  args: {
    txn: txn({ Currency: "USD", AmountFils: 1009, AmountAedFils: 3706 }),
  },
};
