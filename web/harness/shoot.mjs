#!/usr/bin/env node
// Drives the real app in Chromium: navigates to each screen the way a user
// would, screenshots it, and runs the automated audit.
//
//   node harness/shoot.mjs                          # every screen, phone viewport
//   node harness/shoot.mjs --screens home,plan      # a subset
//   node harness/shoot.mjs --viewport small         # 320px stress width
//   node harness/shoot.mjs --list                   # print screen ids
//   node harness/shoot.mjs --no-first-paint         # skip the cold-chunk pass
//
// Every run starts with a first-paint audit that blocks Framer's feature chunk
// (see `firstPaintAudit`) — the only window in which `audit.mjs`'s check 10 can
// observe the regression it was written for.
//
// Screens that scroll are captured in segments (screen.0.png, screen.1.png…)
// because the app scrolls an inner container, so a fullPage screenshot would
// only ever show the first viewport.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { SCREENS, SCREEN_IDS, VIEWPORTS, screenById, settle } from "./nav.mjs";
import { audit, summarize } from "./audit.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

if (flag("list")) {
  for (const s of SCREENS) console.log(`${s.id.padEnd(28)} ${s.title}`);
  process.exit(0);
}

const BASE = arg("base", process.env.LEDGER_UI || "http://127.0.0.1:5199");
const OUT = path.resolve(arg("out", "harness/shots"));
const VIEWPORT_NAME = arg("viewport", "phone");
const VIEWPORT = VIEWPORTS[VIEWPORT_NAME] || VIEWPORTS.phone;
const MAX_SEGMENTS = Number(arg("segments", "6"));
const only = arg("screens", "");
const wanted = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : SCREEN_IDS;

const unknown = wanted.filter((id) => !screenById(id));
if (unknown.length) {
  console.error(`unknown screen id(s): ${unknown.join(", ")}\nvalid: ${SCREEN_IDS.join(", ")}`);
  process.exit(2);
}

/** Find the element that actually scrolls, so we can capture past the fold. */
async function scrollInfo(page) {
  return page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      if (!["auto", "scroll"].includes(s.overflowY)) continue;
      const over = el.scrollHeight - el.clientHeight;
      if (over > 8 && (!best || over > best.over)) {
        best = { over, height: el.clientHeight, total: el.scrollHeight };
        el.setAttribute("data-harness-scroller", "1");
      }
    }
    const doc = document.scrollingElement;
    const docOver = doc.scrollHeight - doc.clientHeight;
    if (!best && docOver > 8) return { kind: "document", over: docOver, height: doc.clientHeight, total: doc.scrollHeight };
    return best ? { kind: "element", ...best } : { kind: "none", over: 0 };
  });
}

async function scrollTo(page, kind, y) {
  await page.evaluate(
    ([kind, y]) => {
      if (kind === "document") document.scrollingElement.scrollTop = y;
      else document.querySelector("[data-harness-scroller]")?.scrollTo({ top: y });
    },
    [kind, y],
  );
  await page.waitForTimeout(260);
}

/**
 * Audit the app in the window `audit.mjs`'s check 10 was actually written for:
 * before Framer's feature chunk has landed.
 *
 * Check 10 catches content that renders at `opacity: 0` because `LazyMotion`
 * resolves its features in an effect and, until that chunk arrives, every `m.*`
 * renders straight from its `initial`. The per-screen pass below cannot ever
 * see that: it waits `domcontentloaded` → settle(900) → navigate → settle(500)
 * before auditing, by which point the chunk resolved long ago. So the one check
 * written against a real regression could not observe it, and the shipped fix
 * (transform-only entrances for first-paint content) had nothing standing
 * guard over it.
 *
 * This pass blocks `motionFeatures-*.js` outright — the permanent version of
 * the cold-network window, and strictly harsher than the real thing — and
 * audits immediately after `domcontentloaded`. Any first-paint content that
 * still depends on Framer to become visible reports as `invisible-text`.
 *
 * Deliberately not screenshotted and deliberately run per-screen only for the
 * two list screens that carry entrance animations above the fold.
 */
const FIRST_PAINT_SCREENS = ["home", "transactions"];

