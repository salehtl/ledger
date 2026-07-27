import { Home, ListOrdered, Inbox, PieChart, Settings, type PixelIconType } from "../components/ui/PixelIcon";

export type TabId = "home" | "transactions" | "review" | "insights" | "settings";

export const TABS: { id: TabId; label: string; icon: PixelIconType }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "transactions", label: "Transactions", icon: ListOrdered },
  { id: "review", label: "Review", icon: Inbox },
  { id: "insights", label: "Insights", icon: PieChart },
  { id: "settings", label: "Settings", icon: Settings },
];
