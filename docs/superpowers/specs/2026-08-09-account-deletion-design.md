# Deleting an account — design

**Date:** 2026-08-09
**Status:** approved by the operator, ready for a plan
**Depends on:** nothing. Shares a ceremony with address rotation.

---

## 1. Why this exists, and the defect at the centre of it

The operator asked for in-app account deletion. The server side was built, and it
**cannot currently be used by anyone.**

`handleDeleteAccount` requires three factors, and factor 2 is a **fresh ID token
from the account's identity provider**, verified server-side:

```go
verifier := s.Verifiers[req.IdP]
if verifier == nil || req.IDToken == "" {   // internal/v2/api/account.go:163-164
```

But v2 is **passkeys only**. The live config carries `apple_client_ids = []` and
`google_client_ids = []`, and the comment beside them records why: dropping the
native client removed the App Store rule that forced Sign in with Apple, and
passwords never existed in v2.

**With no verifiers configured, factor 2 can never be satisfied, so the endpoint
always answers 403.** The deletion path was written when v2 still had identity
providers and was not revisited when they were removed. Building a button on top
of it would ship a screen that cannot work.

So this design is: **replace factor 2 with a passkey re-authentication**, then
build the screen.

## 2. What the three factors are for

The structure is deliberate and worth keeping. From the file header:

1. **A live session** — says which account is being discussed, and nothing else.
2. **A fresh re-authentication** — proves a human just proved who they are.
3. **An Ed25519 signature by an enrolled, non-revoked device key** over a
   single-use nonce from `POST /api/v1/account/challenge`.

The reasoning holds regardless of what provides factor 2: a stolen session has
neither of the others; malware on an unlocked device that can sign cannot produce
a re-authentication.

## 3. The change: factor 2 becomes a WebAuthn assertion

Replace the IdP token with a **fresh passkey assertion over the same
challenge nonce**. This is strictly better than what it replaces, and the file's
own header says so about its weakness:

> the endpoint "binds no IdP nonce … so 'fresh' means the token was minted within
> the window, not that it was minted FOR this action."

A WebAuthn assertion signs a **server-issued challenge**, so it is bound to this
action by construction. The five-minute freshness window becomes a property of the
challenge rather than a mitigation for replay.

Concretely:

- `POST /api/v1/account/challenge` issues the nonce, as it already does.
- The client performs a passkey `get()` over that challenge.
- `DELETE /api/v1/account` carries the assertion in place of `idp` / `id_token`.
- The server verifies the assertion against an **enrolled, non-revoked credential
  of that account**, then verifies factor 3 exactly as now.

**A note the plan must check:** the header says `VerifyOpts` carries `MaxAge` and
nothing else, but the call at `account.go:179` passes a `Nonce`. One of the two is
stale. Establish which before relying on either.

**Factor 3 stays.** The device-key signature is what stops malware that can drive
the authenticator but is not an enrolled writer.

## 4. What deletion must do, and must not do

Deletion is already implemented in `internal/v2/purge`, and the sweeps and
tombstones exist (`deleted_account_sessions`, and the tombstone-retention sweep
that runs on ledgerd's own clock rather than in a database trigger). **This design
does not change the purge itself.**

What the screen must get right:

- **Say what is destroyed and that there is no undo**, on the screen, before the
  ceremony. This is a no-way-back warning: it stays on the screen and **must not**
  move into a tooltip.
- **Say what happens to mail in flight**: the inbound address stops existing, and
  mail sent to it afterwards is refused.
- **Distinguish synced from unsent**, with a count, exactly as the existing wipe
  copy does. A user with unsynced ops on this device is destroying something no
  other device has.
- **Require a typed confirmation** of a fixed word, so the destructive tap cannot
  be a mis-tap. Two prompts in a row are not a substitute — people tap through
  both.
- **Never claim the operator can restore it.** They cannot.

## 5. Where it lives

Settings. The recently restructured groups have no Danger zone, deliberately —
"v2 has no destructive action yet. Do not invent one to fill the shape."

**This design creates the first one.** So a **Danger zone group** is now correct,
at the bottom of Settings, containing exactly one row: Delete account. The
settings design's instruction not to invent one is satisfied — this is no longer
inventing.

## 6. Testing

- **Prove every test bites.** Mutate, watch it fail, revert.
- Deletion is refused when the assertion is missing, stale, replayed, or signed by
  a credential belonging to a different account.
- Deletion is refused when factor 3 is missing or signed by a revoked key.
- All three refusals answer the **same 403**, so a caller cannot learn which
  factor they are missing by watching the status change. This property exists
  today and must survive the change.
- After deletion, a session for that account is rejected, and mail to the address
  is refused.
- The typed confirmation is required; the button does nothing without it.
- The unsent-op count shown is the real one — mutate the source and watch the test
  fail.

## 7. For the operator, today

Until this ships, deletion is `ledgerd purge-user`, run on the box. That is the
path the operator should use to delete and re-onboard his own account. It is
unaffected by the defect above.
