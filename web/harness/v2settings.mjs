/**
 * The v2 Settings screen, in a real browser, measured rather than eyeballed.
 *
 * # Why this file had to exist
 *
 * `web/harness/` used to also hold a v1 fork — `shoot.mjs`, `probe.mjs`,
 * `stack.sh`, `nav.mjs` — that ran vite in `$REPO/frontend` and tapped v1's
 * Settings hub rows, never loading `web/src`, so pointing it at a v2 change
 * "verified" a screen it could not reach. Those files are gone now (v1's real
 * harness lives in `frontend/harness/`); the v2 app still cannot be driven
 * without an account, though — `BootGate` is in front of every screen — so
 * the only way to a laid-out v2 Settings is the ceremony `recovery.mjs`
 * performs. This does that, then audits the screen and every dialog on it.
 *
 * Settings is the screen this matters most on: it is the longest in the app,
 * and a control that has slipped under the fixed bottom nav or past the right
 * edge is invisible to vitest and to Storybook alike.
 *
 *   harness/v2stack.sh up            # cluster + ledgerd + vite, prints an invite
 *   node harness/v2settings.mjs <invite-code>
 *   harness/v2stack.sh down
 *
 * `localhost` and not `127.0.0.1`: WebAuthn needs a secure context.
 *
 * Chromium only, and the limits that come with it are real: `env(safe-area-inset-*)`
 * is 0, there is no software keyboard, and `dvh` never shrinks. It also runs
 * with motion left ALONE — no script in this directory sets `reducedMotion`,
 * unlike v1's `shoot.mjs` (`frontend/harness/`), which sets
 * `reducedMotion: "reduce"` for stable captures and would make `SettingsPage`
 * skip its slide entirely if the habit were copied here.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

import { audit, summarize } from "./audit.mjs";

const ORIGIN = process.env.LEDGER_HARNESS_ORIGIN ?? "http://localhost:5177";
const HERE = new URL(".", import.meta.url).pathname;
const OUT = `${HERE}shots/`;
const SENDMAIL = `${HERE}sendmail.py`;
const CORPUS = `${HERE}../../internal/v2/origin/testdata/gmail-forward-inner-dkim.eml`;
const INVITE = process.argv[2];
if (!INVITE) {
  console.error("usage: node harness/v2settings.mjs <invite-code>");
  process.exit(2);
}

const VIRTUAL_AUTHENTICATOR = {
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

const findings = [];
let failed = false;

function report(label, result) {
  const bad = result.issues.filter((i) => i.severity === "high" || i.severity === "medium");
  findings.push({ label, counts: result.counts, issues: summarize(result.issues) });
  if (bad.length === 0) {
    console.log(`  ok  ${label} — clean (${result.issues.length} low)`);
    return;
  }
  failed = true;
  console.log(`FAIL  ${label} — ${bad.length} finding(s)`);
  for (const s of summarize(bad)) {
    console.log(`        ${s.severity} ${s.kind} ×${s.count}`);
    for (const e of s.examples.slice(0, 4)) console.log(`          ${e.el} — ${e.detail}`);
  }
}

/**
 * The element that actually scrolls — the LARGEST overflow on the page, tagged
 * in place so the scroll and the measurement cannot pick different elements.
 *
 * The first version of this took the FIRST scrollable element it found, which
 * was an inner 816px one; both "segments" then came out byte-identical and the
 * scrolled-to-the-end audit re-measured the top of the screen. A check that
 * cannot fail is worse than no check, so this follows the same rule v1's
 * `shoot.mjs` (`frontend/harness/`) applies.
 */
async function scrollInfo(page) {
  return page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll("*")) {
      if (!["auto", "scroll"].includes(getComputedStyle(el).overflowY)) continue;
      const over = el.scrollHeight - el.clientHeight;
      if (over > 8 && (!best || over > best.over)) {
        document.querySelector("[data-harness-scroller]")?.removeAttribute("data-harness-scroller");
        best = { over, height: el.clientHeight, total: el.scrollHeight };
        el.setAttribute("data-harness-scroller", "1");
      }
    }
    const doc = document.scrollingElement;
    const over = doc.scrollHeight - doc.clientHeight;
    if (!best && over > 8) return { kind: "document", over, height: doc.clientHeight, total: doc.scrollHeight };
    return best ? { kind: "element", ...best } : { kind: "none", over: 0, height: 0, total: 0 };
  });
}

async function scrollTo(page, kind, y) {
  await page.evaluate(
    ([kind, y]) => {
      if (kind === "document") document.scrollingElement.scrollTop = y;
      else document.querySelector("[data-harness-scroller]").scrollTop = y;
    },
    [kind, y],
  );
  await page.waitForTimeout(300);
}

/** Capture the scrolling container in viewport-sized segments, the way v1's shoot.mjs (frontend/harness/) does. */
async function capture(page, name) {
  const info = await scrollInfo(page);
  const segments = info.kind === "none" ? 1 : Math.ceil(info.total / info.height);
  const seen = new Set();
  for (let i = 0; i < segments; i++) {
    await scrollTo(page, info.kind, i * info.height);
    const shot = await page.screenshot({ path: `${OUT}${name}.${i}.png` });
    seen.add(shot.length);
  }
  // Two identical segments mean the scroll did nothing, which is how the first
  // version of this file reported a clean screen it had never looked at.
  if (segments > 1 && seen.size === 1) {
    failed = true;
    console.log(`FAIL  ${name} — ${segments} segments captured but every one is identical; the scroll did nothing`);
  }
  await scrollTo(page, info.kind, 0);
  return { ...info, segments };
}

