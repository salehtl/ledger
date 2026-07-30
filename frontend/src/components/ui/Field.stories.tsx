import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input, NumberField, Select } from "./Field";
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

/**
 * Every numeric field in the app. Clear it and it stays cleared — the parent
 * is told `null`, not `0`, so nothing springs back into the box and nothing
 * bogus gets saved.
 */
export const Number: Story = {
  render: () => {
    const [amount, setAmount] = useState<number | null>(25000);
    return (
      <label className="block text-sm">
        Monthly income (AED)
        <NumberField
          className="mt-1"
          aria-label="Monthly income"
          value={amount}
          onValueChange={setAmount}
          min={0}
          decimals={2}
        />
        <span className="mt-1 block text-xs text-muted">
          committed value: {amount === null ? "null (field is empty)" : amount}
        </span>
      </label>
    );
  },
};

/** A bounded percentage: clamped into 0–100 on blur, not while you type. */
export const NumberPercent: Story = {
  render: () => {
    const [pct, setPct] = useState<number | null>(50);
    return (
      <label className="block text-sm">
        Need %
        <NumberField
          className="mt-1"
          aria-label="Need percent"
          value={pct}
          onValueChange={setPct}
          min={0}
          max={100}
          allowDecimal={false}
        />
      </label>
    );
  },
};
