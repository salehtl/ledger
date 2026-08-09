/**
 * A ceremony walker that reports rather than asserts.
 *
 * `v2nav.mjs` needs a step table — "on this screen, press this" — and the flow it
 * describes changes: the recovery type-back step and the whole verification gate
 * both left in the days before this file was written, and `v2settings.mjs` still
 * waits for buttons neither renders. Reading six screens' JSX to recover the
 * current labels is slower than asking the running app, and it goes stale the
 * same way.
 *
 * So this drives the walk one step at a time and, at each stop, prints every
 * visible control and test id. It presses the first matching label from a list of
 * candidates and, when nothing matches, stops and says what it saw.
 *
 *   harness/v2stack.sh up
 *   node harness/v2explore.mjs <invite-code>
 *
 * Output is a step table to paste into `v2nav.mjs`, and screenshots of every
 * onboarding screen in `shots/explore-*.png`.
 */

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const ORIGIN = process.env.LEDGER_HARNESS_ORIGIN ?? "http://localhost:5177";
const HERE = new URL(".", import.meta.url).pathname;
const OUT = `${HERE}shots/`;
const INVITE = process.argv[2];
if (!INVITE) {
  console.error("usage: node harness/v2explore.mjs <invite-code>");
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

/** Everything a user could press, plus the test ids that identify the screen. */
async function inventory(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const controls = [...document.querySelectorAll("button, a[href], input, select, textarea, [role=button]")]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") ?? "",
        name: (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 70),
        testid: el.getAttribute("data-testid") ?? "",
        disabled: el.disabled === true,
      }));
    const ids = [...document.querySelectorAll("[data-testid]")].filter(visible).map((el) => el.getAttribute("data-testid"));
    const heads = [...document.querySelectorAll("h1, h2")].filter(visible).map((h) => h.textContent.trim().slice(0, 60));
    return { controls, ids, heads };
  });
}

async function show(page, label) {
  const inv = await inventory(page);
  await page.screenshot({ path: `${OUT}explore-${label}.png` });
  console.log(`\n=== ${label} ===`);
  console.log(`  headings: ${inv.heads.join(" | ") || "(none)"}`);
  console.log(`  testids:  ${[...new Set(inv.ids)].join(" ") || "(none)"}`);
  for (const c of inv.controls) {
    console.log(`  [${c.tag}${c.type ? ":" + c.type : ""}]${c.disabled ? " (disabled)" : ""} "${c.name}"${c.testid ? `  #${c.testid}` : ""}`);
  }
  return inv;
}

/** Press the first candidate that is present and enabled; report what happened. */
async function press(page, candidates, label) {
  for (const name of candidates) {
    const b = page.getByRole("button", { name }).first();
    if ((await b.count()) > 0 && (await b.isVisible()) && (await b.isEnabled())) {
      const text = (await b.textContent())?.trim();
      await b.click();
      console.log(`  -> pressed "${text}" at ${label}`);
      return true;
    }
  }
  console.log(`  !! no candidate matched at ${label}: ${candidates.map(String).join(" , ")}`);
  return false;
}

const browser = await chromium.launch();
mkdirSync(OUT, { recursive: true });

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: VIRTUAL_AUTHENTICATOR });
  page.on("pageerror", (e) => console.error("  PAGE ERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  console.error:", m.text().slice(0, 200));
  });

  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome").waitFor({ timeout: 60_000 });
  await show(page, "01-welcome");

  await page.getByLabel("Invite code").first().fill(INVITE);
  await press(page, [/Create my account/i], "welcome");
  await page.getByTestId("welcome-created").waitFor({ timeout: 60_000 });
  await show(page, "02-created");

  await press(page, [/^Not now$/i, /^Continue$/i, /^Done$/i], "created");

  // From here the walk is unknown territory: keep pressing the most likely
  // "forward" control and reporting the screen, until the product's bottom nav
  // appears or nothing matches.
  const FORWARD = [
    /^I have written these down$/i,
    /^Continue$/i,
    /^Next$/i,
    /^Open ledger$/i,
    /^Done$/i,
    /^Set this up later$/i,
    /later$/i,
    /^Skip/i,
  ];

  for (let step = 3; step < 20; step++) {
    await page.waitForTimeout(900);
    const label = String(step).padStart(2, "0");
    const inv = await show(page, `${label}-step`);
    if (inv.controls.some((c) => c.name === "Transactions") && inv.controls.some((c) => c.name === "Review")) {
      console.log("\n*** reached the product shell ***");
      break;
    }
    if (!(await press(page, FORWARD, `step ${step}`))) break;
  }

  console.log(`\nscreenshots in ${OUT}explore-*.png`);
} finally {
  await browser.close();
}
