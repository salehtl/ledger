/**
 * The key vault's round trip, in every engine this product actually ships to.
 *
 * # Why this file exists
 *
 * `recovery.mjs` next door proves the whole recovery ceremony, and it proved it
 * in Chromium only. It was green for months while every iPhone was broken:
 * **WebKit accepts an X25519 `CryptoKey` into IndexedDB, completes the
 * transaction, and returns `null` for that record on every later read.** No
 * error, anywhere. `installAccountKeys` resolved, the account published a key
 * set it could never open, and the recovery screen put itself back on the glass
 * forever.
 *
 * A Chromium-only browser harness is the same shape of miss as a timezone guard
 * that passes because the box is UTC. So this runs the one property that matters
 * — write a key set, open a NEW connection, read it back, and USE it — in both
 * Chromium and WebKit, and fails the run if either engine loses it.
 *
 * It needs no server, no invite and no passkey: only a page on the origin, so
 * the app's own module can be imported and the real `browserKeyVault` driven.
 * WebAuthn cannot be automated in WebKit, which is exactly why the ceremony test
 * cannot simply be pointed at it — and why this narrower thing had to exist.
 *
 * # Running it
 *
 *   harness/v2stack.sh up          # or any vite serving this app
 *   node harness/vault.mjs
 *
 * A scratch database name is used throughout, so a run never touches the vault a
 * real session on the same origin is using.
 */

import { chromium, webkit } from "playwright";

const ORIGIN = process.env.LEDGER_HARNESS_ORIGIN ?? "http://localhost:5177";
const DB = "ledger-v2-keys-harness";

/**
 * The whole property, in one page evaluation.
 *
 * Deliberately through `browserKeyVault()` and `installAccountKeys` rather than
 * through hand-rolled IndexedDB calls: the thing under test is what the product
 * does, and a re-implementation here would have kept passing while the product
 * broke. The read is on a SECOND vault instance, which opens its own connection
 * — reading back through the same one can be served from a transaction that has
 * not committed.
 */
async function roundTrip(page, dbName) {
  return page.evaluate(async (name) => {
    const out = { wrote: false, error: null, read: null, derivedBytes: 0, extractable: null, exportRefused: null };
    const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    try {
      // Only the app's own module is imported. A bare specifier
      // (`@ledger/client/...`) would not resolve here — vite rewrites those
      // while transforming a source file, and this string is not one — so the
      // key set is minted from WebCrypto directly, which is all
      // `installAccountKeys` needs: it reads `ingestPub`, `ingestPriv`, `dek`
      // and `recoverySeed`, and zeroes the three private ones.
      const keys = await import("/src/v2/keys.ts");

      const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      const minted = {
        ingestPub: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
        ingestPriv: pkcs8.slice(pkcs8.length - 32),
        dek: crypto.getRandomValues(new Uint8Array(32)),
        recoverySeed: crypto.getRandomValues(new Uint8Array(32)),
        recoveryPub: new Uint8Array(32),
      };
      const account = "99999999-9999-4999-8999-999999999999";
      const pub = hex(minted.ingestPub);

      await keys.installAccountKeys(account, minted, keys.browserKeyVault(name));
      out.wrote = true;

      // A NEW vault, i.e. a new connection to the database — which is what the
      // next launch of the app does.
      const reader = keys.browserKeyVault(name);
      const row = await reader.read();
      out.read = row === null ? null : { accountId: row.accountId, ingestPub: hex(row.ingestPub) };
      if (row === null) return out;
      if (out.read.ingestPub !== pub) throw new Error("the ingest public key changed across storage");

      // Present is not enough: it has to WORK. This is the decrypt-and-import
      // path every future reader of sealed mail takes.
      const opened = await keys.openIngestPrivate(row);
      const peer = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
      out.derivedBytes = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "X25519", public: peer.publicKey }, opened, 256),
      ).length;

      out.extractable = { dek: row.dek.extractable, ingest: opened.extractable };
      const refused = [];
      for (const [what, key, format] of [
        ["dek/raw", row.dek, "raw"],
        ["dek/jwk", row.dek, "jwk"],
        ["ingest/pkcs8", opened, "pkcs8"],
        ["ingest/jwk", opened, "jwk"],
      ]) {
        try {
          await crypto.subtle.exportKey(format, key);
          refused.push({ what, threw: false });
        } catch {
          refused.push({ what, threw: true });
        }
      }
      out.exportRefused = refused;
      await reader.clear();
    } catch (err) {
      out.error = String(err && err.message ? err.message : err);
    }
    return out;
  }, dbName);
}

let failed = false;
function check(engine, condition, what, detail = "") {
  if (condition) {
    console.log(`  ok    ${engine}: ${what}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.error(`  FAIL  ${engine}: ${what}${detail ? ` — ${detail}` : ""}`);
    failed = true;
  }
}

for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
  console.log(`\n${engine}`);
  const browser = await launcher.launch();
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`  page error: ${e.message}`));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    const r = await roundTrip(page, DB);

    check(engine, r.error === null, "the round trip ran without throwing", r.error ?? "");
    check(engine, r.wrote, "the key set was written");
    // THE assertion. Before the storage shape changed this line said
    // `read: null` in WebKit and nowhere else.
    check(engine, r.read !== null, "the key set reads back on a new connection", r.read === null ? "read null" : r.read.ingestPub.slice(0, 16) + "…");
    check(engine, r.derivedBytes === 32, "the recovered ingest key still derives", `${r.derivedBytes} bytes`);
    check(engine, r.extractable !== null && !r.extractable.dek && !r.extractable.ingest, "both keys are non-extractable", JSON.stringify(r.extractable));
    check(
      engine,
      r.exportRefused !== null && r.exportRefused.every((a) => a.threw),
      "every export attempt is refused",
      JSON.stringify(r.exportRefused),
    );
  } finally {
    await browser.close();
  }
}

if (failed) {
  console.error("\nthe key vault does not round-trip in every engine this ships to.");
  process.exit(1);
}
console.log("\nthe key vault round-trips in Chromium and in WebKit.");
