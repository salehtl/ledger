#!/usr/bin/env node
// Drives the real app in Chromium: navigates to each screen the way a user
// would, screenshots it, and runs the automated audit.
//
//   node harness/shoot.mjs                          # every screen, phone viewport
//   node harness/shoot.mjs --screens home,plan      # a subset
//   node harness/shoot.mjs --viewport small         # 320px stress width
//   node harness/shoot.mjs --list                   # print screen ids
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

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--font-render-hinting=none"] });
  const report = { base: BASE, viewport: VIEWPORT_NAME, screens: [] };

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
  if (flag("json")) console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
