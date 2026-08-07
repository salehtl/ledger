import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToastProvider, useToast } from "./Toast";
import { Button } from "./ui/Button";

function Trigger({ label, toast }: { label: string; toast: Parameters<ReturnType<typeof useToast>["show"]>[0] }) {
  const { show } = useToast();
  return <Button onClick={() => show(toast)}>{label}</Button>;
}

const meta = {
  title: "Shared/Toast",
  component: ToastProvider,
  parameters: {
    docs: {
      description: {
        component:
          "Transient outcome feedback (saved/failed), swipe-dismissable, with an optional action " +
          "(Undo where the write is reversible). Not for persistent states.",
      },
    },
  },
} satisfies Meta<typeof ToastProvider>;
export default meta;

export const SuccessWithUndo: StoryObj = {
  render: () => (
    <ToastProvider>
      <Trigger
        label="Save rule"
        toast={{ message: "Rule saved — CARREFOUR → Groceries", tone: "success", action: { label: "Undo", onAction: () => {} } }}
      />
    </ToastProvider>
  ),
};
export const ErrorTone: StoryObj = {
  render: () => (
    <ToastProvider>
      <Trigger label="Fail to save" toast={{ message: "Couldn't save — try again", tone: "error" }} />
    </ToastProvider>
  ),
};
