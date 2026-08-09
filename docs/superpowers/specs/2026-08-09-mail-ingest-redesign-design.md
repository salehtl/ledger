# Mail as a transaction source — redesign

**Date:** 2026-08-09
**Status:** approved by the operator, ready for a plan
**Depends on:** `2026-08-09-account-isolation-design.md` — lanes 2 and 3 are gated on its P1

---

## 1. Why this exists

Three failures, all measured on the live box on 2026-08-09.

**Manual forwards are a permanent dead end.** The Gmail forward button creates a
new message from the user. The bank's DKIM breaks and no ARC seal is added, so the
message resolves as `outer=gmail.com, inner=null, attested=false, dkim=pass,
arc=none`. `Decide` refuses it, because a forwarder is never trustable as an outer
origin (`internal/v2/origin/trust.go:153-159`). The client then refuses to let the
user confirm it, because `trustBasis` requires `attested`
(`web/src/v2/onboardingIO.ts:410-421`) and `trustRequest` returns `null` without
it. **52 such messages sit in the operator's quarantine right now** — 50 via
`gmail.com` and 2 via `icloud.com`, the same dead end through a different
forwarder. They can never become transactions and expire on the 30-day TTL,
around **6 September 2026**.

**Direct bank mail cannot clear onboarding verification.** A DKIM-passing email
straight from a bank has a verified outer domain but `attested=false`, because
attestation describes an *inner* origin and there is no relay to see behind.

**The quota is silent, and it blocked onboarding.** `DefaultPerAddressDaily = 50`
over a rolling, decaying 24-hour window (`internal/v2/smtpd/limiter.go:35-39,
423-436`), enforced at `RCPT`, refused `452`. The limiter is in memory, so a
restart clears it. Measured: about **50 forwards accepted across three days**
(2026-08-07 to 2026-08-09) and **156 refusals recorded for 2026-08-09 alone**.
Google's forwarding-confirmation mail never arrived.

> **Stated honestly:** that the confirmation was refused *cannot be proven*.
> `smtp_rejections` is a `(day, reason, count)` aggregate with no user and no
> sender (`internal/v2/diag/diag.go:485-487`), and the limiter's memory died at the
> last restart. The fact that it cannot be proven is itself one of the defects.

### The root cause

**The trust model measures transport provenance, and the product's primary user
action destroys transport provenance.** `Decide` is careful, correct code. But the
only evidence it accepts — the bank's DKIM surviving to our server, or an ARC chain
sealed entirely by four blessed domains — is exactly what a manual forward
destroys. The system is cryptographically sound and pointed away from its users.

There is a second half. **The app already ships a third trust basis and refuses to
apply it to mail.** Manual entry exists, is modelled, and appends a `txn_ingested`
op on *no* cryptographic evidence, marked "Added by you". So the app will let a
user retype the numbers from a forwarded email by hand, but not confirm the same
email. That protects nothing. It converts evidence into friction.

### A defect, not a design choice

The server **will** trust a signature-verified outer domain: `Decide`'s outer path
needs only `DKIM==pass || ARC==pass` plus a non-forwarder domain
(`trust.go:140-167`). But the client cannot create that allowlist row, because
`trustBasis` demands `attested`, which is only ever set when a relay is visible
(`internal/v2/origin/inner.go:318-320`).

**The outer trust path has no door in the user interface.**

> **Do not confuse this with the inner path, which works today.** Measured on the
> live box: one iCloud rule auto-forward went arrival → attested → user-confirmed
> at **inner** scope → reprocess → appended, on 2026-08-07. `sender_allowlist`
> holds exactly one row, `dib.ae | inner`, and `quarantine_removals` records the
> promotion. The inner door exists and has been used.
>
> The outer repair therefore serves a **different population**: users whose
> forwarder we do not trust as a sealer — Proton, Yahoo, a corporate server — where
> `relayDomain` is empty, nothing attests, and `Outer` becomes the **bank itself**.
> Both are worth having. They are not the same thing, and the rest of this document
> keeps them apart.

---

## 2. The design: three lanes, not two

The third lane is not new trust. It is the trust the app already grants to typing.

| Lane | Path | Who verifies | Auto-append |
|---|---|---|---|
| 1. Verified | mailbox rule auto-forwards; bank DKIM survives | cryptography | yes |
| 1b. Verified (outer) | a forwarder we do not seal-trust; the bank is the outer domain | cryptography | yes |
| 2. Reviewed | any held message the model cannot verify | the human | no |
| 3. Bulk | a file the user exports from their bank | the human | no |

### Lane 1 — repair the door

Fix `trustBasis` / `trustRequest` so a held item is confirmable at the **outer**
scope when it has `dkim=pass` or `arc=pass`, an outer domain without the
`unverified:` prefix, and an outer domain that is not a forwarder — mirroring
exactly what `Decide` already honours.

