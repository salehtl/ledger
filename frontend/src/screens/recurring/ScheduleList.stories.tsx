import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScheduleList } from "./ScheduleList";
import type { Schedule } from "../../api/types";

function row(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 1,
    merchant: "netflix.com",
    label: "Netflix",
    amount_fils: 5600,
    tolerance_pct: 10,
    interval_days: 30,
    next_due: "2026-08-07",
    direction: "debit",
    category_id: 5,
    account_id: null,
    source: "detected",
    status: "active",
    last_matched_tx_id: 812,
    last_matched_at: "2026-07-07T21:03:00Z",
    last_amount_fils: 5600,
    missed: false,
    price_change: false,
    created_at: "2026-07-29T10:00:00Z",
    updated_at: "2026-07-29T10:00:00Z",
    ...overrides,
  };
}

const meta = {
  title: "Recurring/ScheduleList",
  component: ScheduleList,
  parameters: {
    docs: {
      description: {
        component:
          "The full schedule inventory (active + paused), one calm row each: name, " +
          "cadence · next due · source, amount. Paused rows mute and drop the next-due " +
          "date; the row tap opens the edit sheet, which owns pause/resume/delete.",
      },
    },
  },
  args: { onOpen: () => {} },
} satisfies Meta<typeof ScheduleList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {
  args: {
    schedules: [
      row(),
      row({ id: 2, merchant: "gym co", label: "Gym membership", amount_fils: 25000, source: "manual", next_due: "2026-08-05" }),
      row({ id: 3, merchant: "salary acme gulf llc", label: "Salary", direction: "credit", amount_fils: 2_650_000, next_due: "2026-08-25" }),
    ],
  },
};

export const WithPaused: Story = {
  args: {
    schedules: [
      row(),
      row({ id: 4, merchant: "icloud", label: "iCloud storage", amount_fils: 399, status: "paused", source: "manual" }),
    ],
  },
};
