import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";

const meta = {
  title: "Primitives/Button",
  component: Button,
  args: { children: "Add transaction" },
  parameters: {
    docs: {
      description: {
        component:
          "Any labeled tap action. Primary and danger share the one vermilion plate — " +
          "red is rationed, so the label tells them apart. 44px min height, 2px radius, " +
          "press feedback from the shared Pressable primitive.",
      },
    },
  },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = { args: { variant: "secondary", children: "Secondary" } };
export const Ghost: Story = { args: { variant: "ghost", children: "Cancel" } };
export const Danger: Story = { args: { variant: "danger", children: "Delete rule" } };
export const Disabled: Story = { args: { variant: "primary", disabled: true } };
