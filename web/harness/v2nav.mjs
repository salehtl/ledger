/**
 * The v2 product, reachable — the ceremony, the fixture data and the screen map.
 *
 * # Why this exists rather than a reuse of `nav.mjs`
 *
 * `nav.mjs` is v1's, and it no longer sits next door: `web/harness/`'s v1 forks
 * were deleted on 2026-08-10 and the canonical copy lives in
 * `frontend/harness/nav.mjs`. It taps v1's Settings hub rows against a vite
 * serving `$REPO/frontend`, and it has no idea what a passkey is. Point it at a
 * v2 change and it reports a clean screen it never loaded — the failure mode
 * this whole directory exists to prevent. Nothing here imports it.
 *
 * `v2settings.mjs` got as far as one screen. Everything it learned that still
 * holds is carried over here; everything it assumed that has since changed is
 * not. Two steps it waits for — the recovery type-back and the whole verification
 * gate — no longer exist, so it cannot complete its own walk any more.
 *
 * # Three things this module owns
 *
 *  1. **{@link ceremony}** — sign-up through to the product shell. `BootGate` is
 *     in front of every screen and there is no way past it but a real account,
 *     so every runner in this family starts here.
 *  2. **{@link seed}** — fixture data, authored through the app's own CSV import.
 *     There is no HTTP seam to write through: v2's screens read a local
 *     projection of an append-only op log, so the only honest way to put a
 *     transaction on a screen is to make the app author the op. That also means
 *     the fixtures exercise the importer, which is a second thing measured for
 *     free.
 *  3. **{@link SCREENS}** — every product surface, as the literal taps a user
 *     performs. There is no URL routing to shortcut through, so a screen that
 *     becomes unreachable in the UI becomes unreachable here too. **That failure
 *     is a finding, not a harness bug.**
 *
 * # The fixtures are hostile on purpose
 *
 * Bugs hide in the happy path. `seed` writes a merchant wider than any phone, the
 * widest number the formatter can emit, a foreign currency with no configured
 * rate, and a category name long enough to wrap a chip. v1's `seed.mjs` found
 * more defects with that list than every other technique in this directory
 * combined.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ORIGIN = process.env.LEDGER_HARNESS_ORIGIN ?? "http://localhost:5177";

/** iPhone 14 Pro, and the 320px stress width every grid is sized against. */
export const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  small: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 },
};

/**
 * A resident-key software authenticator, which is what makes the walk possible.
 *
 * The passkey routes verify real signatures — `api.NewServer`'s dev-auth block
 * replaces the ID-token verifiers and never touches `s.Passkeys` — so there is no
 * flag that gets a session without one. Chromium's CDP authenticator signs for
 * real and go-webauthn accepts it like any other.
 */
export const VIRTUAL_AUTHENTICATOR = {
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

export async function settle(page, ms = 400) {
  await page.waitForTimeout(ms);
}

/**
 * A context with the authenticator already installed. Chromium only — CDP.
 *
 * `hasTouch` is off by default and opt-in per runner. It is not cosmetic: with
 * it off the context accepts no touch input at all, so a synthesised touch
 * gesture silently does nothing — which made a scroll check report the left
 * edge of a drill-in unscrollable when the middle of it was equally
 * unscrollable, i.e. when the runner could not scroll anything. It is left off
 * for the capture runs because Tailwind gates `hover:` on `(hover: hover)`, and
 * flipping that mid-review would change every screenshot for a reason unrelated
 * to any change under test.
 */
export async function newSignedOutContext(browser, { viewport = "phone", colorScheme = "light", hasTouch = false } = {}) {
  const context = await browser.newContext({ ...VIEWPORTS[viewport], colorScheme, hasTouch });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: VIRTUAL_AUTHENTICATOR });
  return { context, page, cdp };
}

/**
 * Sign up and walk onboarding to the product shell.
 *
 * `onStep(id, page)` is called once per onboarding screen, before the press that
 * leaves it — that is the only moment those screens are on the glass, and they
 * are unreachable afterwards. A runner that wants to audit onboarding passes a
 * hook; one that only wants the product passes nothing.
 *
 * `skip: true` takes "Set this up later" at every step it is offered, which is a
 * genuinely different end state — the Home screen then carries three setup tasks
 * — and is itself worth capturing.
 */
