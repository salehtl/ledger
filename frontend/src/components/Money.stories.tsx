import type { Meta, StoryObj } from "@storybook/react-vite";
import { Money } from "./Money";

const meta = {
  title: "Shared/Money",
  component: Money,
  parameters: {
    docs: {
      description: {
        component:
          "Formats fils (int64 minor units — AED × 100, never floats) with sign colour coding. " +
          "All amounts render through it. Wrap it (or its container) in .tnum for tabular alignment.",
      },
    },
  },
  decorators: [(S) => <span className="tnum text-sm"><S /></span>],
} satisfies Meta<typeof Money>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Positive: Story = { args: { fils: 1850000 } };
export const Negative: Story = { args: { fils: -14275 } };
/** Zero deliberately prints as an em dash — an amount of 0.00 is noise, not information. */
export const Zero: Story = { args: { fils: 0 } };
