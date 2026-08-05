# Blocked on you — v2 beta

Updated 2026-08-01. Ordered by how long the clock runs *after* you start them.

## DECIDED 2026-08-02 — read this before the sections below

- **Apple Developer Program: enrolled.** §1 is done as an action; approval may
  still take up to ~2 business days. Nothing else here waits on it now.
- **Bundle identifier: `ae.sirdab.ledger`** (changed from `com.salehtl.ledger`;
  `app/app.json` updated). Register the Apple App ID under **exactly** this, and
  bind the Google iOS OAuth client to it too. Reverse-DNS of a domain you already
  own and already run mail on.
- **Floor device: none — your daily iPhone is the only measurement device.**
  This has a consequence worth knowing: **the crypto gate can never return
  PASS.** Decision 11 forbids a PASS verdict without a floor device, so Task 1
  caps at CONDITIONAL, Gate B (the real end-to-end measurement) becomes a **hard
  stop** rather than a confirmation, and fallback **F1** (progressive
  newest-window-first restore) becomes mandatory rather than contingent.
  That is a fine outcome — it just means the architecture question stays open
  until Gate B, and F1 gets built either way. If an old iPhone turns up later,
  say so and the gate can be re-run for a real PASS.

## 1. Apple Developer Program enrolment — DONE, kept for context

Phase 2 ships an app to real alphas' phones. That needs a paid Apple Developer
account ($99/yr). Enrolment is **not instant** — individual accounts are usually
same-day but can take up to ~2 business days, and Apple sometimes asks for ID.

> **SUPERSEDED 2026-08-05: a Mac IS available.** Saleh remotes into `dinosaur`
> *from* a Mac and can run an iOS simulator. The bullets below are true of this
> Linux box and false of the operator, so the constraint they describe is gone:
> local `expo prebuild` + Xcode works, EAS Build is optional rather than the
> only path, and Task 29's two-device scenario can use a simulator as device B
> (it tests correctness, not timing).
>
> **The one thing a simulator must NOT be used for is Tasks 1 / 1b / 28.** A
> simulator executes natively on the Mac's CPU, so its crypto and fold timings
> measure a laptop, not a phone — a fast number there is worse than no number.
> Those need the real iPhone, and Decision 11's floor-device cap is unchanged.
>
> Kept below as the reasoning of record.

**There is no Mac on this box.** That is a real constraint the Phase 2 plan had
to design around, not an inconvenience:

- Expo Go (what you tested the spike on) can only run the JS layer. The moment
  Phase 2 needs **native crypto** — which is task 1, the hard gate — Expo Go
  cannot load it. A native module requires a real build.