export async function ceremony(page, invite, { onStep = async () => {}, skip = false } = {}) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });

  await page.getByTestId("welcome").waitFor({ timeout: 60_000 });
  await onStep("onb-welcome", page);
  await page.getByLabel("Invite code").first().fill(invite);
  await page.getByRole("button", { name: /Create my account/i }).click();

  await page.getByTestId("welcome-created").waitFor({ timeout: 60_000 });
  await onStep("onb-created", page);
  await page.getByRole("button", { name: /^Not now$/i }).click();

  await page.getByTestId("onboarding-recovery").waitFor({ timeout: 60_000 });
  // The words are read before the press, because this is the only screen that
  // ever shows them and a runner may want to keep them.
  const phrase = await page.$$eval('[data-testid="recovery-phrase-words"] li', (items) =>
    items.map((li) => li.textContent.replace(/^\d+/, "").trim()),
  );
  await onStep("onb-recovery", page);
  await page.getByRole("button", { name: /^I have written these down$/i }).click();

  /*
   * The bank step, IF the walk still has one.
   *
   * It was removed on 2026-08-10: templates key on the message's verified
   * sending domain, so arriving mail proves the bank and asking was a question
   * the app could answer itself. Banks moved to Settings. The step is waited for
   * conditionally rather than deleted outright because this walk is also the
   * only automated route through onboarding — if it comes back, or if a runner
   * is pointed at an older build, a hard `waitFor` here would fail for sixty
   * seconds and blame the wrong screen.
   */
  const bank = page.getByTestId("bank");
  await Promise.race([
    bank.waitFor({ timeout: 15_000 }).catch(() => {}),
    page.getByTestId("inbound-address").waitFor({ timeout: 15_000 }).catch(() => {}),
  ]);
  if ((await bank.count()) > 0) {
    await onStep("onb-bank", page);
    if (skip) {
      await page.getByRole("button", { name: /^Set this up later$/i }).click();
    } else {
      await page.getByTestId("bank-row-dib").click();
      await page.getByTestId("bank-row-enbd").click();
      await page.getByRole("button", { name: /^Continue$/ }).click();
    }
  }

  // `address` and `forwarding` are one component in two phases; whichever this
  // walk lands on, the address is on it.
  await page.getByTestId("inbound-address").waitFor({ timeout: 60_000 });
  const inbound = (await page.getByTestId("inbound-address").textContent()).trim();
  await onStep("onb-forwarding", page);
  if (skip) {
    await page.getByRole("button", { name: /^Set this up later$/i }).click();
  } else {
    // "Gmail" became "Show the Gmail steps" in the 2026-08-10 rework, which is
    // the better label — it says what the press does rather than naming a thing.
    // Matched loosely so the walk survives the next rewording too.
    await page.getByRole("button", { name: /Gmail/ }).first().click();
    await settle(page, 300);
    await onStep("onb-forwarding-steps", page);
    await page.getByRole("button", { name: /^I have set up forwarding$/i }).click();
  }

  await page.getByTestId("home-currency").waitFor({ timeout: 60_000 });
  await onStep("onb-home-currency", page);
  if (skip) {
    await page.getByRole("button", { name: /^Set this up later$/i }).click();
  } else {
    await page.getByRole("button", { name: /^AED — UAE dirham$/ }).click();
    await settle(page, 300);
    await onStep("onb-home-currency-confirm", page);
    const tick = page.locator('input[type="checkbox"]').first();
    if ((await tick.count()) > 0) await tick.check();
    await page.getByRole("button", { name: /^Set AED as my home currency$/i }).click();
  }

  await page.getByTestId("onboarding-finish").waitFor({ timeout: 60_000 });
  await onStep("onb-finish", page);
  await page.getByRole("button", { name: /^Open ledger$/i }).click();

  const loops = await reachShell(page);
  await settle(page, 600);
  return { phrase, inbound, loops };
}

