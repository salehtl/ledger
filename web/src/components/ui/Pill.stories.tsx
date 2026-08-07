import type { Meta, StoryObj } from "@storybook/react-vite";
import { Pill } from "./Pill";

const meta = {
  title: "Primitives/Pill",
  component: Pill,
  parameters: {
    docs: {
      description: {
        component:
          "Small inline status badge. Colour no longer carries status — the label does. " +
          "`attention` is the only tone that spends the spot ink; its one sanctioned use is needs_review.",
      },
    },
  },
} satisfies Meta<typeof Pill>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { children: "Archived" } };
export const Muted: Story = { args: { tone: "muted", children: "no AED rate" } };
export const Attention: Story = { args: { tone: "attention", children: "Needs review" } };
