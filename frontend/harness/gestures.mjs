#!/usr/bin/env node
// Drag gestures: does the dismissal *decision* reach anything?
//
// `lib/sheetDrag.ts` and `lib/edgeBack.ts` are pure predicates with unit tests,
// so the rules — how far, how fast, which direction — are covered. What no
// vitest run can cover is whether those rules are still wired to a gesture at
// all: `drag`, `dragControls`, `dragListener`, `dragElastic`, `onDragStart` and
// both `onDragEnd` handlers could be deleted from Dialog/SettingsPage and every
// jsdom test would still pass. A Framer drag cannot be driven in jsdom — there
// is no layout to measure and no frame clock behind the pointer stream — so it
// has to be driven in a real engine, which is this.
//
// It also guards a bug only a real pointer produces. A drag that STARTS on the
// sheet handle and ENDS off the panel (the upward pull, released over the dim
// area) makes the browser synthesise a `click` on the nearest common ancestor of
// press and release — the overlay root, whose handler closes the sheet. So an
// upward drag dismissed the sheet, which is exactly what `dragElastic.top: 0`
// and `shouldDismissSheet(offsetY <= 0) === false` exist to prevent. Dialog
// disarms one root click per drag; the "upward drag" and both "scrim tap" cases
// below are that guard's only automated coverage.
//
// Usage:  node harness/gestures.mjs                      (needs `stack.sh up`)
//         node harness/gestures.mjs --engine webkit
//         BASE=http://127.0.0.1:8099 node harness/gestures.mjs   (`stack.sh prod`)
import { chromium, webkit } from "playwright";
import { VIEWPORTS, screenById, settle, tap } from "./nav.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = process.env.BASE || arg("base", "http://127.0.0.1:5199");
const ENGINE_NAME = arg("engine", "chromium");
const ENGINE = ENGINE_NAME === "webkit" ? webkit : chromium;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? " ok " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};
// A check the *input* could not set up is not a pass and not a failure. Saying
// so out loud beats a green line that proves nothing.
const skip = (name, why) => console.log(`skip  ${name}  ${why}`);

// Mirrored from lib/sheetDrag.ts and lib/edgeBack.ts rather than imported: if
// someone edits a threshold this file should fail and make them think about the
// gesture, not silently follow along.
const SHEET_DISMISS_PX = 110;
const FLICK_VELOCITY = 550;   // px/s
const EDGE_ZONE_PX = 24;
const ROW_COMMIT = 88;        // mirrored from lib/rowSwipe.ts
const CARD_COMMIT = 100;      // mirrored from lib/swipe.ts's COMMIT_PX
const PULL_THRESHOLD_PX = 64; // mirrored from lib/pullToRefresh.ts's PULL_THRESHOLD

// ---------------------------------------------------------------- input drivers
//
// Two drivers, because no single one can do both jobs.
//
// `dragSlow` is real browser input (`page.mouse`), which is what the click,
// hit-testing and click-synthesis behaviour needs — the upward-drag regression
// only exists because a *real* release off the panel synthesises a click, and a
// script-dispatched event never would.
//
// `flick` cannot be real input: Playwright's bottleneck is the per-call protocol
// round-trip, so a `mouse.move({ steps })` burst reaches Framer at somewhere
// between 200 and 900px/s depending on machine load — measured here, it cleared
// the 550px/s bar in about half of runs. A check that flaky is worse than none.
// So the flick is dispatched inside the page, one pointermove per animation
// frame, which puts the frame clock (not the transport) in charge of velocity.
// Framer reads window pointer events and does not care whether they are trusted,
// so everything from PanSession through velocity, `onDragEnd` and the predicate
// runs exactly as it does for a finger; only the OS input layer is bypassed.
//
// That is also why this defaults to Chromium. Headless WebKit runs a ~50ms
// frame clock, and 60px spread over three 50ms frames is 400px/s — a slow drag,
// not a flick, no matter what you dispatch. Chromium's headless clock is ~16ms
// and reaches 900-1900px/s reliably. Run `--engine webkit` for the real-pointer
// cases on the engine the app actually ships to; the flick reports `skip` there.

async function dragSlow(page, from, delta, ms = 600) {
  const steps = 12;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((delta.x || 0) * i) / steps, from.y + ((delta.y || 0) * i) / steps);
    await page.waitForTimeout(ms / steps);
  }
  await page.mouse.up();
}

/**
 * Like `dragSlow` but stops mid-gesture, pointer still down, so the caller
 * can inspect the transient revealed state (SwipeableRow's clip-path panel)
 * before releasing. `dragSnapToOrigin` means that state only exists while
 * the pointer is held — once released the row always springs back to 0
 * regardless of whether the release commits an action, so there is no
 * "settled open" state a post-release screenshot could catch instead.
 */
