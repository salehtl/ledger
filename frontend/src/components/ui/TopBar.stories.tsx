import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TopBar } from "./TopBar";
import { type Scope } from "../../lib/scope";

function TopBarDemo({ title, showScope }: { title: string; showScope: boolean }) {
  const [scope, setScope] = useState<Scope>({ kind: "month", period: "2026-07" });
  return <TopBar title={title} scope={scope} onScopeChange={setScope} showScope={showScope} />;
}

const meta = {
  title: "Chrome/TopBar",
  component: TopBar,
  parameters: {
    docs: {
      description: {
        component:
          "Owns the page title (sans) and the period-scope stepper (mono micro-caps — it's data, " +
          "not prose). Screens never render their own h1 outside this.",
      },
    },
  },
} satisfies Meta<typeof TopBar>;
export default meta;

export const WithScope: StoryObj = { render: () => <TopBarDemo title="Insights" showScope /> };
export const TitleOnly: StoryObj = { render: () => <TopBarDemo title="Settings" showScope={false} /> };
