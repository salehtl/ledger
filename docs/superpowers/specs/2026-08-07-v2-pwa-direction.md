# v2 direction change — PWA client instead of Expo

**Date:** 2026-08-07
**Status:** Direction set, pre-implementation. Amends
`2026-07-31-multi-user-beta-design.md` §3.9 and §5 (Phase 2). Everything else in
that spec — threat model, SMTP ingest, origin trust, op log, crypto design,
templates, dictionary, FX — stands unchanged.
**Branch:** `v2-pwa`, cut from `v2-wip-2026-08-05` (`cb6904e`).

## The change in one line

The server, the op log, and the shared local-first core (`client/src`) are kept
exactly as built. Only the *shell* changes: a React PWA instead of an Expo
iOS app.

## What carries over untouched

- **All of `internal/v2`** — 23 packages, 24 migrations. Phase 1 is done and its
  exit record stands. Verified in this worktree: `scripts/v2-check.sh` passes
  the Go half and all **2,351** client tests.
- **All of `client/src`** — replay, wire/chain, invariants, outbox, norm, tmpl,
  categorize, importer. This is the local-first engine and it is framework-free
  by design. The PWA consumes it identically to how the Expo app would have.
- **`client/src/platform.ts`** — the seam exists precisely so the host runtime is
  swappable. It was written for "Bun and Hermes"; it becomes "Bun and the
  browser" at no structural cost.

## What the browser changes, honestly

### 1. The platform seam is easy — and that is a real finding

Every one of the seam's 14 methods is **synchronous**. WebCrypto's `subtle` API
is async and `DecompressionStream` is a stream, so neither can implement it
directly. The browser implementation is therefore pure JS: `@noble/hashes`
(sha256), `@noble/curves` (ed25519), `fflate` (gzip/gunzip), and native
`TextEncoder`/`atob`/`crypto.getRandomValues` for the rest. No WASM required.

The consequence: **Phase 2's Task 1 (the native-crypto JSI benchmark) is void.**
Its "noble control arm" is now the only arm. There is no native escape hatch to
fall back on if pure-JS crypto is too slow, so the fold/restore budget must be
met by algorithm and scheduling (progressive newest-window-first restore, Web
Workers, incremental replay) rather than by a faster primitive. Fallback **F1**
was already mandatory under Decision 11's no-floor-device cap; it stays
mandatory for a different reason.

### 2. Key storage is genuinely weaker — this needs a §2 amendment

Spec §3.4 puts the device wrap key in the **iOS Keychain, iCloud-Keychain-synced**,
and §3.9 relies on that for painless new-device restore. The browser has no
Keychain. The options are non-extractable `CryptoKey` handles in IndexedDB
(private key material never reachable from JS, but any XSS can still *use* the
key) or raw bytes in IndexedDB (strictly worse). Either way:

- **The recovery phrase becomes the primary and effectively only recovery path.**
  Apple's custodial role leaves the threat model; browser-storage XSS enters it.
- §2's breach inventory and the privacy page must be rewritten accordingly
  before any external tester. This is a real change to what we can claim, not a
  porting detail.

### 3. Storage eviction is a new first-class risk

A local-first client whose local store can be evicted is a different product.
Safari caps non-installed-PWA storage at 7 days of inactivity;
`navigator.storage.persist()` mitigates but is not guaranteed. Add-to-Home-Screen
becomes a correctness requirement, not a nicety, and the client must survive
eviction by re-restoring from the server — which is exactly the cold-restore
path the crypto gate measures. Budget for it.

### 4. Local store: SQLite WASM + OPFS

Phase 2 Task 5 replaced `client/src/store`'s `node:fs` file store with SQLite.
On the web that is `wa-sqlite`/`sqlite-wasm` over OPFS. Same shape, different
driver; the store interface was already abstracted for this.

## What gets easier

- **No Apple Developer Program dependency, no TestFlight, no Beta App Review**
  for a finance app with a mail-ingestion core loop. Alphas get a URL.
- **No EAS, no prebuild, no custom dev client, no floor-device procurement.** The
  whole of Phase 2's Part 0 (P1/P2) disappears.
- **Rich push gets *simpler*, not harder.** Spec §3.8 costed an iOS Notification
  Service Extension with a second crypto implementation in Swift kept
  bit-compatible with the JS one. A service worker decrypts with the *same* JS
  code. The §3.8 NSE section can be deleted rather than deferred.
- **The existing PWA in `frontend/` is a real head start** — screens, design
  system, Storybook, the harness in `frontend/harness/`, and the framework-free
  `frontend/src/lib/` helpers.

## What gets harder

- **iOS PWA push** requires the user to add to Home Screen, and permission
  prompts must follow a user gesture. Onboarding must walk them through it.
- **Background sync is unreliable.** No true background fetch on iOS; the app
  syncs when open. The "instant notification" product value in §3.8 now depends
  entirely on Web Push waking the service worker.
- **Biometric app-lock** is WebAuthn-based rather than Face ID via Keychain.

## Open decisions (before implementation starts)

1. ~~**Fork or evolve `frontend/`?**~~ **DECIDED 2026-08-07: fork.** `web/` is an
   exact copy of `frontend/`'s 436 tracked files, so `main` keeps serving the
   single-user instance untouched until migration (spec §5). **The design
   aesthetic is carried over wholesale and is not up for redesign** — same
   Tailwind v4 tokens, Geist/Geist Mono, dither-kit charts, `lib/motion.ts` as
   the single source of truth for every duration and curve, the same component
   catalogue and its 44px/16px mobile conventions, the same Storybook and
   `harness/`. Screens get rewired from REST-against-the-v1-Go-server to
   local-first replay against `client/src`; they do not get restyled.
   Two edits were needed to stop the fork colliding with v1: the package name
   (`ledger-v2-web`) and `build.outDir` (see `web/vite.config.ts`, which would
   otherwise have overwritten v1's committed embed artifact).
2. **Does the crypto gate keep a hard-stop shape?** It should — the question it
   asks (can a phone restore 3,700 singleton blobs fast enough) is unchanged; only
   the runtime is. Re-run Task 1b's fold benchmark under Safari on the operator's
   iPhone rather than under Hermes.
3. **Key-storage decision** per §2 above, which gates the privacy page rewrite.

## Status of the Expo work

`app/` was removed from the tree on 2026-08-10 (commit 0c582bd) — abandoned in
favor of this PWA and nothing was building or testing it in the meantime. It is
preserved at the `app-expo-final` tag (pushed to origin), so Task 1b's fold
harness and the on-device measurement rig that lived in `app/src/bench/`
(digest.ts, frame.ts, noble.ts, protocol.ts, vectors.ts, verdict.ts) are
still recoverable from that tag if the browser equivalents need something to
measure against.
