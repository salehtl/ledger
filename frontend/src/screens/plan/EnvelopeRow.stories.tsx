import type { Meta, StoryObj } from "@storybook/react-vite";
import { EnvelopeRow } from "./EnvelopeRow";
import { claimsByCategory, type Envelope, type EnvelopeTargetInfo } from "../../lib/envelope";
import { Card } from "../../components/ui/Card";

function env(over: Partial<Envelope> = {}): Envelope {
  return {
    category_id: 5,
    category_name: "Groceries",
    bucket: "need",
    carryover_fils: 0,
    assigned_fils: 120000,
    activity_fils: 47500,
    available_fils: 72500,
    overspent: false,
    overspend_debt_fils: 0,
    ...over,
  };
}

function target(over: Partial<EnvelopeTargetInfo> = {}): EnvelopeTargetInfo {
  return {
    type: "set_aside",
    amount_fils: 120000,
    cadence: "monthly",
    needed_fils: 120000,
    still_needed_fils: 0,
    funded: true,
    ...over,
  };
}

const netflixClaim = claimsByCategory([
  {
    id: 3, merchant: "netflix.com", label: "Netflix", amount_fils: 3900, next_due: "2026-08-01",
    direction: "debit", category_id: 5, due_in_days: 2,
  },
]).get(5)!;

const meta = {
  title: "Plan/EnvelopeRow",
  component: EnvelopeRow,
  parameters: {
    docs: {
      description: {
        component:
          "One envelope line: name + available, the jar-style dithered pace bar, and a mono meta " +
          "line (target progress · needed-this-month · upcoming-bill claims). A category that was " +
          "never funded and has no target renders as a quiet 'jar row' — spend only, no bar, no " +
          "overspend flag. Envelope depth is opt-in per category.",
      },
    },
  },
  args: { onOpen: () => {}, pace: 0.6 },
  decorators: [(S) => <Card className="!p-0 max-w-md"><S /></Card>],
} satisfies Meta<typeof EnvelopeRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Funded: Story = { args: { envelope: env({ target: target() }) } };
export const UnfundedTarget: Story = {
  args: {
    envelope: env({
      category_name: "Utilities",
      assigned_fils: 0,
      activity_fils: 87815,
      available_fils: -87815,
      overspent: true, // wire flag; unfunded target = an ask, not a red wall
      target: target({ type: "refill", amount_fils: 80000, needed_fils: 167815, still_needed_fils: 167815, funded: false }),
    }),
  },
};
export const NeedsMore: Story = {
  args: {
    envelope: env({
      assigned_fils: 80000,
      available_fils: 32500,
      target: target({ funded: false, still_needed_fils: 40000 }),
    }),
  },
};
export const SaveByDate: Story = {
  args: {
    envelope: env({
      category_name: "Japan trip",
      bucket: "saving",
      assigned_fils: 50000,
      activity_fils: 0,
      available_fils: 150000,
      carryover_fils: 100000,
      target: target({
        type: "save_by_date", amount_fils: 1500000, due_date: "2026-12-01",
        months_left: 5, needed_fils: 270000, still_needed_fils: 220000, funded: false,
      }),
    }),
  },
};
export const Overspent: Story = {
  args: {
    envelope: env({
      category_name: "Dining out",
      bucket: "want",
      assigned_fils: 60000,
      activity_fils: 84200,
      available_fils: -24200,
      overspent: true,
    }),
  },
};
export const WithBillClaim: Story = {
  args: {
    envelope: env({ category_name: "Subscriptions", assigned_fils: 2000, activity_fils: 0, available_fils: 2000 }),
    claim: netflixClaim,
  },
};
export const JarRow: Story = {
  args: {
    envelope: env({
      category_name: "Fitness",
      bucket: "want",
      assigned_fils: 0,
      activity_fils: 12000,
      available_fils: -12000,
      overspent: true, // wire flag; the row must NOT shout — never funded
    }),
  },
};
