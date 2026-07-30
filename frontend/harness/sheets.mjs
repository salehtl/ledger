// Bottom-sheet checks that neither vitest nor a Chromium screenshot can make.
//
// Two blind spots, both of which shipped bugs:
//
//  1. `env(safe-area-inset-bottom)` is 0 in every headless engine and every
//     desktop browser. The sheet's action rail was overlapping the last row of
//     content by `inset - 16px` — invisible in CI, 18px of a 44px button eaten
//     on a real iPhone. So the inset is *simulated* here by overriding
//     `--sheet-inset-bottom`, the single value the panel and the rail share.
//
//  2. A `position: fixed` overlay is attached to the viewport, so a touch drag
//     on it chains to the *root* scroller rather than to its DOM ancestor —
//     `<main>`'s own `overscroll-contain` never sees the gesture. The page used
//     to scroll and rubber-band behind an open sheet, dragging the sheet around
//     with it. Dialog now freezes every scrollable ancestor while it is up.
//
// Usage:  node harness/sheets.mjs                                  (`stack.sh up`)
//         BASE=http://127.0.0.1:8099 node harness/sheets.mjs      (`stack.sh prod`)
import { chromium } from "playwright";
import { VIEWPORTS, settle } from "./nav.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:5199";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? " ok " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ ...VIEWPORTS.phone });
await page.goto(BASE);
await settle(page, 1500);
await page.locator('nav button[aria-label="Plan"]').click();
await settle(page, 800);

const scroller = () => page.evaluate(() => {
  const m = document.querySelector("main");
  return { overflowY: getComputedStyle(m).overflowY, scrollTop: m.scrollTop, inline: m.style.overflow };
});

// ---------------------------------------------------------------- scroll lock
await page.evaluate(() => { document.querySelector("main").scrollTop = 120; });
check("page scrolls before the sheet opens", (await scroller()).overflowY === "auto");

await page.locator("button").filter({ hasText: /Groceries|Dining|Rent/ }).first().click();
await page.waitForTimeout(900);
const open = await scroller();
check("page is frozen while the sheet is open", open.overflowY === "hidden");
check("freezing kept the scroll position", open.scrollTop === 120, `scrollTop=${open.scrollTop}`);

const scrim = await page.locator('[data-testid="dialog-scrim"]').boundingBox();
await page.mouse.move(scrim.x + scrim.width / 2, scrim.y + 60);
await page.mouse.wheel(0, 300);
await page.waitForTimeout(300);
check("a scroll gesture over the scrim moves nothing", (await scroller()).scrollTop === 120);

// ------------------------------------------------------------ rail vs. inset
for (const inset of [0, 16, 34, 48]) {
  const r = await page.evaluate((inset) => {
    const panel = document.querySelector('[role="dialog"]');
    const rail = panel.querySelector("[data-dialog-footer]");
    panel.style.setProperty("--sheet-inset-bottom", `max(1rem, ${inset}px)`);
    void panel.offsetHeight;
    const row = rail.previousElementSibling;
    const rr = row.getBoundingClientRect(), fr = rail.getBoundingClientRect(), pr = panel.getBoundingClientRect();
    const btn = row.querySelector("button"), br = btn.getBoundingClientRect();
    return {
      overlap: Math.round(rr.bottom - fr.top),                 // rail eating the row above
      deadStrip: Math.round(pr.bottom - fr.bottom),            // rail floating off the sheet's edge
      visible: Math.round(Math.max(0, Math.min(br.bottom, fr.top) - br.top)),
      height: Math.round(br.height),
      railPad: getComputedStyle(rail).paddingBottom,
    };
  }, inset);
  // The simulation is only meaningful if the override actually reaches the rail.
  // Without this the whole loop passes vacuously against any build that went
  // back to hard-coding env(safe-area-inset-bottom) — which reads as 0 here.
  const wired = r.railPad === `${Math.max(16, inset)}px`;
  check(`inset ${String(inset).padStart(2)}px: rail flush, row unobscured`,
        wired && r.overlap <= 0 && r.deadStrip === 0 && r.visible === r.height,
        `overlap=${r.overlap} deadStrip=${r.deadStrip} button=${r.visible}/${r.height} railPad=${r.railPad}` +
        (wired ? "" : ` (expected ${Math.max(16, inset)}px — rail is not reading --sheet-inset-bottom)`));
}
await page.evaluate(() => document.querySelector('[role="dialog"]').style.removeProperty("--sheet-inset-bottom"));

// Plan swaps sheets rather than stacking them, so one commit unmounts Assign and
// mounts Move. If the new lock ran before the old release it would record
// "hidden" as the value to restore and freeze the page permanently.
const move = page.locator('[role="dialog"] button', { hasText: "Move money in" });
if (await move.count() && await move.first().isEnabled()) {
  await move.first().click();
  await page.waitForTimeout(700);
  check("still frozen across a sheet-to-sheet swap", (await scroller()).overflowY === "hidden");
}

await page.keyboard.press("Escape");
await page.waitForTimeout(900);
const closed = await scroller();
check("page scrolls again once the sheet closes", closed.overflowY === "auto");
check("no inline overflow left behind", closed.inline === "", `inline=${JSON.stringify(closed.inline)}`);
check("scroll position survived", closed.scrollTop === 120, `scrollTop=${closed.scrollTop}`);

// ------------------------------------------------------- root rubber-banding
const root = await page.evaluate(() => ({
  html: getComputedStyle(document.documentElement).overscrollBehaviorY,
  body: getComputedStyle(document.body).overscrollBehaviorY,
}));
check("root scroller cannot rubber-band", root.html === "none" && root.body === "none", JSON.stringify(root));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nPASS — ${results.length} checks`);
process.exit(failed ? 1 : 0);