**The confirm endpoint must apply the same signature-evidence checks the server
applies** (`trust.go:146-152`). It must never trust the client's spelling of a
verdict.

**What is actually being changed, so the implementer does not merely add a client
check:** `Confirm`'s outer-scope predicate today is spelling-based — the match is
`outer_domain = $2` with **no dkim or arc verdict in the WHERE**
(`internal/v2/quarantine/quarantine.go:822-829`), and the `unverified:` prefix is
the only shield. That is exactly the "verified as a property of how the value was
spelled" failure `Decide` refuses for itself (`trust.go:77-86`). The work is to add
the signature-verdict columns to that predicate, mirroring `Decide`.

The recommended setup becomes **a rule in the user's own mailbox**, never a change
at the bank. The user keeps their own alerts and one-time codes. All copy
suggesting a bank-side address change is removed — the operator has deprecated
that route.

**Lane 1 ships first, and its isolation claim is conditional.** Trusted mail
appends one hot op and one cold raw body through the server's **ingest** writer,
which never passes through `handleUpload`. So lane 1 is only unbudgeted-safe once
the isolation spec's P0 ceiling sits **inside the append path** (`appendTx`),
covering `AppendIngest` as well as `AppendClient`.

With that in place, lane 1's growth is bounded by the mail quota — at most about
50 MB of permanent op-log bytes per account per day (quota × the 1 MB blob cap).
**Caveat to state plainly:** that bound rests on the SMTP limiter, which is in
memory and resets on restart, until the persisted counters land.

Without the in-append ceiling, lane 1 must be re-gated behind it: an insider can
DKIM-sign mail from a domain they own, confirm it at the outer scope, and write
permanent bytes with nothing counting them.

### Lane 2 — a held message becomes a prefilled entry

A held message the model cannot verify gains one action: add its transactions
yourself.

1. The client fetches the raw blob. The endpoint exists:
   `?include_blob=1` (`internal/v2/api/quarantine.go:24,286`).
2. The client parses it **locally**, with the TypeScript normalizer and template
   executor that already exist and are conformance-locked to their Go twins
   (`client/src/norm`, `client/src/tmpl`).
3. The user sees a prefilled form, confirms or edits it, and the client authors the
   op — exactly as manual entry does, marked as user-reviewed.
4. It **never** writes `sender_allowlist`. `Decide` is untouched. The
   forwarder-never-outer rule stands.

**Why this does not hole the trust model.** The invariant the pipeline defends is
that trust is decided before attacker-controlled content is parsed, because parsing
first was choosing which bank to **automatically** credit. In this lane no machine
believes anything: the parse output is a form prefill, the human is the verifier,
and the resulting op carries exactly the authority typing carries. The trust model
governs what may be believed *without a human*. This lane never crosses that line.

**A promise this lane must not make.** There is **no heuristic port on the
TypeScript side** — `client/src` has `norm` and `tmpl` and no heuristic. So a
forward from a bank with no published template prefills **nothing** and degrades to
plain manual entry with the raw text shown. That is acceptable, but the UI must not
advertise autofill it cannot deliver.

**No screen has ever rendered a held message body.** Lane 2 builds that rendering
from scratch. It must render as React text children — never as markup.

### Lane 3 — bulk import from a file

**The import library already exists and nothing uses it.** `client/src/importer/`
has RFC-4180 CSV parsing, column mapping, exact integer minor-unit money, direction
modes, category mapping and cross-language conformance vectors. No screen in
`web/src` consumes it, and `ledgerd` has no import subcommand.

Lane 3 is a UI over that library. Parsing happens in the browser. Ops are authored
by the client and sealed like any other. The server never sees a row. Dedup rides
the client fingerprint index the pipeline already relies on.

Requirements specific to this lane, because a malformed op is permanent on every
device forever:

- **Full validation and a preview before a single op is authored.**
- A per-batch cap on op count.
- The source file's hash and the row index recorded in the op payload, so an
  imported row has an audit trail.
- Per-bank column presets, so most users never see a mapping screen.

**Lane 3 must not ship before the isolation ledger and admission gate exist.** It
is the feature that makes "author many ops quickly" legitimate, so shipping it
against an unbudgeted append path would hand an insider a sanctioned tool.

---

### The op shape for lanes 2 and 3 — not negotiable

Both lanes author ops, and **the wrong choice here is permanent on every device
the user owns.** So it is fixed here rather than left to an implementer.

- **Reuse the existing `txn_ingested` op.** Do not mint `txn_reviewed`,
  `txn_imported`, or any new type.
