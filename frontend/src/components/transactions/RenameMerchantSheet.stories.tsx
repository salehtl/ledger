import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RenameMerchantSheet } from "./RenameMerchantSheet";
import type { DepthRule } from "./merchantRename";
import type { TxnDepth } from "../../lib/txSplit";

function txn(over: Partial<TxnDepth> = {}): TxnDepth {
  return {
    ID: 42, PostedAt: "2026-07-10", AmountFils: 3900, AmountAedFils: 3900, Currency: "AED",
    Direction: "debit", MerchantRaw: "NETFLIX.COM 866-579-7172 NL", Status: "confirmed",
    Confidence: 0, Source: "email", CategoryID: 11, CategoryName: "Subscriptions",
    Bucket: "want", Kind: "spending", BucketSnapshot: "", ...over,
  };
}

const rules: DepthRule[] = [
  { ID: 4, MatchType: "contains", Pattern: "netflix", CategoryID: 11, Priority: 100, Source: "ai_confirmed", IsActive: true },
];

const txns = [txn({ ID: 1 }), txn({ ID: 2 }), txn({ ID: 3 }), txn({ ID: 4, MerchantRaw: "SPINNEYS" })];

const meta = {
  title: "Transactions/RenameMerchantSheet",
  component: RenameMerchantSheet,
  parameters: {
    docs: {
      description: {
        component:
          "Rename a merchant once, everywhere: the clean name lands on the rule that matches the " +
          "raw string (created from the transaction's category when none exists yet), so history " +
          "and all future mail print it. The raw string stays visible as provenance and the sheet " +
          "states how many transactions the rename touches. With no rule and no category to seed " +
          "one, it explains the way forward instead of failing.",
      },
    },
  },
  args: { txns, onClose: () => {}, onSaved: () => {} },
  decorators: [
    (S) => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <S />
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof RenameMerchantSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithMatchingRule: Story = { args: { txn: txn(), rules } };

export const ExistingName: Story = { args: { txn: txn({ DisplayName: "Netflix" }), rules } };

export const NoRuleYet: Story = { args: { txn: txn(), rules: [] } };

export const Blocked: Story = {
  args: { txn: txn({ CategoryID: null, CategoryName: "", Bucket: "" }), rules: [] },
};
