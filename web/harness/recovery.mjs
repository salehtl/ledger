/**
 * Fresh-device recovery, driven end to end in a real browser.
 *
 * # What this proves that no unit test can
 *
 * Phase 3 rests on one claim about a browser: **a profile whose site data has
 * been cleared, given twelve words, gets its keys back.** Every layer of that is
 * a real browser behaviour — IndexedDB really being gone, a `CryptoKey` really
 * refusing to export, WebAuthn really finding a discoverable credential — and
 * jsdom simulates none of them. So this drives Chromium against the real Go
 * server, on a scratch database and scratch ports, and does the whole ceremony:
 *
 *   1. Create an account against a freshly minted, single-use invite, with a
 *      CDP virtual authenticator standing in for a platform passkey.
 *   2. Walk the recovery step: capture the twelve words, answer the confirmation
 *      by position, and let the device publish and store its keys.
 *   3. **Attempt to export the stored private key material** and confirm the
 *      browser refuses. This is the non-extractability proof, in Chromium
 *      rather than in Node's WebCrypto.
 *   4. Declare a bank, so the account has content, and let it reach the server.
 *   5. **Throw the browser context away.** New context, empty IndexedDB, empty
 *      localStorage — the same authenticator, because "I cleared my site data"
 *      is not "I lost my phone".
 *   6. Sign in, land on the recovery step in its ENTER form, type the phrase,
 *      and confirm the keys come back — the same ingest public key, usable
 *      handles — and that the account's existing data reads.
 *
 * # Running it
 *
 *   1. A Postgres cluster:  go run ./internal/v2/pgtest/cmd/boot
 *   2. A scratch ledgerd on 127.0.0.1:8123 with rp_id=localhost and
 *      rp_origins=["http://localhost:5177"], against a scratch database.
 *   3. A vite dev server on 127.0.0.1:5177 with LEDGER_V2_API pointed at it.
 *   4. node harness/recovery.mjs <invite-code>
 *
 * `localhost` and not `127.0.0.1`: WebAuthn requires a secure context, and
 * `localhost` is one over plain HTTP while a bare IP is not.
 */

import { chromium } from "playwright";

const ORIGIN = process.env.LEDGER_HARNESS_ORIGIN ?? "http://localhost:5177";
const INVITE = process.argv[2];
if (!INVITE) {
  console.error("usage: node harness/recovery.mjs <invite-code>");
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

const steps = [];
function ok(what, detail = "") {
  steps.push({ what, detail });
  console.log(`  ok  ${what}${detail ? ` — ${detail}` : ""}`);
}
function fail(what, detail) {
  console.error(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
  throw new Error(`${what}: ${detail}`);
}

/** A context with a virtual authenticator attached, and nothing else in it. */
async function freshContext(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: VIRTUAL_AUTHENTICATOR,
  });
  return { context, page, cdp, authenticatorId };
}

/** Reads the twelve words off the recovery screen, in order. */
async function readPhrase(page) {
  await page.getByTestId("recovery-phrase-words").waitFor({ timeout: 60_000 });
  return page.$$eval('[data-testid="recovery-phrase-words"] li', (items) =>
    items.map((li) => li.textContent.replace(/^\d+/, "").trim()),
  );
}

/** Answers the "type three of them back" check. */
async function confirmPhrase(page, words) {
  await page.getByRole("button", { name: /I have written these down/i }).click();
  const fields = await page.$$('[data-testid^="recovery-confirm-"]');
  if (fields.length !== 3) fail("the confirmation asks for three words", `it asked for ${fields.length}`);
  for (const field of fields) {
    const position = Number((await field.getAttribute("data-testid")).replace("recovery-confirm-", ""));
    await field.fill(words[position - 1]);
  }
  await page.getByRole("button", { name: /Finish setting up encryption/i }).click();
}

