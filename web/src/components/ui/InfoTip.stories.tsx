import type { Meta, StoryObj } from "@storybook/react-vite";
import { InfoTip } from "./InfoTip";

const meta = {
  title: "Primitives/InfoTip",
  component: InfoTip,
  parameters: {
    docs: {
      description: {
        component:
          "A tap-to-open explanation anchored to the label it explains. Tap, never hover; the trigger is a " +
          "button named \"About <the thing>\"; the panel holds one or two sentences and never a control. " +
          "Anything with a decision, a control, or more than two sentences is a Dialog instead.",
      },
    },
  },
} satisfies Meta<typeof InfoTip>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A definition, beside the term it defines. */
export const Default: Story = {
  args: {
    about: "the signing domain",
    children: "The domain that cryptographically signed the message. It is the one thing about held mail ledger can verify by itself.",
  },
  render: (args) => (
    <p className="text-sm">
      Signing domain
      <InfoTip {...args} />
    </p>
  ),
};

/** Anchored to the right edge, for a trigger near the right of a row. */
export const AlignedEnd: Story = {
  args: {
    about: "held mail",
    align: "end",
    children: "ledger files mail only when it can prove it came from a bank. Anything else is held, and held mail is never read for you.",
  },
  render: (args) => (
    <div className="flex justify-end text-sm">
      Held mail
      <InfoTip {...args} />
    </div>
  ),
};
