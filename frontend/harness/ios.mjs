#!/usr/bin/env node
// iOS PWA probe — the gap the Chromium harness cannot cover.
//
// shoot.mjs/probe.mjs run headless Chromium with an emulated viewport. Three
// things are simply absent there, and all three are load-bearing on a real
// iPhone in standalone PWA mode:
//
//   1. `env(safe-area-inset-*)` resolves to 0, so notch/home-indicator padding
//      is never actually exercised.
//   2. There is no software keyboard, so nothing is ever occluded by one.
//   3. `dvh` tracks the *browser UI*, not the keyboard — on iOS the layout
//      viewport does not shrink when the keyboard opens, so a bottom-anchored
//      sheet keeps its full height and its lower content ends up underneath.
//
// This measures (2) and (3) directly: open each sheet, focus its first input,
// and ask whether the controls a user must reach are inside the region the
// keyboard leaves visible.
//
//   node harness/ios.mjs                 # all sheet-bearing screens
//   node harness/ios.mjs --screens plan
import { chromium, webkit, devices } from "playwright";
import { screenById, settle } from "./nav.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg("base", process.env.LEDGER_UI || "http://127.0.0.1:5199");
const ENGINE = arg("engine", "webkit") === "chromium" ? chromium : webkit;
const wanted = arg("screens", "plan,accounts,recurring,transactions,projects").split(",").map((s) => s.trim());

// iPhone 14 Pro, standalone PWA (no browser chrome).
const VIEWPORT = { width: 393, height: 852 };
// Keyboard heights on a 14 Pro: ~336px for the default keyboard with the
// predictive/accessory bar. Numeric pads are shorter but never smaller than
// ~290px once the accessory bar is counted.
const KEYBOARD = Number(arg("keyboard", "336"));
const SAFE_BOTTOM = 34; // home indicator

async function main() {
  const browser = await ENGINE.launch();
  const context = await browser.newContext({
    ...devices["iPhone 14 Pro"],
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    locale: "en-AE",
    timezoneId: "Asia/Dubai",
  });
  const page = await context.newPage();
  const findings = [];

  for (const id of wanted) {
    const screen = screenById(id);
    if (!screen) continue;
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await settle(page, 900);
    try {
      await screen.goto(page);
    } catch (e) {
      findings.push({ screen: id, kind: "nav-failed", detail: String(e).split("\n")[0].slice(0, 120) });
      continue;
    }
    await settle(page, 400);

    // Every control on this screen that opens a sheet.
    const openers = await page.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      };
      const covers = [...document.querySelectorAll("body *")].filter((el) => {
        const s = getComputedStyle(el);
        if (!["fixed", "absolute"].includes(s.position) || !vis(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.85 && r.top <= 8;
      });
      const root = covers.length ? covers[covers.length - 1] : document.body;
      return [
        ...new Set(
          [...root.querySelectorAll("button,[role=button]")]
            .filter((b) => vis(b) && !b.closest("nav"))
            .map((b) => (b.textContent || b.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "))
            .filter((t) => t && t.length <= 40 && !/delete|remove|clear|reset|archive|dismiss|sweep/i.test(t)),
        ),
      ];
    });

    for (const text of openers.slice(0, 12)) {
      const btn = page.locator(`button:text-is("${text}"), [aria-label="${text}"]`).first();
      if (!(await btn.count())) continue;
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(550);
      if (!(await page.locator('[role="dialog"]').count())) {
        await page.keyboard.press("Escape").catch(() => {});
        continue;
      }

      const input = page.locator('[role="dialog"] input:not([type=hidden]):not([type=checkbox]), [role="dialog"] textarea').first();
      const hasInput = (await input.count()) > 0;
      if (hasInput) await input.focus().catch(() => {});
      await page.waitForTimeout(250);

      const geo = await page.evaluate(
        ([kb, safe]) => {
          const d = document.querySelector('[role="dialog"]');
          if (!d) return null;
          const vh = window.innerHeight;
          // Region still visible once the keyboard is up.
          const visibleBottom = vh - kb;
          const r = d.getBoundingClientRect();
          const out = { vh, kb, visibleBottom, sheetTop: Math.round(r.top), sheetBottom: Math.round(r.bottom), covered: [] };
          const focused = document.activeElement;
          if (focused && d.contains(focused) && focused.tagName !== "BODY") {
            const fr = focused.getBoundingClientRect();
            if (fr.bottom > visibleBottom)
              out.covered.push({ what: `focused ${focused.tagName.toLowerCase()}[${focused.getAttribute("aria-label") || focused.type || ""}]`, bottom: Math.round(fr.bottom) });
          }
          for (const b of d.querySelectorAll("button")) {
            const t = (b.textContent || "").trim();
            if (!/save|add|create|update|apply|done|assign|move|set|confirm|fund|cover/i.test(t)) continue;
            const br = b.getBoundingClientRect();
            if (br.height === 0) continue;
            if (br.bottom > visibleBottom) out.covered.push({ what: `"${t}"`, bottom: Math.round(br.bottom) });
          }
          // Can the user scroll the sheet to bring them up?
          const scrollable = d.scrollHeight - d.clientHeight;
          out.scrollableBy = scrollable;
          out.homeIndicatorOverlap = Math.max(0, Math.round(r.bottom) - (vh - safe));
          return out;
        },
        [KEYBOARD, SAFE_BOTTOM],
      );

      if (geo && geo.covered.length) {
        findings.push({
          screen: id,
          sheet: text,
          kind: "keyboard-occludes-controls",
          detail: `${geo.covered.map((c) => c.what).join(", ")} sit below the keyboard line (${geo.visibleBottom}px); sheet can only scroll ${geo.scrollableBy}px, so they cannot be reached`,
          geo,
        });
      }

      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      if (await page.locator('[role="dialog"]').count()) {
        await page.locator('[role="dialog"] button:has-text("Cancel"), [role="dialog"] [aria-label*="lose" i]').first().click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  }

  await browser.close();
  for (const f of findings) console.log(`[${f.kind}] ${f.screen} › ${f.sheet ?? ""}\n    ${f.detail}`);
  console.log(`\n${findings.length} iOS-specific finding(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
