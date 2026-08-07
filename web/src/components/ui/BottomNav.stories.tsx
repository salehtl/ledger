import type { Meta, StoryObj } from "@storybook/react-vite";
import { BottomNav } from "./BottomNav";

const meta = {
  title: "Chrome/BottomNav",
  component: BottomNav,
  parameters: {
    docs: {
      description: {
        component:
          "Five tabs. The active tab is a 2px vermilion tick on the top hairline plus text-fg — " +
          "never a tinted pill, never accent-coloured label text. The review badge is one of the " +
          "five sanctioned full-opacity red uses app-wide.",
      },
    },
  },
} satisfies Meta<typeof BottomNav>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { active: "home", reviewCount: 0, onNavigate: () => {} } };
export const WithReviewBadge: Story = { args: { active: "transactions", reviewCount: 3, onNavigate: () => {} } };
