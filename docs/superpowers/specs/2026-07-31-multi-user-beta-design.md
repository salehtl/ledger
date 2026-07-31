# Multi-user closed beta — v2 architecture design

**Date:** 2026-07-31
**Status:** Approved design, pre-implementation
**Supersedes:** the single-user architecture in `budgeting-app-build-plan.md` for the v2 track. The single-user instance keeps running from `main` untouched until migration (see Rollout).

## 1. Goals, in priority order

1. **Privacy & security.** Users own their data. A server breach must yield data that is as worthless as possible to the attacker. Claims must be honest and technically precise — no marketing overreach.
2. **Minimal operational cost.** No unnecessary compute. Procedural, deterministic solutions over AI. One VPS for the foreseeable future; a dedicated cheap DB host only when scale demands it.
3. **Performance.** The app must feel instant. Structural speed (local-first) over optimization.

Non-goals for the beta: AI anywhere in the pipeline, Android, banks beyond the templated set, public availability.

## 2. Honest threat model (adopted verbatim into the privacy page)

**The claim is "encrypted at rest with a plaintext ingest window" — not "zero-access", not "we can't see it."**

- Transaction emails necessarily arrive at the server in plaintext (SMTP). They are parsed **in memory** and encrypted to the user's key at the moment of arrival; only ciphertext touches disk.
- A stolen disk, stolen backup, seized server, or subpoena of stored data yields: ciphertext blobs, blob timestamps/size-buckets, pseudonymous sign-in identifiers, inbound-address tokens. No amounts, no merchants, no raw email.
- A **live, actively compromised server** could log plaintext of *future* mail as it arrives. This is the same residual trust Proton Mail carries for external mail, and we state it plainly.
- Sign-in identifiers are pseudonymous at best (hashed, but low-entropy and enumerable; Google additionally holds the `u-xxx ↔ identity` mapping because the user configures forwarding inside Gmail). Assume a breach reveals *who* the users are; the protection is over *what they spent*.
- Metadata mitigations (required, not optional): blob padding to size buckets (4/16/64 KB), jittered batch upload timing, full-table FX distribution (never per-pair queries).

## 3. Architecture: blind mail-slot server, local-first client

Still one Go binary on one VPS, plus Postgres. The server's job shrinks to: receive, parse-in-memory, encrypt, append, notify. The client (Expo app) holds decrypted data in local SQLite and does **all** budget math, insights, filtering, review-queue, and categorization on-device. Every screen reads local data → instant UI, offline-capable; sync is background reconciliation, never a spinner.

### 3.1 Server surfaces

| Surface | Port / binding | Purpose |
|---|---|---|
| SMTP receiver | :25 public (MX on `in.<domain>`) | Inbound bank mail per user |
| HTTPS API | :443 public, autocert | Auth, sync, template distribution, FX, push registration |
| Admin console | Tailscale-bound only | Template authoring/publishing, donated-sample queue, diagnostics, waitlist |
| Postgres | localhost only | All server state |

Exposing :443/:25 publicly is a deliberate posture change from the Tailscale-only single-user system; admin stays tailnet-only.

### 3.2 Ingestion (SMTP, self-hosted)

- Each user gets a unique inbound address `u-<token>@in.<domain>`. **Token: ≥128-bit (26-char base32), rotatable in-app.**
- Users either point their bank's alert email directly at it, or set an auto-forward rule in their mailbox. Gmail's forward-verification email arrives at our server; the confirmation link is surfaced in-app during onboarding.
- Receiver: `emersion/go-smtp`. Unknown RCPT rejected at RCPT time **with per-IP invalid-RCPT rate-limiting and tarpit delays** (rejection is an enumeration oracle otherwise). DATA capped at 1 MB. Per-address rate limit ~50 msgs/day (bank alerts are single digits/day; excess is an attack).
- **Spoofing defense** (the inbound address is otherwise an unauthenticated write endpoint into a financial ledger, and Gmail forwarding breaks SPF by design): each address learns an allowlist of envelope-from + forwarder signature observed during onboarding verification. Mail from unlisted origins is still accepted and encrypted, but flagged `untrusted_origin`; the **client** renders these in a quarantine lane, since the server cannot judge content.
- Processing: deterministic cascade only (published templates → heuristic). No AI tier. Parsed transaction + raw body are compressed (**compress-then-encrypt**; ciphertext is incompressible), encrypted to the user's key, appended to the op log, plaintext discarded. Unparseable mail: same treatment, `unparsed` flag (a flag is all the server knows).
- **Availability:** sender MTAs retry for ~1–3 days, then bounce — and Gmail auto-disables forwarding rules after sustained failures, silently and (to us) invisibly. Mitigations: (a) **backup MX** on a second cheap VPS doing store-and-forward — non-negotiable; (b) client-side watchdog: the client alerts on "no mail in N days vs. your own baseline" — only the client knows what normal looks like.
- **Precondition (Phase 0):** confirm the VPS provider permits inbound port 25 before any of this is built. If not, fall back to a managed inbound relay and re-open the privacy section.

