/**
 * The shell: three tabs, one gear, two drill-ins, and nothing that talks to v1.
 *
 * # What came out of the nav in Task 10, and why most of it was not deleted
 *
 * Plan, Reports, Accounts, Recurring and Projects are **unrouted, not deleted**.
 * Every one of them reads an HTTP route `ledgerd` does not serve, and that is
 * the dangerous kind of broken: the request 404s, react-query holds an error
 * nobody renders, and the screen sits there looking like it is loading. The
 * files stay because each comes back the moment its data grows a projection —
 * `client/src/replay/state.ts` holds `txns`, `rules`, `homeCurrency`, `rates`,
 * `forks` and `anomalies`, and the missing screens are exactly the ones needing
 * an op that does not exist yet. A "coming soon" placeholder would be a promise
 * with no schedule behind it; an absent screen is honest.
 *
 * v1's Settings hub, and the rules and category managers behind it, are the one
 * part that IS deleted (2026-08-10, owner's call). They did not wait for a
 * projection — they came back on one, as `settings/V2Settings.tsx` and
 * `settings/V2CategoriesPanel.tsx`, which read the projection instead of
 * `/api/settings`. Keeping the v1 originals next to their replacements bought
 * nothing but a second answer to the same question; git history has them.
 *
 * Three things left with them, and their absence is deliberate:
 *
 *  - **`IngestHealthBanner`** polls `/api/health`. There is no ingest worker in
 *    v2 — mail arrives over SMTP into the server's own log — and the health this
 *    shell can actually report is the sync row in Settings.
 *  - **`useLiveEvents`** opens an SSE stream at `/api/events` and invalidates a
 *    list of v1 query keys. v2's equivalent is a sync, and the projection moves
 *    only when one lands.
 *  - **The review badge's `/api/transactions?status=needs_review` query**, now
 *    the projection's own `needs_review` lane — the same query key the Review
 *    screen reads, so the badge and the deck can never disagree.
 *
 * # `useV2OrThrow`, and why the shell is the right place for it
 *
 * This component is unconditionally inside `<BootGate>` (see `main.tsx`), takes
 * no injected source, and used to carry a v1 fallback in `refresh` that quietly
 * invalidated HTTP queries when the gate was missing. That fallback existed
 * because this test file mounted the shell bare; the warning it logged said so.
 *
 * The screens below keep their nullable sources — those exist for their
 * injection seams, and their `null` branch is an explicit disconnected state
 * that makes no HTTP call, not a silent degradation. Asserting the invariant
 * once, here at the root, is what makes those branches unreachable in
 * production: if the gate is missing you never get as far as Review's empty
 * state, you get a stack trace naming the cause.
 */

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useV2OrThrow } from "../v2/BootGate";
import { invalidateAfterSync, useReviewFeed, useReviewSource } from "../v2/queries";
import { DECK_LANES } from "../v2/sources/review";
import { BottomNav } from "../components/ui/BottomNav";
import { TopBar } from "../components/ui/TopBar";
import { type TabId } from "./nav";
import { type Scope, scopeBounds } from "../lib/scope";
import { currentPeriod } from "../lib/insights";
import { useOnline } from "../hooks/useOnline";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { PullToRefreshIndicator } from "../components/PullToRefreshIndicator";
import { Home } from "../screens/Home";
import { Transactions } from "../screens/Transactions";
import { Insights } from "../screens/Insights";
import { Review } from "../screens/Review";
import { Quarantine } from "../screens/Quarantine";
import { PwaUpdatePrompt } from "./PwaUpdatePrompt";
import { SettingsPage } from "../screens/settings/SettingsPage";
import { V2Settings } from "../screens/settings/V2Settings";

const TITLES: Record<TabId, string> = {
  home: "Home",
  transactions: "Transactions",
  insights: "Insights",
  review: "Review",
};

/**
 * The two surfaces hosted above the tabs as full-screen drill-ins.
 *
 * They STACK, and held mail is why: it is reachable both from Review (where its
 * count is already stated) and from Settings (where onboarding now hands off an
 * unfiled remainder). Backing out of it must reveal whichever of the two opened
 * it, which a stack gives for free and a single "current overlay" does not.
 */
type Overlay = { kind: "settings" } | { kind: "quarantine" };