async function dragHold(page, from, delta, ms = 400) {
  const steps = 10;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((delta.x || 0) * i) / steps, from.y + ((delta.y || 0) * i) / steps);
    await page.waitForTimeout(ms / steps);
  }
}

/**
 * Real CDP touch input, for the one case none of the drivers above cover:
 * verifying that a vertical drag on a SwipeableRow falls through to native
 * list scrolling rather than being eaten by the row's own `drag="x"`.
 *
 * That turned out to need a third input path. Neither `dragSlow`
 * (`page.mouse`, even under `isMobile`/`hasTouch` emulation) nor
 * `page.mouse.wheel` produced any scroll at all here — confirmed by
 * dragging/wheeling on a plain, non-draggable point inside `<main>` and
 * watching `scrollTop` stay exactly 0 while `main.scrollHeight` was
 * genuinely ~4400px and directly settable. So this was a test-input gap, not
 * a product one. Chromium's DevTools protocol `Input.dispatchTouchEvent`
 * reaches the compositor's native scroll path the way a finger does — it
 * moved `scrollTop` on the same neutral point, and did so identically when
 * started directly on a SwipeableRow.
 */
async function touchDragScroll(page, from, dy, steps = 12, stepMs = 30) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(stepMs);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x, y: from.y + (dy * i) / steps }],
    });
  }
  await page.waitForTimeout(stepMs);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Frame-paced pointer stream on `selector`. Returns the px/s it achieved. */
async function flick(page, selector, dy, frames = 3) {
  return page.evaluate(
    async ({ selector, dy, frames }) => {
      const el = document.querySelector(selector);
      const r = el.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y0 = Math.round(r.y + r.height / 2);
      const ev = (type, cy, buttons) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: cy, buttons });
      const frame = () => new Promise((res) => requestAnimationFrame(res));
      const samples = [];
      el.dispatchEvent(ev("pointerdown", y0, 1));
      for (let i = 1; i <= frames; i++) {
        await frame();
        const cy = y0 + (dy * i) / frames;
        samples.push({ t: performance.now(), y: cy });
        window.dispatchEvent(ev("pointermove", cy, 1));
      }
      await frame();
      window.dispatchEvent(ev("pointerup", y0 + dy, 0));
      const a = samples[0], b = samples[samples.length - 1];
      return Math.round((b.y - a.y) / ((b.t - a.t) / 1000));
    },
    { selector, dy, frames },
  );
}

// ------------------------------------------------------------------- fixtures

/** Open a bottom sheet from Plan and return its drag handle's centre point. */
async function openSheet(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await settle(page, 1200);
  await tap(page, 'nav button[aria-label="Plan"]');
  await settle(page, 500);
  await page.locator("button").filter({ hasText: /Groceries|Dining|Rent/ }).first().click();
  await page.waitForSelector('[role="dialog"]', { timeout: 8000 });
  await settle(page, 700);                        // let the enter animation finish
  const box = await page.locator("[data-sheet-handle]").first().boundingBox();
  if (!box) throw new Error("no [data-sheet-handle] in the open sheet — Dialog's drag region moved");
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

const sheetOpen = async (page) => (await page.locator('[role="dialog"]').count()) > 0;

/** Drill into a Settings sub-page — a SettingsPage, so it edge-swipes back. */
async function openDrillIn(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await settle(page, 1200);
  await screenById("settings-budget").goto(page);
  await page.waitForSelector("[data-testid=edge-back-strip]", { timeout: 8000 });
  await settle(page, 700);
}

// The Settings hub is itself a SettingsPage, so once you have drilled in there
// are always TWO edge-back strips and counting them proves nothing. The page's
// own <h1> is what goes away when it pops.
const drillInOpen = async (page) =>
  (await page.evaluate(() => [...document.querySelectorAll("h1")].map((h) => h.textContent.trim())))
    .some((t) => /budget & income/i.test(t));

/**
 * Go to Transactions and return the first visible row's Pressable (the
 * `aria-label="Open <merchant>"` button TransactionRow renders), plus a
 * centre point to drive pointer events on. Framer's drag listener sits on
 * the SwipeableRow ancestor of this button, not the button itself, but a
 * pointerdown/pointermove stream dispatched at the button's coordinates
 * reaches it the same way a finger landing anywhere in the row would.
 *
 * `search` narrows to a specific merchant (used for the viewport-wide-name
 * fixture row) via the same search box `nav.mjs`'s `interactions.search` uses.
 */
async function openTransactionsRow(page, { search } = {}) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await settle(page, 1200);
  await tap(page, 'nav button[aria-label="Transactions"]');
  await settle(page, 500);
  if (search) {
    const s = page.locator('input[type="search"], input[placeholder*="earch"]').first();
    await s.click();
    await s.fill(search);
    await page.waitForTimeout(600);
  }
  const btn = page.locator('ul.divide-y li button[aria-label^="Open "]').first();
  await btn.waitFor({ state: "visible", timeout: 8000 });
  const box = await btn.boundingBox();
  if (!box) throw new Error("openTransactionsRow: matched button has no layout box");
  const aria = await btn.getAttribute("aria-label");
  return { aria, center: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } };
}

