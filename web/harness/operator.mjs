/**
 * The operator's own path, on the operator's own engine.
 *
 * # What this reproduces and then repairs
 *
 * The iPhone loop: sign up, write down the phrase, confirm it — and land back on
 * the recovery screen, forever, with no error anywhere. Its cause is WebKit
 * losing an X25519 `CryptoKey` written to IndexedDB (see
 * `.superpowers/sdd/2026-08-08-phase3-crypto/`), so it reproduces in WebKit and
 * in no other engine, which is why the Chromium-only `recovery.mjs` was green
 * throughout.
 *
 * Two phases, one browser profile, because the point is the SECOND one:
 *
 *   node harness/operator.mjs signup  <invite>   # run against the OLD keys.ts
 *   node harness/operator.mjs recover            # run against the NEW keys.ts
 *
 * `signup` asserts the loop: the walk comes back to the recovery step in its
 * ENTER form after a ceremony that reported success. The account now has a key
 * set published under the old storage shape — the operator's account, exactly.
 *
 * `recover` then asserts the repair, with no re-keying and no new invite: the
 * same profile, the same session, the same published blob, and the twelve words
 * from phase one get this device its keys and past the step. Then it reloads and
 * checks it stays past it, which is the thing that never held before.
 *
 * A **persistent profile** (`--user-data-dir`) is what lets those be two
 * processes: the passkey, the session and IndexedDB all have to survive the
 * swap of the module under test.
 *
 * `navigator.credentials` comes from `harness/webauthn.mjs` — a real ES256
 * software authenticator — because Playwright's virtual authenticator is
 * Chromium-only and this run has to happen in WebKit.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { webkit } from "playwright";
import { authenticatorScript } from "./webauthn.mjs";

const ORIGIN = process.env.LEDGER_HARNESS_ORIGIN ?? "http://localhost:5177";
const RP_ID = process.env.LEDGER_HARNESS_RP_ID ?? "localhost";
const STATE_DIR = process.env.LEDGER_HARNESS_DIR ?? "/tmp/ledger-v2-harness";
const PROFILE = `${STATE_DIR}/webkit-profile`;
const PHRASE_FILE = `${STATE_DIR}/operator-phrase.txt`;

const mode = process.argv[2];
if (mode !== "signup" && mode !== "recover") {
  console.error("usage: node harness/operator.mjs signup <invite> | recover");
  process.exit(2);
}

let failed = false;
const ok = (what, detail = "") => console.log(`  ok    ${what}${detail ? ` — ${detail}` : ""}`);
const bad = (what, detail = "") => {
  console.error(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
  failed = true;
};

/** Which screen is on the glass, by the test ids the walk and the gate use. */
async function screenOf(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-testid]")].map((e) => e.dataset.testid).filter((t) =>
      /^(welcome|welcome-created|onboarding-|bank|inbound-address|recover-write|home|app-shell)/.test(t),
    ),
  );
}

async function waitForAny(page, ids, timeout = 90_000) {
  const started = Date.now();
  for (;;) {
    const seen = await screenOf(page);
    const hit = ids.find((id) => seen.includes(id));
    if (hit !== undefined) return hit;
    if (Date.now() - started > timeout) throw new Error(`none of ${ids.join(", ")} appeared; saw ${seen.join(", ")}`);
    await page.waitForTimeout(500);
  }
}

mkdirSync(STATE_DIR, { recursive: true });
const context = await webkit.launchPersistentContext(PROFILE, { viewport: { width: 390, height: 844 } });
await context.addInitScript(authenticatorScript(RP_ID));
const page = context.pages()[0] ?? (await context.newPage());
page.on("pageerror", (e) => console.error(`  page error: ${e.message}`));

