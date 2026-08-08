# Parity and housekeeping — v2 PWA

**Date:** 2026-08-09
**Status:** Decided, pre-implementation.
**Decided by:** the assistant, at the operator's instruction to decide alone overnight and record what needs review.

Nine items from the operator, plus the decisions each one forced. Phase 3 sealing
(Tasks 2–6) is **paused** for this work and resumes after; nothing here seals or
unseals anything, so the "never a half-encrypted log" rule is untouched.

---

## 1. Manual transaction entry

**Decision: reuse `txn_ingested`. No new op type. `SCHEMA_VERSION` stays 3.**

Investigation found nothing ingest-only in the payload. `verified_origin_domain`
is optional and *already* refused when a client supplies it
(`client/src/net/client.ts` — "server-attested"). `replay.ts:1280` names the case
outright: *"every client-authored op — a CSV import, a manual entry — and those
carry real money."*

A new op type would force `SCHEMA_VERSION` 4, and a v3 device meeting a v4 op
raises `UnknownNewerVersionError` — a **hard stop of the entire sync**, not a
per-op skip. The user's second device would stop receiving categorisations, rates
and bank mail until it updated, in exchange for a hand-typed coffee. Refused.

**Provenance is structural and needs no new mechanism.** `provenance` derives from
`writer_id === INGEST_WRITER_ID`, never from the payload, and `"ingest"` is not a
client-writable writer (`oplog/chain.go:284`). A manual entry is therefore
`provenance: "user"` **unforgeably**. What is missing is only the *positive*
signal: today ingested rows get "From your inbox" and manual rows are marked by
absence. Absence is a signal you must already know to look for. Adding a
`"manual"` marker ("Added by you") and a provenance filter value.

`ingest_id` is required, 64 lower-case hex. A manual entry has no raw body, so
mint it from a **fresh random UUID, not from the field values** — content-hashing
would make re-typing the same amount twice collide as a `duplicate_ingest`
anomaly, which is wrong: two identical coffees on one day are two coffees.

