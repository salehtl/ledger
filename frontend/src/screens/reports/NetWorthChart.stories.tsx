import type { Meta, StoryObj } from "@storybook/react-vite";
import { NetWorthChart } from "./NetWorthChart";
import type { NetWorthPoint } from "../../lib/reports";
import { Card } from "../../components/ui/Card";

/** 12 months ending 2026-07, budget/tracking climbing at different paces. */
function series(months: number, step: (i: number) => Pick<NetWorthPoint, "budget_fils" | "tracking_fils">): NetWorthPoint[] {
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(2026, 6 - (months - 1) + i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const s = step(i);
    return { month, ...s, networth_fils: s.budget_fils + s.tracking_fils };
  });
}

const growing = series(12, (i) => ({
  budget_fils: 4_200_000 + i * 310_000 + (i % 3 === 0 ? -180_000 : 90_000),
  tracking_fils: 20_000_000 + i * 800_000,
}));

const meta = {
  title: "Reports/NetWorthChart",
  component: NetWorthChart,
  parameters: {
    docs: {
      description: {
        component:
          "Month-end net worth across budget + tracking accounts: an ink polyline over the app's " +
          "dithered area fill. Scrubbing (axis-locked) or tapping selects a month; the readout and " +
          "the transactions row always state which month they describe. Geometry is pure " +
          "lib/reports.ts; the chart carries no entrance animation — it's a read surface.",
      },
    },
  },
  args: { onDrillMonth: () => {} },
  decorators: [(S) => <Card className="max-w-md"><S /></Card>],
} satisfies Meta<typeof NetWorthChart>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Growing: Story = { args: { points: growing } };

export const Declining: Story = {
  args: {
    points: series(12, (i) => ({
      budget_fils: 9_000_000 - i * 420_000,
      tracking_fils: 14_000_000 - i * 260_000,
    })),
  },
};

export const Underwater: Story = {
  args: {
    points: series(6, (i) => ({
      budget_fils: -3_500_000 + i * 300_000,
      tracking_fils: 1_000_000,
    })),
  },
};

export const FirstMonth: Story = {
  args: { points: series(1, () => ({ budget_fils: 5_800_000, tracking_fils: 0 })) },
};
