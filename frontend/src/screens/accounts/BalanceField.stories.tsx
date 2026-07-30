import type { Meta, StoryObj } from "@storybook/react-vite";
import { BalanceField } from "./BalanceField";

const meta = {
  title: "Accounts/BalanceField",
  component: BalanceField,
  parameters: {
    docs: {
      description: {
        component:
          "The balance amount control shared by check-in and tracking updates: a persistent label, " +
          "a +/− sign toggle (the decimal keyboard has no minus, and credit cards owe), and a 16px " +
          "decimal input. A sign typed into the text wins over the toggle. The parse error is " +
          "caller-gated on blur/submit so nothing flashes mid-entry; the helper line yields to it.",
      },
    },
  },
  args: {
    label: "Balance in your bank app",
    text: "",
    onText: () => {},
    sign: "pos",
    onSign: () => {},
  },
  decorators: [(S) => <div className="max-w-md"><S /></div>],
} satisfies Meta<typeof BalanceField>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { id: "balance-default" } };
export const WithHelper: Story = {
  args: {
    id: "balance-helper",
    text: "7450",
    helper: "expected 7,450.00 · last check-in 4d ago",
  },
};
export const ParseError: Story = {
  args: {
    id: "balance-error",
    text: "8250.555",
    error: "Enter an amount like 8,250.00.",
    helper: "expected 7,450.00 · last check-in 4d ago",
  },
};
export const NegativeSign: Story = {
  args: {
    id: "balance-negative",
    label: "Balance now",
    text: "1,230.00",
    sign: "neg",
    helper: "last (1,230.00) · updated yesterday",
  },
};
