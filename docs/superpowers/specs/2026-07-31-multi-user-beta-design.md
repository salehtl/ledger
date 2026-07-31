# Multi-user closed beta — v2 architecture design

**Date:** 2026-07-31
**Status:** Approved design, revised after two adversarial reviews; pre-implementation
**Supersedes:** the single-user architecture in `budgeting-app-build-plan.md` for the v2 track. The single-user instance keeps running from `main` untouched until migration (see Rollout).

## 1. Goals, in priority order

1. **Privacy & security.** Users own their data. A server breach must yield data that is as worthless as possible to the attacker. Claims must be honest and technically precise — no marketing overreach.
2. **Minimal operational cost.** No unnecessary compute. Procedural, deterministic solutions over AI. One VPS (plus a minimal relay VPS) for the foreseeable future; a dedicated cheap DB host only when scale demands it. Fixed costs accepted for the beta: Apple developer account ($99/yr), one domain, backup-relay VPS (~$5/mo).
3. **Performance.** The app must feel instant. Structural speed (local-first) over optimization.

Non-goals for the beta: AI anywhere in the pipeline, Android, banks beyond the templated set, public availability.

## 2. Honest threat model (adopted verbatim into the privacy page)

**The claim is "encrypted at rest with a plaintext ingest window" — not "zero-access", not "we can't see it."**

- Transaction emails necessarily arrive at our servers in plaintext (SMTP). They are parsed **in memory** and sealed to the user's public key at the moment of arrival; only ciphertext is stored. The backup relay does the same before spooling (§3.2).
- A stolen disk, stolen backup, seized server, or subpoena of stored data yields: ciphertext blobs; blob timestamps and size-buckets; op-type flags (that *something* was ingested/edited, not what); the unencrypted parse-diagnostics ledger (per-ingest sender domain, template ID, timestamps — i.e. which bank each user uses and when transactions occurred, but no amounts or merchants); pseudonymous sign-in identifiers; inbound-address tokens; and, **for users who opted into passphrase recovery, their passphrase-wrapped key material — which is subject to offline guessing and is only as strong as the passphrase** (Argon2id-hardened; strength-checked at creation; the default recovery path is the high-entropy recovery phrase instead).
- A **live, actively compromised server** could log plaintext of *future* mail as it arrives. This is the same residual trust Proton Mail carries for external mail, and we state it plainly.
- Sign-in identifiers are pseudonymous at best (hashed, but low-entropy and enumerable; Google additionally holds the `u-xxx ↔ identity` mapping because the user configures forwarding inside Gmail). Assume a breach reveals *who* the users are; the protection is over *what they spent*.
- **Third parties:** Apple/Google learn who signs in and when (identity providers); Expo and Apple's push service observe notification timing, which correlates with transaction timing — we send content-free pushes immediately rather than delaying them, and disclose this. No third party ever receives mail content.
- Metadata mitigations (required, not optional): blob padding to size buckets (4/16/64 KB), jittered/batched blob upload timing, full-table FX distribution (never per-pair queries).
- Regulatory posture: users' financial data falls under UAE PDPL (Federal Decree-Law 45/2021) and, for EU testers, GDPR. Export and deletion rights are honored in-product (§3.10); the operator is data controller for the unencrypted metadata above.

## 3. Architecture: blind mail-slot server, local-first client

Still one Go binary on one VPS, plus Postgres. The server's job shrinks to: receive, parse-in-memory, seal, append, notify. The client (Expo app) holds decrypted data in local SQLite and does **all** budget math, insights, filtering, review-queue, and categorization on-device. Every screen reads local data → instant UI, offline-capable; sync is background reconciliation, never a spinner.

### 3.1 Server surfaces

| Surface | Port / binding | Purpose |
|---|---|---|
| SMTP receiver | :25 public (MX on `in.<domain>`) | Inbound bank mail per user |
| HTTPS API | :443 public, autocert | Auth, sync, template distribution, FX, push registration |
| Admin console | Tailscale-bound only | Template authoring/publishing, donated-sample queue, diagnostics, waitlist |
| Postgres | localhost only | All server state |
| Backup relay | second VPS, :25 public (lower-priority MX) | Same binary in relay mode (§3.2) |