**Editable after creation** (operator's list did not ask; deciding yes). A typo
you cannot correct is worse than no feature.

## 2. Settings information architecture

**Decision: adopt v1's five labelled groups.**

v1 has Plan / Automation / Device / Library / Danger zone. v2 has nine flat
sections with no grouping tier. Mapping:

- **Plan** — Your plan (budget split + monthly total), Your banks
- **Automation** — Your inbound address, Held mail
- **Device** — Notifications (new, §7), Text size, Haptics, Sound, Passkeys,
  Your devices, Sign out
- **Library** — Categories, Home currency
- **Danger zone** — (v2 has no destructive action yet; omit the group rather than
  invent one)

Sync status has no v1 equivalent and is not a setting — it goes **above** the
groups as a status line, not inside one.

Text size / haptics / sound are **unported, not unbuildable**: `lib/fontScale.ts`,
`feedback.ts`, `haptics.ts` all exist in the v2 tree already.

Not portable, and correctly absent: AI & API usage, Categorization rules, Email
ingest/IMAP config — v2 has no AI and no IMAP. Recurring bills, Accounts,
Projects, Rules, Transfers need projections that do not exist; out of scope.

## 3. The bank picker

**Decision: overlay unsent ops on the projection read.** Not a component bug.

`BankPicker` is correct (44px targets, per-row toggle). The op author is correct
(one keyed `bank_declared {bank, active}` per call, per §3.3's ban on whole-set
replace). The fold is correct. `V2Settings` derives `selected` **solely** from the
projection, which does not move until a sync round-trips — so the refetch returns
the identical array, nothing ticks, and no second bank can be added.

`Transactions.tsx` and `Review.tsx` already solve this with a pending overlay.
Settings was written without one. Add `pendingBanks()` beside the existing
helpers in `web/src/v2/authored.ts` and apply it last-wins per bank key.

## 4. Cross-device preferences — **a data-loss bug, not a sync gap**

Everything the user can set *is* op-log-backed and *does* sync. The defect is the
onboarding walk.

`resumeFacts` only marks setup as seen when `stepFor` reaches the last milestone,
and `stepFor` stops at the first false one — which on a fresh device is
`keys_secured`. So **any device that has to secure keys is treated as never having
been set up**, walks to the Finish screen, and is shown `BudgetSplitStep` seeded
from `DEFAULT_BUDGET_SPLIT` and `""` — it never reads the log. Saving there
authors a full `budget_split_set`, so **a blank total field silently wipes a
monthly total set on the first device.**

Same path fires on the *same* device whenever the key vault reads empty: the
WebKit `CryptoKey` loss, cleared site data, or a failing `GET /api/v1/keys`.

**Decision, two parts:**
1. `BudgetSplitStep` reads `usablePlan(useBudgetSnapshot())` — the latch
   `V2Settings` already has and onboarding lacks. A screen that never read the
   existing plan must never author over it.
2. `resumeFacts` derives `setupSeen` from **account** milestones only. Key
   readiness is an access gate, not evidence about setup history.

There is no "income" setting in v2 — `BudgetSnapshot.income` is derived from
credits. The field the operator remembers is v1's. Not restoring it; the v2
concept is the monthly budget total.

## 5. Face ID / YubiKey unlock — WebAuthn PRF

**Decision: implement, with the recovery phrase kept as a mandatory backstop.**

PRF returns a stable 32-byte secret from the authenticator, which wraps the
account keys directly — so Face ID or a YubiKey touch replaces typing 12 words.
Supported on Safari 18+/iOS 18, Chrome, and YubiKeys via `hmac-secret`.

**The phrase does not become optional.** A PRF secret belongs to the *credential*,
not the person: a passkey deleted from Keychain takes it with it, and a YubiKey
does not sync — one lost key would otherwise mean a lost account. PRF is the
everyday unlock; the phrase is the backstop you never use. This preserves the
Phase 3 §4 decision unchanged.

Key derivation is **HKDF, not Argon2id**. The PRF output is already uniformly
random 32 bytes; stretching it would be theatre and cost 64 MiB per unlock.

**The write-once risk, and why no account has to be destroyed.** Key publication
compares all three key fields byte-for-byte and 409s on any difference; there is
no UPDATE and no DELETE. So the existing `wrapped_keys` column is frozen forever
for any account that has published, and appending a second wrap to it is
unreachable. Relaxing that comparison would reopen the accidental-rekey hazard the
409 exists to prevent.

**The resolution is additive, so the operator's account is not stuck.** Multi-wrap
lives in a new `user_key_wraps` table keyed by credential, not in the frozen byte
format: the existing envelope is untouched, `keys.go` does not change, and
already-published accounts gain PRF retroactively. The operator authorised
deleting his account; it is not necessary and his transaction history stays.

`DELETE` *is* correct for a PRF wrap, unlike for published keys — removing one
loses nothing, because the phrase still opens the account.

**A latent bug found while scoping this, worth fixing regardless of PRF:**
`web/src/v2/session.ts:257` serialises **all** WebAuthn client extension results to
the server. PRF output survives today only as `{}`, by accident of
`JSON.stringify` on an `ArrayBuffer`. Requesting PRF on an assertion without
changing that would upload secret key material.

## 6. Passkey display name

**Decision: `rp_display_name = "Ledger by Sirdab"`, and drop the handle suffix
from `WebAuthnName()`.**

Keychain shows RP display name as the title and `WebAuthnName()` as the account
line, so today it reads "Ledger" over "Ledger YHeaynbu" — the word twice plus the
first 8 chars of the random user handle. The suffix was deliberate, to
distinguish two accounts on one device; the cost of removing it is that two
accounts on one device look identical. For a closed beta that is the right trade.

Safe: login is `BeginDiscoverableLogin`, keyed on the handle. `WebAuthnName()` is
never read back from an assertion and is not a lookup key. `WebAuthnID()` stays
the 32 random bytes.

**Existing credentials cannot be renamed** — the name is copied into the
authenticator at `create()` time and WebAuthn has no rename. The operator must
delete and re-enrol to see the change. New users get it immediately. Say this in
the UI next to the passkey list rather than letting him wonder.

## 7. Web Push (VAPID)

**Decision: content-free notifications.**

v1's push composes `{title, body}` server-side — "AED 240 at Spinneys". After
Phase 3 the server holds ciphertext; composing that body means decrypting user
data on the server to build a payload that then transits Apple's or Google's push
service. That re-establishes exactly the plaintext path Phase 3 removes.

So: the push says new activity arrived; the client decrypts and shows detail on
open. Less useful, and the only version consistent with what onboarding tells the
user.

Note v1's push is a **server half with no browser half** — no `PushManager`, no
`applicationServerKey`, no `push` listener in its service worker. So this is a
build, not a port, and v2 needs `injectManifest` (it is on `generateSW` today,
which cannot carry a custom handler). v2's existing `push_tokens` tables are
Expo/APNs/FCM device tokens for the abandoned native client and are the wrong
shape; a `push_subscriptions` table is needed, keyed per user like `push_tokens`.

## 8. Admin panel

**Decision: `admin.sirdab.ae` resolving to the Tailscale IP. Not public.**

The admin API today is a separate listener on `127.0.0.1:8079`, tailnet-only,
with `config.CheckAdminBind` refusing to start if bound publicly and a test
asserting it is not on the public listener. Authority is one shared static token;
**there is no role concept in the schema at all**. The token was safe because of
the network placement, not on its own merit.

Publishing that surface would put every account's operational data behind a single
static string on the open internet. Refused without real auth, which is its own
project.

The panel serves from the existing admin listener, reusing the token, wrapping the
endpoints that already exist: templates, diagnostics, accounting, waitlist,
quarantine, samples, dictionary moderation.

**Content it must not show:** transactions, amounts, merchants, balances. After
Phase 3 it *cannot*, and building a panel that assumes it can would be a design
that breaks on sealing. Operational data only — accounts, mailbox addresses,
forwarding health, ingest failures, quarantine counts, parse drift, key state.

Same design language as the app: compose from `web/src/components/`.

## 9. Minor findings

The deferred list in `.superpowers/sdd/*/progress.md`, plus the three ambiguities
and three minor items from the copy review (in flight as round 2).

---

## For the operator to review

1. **Settings gains v1's Device group wholesale** — text size, haptics, sound. The
   helpers were already ported; not wiring them was an omission.
2. **Manual transactions are editable.**
3. **Push is content-free**, so it says less than v1's did. This is forced by
   encryption, not a shortcut.
4. **The admin panel is tailnet-only** at the requested hostname. Making it truly
   public needs a role system.
5. **The passkey rename does not affect the existing credential** — re-enrol to
   see it.
6. **PRF does not retire the recovery phrase**, and should not.
7. **No income setting** exists or is being added in v2; income is derived.