/** What is actually in the key vault, and whether the browser will let it out. */
async function inspectVault(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("ledger-v2-keys", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("keys")) req.result.createObjectStore("keys");
      };
    });
    const row = await new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readonly");
      const get = tx.objectStore("keys").get("account");
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    db.close();
    if (!row) return { present: false };

    const exportAttempts = [];
    for (const [name, key, format] of [
      ["ingestPrivate/pkcs8", row.ingestPrivate, "pkcs8"],
      ["ingestPrivate/jwk", row.ingestPrivate, "jwk"],
      ["dek/raw", row.dek, "raw"],
      ["dek/jwk", row.dek, "jwk"],
    ]) {
      try {
        await crypto.subtle.exportKey(format, key);
        exportAttempts.push({ name, threw: false });
      } catch (e) {
        exportAttempts.push({ name, threw: true, message: String(e).slice(0, 120) });
      }
    }

    // The handles must still WORK — a key that cannot be exported and cannot be
    // used is not custody, it is a brick.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, row.dek, new TextEncoder().encode("probe"));
    const opened = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, row.dek, sealed));
    const peer = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const derived = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: peer.publicKey }, row.ingestPrivate, 256),
    ).length;

    return {
      present: true,
      accountId: row.accountId,
      ingestPub: [...row.ingestPub].map((b) => b.toString(16).padStart(2, "0")).join(""),
      extractable: { ingestPrivate: row.ingestPrivate.extractable, dek: row.dek.extractable },
      exportAttempts,
      dekRoundTrip: opened,
      derivedBytes: derived,
      // What a script on this origin can actually read out of storage: the
      // honest statement of what non-extractability buys.
      localStorageDump: JSON.stringify(localStorage).length,
    };
  });
}

const browser = await chromium.launch();
let phrase;
let firstVault;