/**
 * Wait for the product shell, and get there anyway when onboarding takes the
 * walk back.
 *
 * **"Open ledger" does not always open the ledger.** `done()` re-runs boot, which
 * re-derives every fact, and `forwardingDeclared` is derived from
 * `firstMailConfirmedAt` alone — "DEMONSTRATED, not remembered", in
 * `resumeFacts`'s own words. A user who pressed "I have set up forwarding" made
 * an in-memory fact that no reducer persists, so at the next boot the
 * `forwarding_configured` milestone is unmet, it is not in `skipped` either, and
 * `stepFor` walls on it. The finish screen hands them straight back to the step
 * they just completed.
 *
 * That is a product finding, not a harness problem, so this reports each loop
 * rather than papering over it — and then takes "Set this up later", which is the
 * one answer the walk does persist, so the rest of the run has a product to
 * measure. Returns the steps it was bounced back to.
 */
const ONBOARDING_STEP_IDS = ["forwarding", "address", "bank", "home-currency", "onboarding-recovery", "onboarding-finish"];

/** Whichever of the two states the app has settled into, and what it is showing. */
async function whereAreWe(page) {
  return page.evaluate((stepIds) => {
    const shown = (el) => el !== null && el.getBoundingClientRect().width > 0;
    const settings = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent.trim()) === "Settings");
    if (shown(settings ?? null)) return { at: "shell" };
    const ids = [...document.querySelectorAll("[data-testid]")].filter((e) => shown(e)).map((e) => e.getAttribute("data-testid"));
    const step = stepIds.find((id) => ids.includes(id));
    if (step !== undefined) {
      return { at: "onboarding", step, heading: document.querySelector("h1")?.textContent.trim() ?? "" };
    }
    return { at: "unknown", ids: ids.slice(0, 12) };
  }, ONBOARDING_STEP_IDS);
}

async function reachShell(page, { attempts = 5 } = {}) {
  const loops = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Poll rather than race two waitFors: the onboarding screens carry a
    // per-step test id and no shared one, so there is no single locator that
    // means "still in onboarding" to wait on.
    let state = { at: "unknown" };
    for (let tick = 0; tick < 40; tick++) {
      state = await whereAreWe(page);
      if (state.at !== "unknown") break;
      await settle(page, 500);
    }
    if (state.at === "shell") return loops;
    if (state.at === "unknown") throw new Error(`neither the shell nor an onboarding step is on screen: ${JSON.stringify(state.ids)}`);

    // Landing back on the finish screen is the walk re-offering its exit, not a
    // bounce to a step already done — press its button and say nothing.
    if (state.step !== "onboarding-finish") {
      loops.push({ step: state.step, heading: state.heading });
    }

    const later = page.getByRole("button", { name: /^Set this up later$/i }).first();
    const open = page.getByRole("button", { name: /^Open ledger$/i }).first();
    if ((await later.count()) > 0) {
      console.log(`  !!  onboarding sent the walk back to "${state.heading}" (${state.step}) after Open ledger — taking "Set this up later"`);
      await later.click();
    } else if ((await open.count()) > 0) {
      await open.click();
    } else {
      throw new Error(`stuck at onboarding step "${state.step}" with no way forward`);
    }
    await settle(page, 1000);
  }
  throw new Error(`onboarding looped ${attempts} times without reaching the product`);
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

/**
 * The hostile rows, as a bank would export them.
 *
 * Each one is here because it breaks a layout somewhere, and the comment says
 * where. Widths are quoted at the 390px viewport.
 */
