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
import type { SettingsIntent } from "../screens/Settings";
import { Review } from "../screens/Review";
import { IngestHealthBanner } from "../components/IngestHealthBanner";
import { PwaUpdatePrompt } from "./PwaUpdatePrompt";
import { ProjectsFlow } from "../screens/projects/ProjectsFlow";
import { PlanScreen } from "../screens/plan/PlanScreen";
import { RecurringScreen } from "../screens/recurring/RecurringScreen";
import { ReportsScreen } from "../screens/reports/ReportsScreen";
import { AccountsScreen } from "../screens/accounts/AccountsScreen";
import { SettingsPage } from "../screens/settings/SettingsPage";

const TITLES: Record<TabId, string> = {
  home: "Home",
  plan: "Plan",
  transactions: "Transactions",
  review: "Review",
  insights: "Insights",
};

/** Secondary surfaces hosted above the tabs as full-screen drill-ins.
 *  Settings keeps its cross-tab deep-link intent (banner → Email ingest). */
type Overlay =
  | { kind: "settings"; intent?: SettingsIntent }
  | { kind: "accounts" }
  | { kind: "recurring" }
  | { kind: "reports" };

export function AppShell() {
  const [tab, setTab] = useState<TabId>("home");
  // Drill-in overlays stack like ProjectsFlow's pages: every panel on the
  // path stays mounted in DOM order, so backing out of Accounts opened from
  // Settings reveals Settings, while Accounts opened from Home pops to Home.
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const pushOverlay = (o: Overlay) => setOverlays((s) => [...s, o]);
  const popOverlay = () => setOverlays((s) => s.slice(0, -1));
  const intentNonce = useRef(0);
  const openIngestHealth = () => {
    intentNonce.current += 1;
    setOverlays([{ kind: "settings", intent: { page: "ingest", nonce: intentNonce.current } }]);
  };

  // Projects is a Home-first feature: it opens as a full-screen overlay over
  // whatever tab is active, never switching the bottom nav to Settings.
  const [projectsView, setProjectsView] = useState<{ projectId?: number } | null>(null);
  const openProjects = () => setProjectsView({});
  const openProject = (id: number) => setProjectsView({ projectId: id });
  // Lazy initializer so the default month reflects the day the app opens,
  // not the day this module was first imported.
  const [scope, setScope] = useState<Scope>(() => ({ kind: "month", period: currentPeriod() }));
  const online = useOnline();
  useLiveEvents();

  const qc = useQueryClient();
  const mainRef = useRef<HTMLElement>(null);
  // Disabled while offline: a pull would haptic-confirm a refresh that can't fetch.
  const { pullDistance, refreshing } = usePullToRefresh(mainRef, () => qc.invalidateQueries(), online);

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

  // Drill-ins are opaque full-screen panels laid over the tabs, so everything
  // underneath is covered but still in the tab order and the screen-reader
  // cursor — Tab from the Settings back-arrow used to land on the Home rings
  // behind it. `inert` takes the covered layer out of both.
  const covered = overlays.length > 0 || projectsView !== null;
  // Settings owns its own sub-page stack, so it has to tell us when one is
  // open — otherwise the Settings panel's back arrow stays tabbable behind it.
  const [settingsSubpage, setSettingsSubpage] = useState(false);
  const [accountsSubpage, setAccountsSubpage] = useState(false);

  return (
    <div className="flex flex-col h-[100svh] overflow-hidden">
      <PwaUpdatePrompt />
      <div className="contents" inert={covered}>
      <TopBar
        title={TITLES[tab]}
        scope={scope}
        onScopeChange={setScope}
        showScope
        onOpenSettings={() => pushOverlay({ kind: "settings" })}
      />
      {!online && (
        <div role="status" className="shrink-0 bg-warn/15 text-warn text-sm text-center py-1">Offline — showing last loaded data</div>
      )}
      <IngestHealthBanner onView={openIngestHealth} />
      <main ref={mainRef} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />
        {/* min-h-full + flex-col so a screen that wants the whole viewport can
            ask for it with flex-1 (the Review deck centres itself in the space
            rather than stranding it below the card). pb-8 gives scrollable
            screens a terminus above the nav instead of ending flush. */}
        <div className="max-w-screen-sm w-full mx-auto px-4 pt-4 pb-8 min-h-full flex flex-col">
          {tab === "home" && (
            <Home
              scope={scope}
              onOpenProject={openProject}
              onOpenProjects={openProjects}
              onOpenPlan={() => setTab("plan")}
              onOpenRecurring={() => pushOverlay({ kind: "recurring" })}
              onOpenReports={() => pushOverlay({ kind: "reports" })}
            />
          )}
          {tab === "plan" && <PlanScreen scope={scope} />}
          {tab === "transactions" && <Transactions from={bounds.from} to={bounds.to} />}
          {tab === "review" && <Review scope={scope} />}
          {tab === "insights" && <Insights scope={scope} />}
        </div>
      </main>
      <BottomNav active={tab} reviewCount={reviewCount} onNavigate={setTab} />
      </div>
      {overlays.map((o, i) => {
        // Panels stack — Accounts opened from Settings leaves Settings mounted
        // beneath it — so every panel except the top one is covered too.
        const buried = i < overlays.length - 1 || projectsView !== null;
        return (
          <div key={`${o.kind}-${i}`} className="contents" inert={buried}>
            {o.kind === "settings" ? (
              <SettingsPage title="Settings" onClose={popOverlay} covered={settingsSubpage}>
                <Settings
                  scope={scope}
                  intent={o.intent}
                  onSubpageChange={setSettingsSubpage}
                  onOpenProjects={openProjects}
                  onOpenAccounts={() => pushOverlay({ kind: "accounts" })}
                  onOpenRecurring={() => pushOverlay({ kind: "recurring" })}
                />
              </SettingsPage>
            ) : o.kind === "accounts" ? (
              <SettingsPage title="Accounts" onClose={popOverlay} covered={accountsSubpage}>
                <AccountsScreen onDetailChange={setAccountsSubpage} />
              </SettingsPage>
            ) : o.kind === "reports" ? (
              <SettingsPage title="Reports" onClose={popOverlay}>
                <ReportsScreen focus="networth" />
              </SettingsPage>
            ) : (
              <SettingsPage title="Recurring" onClose={popOverlay}>
                <RecurringScreen />
              </SettingsPage>
            )}
          </div>
        );
      })}
      {projectsView !== null && (
        <ProjectsFlow initialProjectId={projectsView.projectId} onClose={() => setProjectsView(null)} />
      )}
    </div>
  );
}
