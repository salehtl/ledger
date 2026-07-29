import type { Meta, StoryObj } from "@storybook/react-vite";
import { PixelSpinner } from "./PixelSpinner";

const meta = {
  title: "Primitives/PixelSpinner",
  component: PixelSpinner,
  parameters: {
    docs: {
      description: {
        component:
          "Eight blocks in a ring on the icon pack's 2-unit grid. Nothing rotates, on purpose — " +
          "brightness travels the ring instead. With `progress` it becomes a determinate gauge " +
          "filling clockwise (pull-to-refresh).",
      },
    },
  },
} satisfies Meta<typeof PixelSpinner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Indeterminate: Story = { args: { size: 36, role: "status", "aria-label": "Loading" } };
export const DeterminateGauge: Story = { args: { size: 36, progress: 0.6 } };
