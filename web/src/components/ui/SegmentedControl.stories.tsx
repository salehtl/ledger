import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SegmentedControl } from "./SegmentedControl";

type Status = "all" | "confirmed" | "review";

function StatusFilterDemo({ fullWidth = false }: { fullWidth?: boolean }) {
  const [value, setValue] = useState<Status>("all");
  return (
    <SegmentedControl
      value={value}
      onChange={setValue}
      fullWidth={fullWidth}
      options={[
        { value: "all", label: "All" },
        { value: "confirmed", label: "Confirmed" },
        { value: "review", label: "Review", badge: 3 },
      ]}
    />
  );
}

const meta = {
  title: "Primitives/SegmentedControl",
  component: SegmentedControl,
  parameters: {
    docs: {
      description: {
        component:
          "Exclusive choice between 2–6 short options. An option can carry a small count badge. " +
          "`fullWidth` stretches to equal-width, never-wrapping segments (page-level status filter).",
      },
    },
  },
} satisfies Meta<typeof SegmentedControl>;
export default meta;

export const StatusFilter: StoryObj = { render: () => <StatusFilterDemo /> };
export const FullWidth: StoryObj = { render: () => <StatusFilterDemo fullWidth /> };
