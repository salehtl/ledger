import type { Meta, StoryObj } from "@storybook/react-vite";
import { Switch } from "./Switch";

const meta = {
  title: "Primitives/Switch",
  component: Switch,
  parameters: {
    docs: {
      description: {
        component: "Boolean toggle over a real checkbox (native semantics). Settings rows wrap it in a full-row label.",
      },
    },
  },
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = { args: { "aria-label": "Auto-categorize" } };
export const On: Story = { args: { "aria-label": "Auto-categorize", defaultChecked: true } };
