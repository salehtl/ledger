import { Home, ListOrdered, Inbox, PieChart, Settings, type LucideIcon } from "lucide-react";

export type TabId = "home" | "transactions" | "review" | "insights" | "settings";

export const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "transactions", label: "Transactions", icon: ListOrdered },
  { id: "review", label: "Review", icon: Inbox },
  { id: "insights", label: "Insights", icon: PieChart },
  { id: "settings", label: "Settings", icon: Settings },
];