async function firstPaintAudit(browser) {
  const findings = [];
  for (const id of FIRST_PAINT_SCREENS) {
    const screen = screenById(id);
    if (!screen) continue;
    const context = await browser.newContext({
      ...VIEWPORT,
      locale: "en-AE",
      timezoneId: "Asia/Dubai",
      colorScheme: arg("scheme", "light"),
      // NOT reducedMotion: "reduce" — under the preference Framer sets opacity
      // keys instantly, which would paper over exactly what this looks for.
    });
    const page = await context.newPage();
    // The chunk never arrives. LazyMotion's promise never settles, so `m.*`
    // stays at `initial` for the lifetime of the page.
    //
    // Both spellings, because the module has two names depending on who is
    // serving it: the production build emits `assets/motionFeatures-<hash>.js`,
    // while the vite dev server this harness normally runs against serves the
    // unbundled source at `/src/app/motionFeatures.ts`. Matching only the
    // built name made this pass a silent no-op in dev — it reported a
    // confident green while the feature bundle loaded perfectly normally.
    let blocked = 0;
    await page.route(/motionFeatures(-[^/]*)?\.(js|ts)(\?.*)?$/, (route) => {
      blocked++;
      return route.abort();
    });
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (id !== "home") {
        await settle(page, 400);
        await screen.goto(page);
      }
      // Just enough for React to commit its first render — NOT enough for a
      // network round trip, which is the whole point.
      await settle(page, 350);
      const a = await audit(page);
      const invisible = a.issues.filter((i) => i.kind === "invisible-text");
      for (const i of invisible) findings.push({ screen: id, el: i.el, detail: i.detail });
      // A green line here is only worth anything if the module was genuinely
      // withheld. If the route never matched, the page loaded normally and
      // this pass observed nothing — report that as a failure of the check
      // itself rather than as a pass.
      if (blocked === 0) {
        findings.push({
          screen: id,
          el: "<harness>",
          detail: "the motionFeatures route never matched — the feature bundle was NOT blocked, so this pass proved nothing",
        });
      }
      console.error(
        `${invisible.length || blocked === 0 ? "FAIL" : " ok "} first-paint (features blocked) ${id.padEnd(14)} ` +
          `${invisible.length} invisible-text finding(s), ${blocked} request(s) blocked`,
      );
    } catch (e) {
      console.error(`FAIL first-paint (features blocked) ${id.padEnd(14)} ${String(e).split("\n")[0].slice(0, 160)}`);
      findings.push({ screen: id, el: "<navigation failed>", detail: String(e).split("\n")[0].slice(0, 200) });
    }
    await context.close();
  }
  return findings;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--font-render-hinting=none"] });
  const report = { base: BASE, viewport: VIEWPORT_NAME, screens: [] };

  report.firstPaint = flag("no-first-paint") ? "skipped" : await firstPaintAudit(browser);

  for (const id of wanted) {
    const screen = screenById(id);
    const context = await browser.newContext({
      ...VIEWPORT,
      // Deterministic rendering: fixed locale/timezone so dates and money
      // format identically between runs.
      locale: "en-AE",
      timezoneId: "Asia/Dubai",
      colorScheme: arg("scheme", "light"),
      reducedMotion: "reduce", // stop mid-animation screenshots
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => consoleErrors.push(`UNCAUGHT: ${String(e).slice(0, 300)}`));

    const entry = { id, title: screen.title, notes: screen.notes, shots: [], error: null };
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
      await settle(page, 900);
      await screen.goto(page);
      await settle(page, 500);

      const info = await scrollInfo(page);
      entry.scroll = info;
      const segments = info.over > 8 ? Math.min(MAX_SEGMENTS, Math.ceil(info.total / info.height)) : 1;

      for (let i = 0; i < segments; i++) {
        if (info.over > 8) await scrollTo(page, info.kind, i * info.height * 0.92);
        const file = path.join(OUT, `${id}.${VIEWPORT_NAME}.${i}.png`);
        // --no-shots re-runs the audit against unchanged screenshots, which is
        // what you want after editing audit.mjs itself.
        if (!flag("no-shots")) await page.screenshot({ path: file });
        entry.shots.push(path.relative(process.cwd(), file));
      }
      // Audit from the top of the screen.
      if (info.over > 8) await scrollTo(page, info.kind, 0);
      const a = await audit(page);
      entry.audit = summarize(a.issues);
      entry.auditCounts = a.counts;
    } catch (e) {
      entry.error = String(e).split("\n")[0].slice(0, 300);
      // Still capture whatever is on screen — a broken navigation is itself a finding.
      try {
        const file = path.join(OUT, `${id}.${VIEWPORT_NAME}.error.png`);
        await page.screenshot({ path: file });
        entry.shots.push(path.relative(process.cwd(), file));
      } catch {}
    }
    entry.consoleErrors = consoleErrors.slice(0, 10);
    report.screens.push(entry);
    const n = (entry.audit || []).reduce((s, g) => s + g.count, 0);
    console.error(
      `${entry.error ? "FAIL" : " ok "} ${id.padEnd(28)} ${entry.shots.length} shot(s)  ${n} audit issue(s)` +
        (entry.error ? `  ${entry.error}` : "") +
        (consoleErrors.length ? `  ${consoleErrors.length} console error(s)` : ""),
    );
    await context.close();
  }

  await browser.close();
  const reportPath = path.join(OUT, `report.${VIEWPORT_NAME}.json`);
  // Merge, don't clobber: re-shooting one screen after a fix must not throw
  // away the other twenty screens' findings.
  try {
    const prev = JSON.parse(await readFile(reportPath, "utf8"));
    const fresh = new Set(report.screens.map((s) => s.id));
    const merged = [...prev.screens.filter((s) => !fresh.has(s.id)), ...report.screens];
    const order = new Map(SCREEN_IDS.map((id, i) => [id, i]));
    merged.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
    report.screens = merged;
  } catch {}
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.error(`\nreport: ${reportPath}`);
  if (Array.isArray(report.firstPaint) && report.firstPaint.length) {
    console.error(
      `\nFIRST-PAINT FAILURES (${report.firstPaint.length}) — content that needs Framer's feature chunk to become visible:`,
    );
    for (const f of report.firstPaint) console.error(`  ${f.screen}: ${f.el} — ${f.detail.slice(0, 160)}`);
  }
  if (flag("json")) console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
