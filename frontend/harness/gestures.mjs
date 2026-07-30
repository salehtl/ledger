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

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nPASS — ${results.length} checks (${ENGINE_NAME})`);
process.exit(failed ? 1 : 0);
