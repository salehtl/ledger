import type { Meta, StoryObj } from "@storybook/react-vite";
import { ColorSwatch } from "./ColorSwatch";

const meta = {
  title: "Primitives/ColorSwatch",
  component: ColorSwatch,
  parameters: {
    docs: {
      description: {
        component:
          "The project colour mark — a hairline square hatched with 45° lines of its hue. " +
          "A project mark is a ring/hatch; a bucket mark is a solid fill — form keeps them apart at " +
          "identical hue. Always aria-hidden; the project name prints beside it.",
      },
    },
  },
} satisfies Meta<typeof ColorSwatch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectMark: Story = {
  args: { color: "azure" },
  decorators: [(S) => <span className="inline-flex items-center gap-2 text-sm"><S />Kitchen reno</span>],
};
export const InlineSmall: Story = {
  args: { color: "sage", size: "sm" },
  decorators: [(S) => <span className="inline-flex items-center gap-2 text-xs text-muted"><S />Trip to Salalah</span>],
};
