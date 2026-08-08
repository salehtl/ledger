# Parity and housekeeping — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Nine operator items: manual transaction entry, Settings IA parity with v1, the bank picker, cross-device preference loss, WebAuthn PRF unlock, the passkey display name, Web Push, an admin panel, and the deferred minor findings.

**Read the spec first:** `docs/superpowers/specs/2026-08-09-parity-and-housekeeping.md`. It records why manual entry reuses `txn_ingested`, why push is content-free, and why the admin panel is not public.

## Global Constraints

- **`SCHEMA_VERSION` stays 3.** If a task appears to need an op-schema change, STOP and report. A v3 device meeting a v4 op hard-stops its entire sync.
- Money is `bigint` minor units, always. Never `Number` for an amount. Amount fields hold **text drafts** parsed to `bigint` — see `web/src/components/MonthlyTotalField.tsx` ("the value is the TEXT, not the amount"). `Number("") === 0` springback is a bug this repo has already shipped once.
- **Do not weaken any existing safety property**: the unknown-newer-version hard stop, writer proof-of-possession, `provenance` deriving from `writer_id` and never from a payload, the trust path never reading configuration, the single op author, `CheckAdminBind`.
- Design aesthetic FROZEN: compose from `web/src/components/`; read `web/src/components/README.md` first. 44px targets, 16px inputs, `Pressable` for press feedback, Dialog-only overlays.
- Motion: `lib/motion.ts` is the sole source of durations/curves; `m.*` never bare `motion.*`; tests rendering `m.*` wrap in `MotionProvider`; never `opacity: 0` in `initial` for first-paint content.
- **Copy rule:** simple language, short sentences, one idea each. AND every string must be literally true — this branch has spent a week deleting sentences the code did not honour. If you cannot make a sentence true, write the weaker one and say so.
- **Beware NUL bytes**: several source files contain literal NULs; `grep` prints NOTHING and exits 1 with no warning. Always `grep -a`. `client/src/diag/nul.test.ts` fails the build on new ones.
- **The git index is shared** with concurrent sessions: check `git diff --cached --name-only` before committing, and stage+commit in ONE atomic command with explicit paths from the repo root.
- **Do not run `cd web && bun run build`** — it writes the tracked `internal/v2/webui/dist` artifact the deploy step owns.
- Commit with a `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

### Task 1: Cross-device preference loss (do first — it destroys data)

**Files:** `web/src/screens/onboarding/BudgetSplitStep.tsx`, `web/src/v2/onboarding.ts` (`resumeFacts` ~:417-423), `web/src/screens/onboarding/Onboarding.tsx:382`. Tests alongside.

- [ ] **Step 1:** Write failing tests first: (a) a device whose account already holds a plan with a monthly total, arriving at the Finish screen, must not author a `budget_split_set` that clears the total; (b) an account past setup whose key vault reads empty must re-enter the product, not the finish walk.
- [ ] **Step 2:** `BudgetSplitStep` seeds from `usablePlan(useBudgetSnapshot(...))` — the same latch `V2Settings.tsx:322-337` already has. A screen that never read the existing plan must never author over it. If the account holds a plan, show it rather than an empty picker.
- [ ] **Step 3:** `resumeFacts` derives `setupSeen` from **account** milestones only; `keysReady` is an access gate, not evidence about setup history.
- [ ] **Step 4:** Verify the same-device cases too: cleared site data, and a failing `GET /api/v1/keys` (which reads as "no keys").
- [ ] **Step 5:** Commit.

---

### Task 2: The bank picker

**Files:** `web/src/screens/settings/V2Settings.tsx:385,398-412`, `web/src/v2/authored.ts`. Tests alongside.

- [ ] **Step 1:** Failing test: toggling a second bank in Settings shows both selected *before* any sync round-trip.
- [ ] **Step 2:** Add `pendingBanks(pending: readonly Op[]): Map<string, boolean>` beside the existing helpers in `authored.ts`, applying `bank_declared` payloads last-wins per `bank` key.
- [ ] **Step 3:** Compute `selected` as the projection read with the pending overlay applied. Memoise on `writer?.pending` (the array is replaced, not mutated — see the note at `Transactions.tsx:169`); that is also what supplies the re-render currently absent.
- [ ] **Step 4:** Do NOT change `BankPicker`, the op author, or the fold — all three are correct.
- [ ] **Step 5:** Commit.

---

### Task 3: Manual transaction entry

**Files:** `web/src/screens/Transactions.tsx`, a new sheet in `web/src/components/transactions/`, `web/src/v2/sources/transactions.ts` (markers). Tests alongside.

- [ ] **Step 1:** Author a client-side `txn_ingested`. `ingest_id` = sha256 of a **fresh random UUID** — never a content hash, which would make two identical coffees collide as a `duplicate_ingest` anomaly. `tier: "none"`, `unparsed: false`, no `verified_origin_domain` (the client path already refuses it).
- [ ] **Step 2:** Add an optional `entry_method: "manual"` payload key — optional keys need no version bump (precedent: `budget_split_set.monthly_total_minor`).
- [ ] **Step 3:** Add a positive `"manual"` marker ("Added by you") in `txnMarkers` and a provenance filter value. Absence-only signalling is too weak.
- [ ] **Step 4:** The sheet: amount, currency (default `homeCurrency()`), direction, merchant, date, category. Amount is a **text draft → bigint**, following `MonthlyTotalField.tsx`. `AddTransactionSheet.tsx` has good field layout and copy to borrow — **do not reuse its money handling**, it uses a `number`.
- [ ] **Step 5:** Write via `Writer.enqueueMany` plus `recordAuthored`, so the row survives the push-ack/pre-fold window instead of vanishing for a few seconds.
- [ ] **Step 6:** Manual rows are **editable** after creation.
- [ ] **Step 7:** Tests: a manual entry is `provenance: "user"` and can never present as bank-verified; amount round-trips exactly above 2^53 minor units; an empty amount field does not spring back to 0.
- [ ] **Step 8:** Commit.

---

### Task 4: Passkey display name

**Files:** `internal/v2/auth/passkey.go:228-247`, `/etc/ledger-v2/config.toml` (operator-applied, document it), the passkey section of Settings. Tests alongside.

- [ ] **Step 1:** `rp_display_name` becomes `"Ledger by Sirdab"`. `WebAuthnName()` returns a stable human string with **no handle suffix**; `WebAuthnDisplayName()` likewise. `WebAuthnID()` stays the 32 random bytes — it is the identity.
- [ ] **Step 2:** Test that discoverable login is unaffected: it is keyed on the handle, and `WebAuthnName()` is never read back from an assertion.
- [ ] **Step 3:** Note in the report that two accounts on one device now look identical in Keychain — the suffix existed for that case. Accepted for a closed beta.
- [ ] **Step 4:** UI: say next to the passkey list that an existing passkey keeps its old name until re-enrolled. WebAuthn has no rename; the name is copied into the authenticator at `create()` time.
- [ ] **Step 5:** Commit.

---

### Task 5: Settings information architecture

**Files:** `web/src/screens/settings/V2Settings.tsx`, plus wiring for `lib/fontScale.ts`, `lib/feedback.ts`, `lib/haptics.ts`. Tests alongside.

Depends on Tasks 2 and 4 (both touch this file) and ideally Task 7 (Notifications lands in the Device group).

- [ ] **Step 1:** Restructure into v1's labelled groups: **Plan** (Your plan, Your banks) · **Automation** (Your inbound address, Held mail) · **Device** (Notifications, Text size, Haptics, Sound, Passkeys, Your devices, Sign out last) · **Library** (Categories, Home currency). Match v1's `Group`/`Card` composition — read `frontend/src/screens/settings/SettingsHub.tsx:139-226`.
- [ ] **Step 2:** Sync status is not a setting: a status line **above** the groups.
- [ ] **Step 3:** Wire text size, haptics and sound to the existing helpers. These are device-local by design — do NOT put them in the op log.
- [ ] **Step 4:** No Danger zone group — v2 has no destructive action yet. Do not invent one to fill the shape.
- [ ] **Step 5:** Check the result with `frontend/harness/` (`shoot.mjs` + `audit.mjs`), not only vitest: a long settings screen is exactly where a control ends up under the bottom nav.
- [ ] **Step 6:** Commit.

---

### Task 6: WebAuthn PRF unlock

**Files:** `client/src/crypto/`, `web/src/v2/keys.ts`, `internal/v2/api/keys.go` + migration, `internal/v2/auth/passkey.go`. Tests alongside.

**The existing wrap envelope and `wrapped_keys` column are FROZEN.** `handlePublishKeys` (`internal/v2/api/keys.go:210`) compares all three key fields byte-for-byte and 409s on any difference; there is no UPDATE and no DELETE. Appending to that column is unreachable for any published account, and relaxing the comparison would reopen the accidental-rekey hazard the 409 exists to prevent. **Do not touch it.** Multi-wrap lives in storage, not in the byte format.

**Step 0 — before any UI work:** confirm on the operator's real device that a real authenticator returns a **stable** PRF output across sessions, across the create→get transition, and ideally after a restart. The entire feature rests on that assumption and it cannot be tested headlessly. If it does not hold, STOP and report.

- [ ] **Step 1:** Factor the 97-byte body encode/decode (`[KEY_SET_VERSION][x25519][dek][ed25519 seed]`) out of `wrapAccountKeys`/`unwrapAccountKeys` so both wrap kinds provably carry identical bytes.
- [ ] **Step 2:** Add a sibling `wrapPrfKeys`/`unwrapPrfKeys` sealing that same body under a NEW envelope: `[1B version=1][1B kdf=2 (HKDF-SHA256)][32B salt][12B nonce][sealed]`, whole header authenticated, with a distinct domain constant (`ledger-v2-account-keys-prf\x00`). Same AAD discipline as the existing wrap.
- [ ] **Step 3:** New table `user_key_wraps(user_id, credential_id bytea REFERENCES webauthn_credentials(credential_id) ON DELETE CASCADE, wrapped bytea CHECK 32..4096, wrap_version, created_at, PRIMARY KEY (user_id, credential_id))`, with the same conditional `ledger_runtime` GRANT block as `00026`. New `GET/POST/DELETE /api/v1/keys/wraps`. Additive: `keys.go` does not change, and already-published accounts gain PRF retroactively. **DELETE is correct here** (unlike published keys) — losing a PRF wrap loses nothing, the phrase still opens the account.
- [ ] **Step 4:** **HKDF-SHA-256, not Argon2id.** The PRF output is a 32-byte HMAC under a per-credential authenticator secret — uniform, no user-chosen input, no offline guessing space. Argon2id's justification in `keys.ts`'s header ("our 128 bits might not really be 128 bits") does not transfer; it would cost a second per unlock and buy nothing. `deriveBits(HKDF, salt=blob salt, info="ledger-v2-prf-wrap-v1")`.
- [ ] **Step 5:** The PRF salt is a **compile-time constant**, not per-account: the PRF is already keyed per-credential, and a per-account salt would force a server round-trip before unlock — unlock must work offline. Per-wrap randomness lives in the HKDF salt inside the blob.
- [ ] **Step 6: security fix, do this even if the rest slips.** `web/src/v2/session.ts:257` `extensionResults()` serialises **all** client extension results to the server. PRF output survives today only as `{}` by accident of `JSON.stringify` on an ArrayBuffer. Explicitly strip `prf` before upload, with a test. Build the extension **client-side**: `publicKeyCreationOptions`/`publicKeyRequestOptions` (`:178,191`) spread `...pk` verbatim, so a server-sent `extensions.prf.eval.first` would arrive as a JSON string and be rejected as a non-BufferSource. go-webauthn v0.17.4 has no PRF awareness (zero hits for `prf`/`hmac-secret`); it passes extensions through as `map[string]any` and needs to do nothing here.
- [ ] **Step 7:** Enrolment flow, which is **post-onboarding only** — it requires the keys to be already unlocked, so it is never part of first run: `create()` with `extensions: {prf: {}}` → check `getClientExtensionResults().prf.enabled`, stop if false → **immediate follow-up `get()`** with `allowCredentials: [newRawId]` and `prf.eval.first`, because Safari/iOS never return PRF output from `create()`. That second biometric prompt must be warned about in the copy.
- [ ] **Step 8:** Feature detection is "try it and degrade", **never a promise made in advance**. `PublicKeyCredential.getClientCapabilities?.()` is worth trying but ground truth is only `prf.enabled` after a real ceremony. An orphaned wrap (passkey deleted from Keychain) is GC'd on a 404/`allowCredentials` miss; the phrase recovers.
- [ ] **Step 9:** The recovery phrase stays **mandatory and unconditional**. Every PRF wrap derives from a secret inside one authenticator the user can lose, reset, or have silently rotated by an OS update, and the server holds nothing that can help. No copy may imply PRF replaces the phrase.
- [ ] **Step 10:** Tests: new envelope round-trip and AAD binding (rewrite a header byte, watch it refuse); PRF-wrap and phrase-wrap decode to **byte-identical** bodies; HKDF vectors pinned against a fixed PRF input; the wrap endpoints in Go including cascade on credential delete and account delete; `extensionResults` strips `prf`; feature detection returns unsupported for a stubbed credentials container. State plainly in the report what only real hardware can verify.
- [ ] **Step 11:** Commit.

---

### Task 7: Web Push (VAPID), content-free

**Files:** `internal/v2/pg/migrations/` (new `push_subscriptions`), `internal/v2/config`, a sender, routes, `web/vite.config.ts` (`injectManifest`), a service worker source, Settings. Tests alongside.

- [ ] **Step 1:** `push_subscriptions` (endpoint, p256dh, auth), keyed per user with the same anti-hijack keying as the existing `push_tokens`. Do NOT reuse `push_tokens` — those are Expo/APNs/FCM device tokens for the abandoned native client and are the wrong shape. Mirror `00003_writers.sql`'s two-role grant recipe; the easily-missed steps fail only in production.
- [ ] **Step 2:** Switch `web/vite.config.ts` from `generateSW` to `injectManifest` so a custom `push`/`notificationclick` handler can exist. Verify the precache manifest still works — this is a build-config change with a real blast radius.
- [ ] **Step 3:** **Payloads are content-free.** No merchant, no amount, no category. "New activity" and nothing more; the client decrypts and shows detail on open. A body composed server-side from user data re-establishes the plaintext path Phase 3 exists to remove.
- [ ] **Step 4:** Client subscribe/unsubscribe in the Settings **Device** group, using the existing VAPID env vars. Note v1's push is a server half with no browser half — there is no client code to port, only the server shape to learn from.
- [ ] **Step 5:** Test the sender and the subscription lifecycle. Headless Chromium cannot verify actual delivery — say so rather than implying coverage.
- [ ] **Step 6:** Commit.

---

### Task 8: Admin panel

**Files:** `internal/v2/admin/`, a small bundle, deployment notes. Tests alongside.

- [ ] **Step 1:** Serve a UI from the **existing admin listener** (`admin_listen = 127.0.0.1:8079`, tailnet-only), reusing `LEDGER_ADMIN_TOKEN`. Do NOT add `admin.sirdab.ae` to `tls_domains` and do NOT mount admin routes on the public listener. `config.CheckAdminBind` and `TestTheAdminConsoleIsNotMountedOnThePublicListener` must both still pass, unmodified.
- [ ] **Step 2:** Wrap the endpoints that already exist: templates (+validate/publish/reprocess), diagnostics, accounting, waitlist, quarantine, samples, dictionary moderation.
- [ ] **Step 3:** **Show operational data only** — accounts, mailbox addresses, forwarding health, ingest failures, quarantine counts, parse drift, key state. Never transactions, amounts, merchants or balances: after Phase 3 the server cannot read them, and a panel assuming otherwise breaks on sealing.
- [ ] **Step 4:** Same design language as the app — compose from `web/src/components/`.
- [ ] **Step 5:** Document the DNS/cert step for `admin.sirdab.ae` → Tailscale IP for the operator to apply. Do not apply it.
- [ ] **Step 6:** Commit.

---

### Task 9: Minor findings

- [ ] **Step 1:** Collect the deferred minor findings from `.superpowers/sdd/*/progress.md` across this branch's plans.
- [ ] **Step 2:** Triage: fix what is genuinely minor and safe; report anything that turns out not to be minor rather than fixing it silently.
- [ ] **Step 3:** Commit.

---

### Task 10: Gate

- [ ] `bash scripts/v2-check.sh` green on a quiet tree; `internal/v2/webui/dist` clean afterwards.
- [ ] `go test ./... -race` and `cd web && bun run test` green.
- [ ] Harness round on the changed screens: `harness/stack.sh up`, `shoot.mjs`, `probe.mjs`, `ios.mjs`. Redirect `stack.sh` output to a file — piping it hangs.
- [ ] Rebuild the bundle and record what the operator must do to deploy. **Do not deploy** — the operator applies migrations as `ledger_migrate` first, out of band.
