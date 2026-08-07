import type { Meta, StoryObj } from "@storybook/react-vite";
import { DitherFill } from "./DitherFill";

const meta = {
  title: "Charts/DitherFill",
  component: DitherFill,
  parameters: {
    docs: {
      description: {
        component:
          "Horizontal magnitude/proportion bar. Hue is bucket identity (amber=needs, lilac=wants, " +
          "sage=saving), so state goes to texture: dotted under budget, solid at/over — the same " +
          "pct >= 1.0 threshold ProgressBar calls over budget. Never used for progress against a target.",
      },
    },
  },
} satisfies Meta<typeof DitherFill>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BucketSplit: Story = {
  args: {
    max: 100,
    height: 12,
    segments: [
      { value: 45, color: "amber" },
      { value: 32, color: "lilac" },
      { value: 23, color: "sage" },
    ],
  },
};
export const OverBudgetSolid: Story = {
  args: {
    max: 100,
    height: 12,
    segments: [
      { value: 45, color: "amber", density: "solid" },
      { value: 32, color: "lilac" },
      { value: 23, color: "sage" },
    ],
  },
};
