// Navigation map for the UI harness.
//
// The app has no URL routing — every screen is reached by tapping through the
// real UI (tabs, the TopBar gear, drill-in rows). So each screen here declares
// the literal tap sequence a user would perform. That means the harness
// exercises the same code paths a human does; if a screen becomes unreachable,
// the harness fails to reach it too, which is the point.

// Playwright context options. The viewport MUST be nested under `viewport:` —
// passing width/height at the top level is silently ignored and you get the
// 1280x720 desktop default, which reviews a layout the app never ships to.
export const VIEWPORTS = {
  // iPhone 14/15 logical size — the app's primary target.
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  // iPhone SE / small Android — the width things break at.
  small: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  // Large phone, to catch layouts that only fill on short screens.
  tall: { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

/** Wait for the app to be visually settled: no in-flight fetches, animations done. */
export async function settle(page, ms = 500) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

/** Tap a control by selector, failing loudly with context if it isn't there. */
export async function tap(page, selector, { timeout = 8000 } = {}) {
  const el = page.locator(selector).first();
  try {
    await el.waitFor({ state: "visible", timeout });
  } catch {
    throw new Error(`tap: no visible element for ${selector}`);
  }
  await el.click({ timeout });
  await page.waitForTimeout(420); // slide/page transitions
}

/**
 * Tap a control by selector, preferring the LAST match rather than the first.
 *
 * AppShell keeps every panel on the current drill-in path mounted (just
 * `inert`), so a card also shown on Home (e.g. a project's ProjectCard, via
 * its "glance" section) still matches a text selector while its *foreground*
 * duplicate is open three panels deep in Settings. `.first()` then resolves
 * to the covered, non-interactive copy and the click hangs for the full
 * timeout waiting on an element that can never become actionable. The
 * foreground overlay is mounted after its covered ancestors in JSX order, so
 * `.last()` reliably lands on the interactive one. Use this instead of `tap`
 * whenever the same label/text can legitimately appear on more than one
 * mounted-but-covered layer (found via the project-detail nav entry).
 */
export async function tapLast(page, selector, { timeout = 8000 } = {}) {
  const el = page.locator(selector).last();
  try {
    await el.waitFor({ state: "visible", timeout });
  } catch {
    throw new Error(`tapLast: no visible element for ${selector}`);
  }
  await el.click({ timeout });
  await page.waitForTimeout(420); // slide/page transitions
}

/** Tap a settings hub row by its visible label. */
export async function tapRow(page, label) {
  const el = page.locator(`button:has-text("${label}")`).first();
  await el.waitFor({ state: "visible", timeout: 8000 });
  await el.click();
  await page.waitForTimeout(450);
}

const TAB = {
  home: 'nav button[aria-label="Home"]',
  plan: 'nav button[aria-label="Plan"]',
  transactions: 'nav button[aria-label="Transactions"]',
  // The review tab's accessible name carries the pending count when non-zero.
  review: 'nav button[aria-label^="Review"]',
  insights: 'nav button[aria-label="Insights"]',
};

const gotoTab = (id) => async (page) => {
  await tap(page, TAB[id]);
  await settle(page, 350);
};

/** Open the Settings hub from the TopBar gear (available on every tab). */
async function openSettings(page) {
  await tap(page, TAB.home);
  await tap(page, '[aria-label="Settings"]');
  await settle(page, 350);
}

/** Open a Settings sub-page by drilling in from the hub. */
const gotoSettingsPage = (label) => async (page) => {
  await openSettings(page);
  await tapRow(page, label);
  await settle(page, 350);
};

/**
 * Every reviewable surface in the app. `interactions` documents the extra
 * states a reviewer should also capture (sheets, filters, editors) — the
 * capture tool can drive them via `--state`.
 */
export const SCREENS = [
  {
    id: "home",
    title: "Home",
    goto: gotoTab("home"),
    notes: "Budget rings, pocket strip, projects glance, 6-month trend.",
  },
  {
    id: "plan",
    title: "Plan (envelopes)",
    goto: gotoTab("plan"),
    notes: "Ready-to-assign banner, envelope rows, assign/move/target sheets.",
    interactions: {
      assign: async (page) => {
        await page.locator("button").filter({ hasText: /assign/i }).first().click().catch(() => {});
        await page.waitForTimeout(500);
      },
    },
  },
  {
    id: "transactions",
    title: "Transactions",
    goto: gotoTab("transactions"),
    notes: "Filter chips, search, grouped rows, swipe actions, detail sheet.",
    interactions: {
      search: async (page) => {
        const s = page.locator('input[type="search"], input[placeholder*="earch"]').first();
        if (await s.count()) {
          await s.click();
          await s.fill("carrefour");
          await page.waitForTimeout(600);
        }
      },
      detail: async (page) => {
        await page.locator('[data-testid="txn-row"], li button, [role="button"]').first().click().catch(() => {});
        await page.waitForTimeout(600);
      },
    },
  },
  {
    id: "review",
    title: "Review (swipe deck)",
    goto: gotoTab("review"),
    notes: "Categorizer deck, empty state when the queue drains.",
  },
  {
    id: "insights",
    title: "Insights",
    goto: gotoTab("insights"),
    notes: "Category breakdown, trend chart, reports entry points.",
  },
  {
    id: "reports",
    title: "Reports",
    goto: async (page) => {
      await tap(page, TAB.home);
      await tap(page, '[aria-label="Open Reports"]');
      await settle(page, 400);
    },
    notes: "Net worth chart, income/expense matrix, age of money, trend compare.",
  },
  {
    id: "recurring",
    title: "Recurring bills",
    goto: async (page) => {
      await tap(page, TAB.home);
      await tap(page, '[aria-label="Open Recurring"]');
      await settle(page, 400);
    },
    notes: "Upcoming feed, schedule list, detected proposals, schedule form.",
  },
  {
    id: "accounts",
    title: "Accounts",
    goto: async (page) => {
      await openSettings(page);
      await tapRow(page, "Accounts");
      await settle(page, 400);
    },
    notes: "Account rows, balances, discrepancy card, add/update/check-in sheets.",
  },
  // account detail is a full-screen SettingsPage of its own (balance history,
  // check-in/update, kind toggle, delete) — reachable off the seeded
  // "Emirates NBD Current" budget account (harness/seed.mjs), not a
  // special-data state, so it gets its own id for the geometry audit.
  {
    id: "account-detail",
    title: "Accounts › account detail",
    goto: async (page) => {
      await openSettings(page);
      await tapRow(page, "Accounts");
      await settle(page, 400);
      await tap(page, 'button:has-text("Emirates NBD Current")');
      await settle(page, 400);
    },
    notes: "Balance history sparkline, check-in/update balance, kind toggle, delete.",
  },
  {
    id: "projects",
    title: "Projects",
    goto: async (page) => {
      await openSettings(page);
      await tapRow(page, "Projects");
      await settle(page, 400);
    },
    notes: "Project list, detail, form, bulk backfill.",
  },
  // ---- projects drill-ins -------------------------------------------------
  // list -> detail -> form/bulk-backfill are each a full-screen SettingsPage
  // (not a Dialog), so they need their own screen ids for shoot.mjs's
  // geometry audit to reach them at all. Reachable deterministically off the
  // seeded "Japan Trip" project (harness/seed.mjs), not a special-data state.
  {
    // "Mark complete"/"Reopen" fire a real PUT with no confirming Dialog —
    // probe.mjs never clicks them because they match its DESTRUCTIVE regex.
    id: "project-detail",
    title: "Projects › project detail",
    goto: async (page) => {
      await openSettings(page);
      await tapRow(page, "Projects");
      await settle(page, 400);
      await tapLast(page, 'button:has-text("Japan Trip")');
      await settle(page, 400);
    },
    notes: "Budget state, count-in-monthly toggle, category breakdown, assigned transactions, edit/complete/delete.",
  },
  {
    id: "project-form",
    title: "Projects › new project form",
    goto: async (page) => {
      await openSettings(page);
      await tapRow(page, "Projects");
      await settle(page, 400);
      await tap(page, 'button:has-text("+ New project")');
      await settle(page, 400);
    },
    notes: "Name, budget, color, date-range fields for a new project (no data dependency, always reachable).",
  },
  {
    // "Assign N to <project>" fires a real bulk-assign PUT with no confirming
    // Dialog — probe.mjs never clicks it because it matches the DESTRUCTIVE
    // regex's `assign \d` clause.
    id: "project-bulk-backfill",
    title: "Projects › bulk backfill",
    goto: async (page) => {
      await openSettings(page);
      await tapRow(page, "Projects");
      await settle(page, 400);
      await tapLast(page, 'button:has-text("Japan Trip")');
      await settle(page, 400);
      await tap(page, 'button:has-text("Add transactions")');
      await settle(page, 400);
    },
    notes: "Inline date/merchant/category filters over the full transaction list, bulk-assign into the project.",
  },
  {
    id: "settings",
    title: "Settings hub",
    goto: async (page) => {
      await openSettings(page);
    },
    notes: "Grouped drill-in rows with state previews; danger zone.",
  },
  // ---- settings sub-pages ------------------------------------------------
  { id: "settings-budget", title: "Settings › Budget & income", goto: gotoSettingsPage("Budget & income") },
  { id: "settings-categorization", title: "Settings › Categorization", goto: gotoSettingsPage("Categorization") },
  { id: "settings-swipe", title: "Settings › Swipe actions", goto: gotoSettingsPage("Swipe actions") },
  { id: "settings-ingest", title: "Settings › Email ingest", goto: gotoSettingsPage("Email ingest") },
  { id: "settings-ai", title: "Settings › AI & API usage", goto: gotoSettingsPage("AI & API usage") },
  { id: "settings-notifications", title: "Settings › Notifications", goto: gotoSettingsPage("Notifications") },
  { id: "settings-textsize", title: "Settings › Text size", goto: gotoSettingsPage("Text size") },
  { id: "settings-categories", title: "Settings › Categories", goto: gotoSettingsPage("Categories") },
  { id: "settings-rules", title: "Settings › Rules", goto: gotoSettingsPage("Rules") },
  { id: "settings-currencies", title: "Settings › Currencies", goto: gotoSettingsPage("Currencies") },
  { id: "settings-transfers", title: "Settings › Transfers", goto: gotoSettingsPage("Transfers") },
];

export const SCREEN_IDS = SCREENS.map((s) => s.id);
export const screenById = (id) => SCREENS.find((s) => s.id === id);