- No Mac means no local `expo prebuild` + Xcode. The path is **EAS Build**
  (Expo's hosted macOS builders), which needs the paid account above.
- Distribution to alphas is then TestFlight, which also needs it.

So: enrol today. Until it lands, Phase 2 can build UI against plaintext but
**cannot answer the one question that decides whether the architecture works.**

## 1b. Three portal items sign-in blocks on — do these while enrolment runs

The app shell exists now (`app/`), and it builds and bundles. Three things in it
are placeholders that only you can replace, and all three are portal work rather
than code:

- ~~**The bundle identifier.**~~ **SETTLED.** `app/app.json:11` is
  `ae.sirdab.ledger`, and the explicit Apple App ID was **registered under
  exactly that on 2026-08-05** with **Sign in with Apple** and **Push
  Notifications** enabled. It cannot change now without a new App Store record.
- ~~**An Apple App ID with "Sign in with Apple"**~~ **DONE, see above.** A
  Services ID is still needed only if a web leg is ever added; the beta uses
  native Sign in with Apple (`expo-apple-authentication`), which is the
  App-Store-expected path.
- ~~**A Google Cloud OAuth client ID of type iOS.**~~ **DEFERRED past the beta,
  decided 2026-08-05. The beta is Sign in with Apple ONLY.** The client is
  iOS-only, so every beta user has an Apple ID and Apple alone covers all of
  them; Google buys no coverage and costs a portal credential plus a second
  issuer in the session and deletion contracts.

  **This costs nothing to defer and nothing to reverse.** `GOOGLE_IOS_CLIENT_ID`
  is already `null`, `googleConfig()` already returns `null`, and callers already
  branch on that **before** rendering a button — so an unconfigured build simply
  has no Google button. Nothing is stubbed, disabled or dead-coded. To turn it on
  later: register the client, then fill the id in `app/src/auth/idp.ts` and its
  reversed form as a `CFBundleURLTypes` scheme in `app.json`. A test reads
  `app.json` and fails if those two ever disagree, so a half-fill is caught here
  rather than under a user's thumb.

  Not chosen: building our own email/password auth for the beta. It would add
  credential storage, reset and verification flows, and a replacement for the
  fresh-`id_token` factor in account deletion — new attack surface in the one
  area of this codebase that has already produced two Criticals (a DoS on the
  global sign-in limiter, and an Ed25519 identity point accepted as a public
  key). Revisit when Android or a web leg makes it actually necessary.

**Sign-in itself is now built** (`app/src/auth/`, `app/src/screens/onboarding/`)
and the two placeholders above are wired so they cannot be half-filled:

- `GOOGLE_IOS_CLIENT_ID` in `app/src/auth/idp.ts` is `null`, and a test reads
  `app.json` and fails if the client ID and the `CFBundleURLTypes` scheme ever
  disagree — so filling one without the other is caught here rather than under a
  user's thumb. Fill both: the client ID there, and
  `com.googleusercontent.apps.<the first half>` as the URL scheme.
- Until then the app **renders the Google button disabled with the reason on
  it**, at first paint. Sign in with Apple is unaffected, and an
  Apple-only build is shippable — the App Store rule runs the other way (Apple
  is required *if* another provider is offered).

The **iOS deployment-target floor** (§8 below) no longer blocks this: the
Keychain class is chosen and is safe at any floor. See §8 for what would change
it.

## 2. Name the floor device

The performance gate is meaningless without one. Phase 0 measured your daily
iPhone, which the results file is explicit is an **upper bound, not the floor**
— so the 58s cold-restore figure is the *best* case, not the worst.

The spec never names an oldest supported device. Decide: what is the oldest
iPhone an alpha will hold? If you don't have one, say so — the plan branches to
CONDITIONAL and makes the later real measurement a hard stop instead.

## 3. Forward one real bank email through Gmail

Five minutes, and it de-risks the primary onboarding path.

The corpus has **zero Gmail forwards**. All 56 samples are Apple Mail, and 50 of
those recover no headers at all. Every alpha who isn't you will onboard through
Gmail, and we have never once seen what that produces.

If Gmail's forward shape breaks the normalizer rather than a template, the fix
bumps a normalizer version, which re-triggers the full-corpus equivalence gate
and invalidates every published template's `normalizer_version`. That is a
Phase-2-schedule event discovered in week one, versus a five-minute email now.

Send a DIB or ENBD transaction email from Gmail to the inbound address; I'll
take it from there.

## 4. Vultr relay VPS — still deferred, still leaving a live edge

You said keep it for later, which is fine. Recording the current state so the
decision stays visible:

`in.sirdab.ae MX 20 -> mx2.sirdab.ae` **does not resolve.** Harmless while mx1
is up. The problem is the failure mode: the moment mx1 is down — exactly when a
backup MX earns its keep — senders retry a non-resolving host rather than
failing over. So today the record is worse than having no backup MX at all.

Two options: provision the relay (D3), or **delete the MX 20 record** (D1). The
second takes a minute and strictly improves things. I'd do that now and
provision later.

Also: the relay design keeps a plaintext spool on the second host that no
database purge can reach. Account deletion cannot clean it. That needs a
decision before the relay carries real mail, not after.

## 5. Decisions the Phase 2 plan needs from you

Not blocking today, but they shape tasks:

- ~~**Invite gate.** There is none.~~ **DONE** (`f0e5979`). Account creation now
  requires a single-use invite code. You mint one with:

      ledgerd mint-invite --note "who it's for"

  It prints the code **once** on stdout and stores only its SHA-256, so it
  cannot be recovered from the database — copy it when you run it.
  `ledgerd mint-invite --show` lists outstanding codes by hash prefix. The code
  is redeemed in the same transaction as the account, single-use enforced.
  Existing accounts sign in without a code and never spend one.
- **Home currency is immutable** for the beta, with account deletion as the only
  remedy. That was the right call for snapshot integrity — confirm you're happy
  telling an alpha that.
- **Gmail's verification email is permanently quarantined by design.** The
  forwarder-domain rule holds it, so onboarding's happy path routes through the
  quarantine lane. Intended, but it means the first thing a new alpha sees is a
  held message.
- **Recovery UX.** The plan deliberately under-delivers "key UX built, crypto
  dormant" rather than ship a recovery-phrase screen that lies to the user in
  Phase 2. Agree or overrule.

## 0. ~~DECIDE FIRST~~ — **DECIDED 2026-08-05. Building the narrow guardrail.**

> Saleh: *"the app should parse the mail in the received mailbox. however it
> should have guardrails that prevent it from injection attacks."*
>
> That is the third option below. **Auto-trust DIB when the decoded text still
> contains the expected Arabic gate literal; route to review when it does not.**
> Chosen on the measurement, not on taste: all eight measured rewrites that
> actually changed the decode also destroyed that literal, so the literal is a
> direct witness of an untampered decode rather than a proxy for one.
>
> Explicitly NOT chosen: dropping `Content-Type` from `DecodingHeaders`
> wholesale (restores auto-trust but accepts the constructed attack), and
> leaving the current confirm-everything behaviour standing.
>
> The section below is kept verbatim as the reasoning of record.



This is shipped behaviour right now (`712667b`) and it changes what the app
feels like, so it should be your first call.

**The situation.** DIB's DKIM signature does not cover `Content-Type`. That
header decides how the signed body bytes are *decoded* — charset, transfer
encoding, which MIME part is the text. So an attacker who has one genuine DIB
message (any DIB customer has these) can rewrite that header, leave the
signature valid, and change what the parser reads out of bytes the bank really
signed.

**How bad is it, honestly?** Less bad than it first looked. Eight rewrites were
measured against a real DIB message: every one that actually changes the decode
also destroys the Arabic literal the template gates on, so the message falls to
heuristic or unparsed — both of which already require review. No wrong amount
was produced from a real message.

But the class is real, and it was proved by construction: a body containing
`Amount =31=30=30.00` matches a template as **900.00** under quoted-printable
and **100.00** as raw text. Bank alerts carry merchant names, and a merchant
name is something an attacker can influence by making a payment. So "no real
message does this today" is not the same as "no real message can."

**The cost of the current fix.** Because nothing distinguishes DIB's own
`Content-Type` from a rewritten one, the safe rule flags *all* of it. Six of
seven corpus fixtures lose auto-trust. Only ENBD's Proofpoint mail, which signs
both headers, stays automatic. In practice: **a DIB user confirms every
transaction by hand.**

That is a real product cost. The whole premise is that the ledger keeps itself
up to date while you get on with your day.

**Your options:**

- **Keep it safe (current).** Every DIB transaction lands in the review queue.
  Nothing wrong ever gets written silently. The app becomes a confirm-everything
  app for DIB users, which for a UAE beta is most of them.
- **Restore auto-trust for DIB.** One line — drop `"Content-Type"` from
  `DecodingHeaders`; two tests fail loudly so it can never happen by accident.
  DIB mail flows automatically again, and the constructed attack becomes
  possible for someone who can both influence a merchant string and send to your
  inbound address.
- **Something narrower**, if you want it: e.g. auto-trust DIB only when the
  decoded text still contains the expected Arabic gate literal, which is what
  actually breaks under tampering. More code, keeps most of the convenience.
  ~~I have not built this; say the word and I will.~~ **BUILT 2026-08-05** —
  `ingest.decodeWitnessed`. One caveat worth your attention: it restores
  auto-trust for DIB **card** mail only. `dib.account.v1` gates purely by
  EXCLUSION (`body_not_contains`), and an absence cannot witness a decode, so
  account and transfer alerts still need confirming. Closing that means adding
  a positive Arabic literal to a published template — a version bump plus a
  corpus-gate re-run — so it is a second decision rather than a follow-up.
  See `.superpowers/sdd/2026-08-02-v2-phase2-client/fe-dib-guardrail-report.md`.

I would not make this call for you. It trades a real, demonstrated integrity
risk against the core daily experience of the product, and which way that goes
depends on how you weigh a wrong number appearing silently versus tapping
confirm several times a day.

## 5b. Time-limited: the dictionary HMAC key is rotatable *right now*

Small, but the window closes on its own.

`LEDGER_DICT_HMAC_KEY` keys the merchant-dictionary submitter hashes. Rotating
it once real submissions exist would defeat both k-anonymity and erasure — a
user could be counted as three distinct submitters across key generations, and
`ForgetSubmitter` would delete nothing while reporting success. The server
therefore **refuses to start** if the key changes while `dict_submissions` has
rows.

Right now that table is empty, because `dict.Submit` has no route yet. So the
key can be changed for free today. The moment a submission endpoint ships in
Phase 2, it is fixed for the life of the deployment.

If the current value was generated casually — pasted from a scratch buffer,
reused, or shorter than 32 bytes — regenerate it now. Otherwise ignore this;
it just needs to be a deliberate choice rather than a default nobody revisited.

## 6. The Phase 3 cutover promise — decide before alphas sign anything

This one surfaced from the Phase 2 plan review and is a genuine call, not a
detail.

The beta stores real bank mail in **plaintext** (Phase 1 and 2 by design; Phase 3
adds at-rest crypto). When Phase 3 lands, every alpha's existing plaintext
history has to go somewhere. The Phase 2 plan writes onboarding copy that refers
to "the migrate-or-delete commitment", "the retention limit", and "the alpha
consent document" as though all three were settled.

None of them are. **The consent document does not exist and no task writes it.**

Decide: when Phase 3 ships, does an alpha's existing history get **migrated**
into the sealed format, or **wiped** with a fresh start? Migration means writing
a re-sealing path and keeping the plaintext readable until it runs. Wiping is
trivial to build and means telling people up front that the beta's data is
disposable.

It has to be decided before onboarding copy is written, because the copy is the
promise — and it's the sort of promise that's very hard to walk back once a real
person has three months of their finances in the app.

## 7. The `enc`-slot gap — a Phase 3 problem visible now

Surfaced while revising the Phase 2 plan, and it's the one genuinely
architectural item on this list.

The blob envelope is described in the spec as **frozen**: a fixed frame with
reserved slots for the nonce and auth tag. Phase 3 seals blobs with HPKE, which
needs a **32-byte encapsulated key** per blob. The frozen frame has nowhere to
put it.

Two ways out, and they're not equivalent:

- **Bump the envelope version** (the plan currently assumes this — version 2 =
  the shipped frame plus a 32-byte `enc`). Honest and simple, but it means the
  frame was never actually frozen, and anything already written under version 1
  needs a migration path.
- **Use a per-user static ephemeral** so the `enc` doesn't travel per blob.
  Keeps the frame, but it's a real cryptographic design change with forward-
  secrecy consequences that need thinking through, not improvising.

Not urgent — Phase 3 is two phases out. But the choice affects what Phase 2's
benchmark corpus should look like, which is task 1, so it wants deciding
early rather than late.

## 8. Smaller Phase 2 decisions

- **Quarantine sheet copy.** A message held because no forwarder attestation is
  possible currently gets the same confirm button as everything else — and that
  button will always refuse. It should say "no verified signature" and explain
  why, rather than offering an action that cannot succeed. Phase 2 UI work.
- **`pobox.com`** is the strongest remaining candidate for the trusted-sealer
  set (named an ARC adopter by the measurement paper, and a pure forwarding
  service, so it is exactly the shape that needs attestation). Its sealing
  domain is unverified, so it was not added. If an alpha uses it, say so and it
  can be evidenced properly.

- **iOS deployment-target floor** — separate from "which iPhone". It governs
  the Keychain constants and the bundle that first-paint gets measured against.
  **No longer blocking sign-in.** Task 13 picked `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
  for the session token and the device identity key, and that choice is safe at
  any plausible floor (the constant has existed since iOS 4). It is still your
  call for the bundle-size measurement, and there is one thing it would change:
  if background sync while the phone is locked is ever wanted, the *session
  token* — never the identity key — would move to
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Nothing in Phase 2 needs that, because
  push is content-free and the user unlocks the phone to open the app.
- **Are export and account deletion in scope for the beta?** §5's exit clause
  names neither, and the exit test won't catch their absence. If an alpha should
  be able to get their data out, that needs saying now.
- **Heuristic-tier reprocessing** — accept template-tier-only reprocessing, or
  fund the dialect port. The cheap answer is fine; it just shouldn't be silent.
- **Home currency** now has two costed designs rather than accept-or-don't. The
  recommendation is "mutable until the first snapshot freezes" — you can change
  it during onboarding, and it locks the moment real numbers depend on it.

## Not blocked on you

Phase 1's build phase is closed — 38/38 tasks, exit test green. Critics are
still running against the finished work and finding real defects; fixes land as
they come. Nothing there needs you.
