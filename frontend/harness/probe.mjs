#!/usr/bin/env node
// Interaction prober: types into things and checks what comes back.
//
// Screenshots cannot catch a field that refuses to stay empty, or a sheet whose
// Save button sits below the fold. This opens each screen, crawls the controls
// that reveal forms, and runs a battery on every input it finds.
//
//   node harness/probe.mjs                     # every screen
//   node harness/probe.mjs --screens plan
//
// Buttons whose label looks destructive are never clicked, so the fixture data
// survives a run.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { SCREENS, SCREEN_IDS, VIEWPORTS, screenById, settle } from "./nav.mjs";
import { audit } from "./audit.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg("base", process.env.LEDGER_UI || "http://127.0.0.1:5199");
const OUT = path.resolve(arg("out", "harness/shots"));
const VIEWPORT = VIEWPORTS[arg("viewport", "phone")] || VIEWPORTS.phone;
const only = arg("screens", "");
const wanted = only ? only.split(",").map((s) => s.trim()) : SCREEN_IDS;
const MAX_OPENERS = Number(arg("openers", "14"));

// Never click these: the fixture data has to survive the crawl.
const DESTRUCTIVE =
  /delete|remove|clear|reset|archive|dismiss|unlink|disconnect|revoke|wipe|erase|sweep|confirm|log ?out|sign ?out|mark complete|reopen|assign \d/i;

/**
 * Inputs worth typing into. Pickers (date, time, colour, file, range) own their
 * own editing model — typing "7" into a date field legitimately produces a
 * date — so they are not free-text fields and the battery doesn't apply.
 */
const INPUT_SEL =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="submit"]):not([type="button"])' +
  ':not([type="date"]):not([type="time"]):not([type="datetime-local"]):not([type="month"]):not([type="week"])' +
  ':not([type="color"]):not([type="file"]):not([type="range"]), textarea';

function labelOf(el) {
  return el.evaluate((n) => {
    const id = n.id ? `#${n.id}` : "";
    const name = n.getAttribute("name") || "";
    const ph = n.getAttribute("placeholder") || "";
    const aria = n.getAttribute("aria-label") || "";
    const lab = n.labels && n.labels.length ? n.labels[0].textContent.trim() : "";
    const type = n.getAttribute("type") || n.tagName.toLowerCase();
    const im = n.getAttribute("inputmode") || "";
    const step = n.getAttribute("step") || "";
    return { id, name, ph, aria, lab, type, inputMode: im, step };
  });
}

const describeInput = (m) =>
  `${m.type}${m.inputMode ? `[inputmode=${m.inputMode}]` : ""} ${m.aria || m.lab || m.ph || m.name || m.id || "(unlabelled)"}`;

/**
 * The battery. Each check is a question a user would ask by fiddling with the
 * field, phrased so a failure reads as a bug report.
 */
