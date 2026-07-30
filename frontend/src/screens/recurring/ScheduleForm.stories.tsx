import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScheduleForm } from "./ScheduleForm";
import type { Schedule } from "./api";
import type { Category } from "../../api/types";

const categories: Category[] = [
  { ID: 5, Name: "Subscriptions", Kind: "spending", Bucket: "want", IsActive: true },
  { ID: 7, Name: "Utilities", Kind: "spending", Bucket: "need", IsActive: true },
];

const active: Schedule = {
  id: 3,
  merchant: "gym co",
  label: "Gym membership",
  amount_fils: 25000,
  tolerance_pct: 10,
  interval_days: 30,
  next_due: "2026-08-05",
  direction: "debit",
  category_id: 5,
  account_id: null,
  source: "manual",
  status: "active",
  last_matched_tx_id: null,
  last_amount_fils: null,
  missed: false,
  price_change: false,
  created_at: "2026-07-29T10:00:00Z",
  updated_at: "2026-07-29T10:00:00Z",
};

const meta = {
  title: "Recurring/ScheduleForm",
  component: ScheduleForm,
  parameters: {
    docs: {
      description: {
        component:
          "Manual schedule sheet for bills that never email, doubling as the edit sheet. " +
          "Edit mode opens pre-filled and carries pause/resume plus a two-tap delete kept " +
          "away from Save. Validation is lib/recurring's buildSchedulePayload.",
      },
    },
  },
  args: {
    categories,
    onSubmit: () => {},
    onClose: () => {},
  },
} satisfies Meta<typeof ScheduleForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Create: Story = {};

export const Edit: Story = {
  args: { initial: active, onPauseToggle: () => {}, onDelete: () => {} },
};

export const EditPaused: Story = {
  args: { initial: { ...active, status: "paused" }, onPauseToggle: () => {}, onDelete: () => {} },
};
