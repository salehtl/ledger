import type { Meta, StoryObj } from "@storybook/react-vite";
import { Fab } from "./Fab";
import { Plus } from "./PixelIcon";

const meta = {
  title: "Primitives/Fab",
  component: Fab,
  parameters: {
    docs: {
      description: {
        component:
          "The screen's single creation action — a square vermilion plate, deliberately not " +
          "elevated (nothing in this design floats). One per screen, max.",
      },
    },
  },
} satisfies Meta<typeof Fab>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { icon: Plus, label: "Add transaction", onClick: () => {} } };
