import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgeOfMoneyTile } from "./AgeOfMoneyTile";
import type { SpendAge } from "../../lib/reports";

const ages: SpendAge[] = [18, 21, 19, 24, 26, 22, 25, 28, 24, 27].map((ageDays, i) => ({
  id: 100 + i,
  date: `2026-07-${String(10 + i).padStart(2, "0")}T09:00:00Z`,
  ageDays,
}));

const meta = {
  title: "Reports/AgeOfMoneyTile",
  component: AgeOfMoneyTile,
  parameters: {
    docs: {
      description: {
        component:
          "Age of money: FIFO days between income arriving and the last funded spends draining it. " +
          "The headline number is the server's; the sparkline mirrors the same FIFO client-side " +
          "(lib/reports.fifoSpendAges) so both agree on definition. Tapping the tile drills to the " +
          "sampled spends. Not-computable renders an honest '—' with the expectation stated.",
      },
    },
  },
  args: { onDrill: () => {} },
  decorators: [(S) => <div className="max-w-md"><S /></div>],
} satisfies Meta<typeof AgeOfMoneyTile>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {
  args: { age: { age_days: 24, sample_size: 10 }, ages },
};

export const SingleSpend: Story = {
  args: { age: { age_days: 3, sample_size: 1 }, ages: ages.slice(0, 1) },
};

export const NotComputable: Story = {
  args: { age: { age_days: 0, sample_size: 0 }, ages: [], onDrill: undefined },
};
