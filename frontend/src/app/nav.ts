import { Home, ListOrdered, Inbox, PieChart, PiggyBank, type PixelIconType } from "../components/ui/PixelIcon";

// The five primary destinations (P5: ≤5, task nouns). Settings lives behind
// the TopBar gear; Reports / Accounts / Recurring open as full-screen
// drill-ins from Insights, Settings and Home rather than holding tab slots.
export type TabId = "home" | "plan" | "transactions" | "review" | "insights";

export const TABS: { id: TabId; label: string; icon: PixelIconType }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "plan", label: "Plan", icon: PiggyBank },
  { id: "transactions", label: "Transactions", icon: ListOrdered },
  { id: "review", label: "Review", icon: Inbox },
  { id: "insights", label: "Insights", icon: PieChart },
];