const HOSTILE_ROWS = [
  // Longer than any phone is wide, with no spaces to wrap on — the single most
  // productive fixture in v1's seed.
  ["2026-08-01", "EMIRATES NBD DIRECT DEBIT COLLECTION SERVICES MIDDLE EAST FZ LLC DUBAI AE", "-1250.75", "Bills"],
  // The widest string the formatter emits: 9,999,999.99 is 12 glyphs plus AED.
  // Deliberately UNCATEGORISED, so it also reaches the review deck — that card
  // sizes one hero number and is the surface most likely to clip it.
  ["2026-08-02", "PROPERTY PURCHASE SETTLEMENT", "-9999999.99", ""],
  // Income, so the row renders the credit register and the sign flips.
  ["2026-08-02", "SALARY AUGUST", "28500.00", "Income"],
  // A category label long enough to wrap a chip and a filter pill.
  ["2026-08-03", "NOON.COM", "-89.00", "Shopping and online marketplaces"],
  // Sub-unit precision, which is where rounding shows.
  ["2026-08-03", "PARKING RTA", "-2.05", "Transport"],
  // Non-ASCII, which changes glyph width and line-breaking.
  ["2026-08-04", "مقهى العربية — Arabian Coffee House", "-34.50", "Eating out"],
  // A refund against a merchant that also has a debit, so the pair can be linked.
  ["2026-08-04", "NOON.COM", "45.00", "Shopping and online marketplaces"],
  // No category at all: this is what lands in the review deck.
  ["2026-08-05", "CARREFOUR MALL OF THE EMIRATES", "-312.40", ""],
  ["2026-08-05", "TALABAT", "-58.25", ""],
  ["2026-08-06", "DUBAI TAXI CORPORATION", "-27.00", ""],
  ["2026-08-06", "SPINNEYS MOTOR CITY", "-143.60", ""],
  ["2026-08-07", "NETFLIX.COM", "-56.00", ""],
  ["2026-08-07", "APPLE.COM/BILL", "-9.99", ""],
  ["2026-08-08", "ADNOC SERVICE STATION 1042", "-180.00", ""],
  ["2026-08-08", "STARBUCKS DIFC", "-24.00", ""],
  // Enough rows that the list scrolls and the review deck stacks.
  ["2026-08-09", "AMAZON.AE", "-215.30", ""],
  ["2026-08-09", "DEWA UTILITY BILL", "-430.00", ""],
  ["2026-08-09", "ETISALAT POSTPAID", "-315.00", ""],
];

/** A second file in a currency with no configured rate — the unset-FX path. */
const FOREIGN_ROWS = [
  ["2026-08-05", "UBER TRIP HELP.UBER.COM", "-18.40", ""],
  ["2026-08-06", "GITHUB.COM", "-4.00", ""],
];

function csv(rows) {
  const esc = (v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ["Date,Description,Amount,Category", ...rows.map((r) => r.map(esc).join(","))].join("\n") + "\n";
}

/**
 * Write fixture transactions by driving the app's own import screen.
 *
 * The screens read a projection of the op log, so there is no database to insert
 * into and no HTTP route that would author an op on a user's behalf. Import is
 * the one path a user has for bulk data, so it is the one the harness uses: no
 * backdoor exists, and building one would be a fixture that proves nothing about
 * the product.
 *
 * Must be called with the product shell on screen.
 */
export async function seed(page) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-v2-fixtures-"));
  const files = [
    { path: join(dir, "statement-aed.csv"), body: csv(HOSTILE_ROWS), currency: "AED" },
    { path: join(dir, "statement-usd.csv"), body: csv(FOREIGN_ROWS), currency: "USD" },
  ];
  for (const f of files) writeFileSync(f.path, f.body);

  let imported = 0;
  for (const f of files) {
    await openSettings(page);
    // Not anchored: `HubRow` renders its label AND its value inside one button,
    // so the accessible name is "Import a statement" followed by whatever the
    // row currently says on the right.
    await page.getByRole("button", { name: /Import a statement/i }).first().click();
    await page.getByRole("dialog").waitFor({ timeout: 15_000 });
    await page.getByTestId("import-file").setInputFiles(f.path);
    await page.getByTestId("import-preview").waitFor({ timeout: 15_000 });

    // The currency field applies to the whole file; the second import is the
    // no-configured-rate case and has to say so.
    const currency = page.locator("#import-currency");
    await currency.fill(f.currency);
    await settle(page, 300);

    const commit = page.getByTestId("import-commit");
    if (await commit.isEnabled()) {
      await commit.click();
      await page.getByTestId("import-done").waitFor({ timeout: 20_000 });
      const said = await page.getByTestId("import-done").textContent();
      imported += Number(said.match(/^(\d+)/)?.[1] ?? 0);
    } else {
      // A refused batch is a finding about the importer, not something to work
      // around silently: the caller sees a smaller count than it asked for.
      const problems = await page.getByTestId("import-problems").textContent().catch(() => "(none listed)");
      console.log(`  !!  ${f.currency} import refused: ${problems.slice(0, 200)}`);
    }
    await page.keyboard.press("Escape");
    await settle(page, 300);
    await closeOverlay(page);
  }
  return { imported, files: files.map((f) => f.path) };
}

// ---------------------------------------------------------------------------
// Getting around
// ---------------------------------------------------------------------------