Exposing :443/:25 publicly is a deliberate posture change from the Tailscale-only single-user system; admin stays tailnet-only.

### 3.2 Ingestion (SMTP, self-hosted)

- Each user gets a unique inbound address `u-<token>@in.<domain>`. **Token: ≥128-bit (26-char base32), rotatable in-app.** Rotation consequences are surfaced in the rotation UX: it breaks the user's existing Gmail forward rule and any bank-side registration (both must be redone via a guided re-onboarding flow) and resets the learned sender allowlist. The old address keeps accepting for a 7-day grace window, flagged, so mail in flight isn't lost.
- Users either point their bank's alert email directly at their address, or set an auto-forward rule in their mailbox. Gmail's forward-verification email arrives at our server; the confirmation link is surfaced in-app during onboarding.
- Receiver: `emersion/go-smtp`. Unknown RCPT rejected at RCPT time **with per-IP invalid-RCPT rate-limiting and tarpit delays** (rejection is an enumeration oracle otherwise). DATA capped at 1 MB. Per-address rate limit ~50 msgs/day (bank alerts are single digits/day; excess is an attack).
- **Origin trust** (the inbound address is otherwise an unauthenticated write endpoint into a financial ledger, and Gmail forwarding rewrites the envelope sender — SRS — so SPF-based filtering is unavailable by design):
  - All mail from origins not on the address's allowlist is accepted, sealed, and stored, but flagged `untrusted_origin`. The **client** renders these in a quarantine lane; the server cannot judge content.
  - **Allowlist learning is explicit, not inferred:** the first mail from a new origin necessarily lands quarantined. The client shows it with a "trust this sender" action; confirming promotes that origin — envelope-from pattern plus authenticated DKIM/ARC signing domain where present — to the allowlist via an authenticated API call. This covers both onboarding paths (Gmail-forwarded mail: the SRS pattern + forwarder's ARC domain; bank-direct mail: the bank's envelope + DKIM domain). Onboarding treats confirming the first real bank email as a step, so the quarantine lane never silently becomes the primary lane.
  - Quarantined blobs never trigger push (no notification-spam channel) and expire after 30 days unless the user confirms them — the server never durably stores unlimited attacker-deliverable content.
- Processing: deterministic cascade only (published templates → heuristic). No AI tier. Parsed transaction + raw body are compressed (**compress-then-encrypt**; ciphertext is incompressible), sealed to the user's public key (§3.4), appended to the op log, plaintext discarded. Unparseable mail: same treatment, `unparsed` flag (a flag is all the server knows).
- **Availability:** sender MTAs retry for ~1–3 days, then bounce — and Gmail auto-disables forwarding rules after sustained failures, silently and (to us) invisibly. Mitigations:
  - **Backup relay MX (non-negotiable): the same binary in relay mode** on a second cheap VPS, holding only a synced replica of `(inbound_address → user public key)`. It seals mail at arrival exactly like the primary and spools **ciphertext only**, forwarding blobs to the primary on recovery. Managed third-party relays are ruled out (they would read plaintext). If relay mode is not built by the time real users' mail flows, §2 must instead disclose a plaintext spool window — shipping without either is not an option.
  - **Client-side watchdog:** the client alerts on "no mail in N days vs. your own baseline" — only the client knows what normal looks like.
- **Precondition (Phase 0):** confirm both VPS providers permit inbound port 25 before any of this is built. If not, fall back to a managed inbound relay and re-open §2.

### 3.3 Data model: per-user op log with event sourcing (not LWW)

Record-level last-write-wins breaks this schema's invariants (splits must sum to parent; fingerprint-dedup is currently server-enforced), silently and unrepairably under E2E. Instead:

- The per-user sync log is an **append-only op log**: immutable, encrypted operations (`txn_ingested`, `txn_categorized`, `txn_split`, `txn_edited`, `rule_added`, …). **Writers are identified**: every op carries `(writer_id, writer_counter)` chosen by its author — each device is a writer, and the server's ingest pipeline is itself a writer. The server assigns a per-user total order (`seq`) at append time; `seq` is *ordering metadata only* and is never part of the encrypted payload or AAD (an offline writer cannot know it at encryption time).
- **Ops are batched into padded blobs.** Writers accumulate ops and upload them as blobs padded to the 4/16/64 KB buckets; AAD binds `(user_id, stream, writer_id, writer_counter)` at the blob level; ops carry intra-blob indices. This reconciles padding with sync cost: a full 3-year history (~3,700 transaction ops, measured on one user across two banks) stays around 1 MB of hot blobs, not 3,700 × 4 KB. Rich push (later, §3.8) decrypts the latest hot blob (≤4 KB), never the cold stream.
- Clients replay ops in `seq` order to materialize local SQLite state. **Every invariant has a deterministic replay-time resolution rule, not just detection:** conflicting envelope assignments — lowest `seq` wins, later op is replay-ignored and surfaced as a notice; duplicate transaction fingerprints — replay-ignored (this is the dedup mechanism, and it also collapses server-parsed vs. client-reprocessed duplicates of the same email); split-set no longer summing to its (edited) parent — the split set is preserved, the transaction is flagged back to `needs_review` on-device. Because rules are deterministic over the total order, every replica converges without an arbiter.
- **Ops carry a schema version.** Clients never write op versions newer than they understand; on encountering an unknown version during replay they hard-stop sync and require an app upgrade (never skip-and-corrupt).
- **Hot/cold split** — structural, from day one: *hot stream* = parsed-transaction ops (~200 bytes each; whole history ~1 MB; syncs in seconds on reinstall); *cold stream* = raw email bodies (~25 MB/user/year, measured on one user — assume multiples for busier banks). Cold syncs lazily/on-demand; clients keep a rolling window (e.g. 90 days) locally. Client-side reprocessing pulls the cold ranges it needs.
- **Integrity chains — two, with distinct honest claims:** (a) each *writer* hash-chains its own blobs (`writer_counter` N embeds the hash of N−1), so a server that drops or reorders any device's ops is detected by that device and, at sync, by the user's other devices; (b) the *server* hash-chains the stored ciphertext sequence, which is what backup restores are verified against. The server-side chain proves storage/backup integrity; it does **not** prove operator honesty — only the writer chains plus cross-device comparison (§3.4) speak to that. Clients verify both chains every sync and report gaps/breaks by sequence number.
- **Snapshots/compaction: deferred deliberately.** Replay cost is acceptable at beta scale; revisit when a user's log exceeds ~50k ops. Deletion is handled by crypto-shredding, not log rewriting (§3.10).

Postgres tables (server side): `users`, `sessions`, `inbound_addresses`, `op_log (user_id, seq, stream, writer_id, writer_counter, type_flag, ciphertext, size_bucket, created_at)`, `templates`, `donated_samples`, `parse_diagnostics`, `waitlist`, `push_tokens`, `fx_rates`.

### 3.4 Cryptography

- **Two key paths, because the server writes but must not read:**
  - *Ingest path (asymmetric):* each user has an **X25519 keypair**; the server stores only the public key and **HPKE-seals** each ingest blob to it at arrival. This is what makes "parsed in memory, only ciphertext stored" actually implementable — a symmetric-only design would require the server to hold the data key.
  - *Client path (symmetric):* a per-user **DEK (AES-256-GCM)** encrypts client-authored op blobs (cheaper, and the DEK never leaves user custody).