async function probeInput(input, meta, ctx) {
  const bugs = [];
  const desc = describeInput(meta);
  // `inputmode="numeric"` means whole digits — a "last 4 digits" box dropping
  // the "." out of "12.5" is doing its job, not mangling input. Only fields
  // that actually accept decimals get the decimal battery.
  const numeric = meta.type === "number" || /numeric|decimal/.test(meta.inputMode);
  const decimal = meta.inputMode === "decimal" || (meta.type === "number" && meta.step !== "1");

  let original = "";
  try {
    original = await input.inputValue();
  } catch {
    return bugs;
  }

  // 1. Can it be cleared? The user's canonical complaint: select-all + delete
  //    and a "0" springs back, so you can't type a fresh value.
  try {
    await input.click({ timeout: 3000 });
    await input.press("ControlOrMeta+a");
    await input.press("Delete");
    await input.page().waitForTimeout(140);
    const afterClear = await input.inputValue();
    if (afterClear !== "") {
      bugs.push({
        kind: "input-will-not-clear",
        severity: "high",
        where: ctx,
        input: desc,
        detail: `clearing the field leaves "${afterClear}" — the user cannot empty it to type a new value`,
      });
    }
  } catch (e) {
    bugs.push({ kind: "input-probe-error", severity: "low", where: ctx, input: desc, detail: String(e).slice(0, 120) });
    return bugs;
  }

  // 2. Does a fresh value land verbatim, with no leading zero glued on?
  try {
    await input.press("ControlOrMeta+a");
    await input.press("Delete");
    await input.type("7", { delay: 40 });
    await input.page().waitForTimeout(120);
    const v = await input.inputValue();
    if (v !== "7") {
      bugs.push({
        kind: "input-rewrites-typed-value",
        severity: "high",
        where: ctx,
        input: desc,
        detail: `typing "7" into the empty field produced "${v}"`,
      });
    }
  } catch {}

  // 3. Decimals: typing "12.5" must survive the intermediate "12." state.
  if (decimal) {
    try {
      await input.press("ControlOrMeta+a");
      await input.press("Delete");
      await input.type("12.5", { delay: 60 });
      await input.page().waitForTimeout(140);
      const v = await input.inputValue();
      if (v !== "12.5" && v !== "12.50") {
        bugs.push({
          kind: "input-mangles-decimal",
          severity: "high",
          where: ctx,
          input: desc,
          detail: `typing "12.5" produced "${v}" — the intermediate "12." state is being rewritten`,
        });
      }
    } catch {}
  }

  // 4. Junk must not reach state as NaN.
  if (numeric) {
    try {
      await input.press("ControlOrMeta+a");
      await input.press("Delete");
      await input.type("abc", { delay: 40 });
      await input.page().waitForTimeout(140);
      const v = await input.inputValue();
      if (/nan/i.test(v)) {
        bugs.push({
          kind: "input-renders-nan",
          severity: "high",
          where: ctx,
          input: desc,
          detail: `typing letters produced "${v}"`,
        });
      }
      const body = await input.page().locator("body").innerText();
      if (/\bNaN\b/.test(body)) {
        bugs.push({
          kind: "nan-leaks-to-screen",
          severity: "high",
          where: ctx,
          input: desc,
          detail: `typing letters into this field rendered "NaN" somewhere on screen`,
        });
      }
    } catch {}
  }

  // 5. Blur with the field empty must not crash or write junk.
  try {
    await input.press("ControlOrMeta+a");
    await input.press("Delete");
    await input.evaluate((n) => n.blur());
    await input.page().waitForTimeout(200);
    const after = await input.inputValue().catch(() => null);
    if (after && /nan|undefined|null/i.test(after)) {
      bugs.push({
        kind: "input-junk-on-blur",
        severity: "high",
        where: ctx,
        input: desc,
        detail: `leaving the field empty and blurring produced "${after}"`,
      });
    }
  } catch {}

  // Put it back so later probes see the original state.
  try {
    await input.click({ timeout: 2000 });
    await input.press("ControlOrMeta+a");
    if (original) await input.type(original, { delay: 10 });
    else await input.press("Delete");
    await input.evaluate((n) => n.blur());
  } catch {}

  return bugs;
}

/** Is a dialog/sheet currently open, and is its primary action reachable? */
async function inspectOverlay(page, ctx) {
  return page.evaluate((ctx) => {
    const bugs = [];
    const dialog = document.querySelector('[role="dialog"], dialog[open]');
    if (!dialog) return { open: false, bugs };
    const dr = dialog.getBoundingClientRect();
    const vh = window.innerHeight;

    if (dr.height > vh + 1) {
      const scrolls = Array.from(dialog.querySelectorAll("*")).some((el) =>
        ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
      );
      if (!scrolls) {
        bugs.push({
          kind: "sheet-taller-than-viewport",
          severity: "high",
          where: ctx,
          detail: `the sheet is ${Math.round(dr.height)}px tall in a ${vh}px viewport with no internal scroll — its lower content is unreachable`,
        });
      }
    }
    // Primary actions the user must be able to reach.
    for (const b of dialog.querySelectorAll("button")) {
      const t = (b.textContent || "").trim();
      if (!/save|add|create|update|apply|done|assign|move|set|confirm/i.test(t)) continue;
      const r = b.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.bottom > vh + 1 || r.top < 0) {
        bugs.push({
          kind: "sheet-action-offscreen",
          severity: "high",
          where: ctx,
          detail: `"${t}" sits at ${Math.round(r.top)}..${Math.round(r.bottom)}px, outside the ${vh}px viewport`,
        });
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= vh) {
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit !== b && !b.contains(hit)) {
          bugs.push({
            kind: "sheet-action-obscured",
            severity: "high",
            where: ctx,
            detail: `"${t}" is covered by <${hit.tagName.toLowerCase()}> — it cannot be tapped`,
          });
        }
      }
    }
    return { open: true, bugs };
  }, ctx);
}

async function closeOverlay(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(350);
  if (await page.locator('[role="dialog"], dialog[open]').count()) {
    const close = page.locator('[role="dialog"] [aria-label*="lose" i], [role="dialog"] button:has-text("Cancel")').first();
    if (await close.count()) await close.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(350);
  }
  return (await page.locator('[role="dialog"], dialog[open]').count()) === 0;
}

