/**
 * Repro: adding a SECOND passkey on the authenticator that already holds the
 * first one.
 *
 * The virtual authenticator is CTAP2/internal/resident, which is what an
 * iCloud Keychain passkey looks like to the page. `BeginAdd` sends every
 * enrolled credential in `excludeCredentials`, so this is the same situation a
 * user is in on any Apple device signed into the Apple ID that synced the
 * first passkey.
 *
 * Asserts nothing automatically: read `addPasskey() =>` and `on-screen note:`
 * in the output and confirm the note names this failure, not a generic one.
 *
 *   node harness/addpasskey-repro.mjs <invite-code>
 */

import { chromium } from "playwright";

const ORIGIN = process.env.LEDGER_HARNESS_ORIGIN ?? "http://localhost:5177";
const INVITE = process.argv[2];
if (!INVITE) {
  console.error("usage: node harness/addpasskey-repro.mjs <invite-code>");
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

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: VIRTUAL_AUTHENTICATOR });

page.on("pageerror", (e) => console.error("  page error:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("  console:", m.text().slice(0, 200));
});

await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
await page.getByTestId("welcome").waitFor({ timeout: 60_000 });
await page.getByLabel("Invite code").first().fill(INVITE);
await page.getByRole("button", { name: /Create my account/i }).click();
await page.getByTestId("welcome-created").waitFor({ timeout: 60_000 });
console.log("account created; first passkey is on the authenticator");

// The raw DOMException, before the app's classifier gets to it.
const raw = await page.evaluate(async () => {
  const token = Object.entries(localStorage).find(([k]) => k.includes("session"))?.[1] ?? null;
  const session = (() => {
    try {
      return JSON.parse(token).token ?? JSON.parse(token).sessionToken ?? token;
    } catch {
      return token;
    }
  })();
  const { addPasskey } = await import("/src/v2/passkeyAdd.ts");
  try {
    const id = await addPasskey({ client: { sessionToken: session } });
    return { added: id };
  } catch (e) {
    return {
      name: String(e?.name ?? ""),
      kind: String(e?.passkeyKind ?? ""),
      message: String(e?.message ?? e).slice(0, 300),
      causeName: String(e?.cause?.name ?? ""),
      causeMessage: String(e?.cause?.message ?? "").slice(0, 300),
    };
  }
});
console.log("addPasskey() =>", JSON.stringify(raw, null, 2));

// And what the user is actually shown, through the app's own button.
const button = page.getByRole("button", { name: /passkey/i }).first();
if (await button.count()) {
  await button.click().catch(() => {});
  const note = await page
    .getByTestId("add-passkey-note")
    .textContent({ timeout: 15_000 })
    .catch(() => null);
  console.log("on-screen note:", note);
}

await browser.close();