- **Both the private key and the DEK are protected identically, by envelope:** wrapped by (1) a device key in the iOS Keychain (iCloud-Keychain-synced), (2) *optionally* an Argon2id-derived key from a user passphrase — strength-checked, parameters pinned in the implementation plan (≥64 MiB memory, tuned to ~1s on target devices), stored server-side as an opaque blob, with the offline-guessing exposure disclosed in §2 — and (3) an exportable high-entropy **recovery phrase, which is the default recovery path**. Wrap rotation = re-wrapping two small keys, never re-encrypting history.
- **Compromise response:** wrap rotation handles a lost *wrap* (e.g. stolen passphrase). A compromised *key itself* (extracted from a stolen unlocked device) cannot be rotated away for history — the design's honest statement is: new epoch keys are generated for future blobs, old keys are retained read-only for history, and background re-encryption of history is an explicit non-goal for the beta.
- **Key transparency, with its limits stated:** device public keys are TOFU-pinned by clients, and the server maintains an append-only key-history log per user. On detecting a history mismatch or writer-chain break, the client **halts sync and shows a non-dismissable warning** — detection without a defined response is theater. A brand-new device necessarily bootstraps from the server, so a malicious server could feed it a clean fake history; the key-backup UX therefore includes a short **cross-device comparison code** (safety-number style) surfaced during second-device enrollment. Single-operator infrastructure cannot make key substitution impossible, only detectable; §2 says so.
- GCM with per-blob random nonces; AAD binds `(user_id, stream, writer_id, writer_counter)` (§3.3) so blobs cannot be replayed across positions, streams, or users.
- Key loss with all wraps lost = history loss. Stated honestly; softened only partially by re-forwarding from the user's own mailbox (Gmail has no bulk-forward — this is not a real recovery path and is not marketed as one).

### 3.5 Templates as data + intake pipeline

Bank support at launch: the **three** existing corpus-validated parsers — DIB (Arabic), ENBD transactions (English), and ENBD account alerts (`enbd_alert.go`) — ported into the template store. Growth is via intake, not AI.

- **Store:** `templates(bank, sender_pattern, version, definition, status: draft→testing→published)`. The definition is a deliberately simple declarative format: label anchors + regexes + typed fields (amount, direction, merchant, date, currency, locale).
- **The normalization pipeline is part of the template contract.** Templates match *normalized* text, and today's normalizer (`internal/parse/body.go`: MIME part selection, charset decode, quoted-printable, HTML-strip to newlines, entity decoding, whitespace collapse) is where template behavior actually lives. It is specified as a **versioned algorithm** with its own conformance fixtures; templates declare the normalizer version they target.
- **Two executors, one constrained dialect.** Go (server, at ingest) and TypeScript (client, local reprocessing) both implement the normalizer + template executor. Template regexes are restricted to a defined **RE2-compatible, backtracking-safe subset**, validated at publish time — this both sidesteps Go/JS regex divergence (`\s` ASCII vs Unicode, case-folding differences; normalization must fold `&nbsp;`/U+00A0 explicitly) and prevents a published template from ReDoS-ing clients on adversarial mail (the inbound path is attacker-writable). A shared conformance fixture suite runs against both executors in CI; disagreement fails the build.
- **Seed validation:** ported templates must reproduce the existing three parsers' output over the full 3-year corpus before Phase 1 ships.
- **Intake flow:**
  1. Onboarding asks the user's bank. Supported → proceed. Unsupported → waitlist + invitation to donate one sample email *during setup* ("we need one example to learn your bank"), with a client-side redaction preview showing exactly what will be sent. Consent at setup converts; consent at the moment of failure does not.
  2. In operation, unparsed mail lands in the client review queue with per-email "donate". By default the client reports a **content-free structural fingerprint** (`structure_sig`: tag skeleton, label positions, zero values) so the admin console clusters demand ("14 users hitting an untemplated FAB credit-card format") without seeing content.
  3. Admin console: donated samples queue → author template → validation replays it over every donated sample for that sender → publish bumps the store version.
  4. Clients pull new template versions and **reprocess locally** over their decrypted cold-stream bodies; recovered transactions append to the op log (fingerprint dedup at replay collapses any overlap with server-parsed results). "Fix the parser, backfill" survives E2E at zero server compute.
- **Diagnostics (deliberate, bounded privacy concession):** per ingest the server stores *non-content* facts unencrypted: template ID attempted, matched/not, which named capture groups were empty, body size bucket, sender domain, parser version. This turns "unparsed, cause unknown" into a fixable bug report. It is also a per-user bank-and-timing ledger, and §2 lists it in the breach inventory; accepted and disclosed.
- Known fragility, accepted with eyes open: existing templates are newline-anchored regex over normalized text; Gmail forwarding re-flows HTML and applies quoted-printable wraps. Phase 1 runs *unencrypted with friendly alphas* precisely to catch this with full visibility.