- **`SCHEMA_VERSION` stays 3.**
- Provenance travels as **optional payload keys**: `entry_method` gains the values
  `reviewed_forward` and `import`, and lane 3 adds the source file hash and the row
  index. Optional keys need no version bump.
- **Replay must never read `entry_method` for authority.** Replay derives
  provenance from the **writer**, never from the payload
  (`client/src/replay/replay.ts:1490-1499`). `entry_method` is a label for the
  user interface and nothing else — an enum nobody validates.

**Why this is a hard rule.** A new op type costs `SCHEMA_VERSION` 4, and a version
3 device meeting a version 4 op raises `UnknownNewerVersionError`, which halts
**that device's entire sync** — not one op. The safe pattern is already recorded in
the codebase, where `entry_method` was introduced for manual entry precisely as an
added optional key needing no bump
(`web/src/v2/sources/transactions.ts:630-641`).

## 3. The quota

The earlier proposal in this conversation — a small "setup reserve" that let a
provider's confirmation mail bypass the quota — **is rejected, and the reason
generalises**: any protected allowance addressed by *claimed* sender data can be
burned by whoever forges that claim. The reserve would have been a cheap denial of
exactly the message it existed to protect. **No reserves. No sender-keyed
carve-outs.**

The confirmation mail survives by **headroom**, not by classification:

- Refusal stays at `RCPT`, stays `452`, stays content-free.
- Raise the ceiling and change its unit: meter **bytes accepted into quarantine per
  account** alongside a higher message count (about 200 per day). The old 50 was
  calibrated for a world with no bulk-forwarding humans in it.
- **Persist the counters.** An in-memory limiter that a restart resets is both too
  forgiving to an attacker and unexplainable to a user.
- **Account for every refusal per account** — `(user_id, day, reason, count)`,
  counts only. Surface it in the app: "N messages were turned away today."

The cumulative quarantine budget from the isolation spec is what makes the raised
daily flow safe. A raised per-day tap with no total is not a limit.

**Copy must be honest.** A `452` is temporary and senders usually retry for a few
days — but not forever, and then they bounce to the sender. The app must say
"senders usually retry for a few days", never "nothing was lost".

**When refusals are high, the app should offer address rotation.** Rotation exists
and is gated hard. What is missing is the prompt: nothing tells a user that a flood
is the moment to rotate.

---

## 4. What was considered and not chosen

**Client-side mailbox ingest** (the PWA reads Gmail or Graph over OAuth) is the
only design that makes the server blind *in transit* as well as at rest, and it
deletes the most onboarding friction. It was not chosen as the primary path
because: iCloud has no mail REST API and the operator's own mailbox is iCloud; a
browser cannot speak IMAP, and proxying IMAP through the server reintroduces
server plaintext with worse credentials; `gmail.readonly` needs Google verification
plus an annual security assessment; and a PWA can only fetch while it is open, so
live alerts would regress to "caught up when you open the app".

It remains available later as an **additive** fast path for Gmail users. It would
author the same client-side ops lanes 2 and 3 author. Nothing here forecloses it.

---

## 5. Migration

- **The 52 held messages.** Ship lane 2 before the TTL bites around 6 September
  2026. If it will not land in time, extend `expires_at` on the existing rows once,
  out of band. That is justified: the promise that nothing is dropped predates the
  tool that honours it.
- **Allowlist and quarantine models are unchanged.** Lane 2 never writes
  `sender_allowlist`. The only trust-code change is client-side, plus the confirm
  endpoint's server-side evidence check.
- **Quota:** persisted counters and the per-account refusal aggregate arrive with
  the isolation spec's tables rather than as separate mechanisms. The existing
  `smtp_rejections` day aggregate stays, for fleet-level monitoring.
### Deprecating the bank-side address, without deleting it

The operator's words: using the ledger address as a bank's official email "is very
dumb as it prevents them from managing their bank account". It also takes the
user's security alerts and one-time codes with it.

**Sunset it, do not delete it.** The standing rule in this project is that a
superseded feature goes behind a disabled flag, not into the bin, and the operator
decides how and whether it returns.

So:

- The "I have set this address with my bank" route in
  `web/src/screens/onboarding/Address.tsx` is **disabled by default** behind a
  flag, not deleted. Its code, tests and copy stay.
- Onboarding stops offering it. The forwarding rule becomes the only presented
  path, and it is no longer phrased as the alternative to something better.
- The `Notice` that admits the route's own failure ("some banks keep only one
  alert address") is retained with the disabled route, since it is the record of
  why the route was retired.
- No existing user is migrated or interrupted. A user whose bank already sends
  direct keeps working: that mail still verifies on the **outer** scope, which
  lane 1's repaired door now lets them confirm.

---

## 6. Abuse analysis