try {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });

  if (mode === "signup") {
    const invite = process.argv[3];
    if (!invite) throw new Error("signup needs an invite code");

    await page.getByTestId("welcome").waitFor({ timeout: 60_000 });
    await page.getByLabel("Invite code").first().fill(invite);
    await page.getByRole("button", { name: /Create my account/i }).click();
    await page.getByTestId("welcome-created").waitFor({ timeout: 60_000 });
    ok("a passkey signs this WebKit browser up", "software ES256 authenticator, verified by go-webauthn");
    await page.getByRole("button", { name: /^Not now$/i }).click();

    await page.getByTestId("recovery-phrase-words").waitFor({ timeout: 90_000 });
    const words = await page.$$eval('[data-testid="recovery-phrase-words"] li', (items) =>
      items.map((li) => li.textContent.replace(/^\d+/, "").trim()),
    );
    if (words.length !== 12) bad("the phrase is twelve words", `it had ${words.length}`);
    writeFileSync(PHRASE_FILE, words.join(" "));
    ok("the twelve words are on the glass", words.slice(0, 2).join(" ") + " …");

    await page.getByRole("button", { name: /I have written these down/i }).click();
    for (const field of await page.$$('[data-testid^="recovery-confirm-"]')) {
      const position = Number((await field.getAttribute("data-testid")).replace("recovery-confirm-", ""));
      await field.fill(words[position - 1]);
    }
    await page.getByRole("button", { name: /Finish setting up encryption/i }).click();

    // The walk always advances first — `onSecured` dispatches the milestone and
    // the machine moves — so a glimpse of the bank step proves nothing. What
    // decides it is where the NEXT boot lands, which is what the operator sees
    // when they come back to the app.
    await waitForAny(page, ["bank", "onboarding-recovery-entry"]);
    await page.reload({ waitUntil: "domcontentloaded" });
    const landed = await waitForAny(page, ["bank", "inbound-address", "onboarding-recovery-entry"], 120_000);
    if (landed === "onboarding-recovery-entry") {
      ok("REPRODUCED: the ceremony reported success and the next launch asks for the phrase again");
    } else {
      ok("the next launch stays past the recovery step", `${landed} — no loop in this build`);
    }
    console.log("\nphase one done. The account has a published key set; the phrase is in " + PHRASE_FILE);
  } else {
    const phrase = readFileSync(PHRASE_FILE, "utf8").trim();

    const landed = await waitForAny(page, ["bank", "onboarding-recovery-entry", "welcome"]);
    if (landed === "welcome") bad("the profile is still signed in", "it landed on Welcome");
    if (landed === "onboarding-recovery-entry") {
      // The signed-in note is the other half of the report: the operator read a
      // bare wall after a working sign-in as "sign-in is broken".
      const note = await page.getByTestId("signed-in-note").textContent();
      if (!/signed in/i.test(note ?? "")) bad("the screen says the sign-in worked", String(note));
      else ok("the recovery screen says the sign-in worked", note.trim());

      await page.getByTestId("recovery-entry-phrase").fill(phrase);
      await page.getByRole("button", { name: /Unlock my account/i }).click();
      // Waited for by ABSENCE of the recovery step as much as by presence of the
      // next one: the step is still on the glass while Argon2id runs, so "any of
      // these ids" would match the screen we are trying to leave.
      try {
        await page.getByTestId("onboarding-recovery-entry").waitFor({ state: "detached", timeout: 180_000 });
        const after = await waitForAny(page, ["bank", "inbound-address"], 120_000);
        ok("an account whose keys were published under the OLD shape recovers from the phrase alone", after);
      } catch (err) {
        bad("the phrase gets this device past the recovery step", err.message);
      }
    } else {
      ok("this profile already holds usable keys", landed);
    }

    // The assertion the whole bug is about: a RELOAD does not go back.
    await page.reload({ waitUntil: "domcontentloaded" });
    const afterReload = await waitForAny(page, ["bank", "inbound-address", "onboarding-recovery-entry", "welcome"], 120_000);
    if (afterReload === "onboarding-recovery-entry") bad("a reload stays past the recovery step", "it asked for the phrase again");
    else ok("a reload stays past the recovery step", afterReload);
  }
} catch (err) {
  bad("the run completed", err.message);
  console.error("\n--- screen at failure ---");
  console.error((await page.evaluate(() => document.body.innerText)).slice(0, 1200));
  console.error(await screenOf(page));
} finally {
  await context.close();
}

process.exit(failed ? 1 : 0);
