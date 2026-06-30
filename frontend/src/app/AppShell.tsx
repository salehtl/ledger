import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Txn } from "../api/types";
import { BottomNav } from "../components/ui/BottomNav";
import { TopBar } from "../components/ui/TopBar";
import { type TabId } from "./nav";
import { type Scope, scopeBounds } from "../lib/scope";
import { currentPeriod } from "../lib/insights";
import { useOnline } from "../hooks/useOnline";
import { useLiveEvents } from "../hooks/useLiveEvents";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { PullToRefreshIndicator } from "../components/PullToRefreshIndicator";
import { Home } from "../screens/Home";
import { Transactions } from "../screens/Transactions";
import { Insights } from "../screens/Insights";
import { Settings } from "../screens/Settings";
import { Review } from "../screens/Review";

const TITLES: Record<TabId, string> = {
  home: "Home",
  transactions: "Transactions",
  review: "Review",
  insights: "Insights",
  settings: "Settings",
};

export function AppShell() {
  const [tab, setTab] = useState<TabId>("home");
  // Lazy initializer so the default month reflects the day the app opens,
  // not the day this module was first imported.
  const [scope, setScope] = useState<Scope>(() => ({ kind: "month", period: currentPeriod() }));
  const online = useOnline();
  useLiveEvents();

  const qc = useQueryClient();
  const mainRef = useRef<HTMLElement>(null);
  const { pullDistance, refreshing } = usePullToRefresh(mainRef, () => qc.invalidateQueries());

  const bounds = scopeBounds(scope);

  const review = useQuery({
    queryKey: ["review", bounds.from ?? "", bounds.to ?? ""],
    queryFn: () => {
      const params = new URLSearchParams({ status: "needs_review" });
      if (bounds.from) params.set("from", bounds.from);
      if (bounds.to) params.set("to", bounds.to);
      return getJSON<Txn[]>(`/api/transactions?${params.toString()}`);
    },
  });
  const reviewCount = review.data?.length ?? 0;

  return (
    <div className="flex flex-col h-[100svh] overflow-hidden">
      <TopBar title={TITLES[tab]} scope={scope} onScopeChange={setScope} showScope={tab !== "settings"} />
      {!online && (
        <div role="status" className="shrink-0 bg-warn/15 text-warn text-sm text-center py-1">Offline — showing last loaded data</div>
      )}
      <main ref={mainRef} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />
        <div className="max-w-screen-sm w-full mx-auto px-4 py-4">
          {tab === "home" && <Home scope={scope} />}
          {tab === "transactions" && <Transactions from={bounds.from} to={bounds.to} />}
          {tab === "review" && <Review scope={scope} />}
          {tab === "insights" && <Insights scope={scope} />}
          {tab === "settings" && <Settings scope={scope} />}
        </div>
      </main>
      <BottomNav active={tab} reviewCount={reviewCount} onNavigate={setTab} />
    </div>
  );
}
