import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card } from "./Card";

const meta = {
  title: "Primitives/Card",
  component: Card,
  parameters: {
    docs: {
      description: {
        component:
          "The paper content surface — hairline border, 2px radius, p-4. " +
          "`padding=\"none\"` plus an inner divide-y list whose rows carry their " +
          "own `px-4` is the list-card idiom: hairlines run edge to edge, content " +
          "keeps the standard inset. Prefer it over `className=\"!p-0\"`, whose " +
          "`!important` outranks any padding utility beside it.",
      },
    },
  },
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: <p className="text-sm">Card content sits on the same paper as the page — separation is the hairline.</p> },
};
export const ListCard: Story = {
  args: {
    padding: "none",
    children: (
      <ul className="divide-y divide-border">
        {[
          ["CARREFOUR", "-142.75"],
          ["CAREEM", "-38.00"],
        ].map(([m, amt]) => (
          <li key={m} className="p-4 flex items-center justify-between">
            <span className="font-medium text-sm">{m}</span>
            <span className="tnum text-sm">{amt}</span>
          </li>
        ))}
      </ul>
    ),
  },
};