const browser = await chromium.launch();
mkdirSync(OUT, { recursive: true });

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: VIRTUAL_AUTHENTICATOR });
  page.on("pageerror", (e) => {
    failed = true;
    console.error("  page error:", e.message);
  });

  // ---- the ceremony, which is the only door into any v2 screen -------------
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome").waitFor({ timeout: 60_000 });
  await page.getByLabel("Invite code").first().fill(INVITE);
  await page.getByRole("button", { name: /Create my account/i }).click();
  await page.getByTestId("welcome-created").waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Not now$/i }).click();

  await page.getByTestId("recovery-phrase-words").waitFor({ timeout: 60_000 });
  const words = await page.$$eval('[data-testid="recovery-phrase-words"] li', (items) =>
    items.map((li) => li.textContent.replace(/^\d+/, "").trim()),
  );
  await page.getByRole("button", { name: /I have written these down/i }).click();
  for (const field of await page.$$('[data-testid^="recovery-confirm-"]')) {
    const position = Number((await field.getAttribute("data-testid")).replace("recovery-confirm-", ""));
    await field.fill(words[position - 1]);
  }
  await page.getByRole("button", { name: /Finish setting up encryption/i }).click();

  // A declared bank, so Settings has a checked row rather than an empty picker.
  await page.getByTestId("bank").waitFor({ timeout: 60_000 });
  await page.getByTestId("bank-row-dib").click();
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await page.getByTestId("inbound-address").waitFor({ timeout: 60_000 });
  const inbound = (await page.getByTestId("inbound-address").textContent()).trim();
  console.log("  ok  account created, bank declared, address", inbound);

  await page.getByRole("button", { name: /^Set this address with your bank directly/i }).click();
  await page.getByRole("button", { name: /^I have set this address with my bank$/i }).click();
  await page.getByTestId("verification").waitFor({ timeout: 60_000 });

  /*
   * The verification step is a REAL gate: it clears only when authenticated
   * bank mail has arrived and been trusted. So the harness posts one, from the
   * corpus, over the scratch SMTP listener — `v2stack.sh` runs ledgerd with
   * `--dns-fixtures`, which is what makes its DKIM verify offline.
   *
   * A FORWARDED message, deliberately. A direct one verifies its DKIM and is
   * still held with `attested = false` — `origin/inner.go` only attests an
   * inner origin, and a message nothing relayed has none — and the client
   * refuses to offer trust for anything unattested. Whether that is right is a
   * question for the mail path, not for this file; it is recorded in the report
   * rather than worked around silently.
   */
  execFileSync("python3", [SENDMAIL, inbound, CORPUS], { stdio: "inherit", cwd: HERE });
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.getByRole("button", { name: /^Check now$/i }).click();
    await page.waitForTimeout(1000);
    const trust = page.getByRole("button", { name: /This is my bank/i });
    if ((await trust.count()) > 0) {
      await trust.first().click();
      break;
    }
  }
  await page.getByRole("button", { name: /^AED/ }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /^AED/ }).first().click();
  console.log("  ok  mail verified and a home currency chosen");

  // The confirmation is gated on a real checkbox: the home currency cannot be
  // changed afterwards, so the step refuses to be walked past absent-mindedly.
  await page.getByTestId("home-currency-confirm").waitFor({ timeout: 30_000 });
  await page.locator('input[type="checkbox"]').first().check();
  await page.getByRole("button", { name: /^Set AED as my home currency$/i }).click();

  // The finish step: the plan, whose defaults are already a complete one.
  await page.getByTestId("onboarding-finish").waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Open ledger$/i }).click();
  await page.getByRole("button", { name: "Settings" }).waitFor({ timeout: 60_000 });
  console.log("  ok  the shell is up, so the walk is finished");

  // ---- Settings itself ----------------------------------------------------
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-sync").waitFor({ timeout: 30_000 });
  // The address read and the templates read both land after first paint; a
  // measurement taken before them measures a shorter screen than the user gets.
  await page.getByTestId("settings-inbound-address").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);

  const groups = await page.$$eval("h2", (hs) => hs.map((h) => h.textContent.trim()));
  console.log(`  ok  groups: ${groups.join(" · ")}`);
  const geometry = await capture(page, "v2-settings");
  console.log(`  ok  captured ${geometry.segments} segment(s), ${geometry.total}px of screen in a ${geometry.height}px viewport`);
  report("settings", await audit(page));

  // Every row is a control a thumb has to reach: measure the bottom of the
  // scroll too, where the sign-out sits.
  const scroller = await scrollInfo(page);
  await scrollTo(page, scroller.kind, scroller.total);
  report("settings (scrolled to the end)", await audit(page));

  // ---- the dialogs Settings owns -----------------------------------------
  for (const [label, opener] of [
    ["text size", /text size/i],
    ["categories", /your categories/i],
    ["add a device", /add a device/i],
    ["sign out", /^sign out$/i],
  ]) {
    await page.getByRole("button", { name: opener }).first().click();
    await page.getByRole("dialog").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}v2-settings-dialog-${label.replace(/\s+/g, "-")}.png` });
    report(`dialog: ${label}`, await audit(page));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  await writeFile(`${OUT}v2-settings.report.json`, JSON.stringify({ groups, geometry, findings }, null, 2));
  console.log(`\nreport: ${OUT}v2-settings.report.json`);
} finally {
  await browser.close();
}

process.exitCode = failed ? 1 : 0;