const dialogOpen = async (page) => (await page.locator('[role="dialog"]').count()) > 0;

const mainScrollTop = (page) => page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);

// ------------------------------------------------------ swipe deck fixtures

/** Open the Review tab's sorting deck and wait for the front card. */
async function openReviewDeck(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await settle(page, 1200);
  await tap(page, 'nav button[aria-label^="Review"]');
  await page.waitForSelector("[data-testid=swipe-card]", { timeout: 8000 });
  await settle(page, 700);
}

/** Merchant name on the card currently at the front of the deck. */
const frontMerchant = (page) =>
  page.evaluate(() => document.querySelector("[data-testid=swipe-card] h2")?.textContent?.trim() ?? "");

/** Centre point of the front card. */
async function cardCentre(page) {
  const box = await page.locator("[data-testid=swipe-card]").first().boundingBox();
  if (!box) throw new Error("no swipe-card in the deck");
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/**
 * Swipe the front card past the commit distance and wait for the sort panel.
 * Returns false rather than throwing when the panel never opens, so "the
 * card's drag gesture is gone" reports as a FAIL line instead of a stack trace.
 */
async function swipeToPanel(page, dx) {
  await dragSlow(page, await cardCentre(page), { x: dx });
  const opened = await page.waitForSelector('[role="dialog"]', { timeout: 5000 }).then(() => true, () => false);
  if (opened) await page.waitForTimeout(400);
  return opened;
}

/** How many cards are left in the deck (the header's "Remaining" figure). */
const deckRemaining = (page) =>
  page.evaluate(() => Number(document.querySelector("main p.tnum.leading-none")?.firstChild?.textContent?.trim() ?? 0));

/** Title of the open subcategory panel — the bucket a commit landed in. */
const panelBucket = (page) => page.locator('[role="dialog"] h2').first().textContent();

/**
 * Finish a started sort (the panel is open) and watch the swap frame by frame.
 *
 * Everything after the click has to happen inside the page: the whole point of
 * the change is that the overlap lasts ~200ms, and a Playwright round-trip per
 * sample would be most of that. Returns:
 *
 *  - `present`  ms until the NEXT card exists in the DOM (it is only actionable
 *               once it does — the old deck did not mount it until the fly-out's
 *               transitionend, ~330ms)
 *  - `overlap`  the most cards on screen at once; 2 means they really do overlap
 *  - `flight`   the leaving card's translateX per frame
 *  - `moved`    px the incoming card moved under a drag dispatched DURING the
 *               overlap — the actual claim, that the next card is usable before
 *               the previous one has finished leaving
 *  - `overlapAtDrag` how many cards were on screen at the instant that drag
 *               started, so "it was draggable" and "the old one was still
 *               there" are asserted about the same moment rather than two
 *               different ones
 */
async function commitAndWatch(page, outgoing, { drag = false } = {}) {
  return page.evaluate(
    async ({ outgoing, drag }) => {
      const cards = () => [...document.querySelectorAll("[data-testid=swipe-card]")];
      const merchant = (c) => c.querySelector("h2")?.textContent?.trim() ?? "";
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const tx = (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).e;

      document.querySelector('[role="dialog"] .grid button').click();
      const t0 = performance.now();
      let present = null, overlap = 0, moved = 0, overlapAtDrag = 0;
      const flight = [];
      while (performance.now() - t0 < 700) {
        await frame();
        const cs = cards();
        overlap = Math.max(overlap, cs.length);
        const leaving = cs.find((c) => merchant(c) === outgoing);
        if (leaving) flight.push(Math.round(tx(leaving)));
        const incoming = cs.find((c) => merchant(c) !== outgoing);
        if (incoming && present === null) {
          present = performance.now() - t0;
          if (drag) {
            // Three frames of grace: Framer mounts a freshly-committed
            // element's drag feature an effect-flush after React inserts it,
            // so a pointerdown on the literal first frame of its existence
            // finds no listener. Measured here: dead on the insertion frame,
            // live by ~50ms — still comfortably inside the ~200ms overlap,
            // and six times sooner than the old deck even MOUNTED the card.
            await frame(); await frame(); await frame();
            overlapAtDrag = cards().length;
            // Dispatched on the element rather than through the OS input layer:
            // the leaving card is position:absolute over the same spot under
            // popLayout, so real coordinates would hit-test onto whichever is
            // on top. Framer listens on the element and does not care whether
            // the event is trusted.
            const r = incoming.getBoundingClientRect();
            const x0 = Math.round(r.x + r.width / 2), y0 = Math.round(r.y + r.height / 2);
            const ev = (type, cx, buttons) =>
              new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", isPrimary: true, clientX: cx, clientY: y0, buttons });
            incoming.dispatchEvent(ev("pointerdown", x0, 1));
            for (let i = 1; i <= 4; i++) {
              await frame();
              window.dispatchEvent(ev("pointermove", x0 + i * 20, 1));
            }
            // PanSession reports through frame.update, so the transform lands
            // on the frame AFTER the last pointermove — read it too early and
            // a working drag measures as zero.
            await frame();
            await frame();
            moved = Math.round(Math.abs(tx(incoming)));
            window.dispatchEvent(ev("pointerup", x0 + 80, 0));
          }
        }
      }
      return { present, overlap, moved, overlapAtDrag, flight };
    },
    { outgoing, drag },
  );
}

// ---------------------------------------------------------------------- checks

const browser = await ENGINE.launch();
// NOT reducedMotion: "reduce" — the screenshot tools set it, and it makes the
// sheet skip its slide entirely, which would hide every bug this file is for.
const page = await browser.newPage({ ...VIEWPORTS.phone });

{
  const name = `downward flick (60px, under the ${SHEET_DISMISS_PX}px distance bar) dismisses on velocity`;
  await openSheet(page);
  const v = await flick(page, "[data-sheet-handle]", 60);
  await page.waitForTimeout(900);
  if (v < FLICK_VELOCITY) skip(name, `input only reached ${v}px/s under ${ENGINE_NAME} — too slow to be a flick`);
  else check(name, !(await sheetOpen(page)), `${v}px/s`);
}

{
  const handle = await openSheet(page);
  await dragSlow(page, handle, { y: 60 });
  await page.waitForTimeout(900);
  check("the same 60px travelled slowly stays open", await sheetOpen(page));
}

{
  const handle = await openSheet(page);
  await dragSlow(page, handle, { y: 200 });
  await page.waitForTimeout(900);
  check(`slow ${200}px drag down dismisses on distance alone`, !(await sheetOpen(page)));
}

{
  // The regression. `dragElastic.top: 0` clamps the panel, so the release lands
  // on the scrim and the browser synthesises a click on the overlay root.
  const handle = await openSheet(page);
  await dragSlow(page, handle, { y: -200 });
  await page.waitForTimeout(900);
  check("upward drag never dismisses (synthesised root click is disarmed)", await sheetOpen(page));
}

{
  const handle = await openSheet(page);
  await page.mouse.click(handle.x, 60);           // the dim area above the sheet
  await page.waitForTimeout(900);
  check("a plain tap on the scrim still closes", !(await sheetOpen(page)));
}

{
  // The disarm must consume exactly one click: after a drag that snapped back,
  // the next tap on the scrim is a real tap and must still close.
  const handle = await openSheet(page);
  await dragSlow(page, handle, { y: -200 });
  await page.waitForTimeout(700);
  await page.mouse.click(handle.x, 60);
  await page.waitForTimeout(900);
  check("scrim tap after a snapped-back drag still closes", !(await sheetOpen(page)));
}

{
  await openDrillIn(page);
  const past = Math.round(VIEWPORTS.phone.viewport.width / 3) + 60;
  await dragSlow(page, { x: 10, y: 500 }, { x: past });
  await page.waitForTimeout(900);
  check("edge swipe past a third pops the drill-in page", !(await drillInOpen(page)), `${past}px`);
}

{
  await openDrillIn(page);
  await dragSlow(page, { x: 10, y: 500 }, { x: 60 });
  await page.waitForTimeout(900);
  check("short edge swipe stays on the page", await drillInOpen(page));
}

{
  await openDrillIn(page);
  await dragSlow(page, { x: 200, y: 500 }, { x: 250 });
  await page.waitForTimeout(900);
  check(`a drag starting outside the ${EDGE_ZONE_PX}px edge zone does nothing`, await drillInOpen(page));
}

{
  await openDrillIn(page);
  await dragSlow(page, { x: 10, y: 500 }, { x: -200 });
  await page.waitForTimeout(900);
  check("leftward edge drag never pops (nothing to the left to reveal)", await drillInOpen(page));
}

// ---------------------------------------------------- SwipeableRow (Task 5)
//
// `lib/rowSwipe.test.ts` covers `swipeCommits` as a pure predicate, so the
// distance/velocity math is unit-tested. What that cannot cover is whether
// the predicate is still wired to a real gesture: `drag="x"`, `dragElastic`,
// `dragDirectionLock` and `onDragEnd` could be deleted from SwipeableRow and
// every jsdom test would still pass (jsdom cannot run a Framer drag at all).
// It also cannot cover the one behaviour that matters most for a row living
// inside a scrolling list: that a vertical drag falls through to the
// scroller instead of being eaten by the row's horizontal drag listener.

{
  const { center } = await openTransactionsRow(page);
  await dragSlow(page, center, { x: ROW_COMMIT + 40 });
  await page.waitForTimeout(700); // dragSnapToOrigin spring + sheet enter
  check("long rightward swipe commits the lead action (opens its sheet)", await dialogOpen(page));
}

{
  const { center } = await openTransactionsRow(page);
  await dragSlow(page, center, { x: 30 }); // well under both ROW_COMMIT and the flick bar
  await page.waitForTimeout(700);
  check("short swipe springs back without committing", !(await dialogOpen(page)));
}

{
  const { center } = await openTransactionsRow(page);
  const before = await mainScrollTop(page);
  // Dragging the pointer UP is what scrolls page content DOWN (scrollTop
  // increases) on a touch device — the list starts pinned at scrollTop 0, so
  // a downward drag has nowhere to go and would give a false pass either way.
  await touchDragScroll(page, center, -300);
  await page.waitForTimeout(500);
  const after = await mainScrollTop(page);
  check(
    "a vertical drag starting on a row scrolls the list, not the row",
    after > before && !(await dialogOpen(page)),
    `scrollTop ${before} -> ${after}`,
  );
}

{
  // The seed repeats merchant names across days (multiple "NOON.COM" rows,
  // for instance), so re-matching the swiped row afterward by its aria-label
  // is not reliable — a *different* transaction with the same merchant can
  // slide into the same list position once the archived one drops out of the
  // default "All" view (the API excludes archived rows unless asked for) and
  // satisfy a same-text match despite being untouched. Scoping to a search
  // term first, then checking the row surfaces under the Archived tab under
  // that same search, verifies the specific swiped transaction rather than
  // whatever merchant name happens to still be first.
  const { center } = await openTransactionsRow(page, { search: "hypermarket" });
  await dragSlow(page, center, { x: -(ROW_COMMIT + 40) });
  await page.waitForTimeout(900);
  await page.locator("button").filter({ hasText: /^Archived$/ }).first().click();
  await page.waitForTimeout(500);
  const archivedRows = await page.locator('ul.divide-y li button[aria-label^="Open "]').count();
  check(
    "long leftward swipe commits the trail action (archives the row)",
    archivedRows > 0,
    `${archivedRows} row(s) under Archived + search "hypermarket"`,
  );
}

{
  // The hostile fixture: a merchant name wider than the viewport at any font
  // size. A width-driven reveal panel could in principle grow the page; the
  // clip-path panel is sized to the row's own box and can't. Held mid-drag
  // (not released) because `dragSnapToOrigin` means the revealed state only
  // exists while the pointer is down.
  const { center, aria } = await openTransactionsRow(page, { search: "hypermarket" });
  await dragHold(page, center, { x: 70 });
  // Measured against <main>, not document.scrollingElement: <main> sets
  // overflow-y: auto, and per the CSS Overflow spec a non-"visible" value on
  // one axis forces the other axis's "visible" to compute as "auto" too — so
  // <main> is ALSO a horizontal scroll container (mutation-tested: with
  // SwipeableRow's overflow-hidden pulled, a dragged row pokes out of the row
  // box exactly as expected, but <main> silently absorbs it as its own
  // scrollable overflow rather than ever reaching document.scrollWidth,
  // which would make this check pass even on that regression).
  const overflow = await page.evaluate(() => {
    const m = document.querySelector("main");
    return m.scrollWidth - m.clientWidth;
  });
  check(
    "revealing the lead panel on the viewport-wide merchant row does not widen the row's scroller",
    overflow <= 1,
    `<main> scrollWidth exceeds clientWidth by ${overflow}px on "${aria.slice(0, 50)}…"`,
  );
  await page.mouse.up();
  await page.waitForTimeout(500); // let dragSnapToOrigin settle before the next navigation
}

{
  // Review finding 1: dragElastic only ever applies beyond a dragConstraints
  // boundary. With none set, a lead-only row dragged toward its *missing*
  // trail action tracked the finger 1:1, unbounded — the deleted
  // `swipeOffset`'s `resist()` used to prevent exactly this ("only
  // rubber-bands, never fully opens, toward a missing action").
  //
  // Archived rows are lead-only (Transactions.tsx passes `trail: undefined`
  // for them), so archive the first row of the default list — the same
  // leftward-swipe-to-commit mechanics the previous check already proved
  // reach the server — to get one guaranteed lead-only row. Deliberately
  // *not* scoped to the "hypermarket" search: that fixture only has 3 rows
  // this month and the earlier check already spends one of them, so reusing
  // it here would risk leaving none for a rerun.
  const { center: toArchiveCenter } = await openTransactionsRow(page);
  await dragSlow(page, toArchiveCenter, { x: -(ROW_COMMIT + 40) });
  await page.waitForTimeout(900);
  await page.locator("button").filter({ hasText: /^Archived$/ }).first().click();
  await page.waitForTimeout(500);
  const row = page.locator('ul.divide-y li button[aria-label^="Open "]').first();
  await row.waitFor({ state: "visible", timeout: 8000 });
  const box = await row.boundingBox();
  const startX = box.x;
  const center = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  // Held mid-drag, same reasoning as the wide-merchant check: dragSnapToOrigin
  // means the offset only exists while the pointer is down. Empirically:
  // unconstrained, a raw -300px drag moves the row ~295px (near 1:1);
  // constrained with dragElastic 0.4 against a left:0 boundary, it moves
  // ~115px. 200px is a wide, deliberately generous line between the two.
  await dragHold(page, center, { x: -300 }, 500);
  const boxDuring = await row.boundingBox();
  const delta = boxDuring.x - startX;
  check(
    "dragging a lead-only (archived) row toward its missing trail action rubber-bands, not 1:1",
    Math.abs(delta) < 200,
    `raw -300px drag moved the row ${Math.round(delta)}px`,
  );
  await page.mouse.up();
  await page.waitForTimeout(500);
}

{
  // Review finding 2: Framer's onDragStart fires from PanSession as soon as
  // ANY 2D pointer movement crosses ~3px — before dragDirectionLock has
  // decided the axis. So a plain vertical scroll that merely started on a
  // row also sets that row's `moved` ref to true, and nothing was resetting
  // it afterward (onClickCapture only clears it if a click actually
  // follows, and a scroll never produces one). Net effect: the *next*
  // genuine tap on that same row got its click wrongly swallowed. The fix
  // is an unconditional reset on every new gesture's pointerdown — this
  // proves a real tap right after a real scroll still opens detail.
  const { center } = await openTransactionsRow(page);
  const row = page.locator('ul.divide-y li button[aria-label^="Open "]').first();
  // Small and vertical: enough to register as a scroll (touchDragScroll is
  // the real-CDP-touch driver — see its definition above for why page.mouse
  // could not produce native scroll at all), not so much that the same row
  // scrolls out of the tappable viewport.
  await touchDragScroll(page, center, -80);
  await page.waitForTimeout(500);
  await row.click();
  await page.waitForTimeout(700);
  check(
    "a tap on a row right after scrolling it still opens detail (no stale click-suppression)",
    await dialogOpen(page),
  );
}

// ------------------------------------------------------- SwipeDeck (Task 6)
//
// `lib/swipe.test.ts` covers `commitDirection` as a pure predicate and
// SwipeDeck.undo.test.tsx covers the commit path through the rails, but jsdom
// cannot run a Framer drag at all — so `drag`, `onDragEnd` and the whole
// gesture wiring on the card could be deleted and every unit test would still
// pass. And the point of the change is a *timing* one that only exists in a
// laid-out browser: the deck used to mount the next card only on the fly-out's
// transitionend (~330ms measured here), then play a 320ms CSS entrance on top,
// so the next card was untouchable for over half a second in the app's
// highest-frequency flow.

// Each check below sorts a card for real, and a sorted card leaves the queue.
// Run `harness/stack.sh reset` before this file if the deck has been worked.
await openReviewDeck(page);
const deckReady = (await deckRemaining(page)) >= 6;

if (!deckReady) {
  skip("swipe deck checks", `only ${await deckRemaining(page)} cards left in the review queue — run harness/stack.sh reset`);
} else {

{
  const name = "a card swiped past the commit distance sorts and the deck advances";
  await openReviewDeck(page);
  const outgoing = await frontMerchant(page);
  if (!(await swipeToPanel(page, CARD_COMMIT + 40))) {
    check(name, false, "the swipe never opened the sort panel — the card's drag is not wired to commitDirection");
  } else {
    await commitAndWatch(page, outgoing);
    await page.waitForTimeout(400);
    check(name, (await frontMerchant(page)) !== outgoing,
      `"${outgoing.slice(0, 24)}" -> "${(await frontMerchant(page)).slice(0, 24)}"`);
  }
}

{
  // THE point of the task. Not "does it eventually advance" — "is the next
  // card usable while the previous one is still leaving".
  const name = "the next card is mounted and draggable while the committed one is still leaving";
  await openReviewDeck(page);
  const outgoing = await frontMerchant(page);
  if (!(await swipeToPanel(page, -(CARD_COMMIT + 40)))) {
    check(name, false, "the swipe never opened the sort panel — the card's drag is not wired to commitDirection");
  } else {
    const r = await commitAndWatch(page, outgoing, { drag: true });
    check(name,
      r.overlapAtDrag === 2 && r.present !== null && r.present < 120 && r.moved > 40,
      `next card at ${Math.round(r.present)}ms, ${r.overlapAtDrag} cards on screen when the drag started, which moved it ${r.moved}px`);
  }
  await page.waitForTimeout(500);
}

{
  // The exit has to carry the direction it committed to. That needs the deck's
  // index to advance one render AFTER the card is marked flying:
  // AnimatePresence animates a child out as it was LAST rendered, so batching
  // the two into one setState leaves the outgoing card's final snapshot with
  // `flying === null` — it fades straight down and the directional exit
  // becomes dead code that still looks plausible.
  const name = "a card committed left actually flies left, rather than fading in place";
  await openReviewDeck(page);
  const outgoing = await frontMerchant(page);
  if (!(await swipeToPanel(page, -(CARD_COMMIT + 40)))) {
    check(name, false, "the swipe never opened the sort panel — the card's drag is not wired to commitDirection");
  } else {
    const { flight } = await commitAndWatch(page, outgoing);
    const end = flight.length ? flight[flight.length - 1] : 0;
    check(name, end < -400, `leaving card ended at translateX ${end}px (fade-in-place would be ~0)`);
  }
  await page.waitForTimeout(500);
}

{
  // The rails exist so the deck is workable without a gesture at all. They
  // must mean the same thing the swipe does, not merely "do something".
  await openReviewDeck(page);
  const swiped = await swipeToPanel(page, -(CARD_COMMIT + 40));
  const bySwipe = swiped ? (await panelBucket(page))?.trim() : null;
  if (swiped) { await page.keyboard.press("Escape"); await page.waitForTimeout(600); }

  await page.locator('button[aria-label$="sort this transaction"]').filter({ hasText: /Want/ }).first().click();
  await page.waitForSelector('[role="dialog"]', { timeout: 8000 });
  const byRail = (await panelBucket(page))?.trim();
  check(
    "tapping a bucket rail commits to the same bucket the equivalent swipe does",
    bySwipe === byRail && !!bySwipe,
    `leftward swipe -> "${bySwipe}", Want rail -> "${byRail}"`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

{
  // Triple-tap-to-skip had to be rebuilt on Framer's tap gesture when the
  // hand-rolled pointer handlers went. Framer fires `onTap` on release whether
  // or not a drag happened, so without the `dragged` guard in SwipeCard every
  // swipe would also bank a tap and three short indecisive drags would silently
  // skip the card. Both halves are asserted here because either alone passes on
  // a broken implementation: never-skips passes if taps are ignored entirely,
  // and skips-on-three passes if drags are counted as taps too.
  const name = "three short drags never skip, three taps do";
  await openReviewDeck(page);
  const start = await frontMerchant(page);
  const c = await cardCentre(page);
  for (let i = 0; i < 3; i++) await dragSlow(page, c, { x: 30 }, 200);
  await page.waitForTimeout(600);
  const afterDrags = await frontMerchant(page);
  // Below the card body, clear of the "View source email" link.
  const tapAt = { x: c.x, y: c.y + 120 };
  for (let i = 0; i < 3; i++) { await page.mouse.click(tapAt.x, tapAt.y); await page.waitForTimeout(90); }
  await page.waitForTimeout(600);
  const afterTaps = await frontMerchant(page);
  check(name, afterDrags === start && afterTaps !== start,
    `after 3 short drags "${afterDrags.slice(0, 20)}", after 3 taps "${afterTaps.slice(0, 20)}" (started on "${start.slice(0, 20)}")`);
}

{
  // Reduced motion. The old card ignored the preference entirely: the `flying`
  // branch of its transition ternary short-circuited before reduceMotion was
  // consulted, so the largest movement in the app — a 600-800px translate with
  // a 20-degree rotation — played in full for a user who had asked for less.
  // Under MotionConfig reducedMotion="user" Framer gives positional keys
  // `{type: false}`, i.e. no animation at all, so the card must never be caught
  // mid-flight. Committed from the rail so it starts at rest and any
  // mid-flight sample is unambiguous.
  //
  // The same measurement is run on the normal-motion page below; that pairing
  // is what stops this from being a check that passes because the sampler is
  // broken.
  const midFlight = (flight) => flight.filter((v) => Math.abs(v) > 30 && Math.abs(v) < 500).length;

  const reduced = await browser.newPage({ ...VIEWPORTS.phone, reducedMotion: "reduce" });
  await openReviewDeck(reduced);
  const outR = await frontMerchant(reduced);
  await reduced.locator('button[aria-label$="sort this transaction"]').filter({ hasText: /Want/ }).first().click();
  await reduced.waitForSelector('[role="dialog"]', { timeout: 8000 });
  await reduced.waitForTimeout(400);
  const rr = await commitAndWatch(reduced, outR);
  await reduced.close();

  await openReviewDeck(page);
  const outN = await frontMerchant(page);
  await page.locator('button[aria-label$="sort this transaction"]').filter({ hasText: /Want/ }).first().click();
  await page.waitForSelector('[role="dialog"]', { timeout: 8000 });
  await page.waitForTimeout(400);
  const rn = await commitAndWatch(page, outN);

  check(
    "the same commit IS caught mid-flight without the preference (the sampler works)",
    midFlight(rn.flight) >= 2,
    `${midFlight(rn.flight)} mid-flight frames, flight [${rn.flight.slice(0, 8).join(",")}]`,
  );
  check(
    "under prefers-reduced-motion the committed card is never caught mid-flight",
    midFlight(rr.flight) === 0,
    `${midFlight(rr.flight)} mid-flight frames, flight [${rr.flight.slice(0, 8).join(",")}]`,
  );
}

} // deckReady

// ------------------------------------------------------- Pull-to-refresh (Task 7)
//
// usePullToRefresh listens for raw touchstart/touchmove/touchend on <main>,
// so — like SwipeableRow's drag — none of this is drivable from jsdom; it
// needs a real touch stream (the same CDP `Input.dispatchTouchEvent` path
// `touchDragScroll` uses above, since `page.mouse` never produced native
// touch behaviour here either).
//
// Two things are checked: that a real pull-and-release still reaches
// `qc.invalidateQueries()` in AppShell (the release wiring didn't come loose
// in the rewrite), and that PullToRefreshIndicator's now-fixed-height
// clipper genuinely never resizes — the whole point of Task 7 was moving it
// off a `height` transition that ran a layout animation while the page was
// also refetching.

/** Navigate to Home and return a touch point safely inside <main>, at rest (scrollTop 0). */
async function openHomeForPull(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await settle(page, 1200);
  await tap(page, 'nav button[aria-label="Home"]');
  await settle(page, 500);
  await page.evaluate(() => { document.querySelector("main").scrollTop = 0; });
  const box = await page.locator("main").boundingBox();
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 80) };
}

/** The indicator's own box height and the document's scroll height, in one round trip. */
const geometry = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="ptr-indicator"]');
    return {
      indicatorHeight: el ? Math.round(el.getBoundingClientRect().height) : null,
      docHeight: document.documentElement.scrollHeight,
    };
  });

