import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Txn } from "../api/types";
import { BottomNav } from "../components/ui/BottomNav";
import { TopBar } from "../components/ui/TopBar";
import { type TabId } from "./nav";
import { type Scope, DEFAULT_SCOPE, scopeBounds, scopeAnchor } from "../lib/scope";
import { useOnline } from "../hooks/useOnline";
import { useLiveEvents } from "../hooks/useLiveEvents";
import { Home } from "../screens/Home";
import { Transactions } from "../screens/Transactions";
import { Insights } from "../screens/Insights";
import { Settings } from "../screens/Settings";
import { ReviewSwipe } from "../screens/ReviewSwipe";

const TITLES: Record<TabId, string> = {
  home: "Home",
  transactions: "Transactions",
  insights: "Insights",
  settings: "Settings",
};

export function AppShell() {
  const [tab, setTab] = useState<TabId>("home");
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  const [inSwipeMode, setInSwipeMode] = useState(false);
  const online = useOnline();
  useLiveEvents();

  const review = useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") });
  const reviewCount = review.data?.length ?? 0;

  const bounds = scopeBounds(scope);
  const anchor = scopeAnchor(scope);

  return (
    <div className="flex flex-col h-[100svh] overflow-hidden">
      <TopBar title={TITLES[tab]} scope={scope} onScopeChange={setScope} showScope={tab !== "settings"} />
      {!online && (
        <div role="status" className="shrink-0 bg-warn/15 text-warn text-sm text-center py-1">Offline — showing last loaded data</div>
      )}
      <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="max-w-screen-sm w-full mx-auto px-4 py-4">
          {tab === "home" && <Home period={anchor} />}
          {tab === "transactions" && <Transactions from={bounds.from} to={bounds.to} onOpenSwipeMode={() => setInSwipeMode(true)} />}
          {tab === "insights" && <Insights period={anchor} />}
          {tab === "settings" && <Settings />}
        </div>
      </main>
      <BottomNav active={tab} reviewCount={reviewCount} onNavigate={setTab} />
      {inSwipeMode && <ReviewSwipe onClose={() => setInSwipeMode(false)} />}
    </div>
  );
}
