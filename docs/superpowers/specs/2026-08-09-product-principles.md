# Product principles: private, and flexible enough for real life

**Date:** 2026-08-09
**Status:** the operator's direction, recorded as standing guidance
**Applies to:** every spec in this series, and anything built after them

---

## 1. The two commitments

The operator's words:

> "Whilst I want the app to be secure and private (users' emails are not saved and
> their data is encrypted) I also want to have a great user experience and have the
> app be flexible to actually work with real life scenarios which are chaotic and
> constantly in flux. People can change banks, they can change emails, they have
> freedom and the app needs to be flexible enough to work in all scenarios."

Both halves are binding. Where they pull against each other, this document says
which way to resolve it.

## 2. One correction, so the app never claims it

**Emails are saved.** Every raw body is appended to the **cold stream** of the op
log and kept (`internal/v2/ingest/pipeline.go:884`; invariant I16 — the cold blob
carries a raw body and never an op). It is not a temporary copy and there is no
sweep that removes it.

That is deliberate, and it is the same principle ledger 1.0 runs on: **a parser
bug must never be permanent data loss.** Fix the parser, reprocess, and the
missing transactions come back. Discarding the body would trade a recoverable
error for an unrecoverable one.

What encryption changes is **who can read it**, not whether it is kept. After
Phase 3 the body is sealed to the account's key and the server holds bytes it
cannot open.

So the intended sentence is:

> **Only your devices can read your mail.**

and never "we don't keep your mail". The second is false, and a UI sentence the
code does not honour is this branch's second most repeated defect. Held mail in
quarantine is the one exception that *is* deleted — on a 30-day timer, with the
expiry announced before it happens.

### But that sentence is NOT TRUE YET, and must not ship until it is

**Sealing has not landed.** Today every stored body and every held message is
**plaintext in Postgres**, readable by anyone with operator access to the box:

- `internal/v2/blob/blob.go:63` — "Nothing here is confidential or authentic. The
  payload is readable… Phase 1 blobs are plaintext on purpose."
- `internal/v2/oplog/append.go:142` — "Phase 3 **swaps** this one field for a real
  HPKE sealer". Future tense.
- No HPKE implementation exists anywhere in `internal/v2`.

This is easy to get wrong — the author of this document got it wrong in the
sentence above before checking — because the **key machinery is built and in use**:
the recovery phrase, the account keys, passkey-PRF unlock, per-credential key
wraps. All of that is real and shipped. What is missing is the step that seals the
stored bytes with those keys.

Consequences that bind until Phase 3 lands:

1. **No screen, no marketing copy and no consent document may say the server
   cannot read the user's mail.** It can. Say what is true today: it is stored on a
   private server the operator controls, and encryption at rest is coming.
2. The alpha consent document must match this. Check `docs/alpha-consent.md`
   against reality before another invite goes out.
3. **This is the highest-priority unfinished work in the product**, ahead of every
   feature in this series, because it is the only claim that cannot be repaired
   retroactively — mail read before sealing was already readable.

## 3. Flexibility is achieved by inference and reversibility, never by weaker proof

The failure to avoid is treating "flexible" as "asks fewer questions about
security". It is not. Flexibility comes from two properties, and neither costs
anything cryptographic:

1. **Infer instead of asking.** Every fact the system can derive from evidence is
   one the user cannot get wrong. See the onboarding spec — the bank is read from
   the verified signing domain, never from a declaration.
2. **Everything is reversible and adjustable, afterwards, permanently.** No state
   is set once at onboarding and then fossilised.

## 4. The real-life scenarios, and what must happen in each

These are the cases the app must handle without a support conversation. Each is a
test the plan should write.

| Scenario | What must happen |
|---|---|
| **Adds a second bank** | the new verified domain appears by itself; one confirmation; nothing re-run |
| **Changes bank entirely** | the old bank simply stops arriving. Its history stays. No cleanup demanded, no "archive this bank" chore |
| **Bank changes its email format** | the template stops matching → heuristic tier → review, never silence. The drift monitor already exists for exactly this; the operator sees it and publishes a fix, and reprocessing backfills |
| **Bank sends from a new domain** | it arrives unverified and held, with one confirmation to accept it. Not a re-onboarding |
| **Changes mail provider** | the ledger address does not change. They make a new rule in the new mailbox. Nothing on our side moves |
| **Changes their own email address** | irrelevant to us by design — we never depended on it. Only the forwarding rule's source changes |
| **Address leaked or flooded** | rotation exists and stays hard-gated. The prompt is what is missing, not the mechanism |
| **New device** | passkey add, sync. No re-onboarding, no second inbound address |
| **Lost device** | list and remove that passkey; its sessions end with it |
| **Stops using ledger** | deletion works, in the app, and takes everything |
| **Uses no email at all** | manual entry and file import. The app is a budgeting app before a single email arrives |

## 5. The four things that genuinely cannot flex

Honesty about the rigid parts is what makes the flexible parts credible. These
four do not bend, and the app should say so plainly rather than discover it with
a user:

1. **The recovery phrase.** Encryption means the operator cannot restore access.
   There is no back door to add later, because its absence is the product.
2. **The op log is append-only.** A malformed op is permanent on every device.
   This is why op authoring is the most dangerous code in the repo.
3. **A manual forward can never be cryptographically verified.** The forwarder
   destroys the evidence. It is admitted through human review instead — which is
   flexibility bought correctly, without weakening what "verified" means.
4. **Held mail expires after 30 days.** Announced, never silent.

## 6. How to resolve the tension when it appears

When a privacy property and a usability wish conflict:

- **Never weaken a proof to save a tap.** Add a human-reviewed path instead. Lane 2
  of the mail redesign is the model: the user's own judgement is a legitimate
  basis, and it is exactly the basis manual entry already uses.
- **Never let a security rule become a dead end.** Every refusal needs a next
  action on the same screen. The onboarding lockout on 2026-08-09 was a correct
  refusal with nowhere to go, and that made it a bug.
- **Prefer an honest, plain sentence to a reassuring vague one.** "Only your
  devices can read this" beats "your data is safe", and it survives contact with
  someone who checks.
