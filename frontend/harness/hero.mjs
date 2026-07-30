// Reproduces "weird bug video": the PWA relaunches, paints the persisted cache,
// then the network answer lands and every figure in the hero card changes.
//
// The recording caught the card mid-swap reading "39,800.31 spent … 6,519.19
// left of 52,034.00" — 52,034 − 39,800 is not 6,519. The hero was the only
// animated figure on the card, so for the 650ms roll it disagreed with its own
// siblings and walked through amounts that were never real.
//
// Test: sample the card every frame across the swap and assert budget − spent
// == remaining at every single sample.
import { chromium } from "playwright";
import { VIEWPORTS, settle } from "./nav.mjs";

const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ""));

const browser = await chromium.launch();
const page = await browser.newPage({ ...VIEWPORTS.phone });

// Pass 1 — real data, so localStorage ends up holding a genuine persisted cache.
await page.goto((process.env.BASE || "http://127.0.0.1:5199"));
await settle(page, 2000);
const truth = await page.evaluate(() => document.body.innerText.match(/of ([\d,]+\.\d\d) budget/)?.[1]);
console.log("live budget:", truth);

// Make the persisted cache disagree with the server, exactly as a day-old
// snapshot would. Only per-bucket `spent` is shifted: Home derives the hero and
// the "N left" figure from it while `target` (the budget) stays put, so the
// restored snapshot is internally consistent — just wrong. Any contradiction
// the sampling finds is therefore the UI's, not the fixture's.
const shifted = await page.evaluate(() => {
  const raw = localStorage.getItem("ledger-query-cache");
  if (!raw) return { ok: false, why: "no persisted cache" };
  // Age each entry an hour past `staleTime` so mounting actually refetches —
  // otherwise the restored data counts as fresh and no swap ever happens. The
  // envelope's own `timestamp` is left alone: it gates PERSIST_MAX_AGE, and
  // aging that would make the persister discard the snapshot instead.
  const next = raw
    .replace(/"spent":(\d+)/g, (_, v) => `"spent":${Math.round(Number(v) * 0.87)}`)
    .replace(/"dataUpdatedAt":(\d+)/g, (_, v) => `"dataUpdatedAt":${Number(v) - 3600000}`);
  localStorage.setItem("ledger-query-cache", next);
  return { ok: next !== raw, spentHits: (raw.match(/"spent":\d+/g) || []).length,
           agedHits: (raw.match(/"dataUpdatedAt":\d+/g) || []).length };
});
console.log("persisted cache:", JSON.stringify(shifted));
if (!shifted.ok) { console.log("FAIL — could not stage a stale cache; test proves nothing"); await browser.close(); process.exit(1); }

// Hold the network answer back so the restored-but-stale card is on screen long
// enough to sample. Without this the swap can land before the first frame.
await page.route("**/api/summary*", async (route) => {
  await new Promise((r) => setTimeout(r, 1200));
  await route.continue();
});

// Sample on every animation frame, from inside the page. Reading
// `style.transform` would be useless here: React writes the *target* there
// instantly, so it looks settled even while the wheel is visibly rolling
// somewhere else. Only the computed matrix says what is actually on screen.
await page.addInitScript(() => {
  const seen = [];
  window.__heroSamples = seen;
  const tick = () => {
    const row = document.querySelector(".rolling-row");
    if (row) {
      let inTransit = 0, digits = "";
      for (const cell of row.querySelectorAll(".rolling-cell")) {
        if (!cell.classList.contains("rolling-wheel")) { digits += cell.textContent; continue; }
        const track = cell.firstElementChild;
        const wantPct = parseFloat(/translateY\((-?[\d.]+)%\)/.exec(track.style.transform)?.[1] ?? "0");
        const m = new DOMMatrixReadOnly(getComputedStyle(track).transform);
        const nowPct = track.offsetHeight ? (m.m42 / track.offsetHeight) * 100 : wantPct;
        if (Math.abs(nowPct - wantPct) > 0.5) inTransit++;
        digits += String(Math.round(-nowPct / 10));
      }
      const text = document.body.innerText;
      seen.push({
        painted: digits, inTransit,
        budget: text.match(/of ([\d,]+\.\d\d) budget/)?.[1],
        left: text.match(/([\d,]+\.\d\d) left/)?.[1],
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.goto((process.env.BASE || "http://127.0.0.1:5199"));
await page.waitForTimeout(4000);
const samples = (await page.evaluate(() => window.__heroSamples)).filter((s) => s.budget && s.left);
await browser.close();

// The mount spin-up is exempt — a wheel climbing from zero has no prior figure
// to contradict. Drop the leading run of frames before the first settled state.
const firstSettled = samples.findIndex((s) => s.inTransit === 0);
const afterSpinUp = firstSettled < 0 ? samples : samples.slice(firstSettled);

const distinct = [...new Map(afterSpinUp.map((s) => [s.painted + s.budget + s.left, s])).values()];
console.log(`\n${samples.length} frames (${afterSpinUp.length} after spin-up), ${distinct.length} distinct card states:`);
let bad = 0;
for (const s of distinct) {
  const consistent = Math.abs(num(s.budget) - num(s.painted) - num(s.left)) < 0.02;
  const ok = consistent && s.inTransit === 0;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} painted=${s.painted}  of ${s.budget}  ${s.left} left` +
              (s.inTransit ? `   [${s.inTransit} wheel(s) mid-roll]` : "") + (consistent ? "" : "   [contradicts card]"));
}
console.log(bad ? `\n${bad} bad card state(s)` : `\nPASS — after spin-up the hero never lagged or contradicted its card`);
process.exit(bad ? 1 : 0);