### 3.3 Data model: per-user op log with event sourcing (not LWW)

Record-level last-write-wins breaks this schema's invariants (splits must sum to parent; fingerprint-dedup is currently server-enforced), silently and unrepairably under E2E. Instead:

- The per-user sync log is an **append-only op log**: immutable, encrypted operations (`txn_ingested`, `txn_categorized`, `txn_split`, `txn_edited`, `rule_added`, …), totally ordered by server-assigned sequence number.
- Clients replay ops deterministically to materialize local SQLite state, then run an **invariant checker** (split sums, fingerprint uniqueness, envelope-assignment uniqueness). Dedup by fingerprint is a replay-time rule.
- **Hot/cold split** — structural, from day one:
  - *Hot stream:* parsed-transaction ops (~200 bytes each). A full 3-year history is <1 MB → cold start and reinstall sync in seconds; rich push decrypts one hot blob.
  - *Cold stream:* raw email bodies (~25 MB/user/year, measured). Synced lazily/on-demand; clients keep a rolling window (e.g. 90 days) hot locally. Client-side reprocessing pulls the cold ranges it needs.
- **Hash-chained blobs:** op *N* embeds the hash of op *N−1*. Clients verify the chain every sync and report gaps/breaks by sequence number. This is the only way to verify backups of ciphertext we cannot read, and the only tamper/reorder detection in the system.

Postgres tables (server side): `users`, `sessions`, `inbound_addresses`, `op_log (user_id, seq, stream, type_flag, ciphertext, size_bucket, created_at)`, `templates`, `donated_samples`, `parse_diagnostics`, `waitlist`, `push_tokens`, `fx_rates`.

### 3.4 Cryptography

- **Envelope encryption.** One per-user data key (DEK, AES-256-GCM) encrypts all blobs. The DEK is wrapped three ways: (1) device keypair in iOS Keychain (iCloud-Keychain-synced), (2) Argon2id-derived key from a user passphrase — the wrapped blob is stored server-side, opaque to us, enabling recovery on any device, (3) an exportable recovery phrase. Key rotation = re-wrapping one small key, never re-encrypting history.
- **Key substitution defense.** Device public keys are TOFU-pinned by clients, and the server maintains an append-only, client-verified key-history log per user. A silent server-side key swap at second-device enrollment is thereby *detectable* (it cannot be made impossible with a single operator; we say so).
- GCM with per-blob random nonces; AAD binds `(user_id, stream, seq)` so blobs cannot be replayed across positions or users.
- Key loss with all three wraps lost = history loss. Stated honestly; softened only partially by re-forwarding from the user's own mailbox (Gmail has no bulk-forward — this is not a real recovery path and is not marketed as one).
- E2E claim boundary: see §2. The design keeps the door open to reducing the ingest window later (e.g. bank-direct addresses skip forwarding metadata) but does not promise it.

### 3.5 Templates as data + intake pipeline

Bank support at launch: **DIB (Arabic) and ENBD (English)** — the two existing, corpus-validated parsers — ported into the template store. Growth is via intake, not AI.

- **Store:** `templates(bank, sender_pattern, version, definition, status: draft→testing→published)`. The definition is a deliberately simple declarative format: label anchors + regexes + typed fields (amount, direction, merchant, date, currency, locale). Simplicity is a requirement, because **two executors** implement it: Go (server, at ingest) and TypeScript (client, for local reprocessing). A shared conformance fixture suite runs against both in CI; disagreement fails the build.
- **Seed validation:** ported DIB/ENBD templates must reproduce the existing parsers' output over the full 3-year corpus before Phase 1 ships.
- **Intake flow:**
  1. Onboarding asks the user's bank. Supported → proceed. Unsupported → waitlist + invitation to donate one sample email *during setup* ("we need one example to learn your bank"), with a client-side redaction preview showing exactly what will be sent. Consent at setup converts; consent at the moment of failure does not.
  2. In operation, unparsed mail lands in the client review queue with per-email "donate". By default the client reports a **content-free structural fingerprint** (`structure_sig`: tag skeleton, label positions, zero values) so the admin console clusters demand ("14 users hitting an untemplated FAB credit-card format") without seeing content.
  3. Admin console: donated samples queue → author template → validation replays it over every donated sample for that sender → publish bumps the store version.
  4. Clients pull new template versions and **reprocess locally** over their decrypted cold-stream bodies; recovered transactions append to the op log. "Fix the parser, backfill" survives E2E at zero server compute.
- **Diagnostics (deliberate, bounded privacy concession):** per ingest the server stores *non-content* facts unencrypted: template ID attempted, matched/not, which named capture groups were empty, body size bucket, sender domain, parser version. This turns "unparsed, cause unknown" into a fixable bug report. Sender domain ≈ the user's bank, which mail routing and blob-size clustering reveal anyway; accepted and disclosed.
- Known fragility, accepted with eyes open: existing templates are newline-anchored regex over HTML-stripped text; Gmail forwarding re-flows HTML and applies quoted-printable wraps. Phase 1 runs *unencrypted with friendly alphas* precisely to catch this with full visibility.

