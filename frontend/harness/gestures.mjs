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

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nPASS — ${results.length} checks (${ENGINE_NAME})`);
process.exit(failed ? 1 : 0);
