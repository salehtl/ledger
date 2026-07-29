import type { Meta, StoryObj } from "@storybook/react-vite";
import { Dialog, DialogFooter } from "./Dialog";
import { Button } from "./Button";

const meta = {
  title: "Primitives/Dialog",
  component: Dialog,
  parameters: {
    docs: {
      description: {
        component:
          "The one modal/bottom-sheet: scrim, slide-up, focus trap, drag-to-dismiss, safe-area padding. " +
          "The single elevated surface in the app — everything else separates with a hairline. " +
          "Bottom actions go in DialogFooter, which stays sticky over scrolling content.",
      },
    },
  },
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Sheet: Story = {
  args: {
    title: "Categorize",
    onClose: () => {},
    children: <p className="text-sm text-muted">Sheet content — pickers, lists, forms.</p>,
  },
};
export const WithFooter: Story = {
  args: {
    title: "Edit category",
    onClose: () => {},
    children: (
      <>
        <p className="text-sm text-muted">Long content scrolls underneath the sticky footer.</p>
        <DialogFooter>
          <Button variant="ghost">Cancel</Button>
          <Button variant="primary">Save</Button>
        </DialogFooter>
      </>
    ),
  },
};