export function AppShell() {
  const v2 = useV2OrThrow();
  const [tab, setTab] = useState<TabId>("home");
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const pushOverlay = (o: Overlay) => setOverlays((s) => [...s, o]);
  const popOverlay = () => setOverlays((s) => s.slice(0, -1));

  // Lazy initializer so the default month reflects the day the app opens,
  // not the day this module was first imported.
  const [scope, setScope] = useState<Scope>(() => ({ kind: "month", period: currentPeriod() }));
  const online = useOnline();

  const qc = useQueryClient();
  const mainRef = useRef<HTMLElement>(null);

  /**
   * A pull is a SYNC, not a refetch.
   *
   * The screens read the local projection, so invalidating without syncing
   * first would re-read the same rows and look broken. `run("refresh")` joins
   * whatever sync is already in flight (`SyncEngine`'s rule-3 guard), and the
   * invalidation afterwards is what tells the tree the projection moved.
   *
   * `sync.run` rather than the coordinator directly, because it never rejects: a
   * halt raised by a pull is recorded as a fault on the gate's own status and
   * reaches its wall, instead of being swallowed here.
   */
  const refresh = useCallback(async () => {
    await v2.sync.run("refresh");
    await invalidateAfterSync(qc);
  }, [v2, qc]);
  // Disabled while offline: a pull would haptic-confirm a refresh that can't fetch.
  const { pullDistance, refreshing } = usePullToRefresh(mainRef, refresh, online);

  const bounds = scopeBounds(scope);

  // The same key AND the same lanes the Review screen reads, so the badge and
  // the deck are one pass of the projection rather than two that can disagree.
  // The badge counts what the deck can answer — flagged rows and rows with no
  // category — and nothing else: a badge that counted a lane with no control
  // behind it would send the user to a screen that cannot clear it.
  const reviewFeed = useReviewFeed(useReviewSource(), DECK_LANES);
  const counts = reviewFeed.data?.counts;
  const reviewCount = (counts?.needs_review ?? 0) + (counts?.uncategorized ?? 0);

  // Drill-ins are opaque full-screen panels laid over the tabs, so everything
  // underneath is covered but still in the tab order and the screen-reader
  // cursor — Tab from the Settings back-arrow used to land on the Home rings
  // behind it. `inert` takes the covered layer out of both.
  const covered = overlays.length > 0;

  return (
    <div className="flex flex-col h-[100svh] overflow-hidden">
      <PwaUpdatePrompt />
      <div className="contents" inert={covered}>
        <TopBar
          title={TITLES[tab]}
          scope={scope}
          onScopeChange={setScope}
          // Transactions and Insights are the screens a period bounds. Home
          // sums the whole log (there is no per-period plan in the projection)
          // and the review queue is a state rather than a period — both screens
          // say so in their own headers, and a stepper that changed nothing on
          // the tab you were looking at was the shell contradicting them.
          showScope={tab === "transactions" || tab === "insights"}
          onOpenSettings={() => pushOverlay({ kind: "settings" })}
        />
        {!online && (
          <div role="status" className="shrink-0 bg-warn/15 text-warn text-sm text-center py-1">
            Offline — showing last loaded data
          </div>
        )}
        <main ref={mainRef} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />
          {/* min-h-full + flex-col so a screen that wants the whole viewport can
              ask for it with flex-1 (the Review deck centres itself in the space
              rather than stranding it below the card). pb-8 gives scrollable
              screens a terminus above the nav instead of ending flush. */}
          <div className="max-w-screen-sm w-full mx-auto px-4 pt-4 pb-8 min-h-full flex flex-col">
            {tab === "home" && <Home />}
            {tab === "transactions" && <Transactions from={bounds.from} to={bounds.to} />}
            {tab === "insights" && <Insights scope={scope} />}
            {tab === "review" && <Review onOpenQuarantine={() => pushOverlay({ kind: "quarantine" })} />}
          </div>
        </main>
        <BottomNav active={tab} reviewCount={reviewCount} onNavigate={setTab} />
      </div>
      {overlays.map((o, i) => {
        // Panels stack — held mail opened from Settings leaves Settings mounted
        // beneath it — so every panel except the top one is covered too.
        const buried = i < overlays.length - 1;
        return (
          <div key={`${o.kind}-${i}`} className="contents" inert={buried}>
            {o.kind === "settings" ? (
              <SettingsPage title="Settings" onClose={popOverlay} covered={buried}>
                <V2Settings onOpenQuarantine={() => pushOverlay({ kind: "quarantine" })} />
              </SettingsPage>
            ) : (
              <SettingsPage title="Held mail" onClose={popOverlay}>
                {/* A confirmation releases mail into the log on the SERVER; it
                    reaches this device only on a pull, so the screen is handed
                    one rather than left claiming a filing this ledger cannot
                    see yet. */}
                <Quarantine sync={refresh} />
              </SettingsPage>
            )}
          </div>
        );
      })}
    </div>
  );
}
