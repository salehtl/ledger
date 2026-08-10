/**
 * Every card in the review deck, measured — not just the one on top.
 *
 * `v2shoot.mjs` audits the Review screen, which means it audits **one card**:
 * the deck shows the top of a pile and the rest are unreachable without
 * advancing it. So the screen came back clean while a card three places down
 * clipped its hero number, because nothing had ever looked at that card.
 *
 * This walks the whole pile with "Skip for now" — the deck's own control, so no
 * card is reached by a route a user does not have — and at each one measures the
 * hero amount against the box that clips it. `SwipeCard` sizes the hero with
 * `clamp(1.75rem, 9vw, 3rem)` and the card clips its overflow, so the question
 * "at what amount does a digit fall off the end?" is a measurement, not an
 * opinion.
 *
 *   harness/v2stack.sh up
 *   node harness/v2deck.mjs <invite-code>
 */

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

import { audit, summarize } from "./audit.mjs";
import { ceremony, gotoTab, newSignedOutContext, seed, settle } from "./v2nav.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const OUT = `${HERE}shots/`;
const INVITE = process.argv[2];
if (!INVITE) {
  console.error("usage: node harness/v2deck.mjs <invite-code>");
  process.exit(2);
}

let failed = false;

/** The top card's merchant, hero text, and whether the hero fits its box. */
async function topCard(page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-testid="swipe-card"]');
    if (card === null) return null;
    /*
     * The hero is the biggest tabular figure that IS a figure.
     *
     * Taking the biggest `.tnum` alone was a check that could not fail: a change
     * that shrank the amount to its floor left the merchant's initial-letter
     * avatar as the largest `.tnum` on the card, and the runner cheerfully
     * reported "hero E at 30px fits" for all fourteen cards. Requiring a digit
     * is what makes it measure the thing it is named after.
     */
    const figures = [...card.querySelectorAll(".tnum")]
      .filter((el) => /\d/.test(el.textContent ?? ""))
      .map((el) => ({ el, size: parseFloat(getComputedStyle(el).fontSize) }))
      .sort((a, b) => b.size - a.size);
    const hero = figures[0]?.el ?? null;
    if (hero === null) return { merchant: card.innerText.split("\n")[0] ?? "", hero: null };

    // What actually clips it: the nearest ancestor with hidden overflow.
    let clipper = hero.parentElement;
    while (clipper !== null && !["hidden", "clip"].includes(getComputedStyle(clipper).overflowX)) {
      clipper = clipper.parentElement;
    }
    const hr = hero.getBoundingClientRect();
    const cr = clipper === null ? null : clipper.getBoundingClientRect();
    return {
      merchant: (card.querySelector("h2, h3")?.textContent ?? card.innerText.split("\n")[0] ?? "").trim().slice(0, 40),
      hero: hero.textContent.trim(),
      fontSize: Math.round(parseFloat(getComputedStyle(hero).fontSize)),
      heroWidth: Math.round(hr.width),
      scrollWidth: hero.scrollWidth,
      clientWidth: hero.clientWidth,
      clipper: clipper === null ? null : { width: Math.round(cr.width), left: Math.round(cr.left), right: Math.round(cr.right) },
      // The decisive number: how far the figure runs past what contains it.
      overflow: cr === null ? 0 : Math.max(0, Math.round(hr.right - cr.right)) + Math.max(0, Math.round(cr.left - hr.left)),
    };
  });
}

const browser = await chromium.launch();
mkdirSync(OUT, { recursive: true });

try {
  const { page } = await newSignedOutContext(browser, {});
  page.on("pageerror", (e) => {
    failed = true;
    console.error("  PAGE ERROR:", e.message);
  });

  await ceremony(page, INVITE, {});
  const seeded = await seed(page);
  console.log(`  ok  ${seeded.imported} fixture transaction(s)`);

  await gotoTab(page, "Review");
  await settle(page, 1200);

  const seen = [];
  for (let i = 0; i < 30; i++) {
    const card = await topCard(page);
    if (card === null) {
      console.log(`  --  deck empty after ${i} card(s)`);
      break;
    }
    seen.push(card);
    const bad = card.hero !== null && card.overflow > 1;
    if (bad) {
      failed = true;
      console.log(
        `FAIL  card ${i + 1} "${card.merchant}" — hero ${card.hero} at ${card.fontSize}px is ${card.heroWidth}px ` +
          `in a ${card.clipper?.width}px box; ${card.overflow}px is cut off`,
      );
      await page.screenshot({ path: `${OUT}deck-clipped-${i + 1}.png` });
    } else if (card.hero !== null) {
      console.log(`  ok  card ${i + 1} "${card.merchant}" — hero ${card.hero} at ${card.fontSize}px fits (${card.heroWidth}/${card.clipper?.width}px)`);
    }

    const skip = page.getByRole("button", { name: /^Skip for now$/i }).first();
    if ((await skip.count()) === 0) break;
    await skip.click();
    await settle(page, 500);
  }

  console.log(`\n${seen.length} card(s) measured`);
  const worst = seen.filter((c) => c.overflow > 1).sort((a, b) => b.overflow - a.overflow)[0];
  if (worst !== undefined) {
    console.log(`worst: "${worst.merchant}" ${worst.hero} — ${worst.overflow}px past the card`);
  }
  console.log(summarize((await audit(page)).issues).map((s) => `  ${s.severity} ${s.kind} ×${s.count}`).join("\n") || "  audit clean");
} finally {
  await browser.close();
}

process.exitCode = failed ? 1 : 0;
