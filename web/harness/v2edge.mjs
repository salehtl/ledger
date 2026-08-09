/**
 * The left edge of a drill-in: does the back arrow take a tap, and does the
 * page scroll under your thumb?
 *
 * `SettingsPage` lays an invisible 24px activation strip down its whole left
 * side to catch the edge-back drag. The strip is `absolute … z-10` and carries
 * `touch-none`, and it is a sibling of the header rather than of the body, so it
 * covers both. Two things follow that nothing else in this directory can see:
 *
 *  1. **It is on top of the back arrow.** `IconButton … -ml-2` starts at x=8, so
 *     the strip covers its left half. A press there starts a drag that never
 *     moves, and the click that follows lands on an `aria-hidden` div with no
 *     handler.
 *  2. **`touch-none` cancels scrolling in that column.** A thumb that lands
 *     within 24px of the left edge and drags up moves nothing.
 *
 * Both are geometry `audit.mjs` cannot judge: the arrow's CENTRE point is clear,
 * which is all `control-obscured` looks at, and no static measurement can tell
 * whether a scroll would have happened.
 *
 *   harness/v2stack.sh up
 *   node harness/v2edge.mjs <invite-code>
 *
 * Real pointer input (`page.mouse`), not dispatched events: this is entirely
 * about hit-testing and click synthesis, and a synthetic event would not
 * reproduce either.
 */

import { chromium } from "playwright";

import { ceremony, newSignedOutContext, openSettings, settle } from "./v2nav.mjs";

const INVITE = process.argv[2];
if (!INVITE) {
  console.error("usage: node harness/v2edge.mjs <invite-code>");
  process.exit(2);
}

let failed = false;
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ok  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  } else {
    failed = true;
    console.log(`FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const settingsOpen = (page) => page.getByRole("heading", { name: "Settings", level: 1 }).count().then((n) => n > 0);

const browser = await chromium.launch();
try {
  // hasTouch, because half of what this file measures is `touch-action`,
  // and a context with no touch capability silently ignores a touch gesture.
  const { page, cdp } = await newSignedOutContext(browser, { hasTouch: true });
  page.on("pageerror", (e) => {
    failed = true;
    console.error("  PAGE ERROR:", e.message);
  });
  await ceremony(page, INVITE, {});

  // ---- 1. a tap on the LEFT EDGE of the back arrow ------------------------
  await openSettings(page);
  const arrow = await page.getByRole("button", { name: /^Back from Settings$/ }).boundingBox();
  // 4px inside the arrow's own left edge — inside the control, inside the strip.
  const x = Math.round(arrow.x + 4);
  const y = Math.round(arrow.y + arrow.height / 2);
  await page.mouse.click(x, y);
  await settle(page, 700);
  check(!(await settingsOpen(page)), "a tap on the back arrow's left edge closes the drill-in", `pressed at x=${x}, arrow spans ${Math.round(arrow.x)}..${Math.round(arrow.x + arrow.width)}`);

  // ---- 2. the arrow's centre still works, so the test above is about the edge
  if (await settingsOpen(page)) await page.keyboard.press("Escape");
  await openSettings(page);
  const again = await page.getByRole("button", { name: /^Back from Settings$/ }).boundingBox();
  await page.mouse.click(Math.round(again.x + again.width / 2), Math.round(again.y + again.height / 2));
  await settle(page, 700);
  check(!(await settingsOpen(page)), "a tap on the back arrow's centre closes the drill-in");

  /*
   * ---- 3. nothing in the left column forbids a vertical pan ---------------
   *
   * This is asserted from the computed `touch-action` chain rather than by
   * performing a scroll, and the reason is measured rather than assumed:
   * `Input.synthesizeScrollGesture` with a touch source does not drive a NESTED
   * scroll container in headless Chromium. A control gesture from the middle of
   * the very same panel — where every element in the chain is `touch-action:
   * auto` and the panel plainly scrolls in a real browser — moves it 0px too.
   * A check that fails whatever the code does is worse than no check, so the
   * gesture is not the instrument here.
   *
   * The chain is the exact property that was broken. The old strip was the hit
   * element at x=10 and carried `touch-none`, so the browser was told not to
   * pan from that column at all; every ancestor up to the scroller reads `auto`
   * now. Break it by putting `touch-none` back on the strip and this fails.
   */
  await openSettings(page);
  const before = await page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => d.className.includes("overflow-y-auto") && d.scrollHeight > d.clientHeight + 8);
    return el === undefined ? null : { top: el.scrollTop, room: el.scrollHeight - el.clientHeight };
  });
  if (before === null) {
    check(false, "Settings has a scrollable body to test against");
  } else {
    const verdict = await page.evaluate(() => {
      // Walk from what a thumb 10px from the left edge actually touches, up to
      // the scrolling body, and collect anything that forbids a vertical pan.
      let el = document.elementFromPoint(10, 620);
      const hit = el === null ? "(nothing)" : `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}`;
      const blockers = [];
      while (el !== null && el !== document.documentElement) {
        const ta = getComputedStyle(el).touchAction;
        if (ta === "none" || ta === "pan-x" || ta === "pinch-zoom") {
          blockers.push(`${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}=${ta}`);
        }
        if (["auto", "scroll"].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 8) break;
        el = el.parentElement;
      }
      return { hit, blockers, reachedScroller: el !== null && el !== document.documentElement };
    });
    check(
      verdict.blockers.length === 0 && verdict.reachedScroller,
      "a thumb 10px from the left edge can pan the panel vertically",
      `touch reaches ${verdict.hit}; ${verdict.blockers.length === 0 ? "nothing forbids a vertical pan" : `blocked by ${verdict.blockers.join(", ")}`}` +
        (verdict.reachedScroller ? "" : "; and the walk never reached a scroller"),
    );
  }


  // ---- 4. the edge-back drag itself still works, with a mouse -------------
  if (!(await settingsOpen(page))) await openSettings(page);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => d.className.includes("overflow-y-auto"));
    if (el !== undefined) el.scrollTop = 0;
  });
  await settle(page, 300);
  await page.mouse.move(6, 400);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(6 + i * 22, 400);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await settle(page, 900);
  check(!(await settingsOpen(page)), "an edge drag to the right still closes the drill-in (mouse)");

  /*
   * ---- 5. and with a real TOUCH gesture -----------------------------------
   *
   * The mouse check above proves the geometry and the predicate, and nothing
   * about `touch-action` — a mouse ignores it entirely. This is the half that
   * would notice if the browser started eating the horizontal gesture as a
   * scroll, which is the exact risk in arming the drag from the panel instead
   * of from a `touch-none` overlay.
   */
  await openSettings(page);
  await settle(page, 400);
  await cdp.send("Input.synthesizeScrollGesture", {
    x: 6,
    y: 400,
    xDistance: 300,
    yDistance: 0,
    gestureSourceType: "touch",
    speed: 900,
  });
  await settle(page, 900);
  check(!(await settingsOpen(page)), "an edge drag to the right still closes the drill-in (touch)");
} finally {
  await browser.close();
}

process.exitCode = failed ? 1 : 0;