**Lane 2 is the new surface, and the attack is social, not technical.** An attacker
who learns an address sends convincing fake bank mail. It cannot reach lane 1: no
verifiable origin, forwarder-as-outer refused, and envelope claims carry the
`unverified:` prefix which is not a hostname and can never match an allowlist row.
So it lands in quarantine and invites the user to confirm a fake debit.

What contains it:

- The review screen shows **trust facts, not letterhead**: "Unverified. Claims to
  be from `x`. Nothing checked this." Plain and short.
- Confirming pollutes only the user's own ledger. No money moves. The blast radius
  is self-deception, which is already true of manual entry.
- Address rotation evicts an attacker who has the address.
- The byte and count budgets bound the flood.

**Flooding the review lane.** Junk fills quarantine and buries the real forward.
The quarantine budget bounds it, the UI must sort verified-confirmable items above
unverified ones, and rotation is the recovery. **Evict-oldest-under-pressure was
considered and rejected** — an attacker flooding would then evict the user's
genuine forwards, which is attacker-triggered loss. Refusal at the door with a
visible per-account count is the honest failure mode.

**Outer-scope confirmation as a lure.** An attacker sends DKIM-valid mail from
`enbd-alerts-secure.com`. It is genuinely verified, and lane 1's repaired door now
offers to trust it. If the user confirms, future mail from that domain
auto-appends — but only through the parse tiers, and templates run for the verified
domain only, so no published template matches and everything lands in the heuristic
tier, which is never auto-trusted. Damage is bounded to review-queue noise plus an
allowlist row the user can revoke. **The confirm screen must render the exact
domain with no prettifying**, and should flag a domain that matches no published
template.

**Import.** The adversary is a buggy file, and permanence makes that severe. The
validation, preview, batch cap and source hash in §2 are the answer.

---

## 7. Testing

- **Prove every test bites.** Mutate, watch it fail, revert. Report which and how.
- Lane 1: the confirm endpoint refuses a client-asserted verdict that the signature
  results do not support. Invert the check and watch the test fail.
- Lane 1: a forwarder outer domain is still refused, at both client and server.
- Lane 2: an op authored from a review carries the user-reviewed marker and writes
  no allowlist row.
- Lane 2: a message with no matching template prefills nothing and says so.
- Lane 2: rendering a hostile body injects no markup.
- Lane 3: a malformed file authors **zero** ops. This is the one that matters most.
- Quota: refusal counts are attributed to the right account and survive a restart.
- Copy: every promise the UI makes is honoured by the code. This branch has
  produced a false UI sentence in every review round.

**The harness gap must be closed for the screens this touches.**
`web/harness/` was forked with the tree and most of it still drives v1, so a naive
run goes green against code that was never loaded. `web/harness/v2settings.mjs` is
the only runner that reaches the v2 product. Lanes 2 and 3 need equivalent runners,
and `v2stack.sh` must pass `--dns-fixtures` or every message a harness posts is
`unauthenticated`.

## 8. Open questions

- **CLOSED, against evidence rather than a new sample (2026-08-09).** The premise
  that a mailbox rule auto-forward preserves the bank's DKIM is **proven for
  iCloud**: 174 of 174 `X-Apple-Action: FORWARD` messages in the v1 corpus arrived
  with the bank's DKIM passing and aligned, iCloud's own ARC seal is trusted, and
  one such message completed the whole lane on the live box on 2026-08-07. The
  `v2-arc-spike` independently verified 140 of these chains against live DNS with a
  body-flip negative control that fails all 140.

- **STILL OPEN, and scoped to Gmail.** There has never been a Gmail auto-forward
  sample here — zero messages in the corpus carry `X-Forwarded-To`. Gmail seals
  (1,024 corpus messages carry a `google.com` ARC seal, all verifying), and both
  attestation paths should be available to it, but **nobody has run a Gmail rule
  forward through this code.** The alpha onboards through exactly that path.
  **Run the two-step experiment before the Gmail onboarding step of the build:**
  add a Gmail filter `from:dib.ae` forwarding to the ledger address, read the
  confirmation code out of the held message, then check the newest quarantine row
  for `attested=t, inner_domain=dib.ae`.

- **A real fragility, either provider.** `relayDomain` needs instance-1's AAR to
  report a passing bank DKIM. ENBD mail via its Microsoft gateway seals
  `microsoft.com` with `dkim=none`, so an auto-forward of that path proves no relay
  and attests nothing. It is not lost: `Outer` becomes `emiratesnbd.com`, the bank,
  confirmable at the **outer** scope — which is lane 1b above.
- Whether the client can decrypt and render a quarantine blob end-to-end is
  unproven. The endpoint exists and blobs are plaintext-sealed today, but no screen
  consumes `include_blob=1`.
- Per-bank import presets need a real bank CSV to size. The operator has v1's
  importer and real statements.