### 3.6 Categorization (no LLM)

- Global anonymous merchant→category dictionary: seeded from the operator's existing rules, grown from **opt-in** confirmations (a bare merchant pattern, never user-linked). **Submissions are operator-moderated before publication, and entries are suppressed until at least k distinct users have submitted the same merchant** — this blocks both dictionary poisoning (`AMAZON → Charity`) and rare-merchant entries that would be user-identifying. Distributed to clients like templates.
- Per-user override rules live client-side and sync as encrypted ops. Rule matching runs on-device.

### 3.7 Currency & FX

- Every transaction stores original currency + amount in that currency's minor units (`int64`). Each user picks a home currency at onboarding; budget math converts on-device.
- Server fetches daily rates **once** (one upstream call/day total) and serves the **entire** table to every client — never per-pair queries (a per-pair fetch is a travel-history side channel). Historical table ships as a compact cached binary (~170 currencies × days; a couple MB once, few hundred bytes/day incremental) so past months recompute correctly.
- Unknown-rate transactions surface in the client review queue rather than silently distorting budgets.

### 3.8 Auth, sessions, push

- Sign in with Apple + Google Sign-In (identity only, non-sensitive scopes — no OAuth verification/CASA exposure) via `expo-auth-session`. App Store rule: offering Google obligates Apple sign-in; both ship.
- Backend verifies identity tokens, issues **opaque server-side session tokens** (revocable; no JWT machinery). Passwords never exist.
- Push: Expo push service, **content-free** ("New transaction") for the beta, sent immediately — instant notification is core product value, and the resulting timing visibility to Expo/APNs is disclosed in §2 rather than jittered away (a "delay notifications" privacy setting may be offered later). Quarantined mail never triggers push (§3.2). Rich decrypted notifications later via an iOS Notification Service Extension — costed honestly: leaves Expo Go (config-plugin prebuild), separate process with ~24 MB ceiling, requires a **second crypto implementation in native Swift** (HPKE + GCM) sharing a Keychain access group, kept bit-compatible with the JS one and pointed only at the latest hot blob (≤4 KB).

### 3.9 Client (Expo, iOS-first)

- Expo / React Native, iOS TestFlight for the beta; Android later. Reuses the framework-free `lib/` logic (money, filtering, gesture predicates) and API types; screens/components are a rewrite (Reanimated, RN primitives).
- Local SQLite is the source of truth for the UI; op-log replay materializes it; crypto via a JSI-native module (never bridge/base64 marshalling — measured as a cold-start killer).
- Review queue, quarantine lane with "trust this sender" (§3.2), donation flow with redaction preview, forwarding-setup onboarding with in-app Gmail verification link, key backup UX (recovery phrase default, optional passphrase, cross-device comparison code).

### 3.10 Data ownership: export & deletion

"Users own their data" is a product feature, not a slogan:

- **Export:** generated **on-device** from local SQLite (decrypted JSON + CSV, shared via the iOS share sheet). Trivial in a local-first design — the user's device already holds everything; the server is not involved.
- **Account deletion:** in-app, self-service (App Review guideline 5.1.1(v) requires it). Server-side it is **crypto-shredding plus purge**: delete the user's op-log rows, wrapped-key blobs, public keys, diagnostics rows, addresses, sessions, and push tokens. Backups age out on their retention schedule; until then their copies of the user's blobs are ciphertext whose keys no longer exist anywhere. Ships in **Phase 2**, before any external tester touches the system with crypto on.
- **Beta terms:** a plain-language ToS stating the app is informational, not financial advice; balances/budgets must be verified against the bank; and (for alphas) the Phase 1 plaintext handling, retention, and deletion commitments (§5).

## 4. Acknowledged trade-offs (accepted, not hidden)