### 3.6 Categorization (no LLM)

- Global anonymous merchant→category dictionary: seeded from the operator's existing rules, grown from **opt-in** confirmations (a bare merchant pattern, never user-linked). Distributed to clients like templates.
- Per-user override rules live client-side and sync as encrypted ops. Rule matching runs on-device.

### 3.7 Currency & FX

- Every transaction stores original currency + amount in that currency's minor units (`int64`). Each user picks a home currency at onboarding; budget math converts on-device.
- Server fetches daily rates **once** (one upstream call/day total) and serves the **entire** table to every client — never per-pair queries (a per-pair fetch is a travel-history side channel). Historical table ships as a compact cached binary (~170 currencies × days; a couple MB once, few hundred bytes/day incremental) so past months recompute correctly.
- Unknown-rate transactions surface in the client review queue rather than silently distorting budgets.

### 3.8 Auth, sessions, push

- Sign in with Apple + Google Sign-In (identity only, non-sensitive scopes — no OAuth verification/CASA exposure) via `expo-auth-session`. App Store rule: offering Google obligates Apple sign-in; both ship.
- Backend verifies identity tokens, issues **opaque server-side session tokens** (revocable; no JWT machinery). Passwords never exist.
- Push: Expo push service, **content-free** ("New transaction") for the beta. Rich decrypted notifications later via an iOS Notification Service Extension — costed honestly: leaves Expo Go (config-plugin prebuild), separate process with ~24 MB ceiling, requires a **second crypto implementation in native Swift** sharing a Keychain access group, kept bit-compatible with the JS one and pointed only at hot-stream blobs (~200 bytes to decrypt).

### 3.9 Client (Expo, iOS-first)

- Expo / React Native, iOS TestFlight for the beta; Android later. Reuses the framework-free `lib/` logic (money, filtering, gesture predicates) and API types; screens/components are a rewrite (Reanimated, RN primitives).
- Local SQLite is the source of truth for the UI; op-log replay materializes it; crypto via a JSI-native module (never bridge/base64 marshalling — measured as a cold-start killer).
- Review queue, quarantine lane (`untrusted_origin`), donation flow with redaction preview, forwarding-setup onboarding with in-app Gmail verification link, key backup UX (passphrase + recovery phrase).

## 4. Acknowledged trade-offs (accepted, not hidden)

1. **Privacy vs. cost:** E2E forbids cross-user dedup/compression of near-identical bank HTML (~an order of magnitude of storage at scale). Accepted; mitigated by compress-then-encrypt and hot/cold split.
2. **Privacy vs. performance:** cold-start cost of encrypted history. Mitigated structurally (hot stream <1 MB); full raw-body hydration remains a lazy, background concern.
3. **Privacy vs. supportability:** we cannot read the inputs to a failing parser. Mitigated by non-content diagnostics, structural fingerprints, consent-gated donation, and an unencrypted alpha phase to stabilize templates first.
4. **Bank coverage is a human bottleneck** (hand-written templates per bank per alert type). Accepted via narrow launch scope + intake pipeline + waitlist. AI re-enters, if ever, as consent-gated/user-initiated — never the always-on server path.
5. **Single-operator key infrastructure:** silent key substitution is made detectable (TOFU + key-history log), not impossible. Stated in the privacy page.

## 5. Rollout

- **Phase 0 — kill-risks week.** (a) Confirm inbound port 25 with the VPS provider — gates §3.2. (b) Spike local-first: on-device SQLite + budget-math replay over the real 3,682-transaction corpus on the oldest target iPhone; measure cold start. Failure here kills the architecture in a week instead of a quarter.
- **Phase 1 — backend v2, plaintext.** Postgres, auth, hardened SMTP receiver, op-log sync (hot/cold, hash-chained), template store + conformance suite + diagnostics, backup MX. 3–5 friendly alpha users, **unencrypted**, known banks, full parser visibility while Gmail-forwarding fidelity is proven.
- **Phase 2 — Expo app.** Local-first client, replay + invariant checker, review queue, onboarding, key UX built but crypto dormant.
- **Phase 3 — crypto on.** Envelope encryption, DEK wraps, TOFU key history, padding, jittered upload. Content-free push.
- **Phase 4 — closed beta.** TestFlight, honest privacy page (§2). NSE rich push and Android post-beta.
- **Migration:** the operator's own instance migrates onto v2 as user #1 (SQLite → op-log import via the existing `importer` patterns); the single-user path retires afterward.

Development happens in this repo on a long-lived v2 branch/worktree; `main` keeps serving the running single-user instance until migration.

## 6. Open questions (tracked, non-blocking)

- Domain choice for `in.<domain>` and app API.
- FX rate source (needs: free tier, daily, ~170 currencies).
- Backup-MX host/provider.
- Template definition format details (to be designed in the Phase 1 plan alongside the conformance suite).
- Whether Phase 1 alphas run on the existing PWA (fastest) or a bare test client — decide when Phase 1 is planned; the PWA exercises the server but not the local-first model, so it is a server test only.
