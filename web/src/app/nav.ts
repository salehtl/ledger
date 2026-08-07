import { Home, ListOrdered, PieChart, Inbox, type PixelIconType } from "../components/ui/PixelIcon";

/**
 * The tabs, which in v2 are exactly the screens the local projection can feed.
 *
 * Plan left the bar, and the screens behind it are **unrouted, not deleted**.
 * The reason is the same one `Home.tsx` gives for the widgets it dropped:
 * `client/src/replay/state.ts` holds `txns`, `rules`, `homeCurrency`, `rates`,
 * `forks` and `anomalies`, and no op authors an envelope, a monthly target, a
 * project, a schedule or an account balance. A tab that opened a screen reading
 * `/api/insights/trend` would not fail — `ledgerd` does not serve that route, so
 * it would render an empty, plausible-looking screen forever. The files stay
 * because they come back the moment their data grows a projection, and a
 * "coming soon" placeholder is a promise this codebase cannot currently keep.
 *
 * **Insights came back** in Task 4, on `v2/sources/insights.ts` — the month's
 * spending split, its month-over-month deltas and the in-vs-out flow are all
 * sums over ops the log has had since Phase 1. What it could NOT bring back
 * (the Reports suite, the over-budget markers) is listed on the screen itself.
 *
 * The other two v2 destinations are deliberately not tabs:
 *
 *  - **Settings** is the TopBar gear, as it has been since v3. It is a place you
 *    go to change something, not a task you return to.
 *  - **Held mail** is a drill-in, reached from Review (where its count is
 *    already stated) and from Settings (which is where onboarding now hands off
 *    an unfiled remainder). It is a decision made rarely — once per bank — and
 *    the bar is for task nouns.
 */
export type TabId = "home" | "transactions" | "insights" | "review";

export const TABS: { id: TabId; label: string; icon: PixelIconType }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "transactions", label: "Transactions", icon: ListOrdered },
  { id: "insights", label: "Insights", icon: PieChart },
  { id: "review", label: "Review", icon: Inbox },
];