1. **Privacy vs. cost:** E2E forbids cross-user dedup/compression of near-identical bank HTML (~an order of magnitude of storage at scale). Accepted; mitigated by compress-then-encrypt and hot/cold split.
2. **Privacy vs. performance:** cold-start cost of encrypted history. Mitigated structurally (hot stream ~1 MB in batched padded blobs); full raw-body hydration remains a lazy, background concern.
3. **Privacy vs. supportability:** we cannot read the inputs to a failing parser. Mitigated by non-content diagnostics, structural fingerprints, consent-gated donation, and an unencrypted alpha phase to stabilize templates first.
4. **Privacy vs. immediacy:** instant push leaks transaction timing to push infrastructure. Accepted and disclosed (§2, §3.8).
5. **Bank coverage is a human bottleneck** (hand-written templates per bank per alert type). Accepted via narrow launch scope + intake pipeline + waitlist. AI re-enters, if ever, as consent-gated/user-initiated — never the always-on server path.
6. **Single-operator key infrastructure:** silent key substitution is made detectable (TOFU + key history + cross-device comparison code), not impossible; a fresh device's first bootstrap trusts the server. Stated in the privacy page.

## 5. Rollout

Each phase has an explicit exit criterion; failing it means stop and rethink, not push on.

- **Phase 0 — kill-risks week.** (a) Confirm inbound port 25 with both VPS providers — gates §3.2. (b) Spike local-first: on-device SQLite + budget-math replay over the real ~3,700-transaction corpus on the oldest target iPhone. *Exit: port 25 confirmed; cold replay + first paint within an acceptable budget (target <2s warm, <10s cold-restore) on that device.*
- **Phase 1 — backend v2, plaintext.** Postgres, auth, hardened SMTP receiver, op-log sync (hot/cold, batched padded blobs, both chains), template store + normalizer contract + conformance suite + diagnostics, backup relay. **The Phase 1 sync client is decided: a minimal headless client** (script or bare Expo shell) that authenticates, pulls, replays, runs the invariant checker, and round-trips client-authored ops — this, not the PWA, is the exit test; the existing PWA may additionally serve alphas via a temporary server-side materialized view, understood as throwaway. 3–5 friendly alpha users, **unencrypted, under signed plain-language consent** (plaintext handling, retention limit, deletion at Phase 3 cutover), known banks, full parser visibility while Gmail-forwarding fidelity is proven. *Exit: headless client replays cleanly with invariants green across two concurrent writers; ≥95% of alphas' genuine transaction mail parses over two consecutive weeks; zero silent drops (every inbound email accounted for in diagnostics).*
- **Phase 2 — Expo app.** Local-first client, replay + invariant checker, review queue + quarantine lane, onboarding (bank picker, forwarding setup, "trust this sender" step), export + account deletion, key UX built but crypto dormant. *Exit: a fresh install onboards, syncs, categorizes, and survives airplane-mode edits on two devices without invariant violations.*
- **Phase 3 — crypto on.** HPKE ingest sealing, DEK for client ops, wraps + recovery phrase, TOFU key history + comparison code, padding, jittered uploads, alpha data migrated or deleted per consent. *Exit: end-to-end flow with crypto on matches Phase 2 behavior; restore-from-backup verifies against the server chain; second-device enrollment verifies against the writer chains.*
- **Phase 4 — closed beta.** TestFlight, honest privacy page (§2), ToS (§3.10). NSE rich push and Android post-beta. *Exit: defined by beta learnings; not pre-committed.*
- **Migration:** the operator's own instance migrates onto v2 as user #1 (SQLite → op-log import via the existing `importer` patterns); the single-user path retires afterward.

Development happens in this repo on a long-lived v2 branch/worktree; `main` keeps serving the running single-user instance until migration.

## 6. Open questions (tracked, non-blocking)

- Domain choice for `in.<domain>` and app API.
- FX rate source (needs: free tier, daily, ~170 currencies).
- Backup-relay VPS provider (constraint: must permit inbound :25 and run our relay binary — managed relays are ruled out, §3.2).
- Template definition + normalizer contract details (to be designed in the Phase 1 plan alongside the conformance suite).
- k threshold and moderation workflow for the merchant dictionary (§3.6).