/**
 * Tap a bottom-nav tab.
 *
 * Matched by prefix, not exactly: `BottomNav` renames the Review tab to
 * "Review, 12 need review" the moment the badge is non-zero, so an exact match
 * worked in the first pass — when the imported rows had not yet folded into the
 * needs-review lane — and then could not find the tab in the second.
 */
export async function gotoTab(page, label) {
  await page.getByRole("button", { name: new RegExp(`^${label}(,|$)`) }).last().click();
  await settle(page, 500);
}

/**
 * Open Settings, or notice it is already open.
 *
 * Idempotent because it has to be: a caller that opens Settings twice used to
 * spend thirty seconds retrying a click on the TopBar gear while the open
 * panel's own `<h1>Settings</h1>` sat on top of it, and the error named the
 * heading rather than the cause.
 */
export async function openSettings(page) {
  const open = page.getByRole("heading", { name: "Settings", level: 1 });
  if ((await open.count()) === 0) {
    await page.getByRole("button", { name: "Settings" }).first().click();
  }
  await page.getByTestId("settings-sync").waitFor({ timeout: 30_000 });
  await settle(page, 500);
}

/**
 * Back out of a full-screen drill-in (Settings, Held mail).
 *
 * The control is `IconButton label={`Back from ${title}`}` — not "Back", and not
 * "Close". Matching the shorter names found nothing, fell through to Escape,
 * which a `SettingsPage` does not listen for, and left the panel open over
 * whatever the next step tried to press.
 */
export async function closeOverlay(page) {
  // The TOP panel's back button, not the first in the DOM. With Held mail open
  // over Settings there are two, the buried one comes first, and clicking it
  // retries against the panel covering it until the timeout.
  const handles = await page.$$('button[aria-label^="Back from "]');
  let back = null;
  for (const handle of handles) {
    if (await handle.evaluate((el) => el.closest("[inert]") === null)) back = handle;
  }
  if (back === null) return;
  await back.click({ timeout: 10_000 });
  // The panel animates out and calls `onClose` on exit-complete, so the caller
  // must not race the unmount.
  await settle(page, 700);
}

/**
 * Every product surface, as taps.
 *
 * `open` is handed a page showing the Home tab with no overlay, and must leave
 * the named surface on screen. `reset` puts it back. Keeping the contract that
 * strict is what lets a runner iterate the list without the order mattering.
 */
export const SCREENS = [
  { id: "home", open: async (page) => gotoTab(page, "Home") },
  { id: "transactions", open: async (page) => gotoTab(page, "Transactions") },
  { id: "insights", open: async (page) => gotoTab(page, "Insights") },
  { id: "review", open: async (page) => gotoTab(page, "Review") },
  { id: "settings", open: async (page) => openSettings(page), reset: closeOverlay },
  {
    id: "held-mail",
    open: async (page) => {
      await openSettings(page);
      await page.getByRole("button", { name: /^Held mail/ }).first().click();
      await settle(page, 600);
    },
    reset: async (page) => {
      await closeOverlay(page);
      await closeOverlay(page);
    },
  },
];

/**
 * The dialogs Settings owns, by the label that opens each.
 *
 * Listed rather than crawled because the crawl cannot tell an opener from a
 * toggle, and pressing every button on Settings signs the harness out halfway
 * through. Order matches the screen.
 *
 * The matchers are **unanchored on purpose**: `HubRow` puts its label and its
 * current value inside one button, so the accessible name of the text-size row
 * is "Text size" followed by "Default". Anchoring matched nothing and the whole
 * dialog sweep silently covered zero screens.
 */
export const SETTINGS_DIALOGS = [
  { id: "text-size", match: /^Text size/ },
  { id: "import", match: /Import a statement/ },
  { id: "export", match: /Download my data/ },
  { id: "categories", match: /Your categories/ },
  // `via` walks a drill-in first. Settings became a list of one-line rows on
  // 2026-08-10, so a control that used to sit in an expanded panel now lives one
  // screen in — the sweep has to make the same two taps a person makes, and
  // reported "no row matching" until it did.
  { id: "mail-check", match: /^Check my mail setup$/, via: /^Is mail arriving\?/ },
  { id: "forwarding", match: /Forwarding instructions/ },
  // Only rendered while no home currency is set — it is a one-shot ceremony and
  // the row is gone once it has been used. `optional` says so, rather than the
  // sweep reporting a missing row every run against a configured account.
  { id: "home-currency", match: /^Set my home currency$/, via: /^Home currency/, optional: true },
  { id: "add-device", match: /Add a device/, via: /^Other devices/ },
  { id: "delete-account", match: /Delete account/ },
  { id: "sign-out", match: /^Sign out/ },
];