/** Poll (real round trips — this is Node-side, no in-page frame loop available for CDP input) for a predicate. */
async function pollFor(page, evalFn, { timeout = 2000, interval = 15 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(evalFn)) return true;
    await page.waitForTimeout(interval);
  }
  return false;
}

const refreshingVisible = () => !!document.querySelector('[role="status"][aria-label="Refreshing"]');

{
  const from = await openHomeForPull(page);
  const geoms = [await geometry(page)];

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  const steps = 14;
  // 180px raw finger travel -> resist(180) = min(MAX_PULL 96, 180*0.5) = 90px,
  // comfortably past the 64px PULL_THRESHOLD.
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(25);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + (180 * i) / steps }] });
    geoms.push(await geometry(page));
  }
  await page.waitForTimeout(50);
  geoms.push(await geometry(page));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  // Sample tightly right after release: refreshing is set synchronously in
  // onEnd, so a slow poll here could step right over the window before
  // qc.invalidateQueries()'s refetches settle it back to false.
  const becameRefreshing = await pollFor(page, refreshingVisible, { timeout: 1500, interval: 10 });
  geoms.push(await geometry(page));
  const settledAfter = becameRefreshing
    ? await pollFor(page, () => !document.querySelector('[role="status"][aria-label="Refreshing"]'), { timeout: 4000, interval: 20 })
    : false;
  geoms.push(await geometry(page));

  check(
    "pulling past the threshold and releasing triggers a refresh (the Refreshing indicator appears, then clears once invalidateQueries settles)",
    becameRefreshing && settledAfter,
    `appeared=${becameRefreshing} settled=${settledAfter}`,
  );

  const heights = geoms.map((g) => g.indicatorHeight).filter((h) => h !== null);
  check(
    "the indicator's container never changes height across the pull, release and refresh",
    heights.length > 0 && heights.every((h) => h === PULL_THRESHOLD_PX),
    `heights observed: [${heights.join(",")}]`,
  );

  const docHeights = new Set(geoms.map((g) => g.docHeight));
  check(
    "the pull never changes the page's own layout height (the clipper contributes no layout)",
    docHeights.size === 1,
    `doc scrollHeight values: [${[...docHeights].join(",")}]`,
  );
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nPASS — ${results.length} checks (${ENGINE_NAME})`);
process.exit(failed ? 1 : 0);