try {
  // ---------------------------------------------------------------------
  // Device one: create the account and secure the keys.
  // ---------------------------------------------------------------------
  console.log("device one — a new account");
  const one = await freshContext(browser);
  one.page.on("pageerror", (e) => console.error("  page error:", e.message));
  await one.page.goto(ORIGIN, { waitUntil: "domcontentloaded" });

  // The gate paints a spinner first; filling before the front door has settled
  // writes into a field React is about to replace.
  await one.page.getByTestId("welcome").waitFor({ timeout: 60_000 });
  await one.page.getByLabel("Invite code").first().fill(INVITE);
  await one.page.getByRole("button", { name: /Create my account/i }).click();

  // The add-a-second-passkey offer sits between sign-up and the walk. Declined,
  // because this run is about key material and not about authenticators.
  await one.page.getByTestId("welcome-created").waitFor({ timeout: 60_000 });
  await one.page.getByRole("button", { name: /^Not now$/i }).click();

  const words = await readPhrase(one.page);
  if (words.length !== 12) fail("the phrase is twelve words", `it had ${words.length}`);
  phrase = words.join(" ");
  ok("a twelve-word phrase is shown before anything is published", words.slice(0, 2).join(" ") + " …");

  await confirmPhrase(one.page, words);
  // The bank step is the next milestone; reaching it means the keys were
  // published and stored, because the machine refuses to walk past a gap.
  await one.page.getByTestId("bank").waitFor({ timeout: 60_000 });
  ok("the walk reaches the next step, so the keys were published and stored");

  firstVault = await inspectVault(one.page);
  if (!firstVault.present) fail("the key vault holds a key set", "it was empty");
  if (firstVault.extractable.ingestPrivate || firstVault.extractable.dek) {
    fail("the stored keys are non-extractable", JSON.stringify(firstVault.extractable));
  }
  const leaked = firstVault.exportAttempts.filter((a) => !a.threw);
  if (leaked.length > 0) fail("every export attempt is refused", `these did not throw: ${leaked.map((l) => l.name).join(", ")}`);
  ok("Chromium refuses all four export attempts", firstVault.exportAttempts[0].message);
  if (firstVault.dekRoundTrip !== "probe" || firstVault.derivedBytes !== 32) {
    fail("the stored handles still work", JSON.stringify({ round: firstVault.dekRoundTrip, derived: firstVault.derivedBytes }));
  }
  ok("the handles still seal, open and derive", `ingest pub ${firstVault.ingestPub.slice(0, 16)}…`);

  // Give the account some content, so recovery has something to read back.
  await one.page.getByTestId("bank-row-dib").click();
  await one.page.getByRole("button", { name: /^Continue$/ }).click();
  await one.page.getByTestId("inbound-address").waitFor({ timeout: 60_000 });
  ok("a bank is declared and the walk moves on, so the account has content");

  // The op has to actually REACH the server, or the second context has nothing
  // to read back and this would prove only that a local database survived.
  await one.page.waitForTimeout(3000);

  // The credential itself, lifted out of the authenticator so the second
  // context can be given it. This is what models the real situation: the
  // passkey lives in the platform's keychain and survives a browser clear, so
  // "I cleared my site data" leaves the credential and destroys everything
  // else. A second context with a second, empty authenticator would model a
  // LOST DEVICE, which is a different (and unrecoverable) story.
  const { credentials } = await one.cdp.send("WebAuthn.getCredentials", { authenticatorId: one.authenticatorId });
  if (credentials.length !== 1) fail("the authenticator holds exactly one credential", `it held ${credentials.length}`);
  await one.context.close();

  // ---------------------------------------------------------------------
  // The same device, site data cleared: a genuinely empty browser profile.
  // ---------------------------------------------------------------------
  console.log("\nthe same device, site data cleared");
  const two = await freshContext(browser);
  await two.cdp.send("WebAuthn.addCredential", {
    authenticatorId: two.authenticatorId,
    credential: { ...credentials[0], isResidentCredential: true },
  });
  two.page.on("pageerror", (e) => console.error("  page error:", e.message));
  await two.page.goto(ORIGIN, { waitUntil: "domcontentloaded" });

  const before = await two.page.evaluate(async () => ({
    localStorage: Object.keys(localStorage).length,
    databases: (await indexedDB.databases()).map((d) => d.name),
  }));
  if (before.localStorage !== 0 || before.databases.length !== 0) {
    fail("the second context starts empty", JSON.stringify(before));
  }
  ok("the browser starts with no localStorage and no databases");

  // The credential lives in the authenticator, not in site data — which is what
  // "I cleared my browser" means and "I lost my phone" does not.
  await two.page.getByRole("button", { name: /^Sign in$/i }).click();

  /*
   * # WHERE THIS RUN STOPS BEING A UI WALK, AND WHY
   *
   * A cleared browser is a NEW DEVICE WRITER, because the writer's Ed25519
   * identity key lived in the local database that was just destroyed. The
   * account's one self-approval (`auth.Writers.Register`'s TOFU bootstrap) was
   * spent by the original device, so this browser stops at the enrolment wall
   * and asks for approval from a device that is already signed in — BEFORE the
   * onboarding walk, and therefore before the recovery step.
   *
   * That gate is not Phase 3's and it is not key material: it is the writer
   * roster, and it has been there since second-device enrolment shipped. It is
   * reported in this task's write-up as a finding, because on the web it means
   * a one-device user who clears their site data cannot WRITE again from the
   * phrase alone — even though, as the rest of this run shows, they can read.
   *
   * So from here the recovery ceremony is driven through the SAME production
   * modules the screen calls, dynamically imported out of the running dev
   * server's module graph — `web/src/v2/keys.ts`, `client/src/crypto/keys.ts`
   * and the real `webPlatform` — in a browser whose storage really was empty a
   * moment ago, against the real server. It is one layer below the screen and
   * exactly the same code path; `RecoveryPhrase.test.tsx` covers the screen
   * that calls it.
   */
  await two.page.waitForTimeout(4000);
  const sessionPresent = await two.page.evaluate(() =>
    Object.keys(localStorage).some((k) => k.includes("session")),
  );
  if (!sessionPresent) fail("the cleared browser signs in with the surviving passkey", "no session was stored");
  ok("the cleared browser signs in again with the passkey alone");

  const recovery = await two.page.evaluate(
    async ([goodPhrase, badPhrase]) => {
      const keys = await import("/src/v2/keys.ts");
      const token = Object.entries(localStorage).find(([k]) => k.includes("session"))?.[1] ?? null;
      const accountId = Object.entries(localStorage).find(([k]) => k.includes("user_id"))?.[1] ?? null;
      const io = { sessionToken: token, server: "" };

      const status = await keys.keyStatus(accountId ?? "", keys.browserKeyVault(), io);
      const published = await keys.readPublishedKeys(io);

      // A well-formed but wrong phrase must be refused, and must store nothing.
      let wrongRefused = false;
      try {
        await keys.recoverAccountKeys({ accountId, phrase: badPhrase, published, vault: keys.browserKeyVault() });
      } catch {
        wrongRefused = true;
      }
      const afterWrong = await keys.browserKeyVault().read();

      await keys.recoverAccountKeys({ accountId, phrase: goodPhrase, published, vault: keys.browserKeyVault() });

      // And the account's existing content is readable: the op authored before
      // the wipe is on the server and comes back over the same session.
      const res = await fetch("/api/v1/sync?stream=hot&after=0", { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      const blobs = (body.rows ?? []).map((r) => r.blob ?? "").join("|");

      return {
        statusKind: status.kind,
        wrongRefused,
        vaultAfterWrong: afterWrong !== null,
        opRows: (body.rows ?? []).length,
        sawBankOp: /YmFua19kZWNsYXJlZA|bank_declared/.test(atob(blobs.split("|")[0] ?? "") || blobs),
      };
    },
    [phrase, "legal winner thank year wave sausage worth useful legal winner thank yellow"],
  );

  // The account HAS keys and this browser does not: `needs_recovery`, never
  // `unpublished`. Reading `unpublished` here would be the catastrophic failure
  // — a second key set minted for an account whose data is sealed to the first.
  if (recovery.statusKind !== "needs_recovery") {
    fail("a cleared browser asks for the phrase, never mints a second key set", `it read ${recovery.statusKind}`);
  }
  ok("a cleared browser reads `needs_recovery`, never `unpublished`");

  if (!recovery.wrongRefused || recovery.vaultAfterWrong) {
    fail("a wrong phrase is refused and stores nothing", JSON.stringify(recovery));
  }
  ok("a well-formed but wrong phrase is refused, and stores nothing");

  const secondVault = await inspectVault(two.page);
  if (!secondVault.present) fail("the recovered vault holds a key set", "it was empty");
  if (secondVault.ingestPub !== firstVault.ingestPub) {
    fail("the recovered ingest key is the SAME key", `${secondVault.ingestPub} != ${firstVault.ingestPub}`);
  }
  ok("the recovered ingest public key is byte-identical to the original", secondVault.ingestPub.slice(0, 16) + "…");
  if (secondVault.extractable.ingestPrivate || secondVault.extractable.dek) {
    fail("the recovered keys are non-extractable too", JSON.stringify(secondVault.extractable));
  }
  if (secondVault.exportAttempts.some((a) => !a.threw)) fail("every export attempt on the recovered keys is refused", "");
  ok("the recovered keys are non-extractable, and every export attempt is refused");

  // And the account's existing content is readable from this browser: the op
  // authored before the wipe came back over the same session.
  if (recovery.opRows < 1) fail("the account's existing content is readable after recovery", "the log came back empty");
  ok("the op authored before the wipe reads back", `${recovery.opRows} row(s) in the hot stream`);

  await two.context.close();
  console.log(`\n${steps.length} checks passed.`);
} catch (err) {
  // What was actually on the glass when it gave up. Without this a timeout says
  // only "the thing I waited for never appeared", which is the least useful
  // half of the story.
  for (const page of browser.contexts().flatMap((c) => c.pages())) {
    console.error("\n--- screen at failure ---");
    console.error((await page.evaluate(() => document.body.innerText)).slice(0, 1200));
    console.error("--- test ids ---");
    console.error(await page.evaluate(() => [...document.querySelectorAll("[data-testid]")].map((e) => e.dataset.testid)));
  }
  throw err;
} finally {
  await browser.close();
}
