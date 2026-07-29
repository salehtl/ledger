import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyState } from "./EmptyState";
import { AlertTriangle, Inbox } from "./ui/PixelIcon";

const meta = {
  title: "Shared/EmptyState",
  component: EmptyState,
  parameters: {
    docs: {
      description: {
        component: "Canonical empty/error state (icon chip + title + hint). Used for both no-data and query-error states.",
      },
    },
  },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoData: Story = {
  args: { icon: Inbox, title: "No recent activity", hint: "New transactions will appear here." },
};
export const QueryError: Story = {
  args: { icon: AlertTriangle, title: "Couldn't load your spending", hint: "Check your connection and try again." },
};
