import type { Meta, StoryObj } from "@storybook/react-vite";
import { SectionLabel } from "./SectionLabel";

const meta = {
  title: "Primitives/SectionLabel",
  component: SectionLabel,
  parameters: {
    docs: {
      description: {
        component:
          "The one eyebrow/section-heading style: mono, 10px, medium, uppercase, 0.14em tracking, muted.",
      },
    },
  },
} satisfies Meta<typeof SectionLabel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { children: "Budget pace" } };
export const AsHeading: Story = { args: { as: "h2", children: "Projects" } };
