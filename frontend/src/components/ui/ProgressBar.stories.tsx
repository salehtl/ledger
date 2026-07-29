import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProgressBar } from "./ProgressBar";

const meta = {
  title: "Primitives/ProgressBar",
  component: ProgressBar,
  parameters: {
    docs: {
      description: {
        component:
          "The app's one progress/pace bar. Texture is constant (dithered); the ink travels the " +
          "pace ramp: ink while inside pace → amber-orange past pace → red past budget. " +
          "No `pace` means no amber — an open-ended target has nothing to be ahead of. " +
          "`onAccent` (hero panel) carries state as texture instead: dotted until over budget, then solid.",
      },
    },
  },
} satisfies Meta<typeof ProgressBar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnderPace: Story = { args: { pct: 0.62, pace: 0.68, label: "Needs budget used" } };
export const OverPace: Story = { args: { pct: 0.78, pace: 0.68, label: "Wants budget used" } };
export const OverBudget: Story = { args: { pct: 1.12, pace: 0.68, label: "Total budget used" } };
export const NoPace: Story = { args: { pct: 0.85, label: "Project budget used" } };
export const HeroOnAccent: Story = {
  args: { pct: 1.05, pace: 0.68, onAccent: true, label: "Total budget used" },
  decorators: [(S) => <div className="bg-hero text-hero-fg p-5 rounded-[var(--radius)]"><S /></div>],
};