/**
 * Open every `InfoTip` on the current screen and report where its panel landed.
 *
 * This is the check the operator asked for by name. The panel is width-capped to
 * the viewport but positioned against its **trigger**, so a tip on a control near
 * the right edge opens past it — a defect no unit test can see, because jsdom has
 * no layout and every rectangle it reports is zero.
 *
 * Returns one row per tip: the trigger's accessible name, the panel's measured
 * box, and whether it stayed inside the viewport and clear of the bottom nav.
 */
export async function measureInfoTips(page) {
  /*
   * Only the live layer. Drill-ins STACK — Held mail opened from Settings leaves
   * Settings mounted underneath — and `AppShell` takes the covered layer out of
   * the tab order with `inert` rather than unmounting it. An inert button is
   * still laid out and still passes `isVisible()`, so the first version of this
   * spent thirty seconds retrying a click on Settings' plan tip through the Held
   * mail panel sitting on top of it.
   */
  /*
   * When a Dialog is open, only the tips INSIDE it count.
   *
   * `Dialog` does not mark the page beneath it inert — `audit.mjs` reports that
   * as `background-layer-not-inert` on every one of them — so the inert filter
   * alone still reaches Settings' own tips through an open sheet. Clicking one
   * lands on the scrim, the sheet closes, no panel opens, and the run fills with
   * "opened no panel" for a control the user could never have pressed.
   */
  const dialog = await page.$('[role="dialog"]');
  const scope = dialog ?? page;
  const handles = await scope.$$('button[aria-label^="About "]');
  const triggers = [];
  for (const handle of handles) {
    const live = await handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.closest("[inert]") === null && r.width > 0 && r.height > 0;
    });
    if (live) triggers.push(handle);
  }

  const rows = [];
  for (const trigger of triggers) {
    const about = await trigger.getAttribute("aria-label");
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    try {
      // Short, because a tip that cannot be pressed is itself the finding and
      // thirty seconds of retries buries it in a wall of Playwright log.
      await trigger.click({ timeout: 5000 });
    } catch {
      rows.push({ about, opened: false, unreachable: true });
      continue;
    }
    await settle(page, 250);
    const measured = await page.evaluate(() => {
      // Same reason as the trigger filter: a note left open on a buried layer
      // would be measured instead of the one just opened.
      const panel = [...document.querySelectorAll('[role="note"]')].find((el) => el.closest("[inert]") === null) ?? null;
      if (panel === null) return null;
      const r = panel.getBoundingClientRect();
      /*
       * "Covered" is measured, not inferred from the bottom nav's box.
       *
       * Overlapping the nav's rectangle is only a defect when the nav actually
       * paints on top: inside a Dialog the sheet is above the nav, so a panel
       * that crosses that line is still perfectly visible. Sampling what is
       * really at the panel's bottom edge answers the question the box cannot.
       */
      const probeY = Math.min(r.bottom - 2, window.innerHeight - 1);
      const hit = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1), Math.max(probeY, 0));
      const coveredBy = hit === null || panel.contains(hit) ? null : (hit.closest("nav") !== null ? "bottom nav" : hit.tagName.toLowerCase());
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        vw: document.documentElement.clientWidth,
        vh: document.documentElement.clientHeight,
        coveredBy,
      };
    });
    if (measured === null) {
      rows.push({ about, opened: false });
    } else {
      const overflowRight = Math.max(0, measured.right - measured.vw);
      const overflowLeft = Math.max(0, -measured.left);
      const overflowBottom = Math.max(0, measured.bottom - measured.vh);
      rows.push({
        about,
        opened: true,
        ...measured,
        overflowRight,
        overflowLeft,
        overflowBottom,
        ok: overflowRight === 0 && overflowLeft === 0 && overflowBottom === 0 && measured.coveredBy === null,
      });
      await page.keyboard.press("Escape");
      await settle(page, 200);
    }
  }
  return rows;
}
