import { Home, ListOrdered, Inbox, PieChart, Settings, PiggyBank, ArrowLeftRight, TrendingUp, FolderKanban, type PixelIconType } from "../components/ui/PixelIcon";

export type TabId =
  | "home"
  | "plan"
  | "transactions"
  | "review"
  | "insights"
  | "settings"
  // v3 build-phase scaffold tabs; final IA lands with the integration piece.
  | "recurring"
  | "reports"
  | "accounts";

export const TABS: { id: TabId; label: string; icon: PixelIconType }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "plan", label: "Plan", icon: PiggyBank },
  { id: "transactions", label: "Transactions", icon: ListOrdered },
  { id: "review", label: "Review", icon: Inbox },
  { id: "insights", label: "Insights", icon: PieChart },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "recurring", label: "Recurring", icon: ArrowLeftRight },
  { id: "reports", label: "Reports", icon: TrendingUp },
  { id: "accounts", label: "Accounts", icon: FolderKanban },
];
