import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReadyToAssignBanner } from "./ReadyToAssignBanner";
import type { EnvelopeSummary } from "../../lib/envelope";

function summary(over: Partial<EnvelopeSummary> = {}): EnvelopeSummary {
  return {
    month: "2026-07",
    income_fils: 2650000,
    assigned_fils: 2400000,
    overspend_debt_fils: 0,
    ready_to_assign_fils: 250000,
    envelopes: [],
    ...over,
  };
}

const meta = {
  title: "Plan/ReadyToAssignBanner",
  component: ReadyToAssignBanner,
  parameters: {
    docs: {
      description: {
        component:
          "The Plan screen's one live number: what's left to assign this month (RollingNumber). " +
          "Red is rationed — the figure goes `text-bad` only when over-assigned (negative). " +
          "Auto-assign (the screen's primary action) shows only while there is money to place.",
      },
    },
  },
  args: { onAutoAssign: () => {} },
} satisfies Meta<typeof ReadyToAssignBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Positive: Story = { args: { summary: summary() } };
export const Zero: Story = {
  args: { summary: summary({ assigned_fils: 2650000, ready_to_assign_fils: 0 }) },
};
export const Negative: Story = {
  args: { summary: summary({ assigned_fils: 2850000, ready_to_assign_fils: -200000 }) },
};
export const WithOverspendDebt: Story = {
  args: {
    summary: summary({ overspend_debt_fils: 45000, assigned_fils: 2500000, ready_to_assign_fils: 105000 }),
  },
};
export const FirstRun: Story = {
  args: { summary: summary({ income_fils: 0, assigned_fils: 0, ready_to_assign_fils: 0 }) },
};
export const Assigning: Story = { args: { summary: summary(), autoAssignPending: true } };
