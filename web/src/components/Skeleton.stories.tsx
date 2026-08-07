import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton } from "./Skeleton";

const meta = {
  title: "Shared/Skeleton",
  component: Skeleton,
  parameters: {
    docs: {
      description: {
        component: "Pulse placeholder rows for list-shaped primary loads only. Non-list waits get PixelSpinner.",
      },
    },
  },
} satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ListLoad: Story = { args: { rows: 5 } };
