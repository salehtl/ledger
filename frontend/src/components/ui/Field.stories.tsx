import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input, Select } from "./Field";
import { Search } from "./PixelIcon";

const meta = {
  title: "Primitives/Field",
  component: Input,
  parameters: {
    docs: {
      description: {
        component:
          "The only text/select controls. 16px font (anything smaller makes iOS Safari zoom on focus), " +
          "44px min height. `inset` is for fields inside a Dialog, whose panel is already bg-surface.",
      },
    },
  },
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TextInput: Story = { args: { placeholder: "Merchant contains…" } };
export const SearchInput: Story = { args: { placeholder: "Search merchants…", icon: Search } };
export const InsetInput: Story = { args: { placeholder: "0.00", inset: true, inputMode: "decimal" } };
export const CategorySelect: Story = {
  render: () => (
    <Select defaultValue="groceries" aria-label="Category">
      <option value="groceries">Groceries</option>
      <option value="transport">Transport</option>
      <option value="dining">Dining out</option>
    </Select>
  ),
};