async function probeScreen(page, screen) {
  const bugs = [];
  const seenInputs = new Set();

  const probeVisibleInputs = async (ctx) => {
    const inputs = await page.locator(INPUT_SEL).all();
    for (const input of inputs) {
      if (!(await input.isVisible().catch(() => false))) continue;
      if (await input.isDisabled().catch(() => false)) continue;
      const meta = await labelOf(input);
      const key = `${ctx}|${describeInput(meta)}`;
      if (seenInputs.has(key)) continue;
      seenInputs.add(key);
      bugs.push(...(await probeInput(input, meta, ctx)));
    }
  };

  // Inputs sitting directly on the screen.
  await probeVisibleInputs(screen.id);

  // Then crawl the controls that reveal forms — but only the ones the user can
  // actually see. Screens stack as full-screen overlays, so the whole settings
  // hub is still in the DOM underneath the Accounts screen; clicking those
  // buried rows does nothing and burns the crawl budget.
  const openerTexts = await page.evaluate((destructiveSrc) => {
    const destructive = new RegExp(destructiveSrc.slice(1, destructiveSrc.lastIndexOf("/")), "i");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const vis = (el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const covers = [...document.querySelectorAll("body *")].filter((el) => {
      const s = getComputedStyle(el);
      if (!["fixed", "absolute"].includes(s.position) || !vis(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= vw * 0.9 && r.height >= vh * 0.85 && r.top <= 8;
    });
    const root = covers.length ? covers[covers.length - 1] : document.body;

    const out = [];
    for (const b of root.querySelectorAll("button, [role='button']")) {
      if (b.closest("nav") || !vis(b)) continue;
      const t = (b.textContent || b.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
      if (!t || t.length > 40 || destructive.test(t)) continue;
      out.push(t);
    }
    return [...new Set(out)];
  }, DESTRUCTIVE.toString());

  for (const text of openerTexts.slice(0, MAX_OPENERS)) {
    const before = await page.locator('[role="dialog"], dialog[open]').count();
    if (before) await closeOverlay(page);
    const btn = page.locator(`button:text-is("${text}"), [aria-label="${text}"]`).first();
    if (!(await btn.count())) continue;
    try {
      await btn.click({ timeout: 3000 });
    } catch {
      continue;
    }
    await page.waitForTimeout(550);
    const ov = await inspectOverlay(page, `${screen.id} › "${text}"`);
    if (!ov.open) {
      // Not a sheet-opener — it navigated or toggled. Undo and move on.
      await page.keyboard.press("Escape").catch(() => {});
      continue;
    }
    bugs.push(...ov.bugs);
    // Audit the sheet itself. Sheets are where most of the app's forms live,
    // and a screenshot pass never sees inside them because they start closed.
    try {
      const inSheet = await audit(page);
      for (const i of inSheet.issues) {
        if (i.kind === "background-layer-not-inert") continue; // expected: a modal covers the page
        bugs.push({ kind: i.kind, severity: i.severity, where: `${screen.id} › "${text}"`, input: i.el, detail: i.detail });
      }
    } catch {}
    await probeVisibleInputs(`${screen.id} › "${text}"`);
    const closed = await closeOverlay(page);
    if (!closed) {
      bugs.push({
        kind: "sheet-will-not-close",
        severity: "high",
        where: `${screen.id} › "${text}"`,
        detail: "Escape and Cancel both failed to dismiss this sheet — the user is trapped",
      });
      // Reload to escape the trap so the rest of the crawl still runs.
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await settle(page, 800);
      await screen.goto(page).catch(() => {});
    }
  }
  return bugs;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = { base: BASE, screens: [] };

  for (const id of wanted) {
    const screen = screenById(id);
    if (!screen) continue;
    const context = await browser.newContext({ ...VIEWPORT, locale: "en-AE", timezoneId: "Asia/Dubai", reducedMotion: "reduce" });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(`UNCAUGHT: ${String(e).slice(0, 240)}`));
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 240)));

    const entry = { id, title: screen.title, bugs: [], error: null };
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
      await settle(page, 900);
      await screen.goto(page);
      await settle(page, 400);
      entry.bugs = await probeScreen(page, screen);
    } catch (e) {
      entry.error = String(e).split("\n")[0].slice(0, 240);
    }
    entry.consoleErrors = [...new Set(consoleErrors)].slice(0, 8);
    report.screens.push(entry);
    console.error(
      `${entry.error ? "FAIL" : " ok "} ${id.padEnd(28)} ${entry.bugs.length} interaction bug(s)` +
        (entry.error ? `  ${entry.error}` : ""),
    );
    for (const b of entry.bugs) console.error(`      · [${b.kind}] ${b.where}: ${b.input || ""} ${b.detail}`);
    await context.close();
  }

  await browser.close();
  const p = path.join(OUT, "probe.json");
  await writeFile(p, JSON.stringify(report, null, 2));
  const total = report.screens.reduce((s, e) => s + e.bugs.length, 0);
  console.error(`\n${total} interaction bug(s) — report: ${p}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
