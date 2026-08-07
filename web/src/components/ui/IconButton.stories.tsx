import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconButton } from "./IconButton";
import { Search, Trash2 } from "./PixelIcon";

const meta = {
  title: "Primitives/IconButton",
  component: IconButton,
  parameters: {
    docs: {
      description: {
        component:
          "Icon-only action with a required accessible label. 44px default; size=\"sm\" (36px) " +
          "only inside dense stacked rows. Danger tone keeps red for interaction states — rest is muted.",
      },
    },
  },
} satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Muted: Story = { args: { label: "Search", children: <Search size={24} aria-hidden /> } };
export const Accent: Story = { args: { label: "Confirm", tone: "accent", children: <Search size={24} aria-hidden /> } };
export const Danger: Story = { args: { label: "Delete rule", tone: "danger", children: <Trash2 size={24} aria-hidden /> } };
export const DenseSmall: Story = { args: { label: "Delete category", size: "sm", children: <Trash2 size={24} aria-hidden /> } };
