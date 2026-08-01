# v2 Phase 2 — The local-first Expo iOS client, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a real iOS app on the headless client Phase 1 already built — local SQLite as the UI's source of truth, op-log replay materializing it, sync as background reconciliation — and prove, by measurement on the oldest target device, that the local-first bet survives production crypto. Phase 1 built the protocol; Phase 2 builds the product and the evidence.

**Architecture:** A new Expo app at `app/`, pinned to SDK 54, prebuilt into a custom dev client because a JSI-native crypto module cannot load in Expo Go. `app/` **imports `client/src` as a library** — it does not fork it and does not rewrite it. Four platform seams (sha256, gzip, Ed25519+UUID, `Store`) get React Native implementations; everything above them — `replay/`, `invariants/`, `norm/`, `tmpl/`, `wire/op.ts` — runs unmodified on Hermes. A small number of Phase 1 *server* changes land here too, because Phase 2 is the first phase with a client that needs them (template distribution, dictionary submission, a sign-up allowlist, the roster's missing `ingest` writer, a real rotation nonce).

**Tech Stack (every version exact, never a range — Phase 1 Decision 15 applies unchanged):** `expo` 54.0.36, `react-native` 0.81.5, `react` 19.1.0, `expo-sqlite` 16.0.10, `expo-secure-store`, `expo-auth-session`, `expo-notifications`, `expo-file-system`, `expo-sharing`, `expo-dev-client`, `react-native-reanimated`, `@noble/curves` 2.2.0, `@noble/hashes` 2.2.0, `@noble/ciphers` 2.2.0 (control arm + Ed25519), `fflate` 0.8.3 (gzip), `ulid` 2.3.0, TypeScript 5.9.2. Native module in Swift against **CryptoKit**. Builds via **EAS Build** (there is no Mac — see P1).

---

## Read this before anything else: what Phase 2 is actually for

Phase 0 passed the on-device replay spike **PROVISIONALLY**. Median cold restore was **58.0 s** against a 10 s budget. But `decryptMs` — pure-JS X25519 + AES-GCM via `@noble` — was **94.3 %** of it, `total − decrypt` was **3.3 s**, and the full 3,683-row budget aggregate computed in **0.65 ms**. The conclusion on record is: *nothing about the architecture is slow, one library is.*

That conclusion has never been tested. Spec §5 therefore makes a native-JSI crypto benchmark the **mandatory first task of Phase 2**, and it is Task 1 of this plan. The projections it must beat are thin:

| Assumed native speedup | Projected cold restore | Margin under the 10 s gate |
|---|---|---|
| 10× | ~8.8 s | ~12 % |
| 50× | ~4.4 s | 56 % |
| 100× | ~3.9 s | 61 % |

The 10 × row leans on a `fetchMs` figure `spike/phase0/RESULTS.md` itself disclaims (Caveat 2: DERP-relayed, and the transport shape was one bulk `all.bin` GET, not the paged sync the product uses), excludes first paint entirely (Caveat 8 — **never measured**), and was taken on the operator's daily-driver iPhone rather than the oldest target device (Caveat 1). Stack those and the 10 × margin can evaporate.

**And there is a trap specific to Phase 2 that a naive plan walks straight into.** Phase 1 is plaintext. `blob.openBlob` in `client/src/wire/blob.ts` is a gunzip and an AAD compare — there is *no crypto in it*. So the Phase 2 app, built and measured honestly end to end, will restore fast and prove **nothing** about Phase 3. Every measurement in this plan that claims to speak to the crypto budget must be taken against a **deliberately constructed Phase-3-shaped sealed corpus** (§3.4: HPKE to the user's X25519 public key, random 96-bit nonce, AAD binding `(user_id, stream, writer_id, writer_counter)`), never against the plaintext blobs the app actually syncs. Task 1 and Task 28 both say so; if an implementer skips it, the gate becomes ceremony.

Two further Phase 0 results are unmeasured and must not be inherited as settled:

- **First paint.** The 13 ms "warm start" is a post-mount SQLite read taken *after* process launch, Hermes bundle evaluation and React mount. Spec §5's `<2 s` criterion names first paint explicitly and Phase 0 never instrumented it. Task 1 builds that instrument.
- **Replay semantics.** `computeMs = 0.65 ms` timed a naive `INSERT OR REPLACE` plus one currency-blind `SUM`. Causality/supersede resolution, per-entity version heads, writer-chain verification over all 3,683 blobs, the quarantine lane and §3.7's FX conversion were all absent (Caveat 9). "Replay is free" is not a result this plan may assume.

---

## Global Constraints

Every task's requirements implicitly include this section. Violating any of these is a task failure regardless of whether tests pass.

- **Task 1 is a gate, not a formality.** No task numbered 3 or higher may be started until Task 1 has produced `docs/superpowers/specs/v2-phase2-crypto-gate.md` with a recorded verdict and the user has signed off on the branch taken. A CONDITIONAL verdict changes the content of later tasks (see Task 1's decision rule); a FAIL stops Phase 2 and reopens Phase 0. Task 2 may run concurrently with Task 1 — it needs no app.
- **PHASE 2 IS STILL PLAINTEXT. Do not add encryption to the product path.** Phase 3 swaps exactly one implementation (`blob.Sealer` on the Go side, the open path in `client/src/wire/blob.ts` on the TS side). Task 1 builds a native crypto module and Task 28 uses it against a synthetic sealed corpus — both are **benchmark instruments**, live under `app/modules/ledger-crypto/` and `app/src/bench/`, and are never wired into the sync path. An implementer who "helpfully" starts sealing real blobs breaks the Phase 3 migration and will be reverted.
- **`client/src` is a library, not a starting point to fork.** `app/` imports it. The only edits permitted to `client/src` are (a) the four platform seams in Task 4, (b) the `Store`/`RowStore` split in Task 5, (c) the `unparsed`/zero-amount op gap in Task 7, and (d) additive exports. **No behaviour change**, proven by the existing suite: after every one of those edits `cd client && bun test` must show no pre-existing test removed, skipped or weakened and a collected count no lower than Task 0 Step 3's recorded baseline (1,911 collected / 1,875 pass / 35 skip / 1 known fold-timeout at this plan's revision, `f0ac846`), and `bash scripts/v2-check.sh` must print `v2-check: OK (go + client + conformance)`.
- **Do not reimplement `Client`'s protocol logic in the app.** `client/README.md` says Phase 2's app "must not be built by growing this one," and gives three reasons — it re-folds its whole log per command, it keeps every verified row on disk forever, and it holds its writer key in a plain file. All three are *store and instrument* choices, and Task 5 replaces all three. **None of them is the pull → verify → pin → fold → attest → push ordering**, which Phase 1's own ledger records taking four review rounds to get right (checkpoint-before-attestation ordering, the I11 sync deadlock and its escape hatch, the hot/cold pin interaction that makes the next pull an unclearable chain break). Reimplementing that in the app re-opens every one of those bugs. Task 5 updates `client/README.md` to say this precisely.
- **Money is `bigint` minor units, never `number`.** Amounts are positive; `direction` is `'debit' | 'credit'`. FX is `(amountMinor * rateMicro + 500_000n) / 1_000_000n`, half-up, `BigInt` only. **No `Number()` anywhere in a money or FX path** — and note `Number("") === 0`, the springback bug the v1 harness found, which is why every numeric input in this plan uses a string draft state and converts once on commit.
- **FX determinism (spec §3.7), verbatim binding, unchanged from Phase 1:** `snapshot(T) = convert(amount(T), head_rate(ccy(T), P))` where `P` is the smallest log position ≥ `pos(T)` at which a head rate for `ccy(T)` exists in the synced prefix; null otherwise. `head_rate` resolves purely by fold-by-`seq`, never by wall clock. `rate_set`/`rate_unset` are parent-free and append-only. A later `rate_set` backfills only transactions still null *as of that position*. A supersede recomputes fresh at its own position. Home currency is log state, one-shot, immutable. The client already implements all of this in `client/src/replay/fx.ts`; Phase 2 builds UI on it and must not re-derive it.
- **Chunk, and yield, and hold one connection.** The Phase 0 pre-fix build hit >500 MB RSS and froze. Two confirmed root causes: a ~39-request/144 MB fetch storm from unguarded repeat presses, and `expo-sqlite`'s `openDatabaseSync` leaking a native connection per press. The fix that shipped was chunking at 250 records with `await new Promise(r => setTimeout(r, 0))` between chunks — **the yield was the load-bearing part, not the chunking** — plus a single reused connection and an `isRunning` guard. All three are mandatory in Task 8 and each gets a named regression test. And note what the yield does *not* buy: total `yieldMs` across a 58 s restore was 1.9–4.2 ms, so the JS thread was blocked in ~3.8 s slabs the whole time. Responsiveness comes from Task 1's **async batch** native API dispatching to a background queue, not from the yield.
- **Never touch the live v1 system.** Never bind `:8080`. Never open `/var/lib/ledger/ledger.db` except through one root-run `sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup ..."` whose copy lands in the working directory below. `main` keeps serving the single-user instance until Phase 3 migration.
- **Never touch the `/` proxy and never claim `--https=8443`.** `tailscale serve status` today is `https://dinosaur.<tailnet>.ts.net/ → proxy 127.0.0.1:8080` (**production v1's PWA**) and `:8443 → path /srv/ledger-storybook` (already claimed, `deploy/README.md:60,65`). A bare `tailscale serve https / …` replaces the `/` proxy and takes the operator's live instance offline. v2 uses **`--https=8444`** and nothing else. Capture `tailscale serve status` before and after any change to it.
- **No real financial data is ever committed, and no plaintext of it is ever written outside the working directory.** The measurement corpus is derived from the operator's three-year history; this repo has a `gh pr create` workflow, so a committed corpus is that history one push from GitHub. Sealed corpora, `corpus.db`, and any file containing a real merchant or amount live in `$W` (below) or in `spike/phase2/`, which is gitignored in its entirety. What may be committed is a **manifest** (counts, sizes, public keys, aggregate bucket totals) and **synthetic** vectors produced by a seeded generator with fabricated merchants and amounts. Any task whose final `git add` could sweep one of these must list explicit paths and verify with `git show --stat`.
- **The working directory is a fixed literal path** that survives across sessions, because Task 28 needs Task 1's corpus weeks later and the session scratchpad is session-scoped:
  ```
  W=/root/Coding/ledger/.claude/worktrees/v2/spike/phase2/work      # gitignored; survives sessions
  S=/tmp/claude-0/-root-Coding-ledger/bcc8cb5e-1dd4-451e-94e9-031572dd88c7/scratchpad  # ephemeral
  mkdir -p "$W"
  ```
  `spike/phase2/.gitignore` containing `*` is created by Task 1 Step 1, **before** anything is written there.
- **Test-count gates are stated as properties, not numbers.** The client suite measured **1,911 collected / 1,875 pass / 35 skip / 1 fail** as of this plan's revision (`f0ac846`) — the 35 skips are the e2e files, which **self-skip without `LEDGER_TEST_POSTGRES_URL`**, and the 1 fail is a flaky 5 s timeout in `fx.test.ts`'s "incremental application … at EVERY prefix" (5,708 ms observed). So: **no pre-existing test may be removed, skipped or weakened; the collected count is monotonically non-decreasing; and any gate that names an e2e test must assert it actually ran rather than skipped.** A plan that pins an absolute number is a plan that goes stale in a week — an earlier draft of this file pinned "1,904 across 17 files" in four places and was already wrong when it was written.
- **The canonical sync order is `pull → verify → pin → fold → attest → push`.** Every restatement of it in this plan must contain all six, `pin` included. Phase 1's ledger records four review rounds establishing that a checkpoint built from unpinned heads claims genesis for chains that are merely un-pinned rather than empty.
- **Several sessions share this worktree.** Never `git commit -a`, never `--amend`, never `--only` — all three have swept other sessions' work here. Stage explicit paths and verify with `git show --stat`. If a shared file (`cmd/ledgerd/main.go`, `internal/v2/api/api.go`, spec docs) is mid-flight in another session, reconstruct HEAD + your own edits for that file and stage the blob directly rather than `git add`-ing it.
- **No AI anywhere.** No extraction fallback, no categorization fallback, no `internal/anthropic`. Categorization is rules + the global dictionary, on-device.
- **No public exposure yet.** The Phase 2 device reaches `ledgerd` over **Tailscale HTTPS** (`tailscale serve` fronting the loopback listener), exactly as v1 does — `config.validate()` refuses a non-loopback `http_listen` and that stays true. Public `:443` autocert is Phase 1's deferred Task D4 and is not this plan's job. Inbound `:25` **is** this plan's job (P3), because there is no Gmail measurement and no onboarding test without real mail arriving.
- **Repo conventions:** `gofmt` for Go; two-space TS with semicolons; conventional commits (`feat(v2): …`); TDD ordering — write the failing test, run it, watch it fail, then implement. Every task ends with `bash scripts/v2-check.sh` green plus, from Task 3 onward, `cd app && bun run test` and `bun run typecheck` green.
- **All Phase 2 client code lives under `app/`.** Server changes live under `internal/v2/` and `cmd/ledgerd/`. Shared fixtures live under `conformance/`. Files outside those trees this plan may change: `client/src/**` (only as listed above), `client/README.md`, `scripts/v2-check.sh`, `docs/superpowers/specs/*`, `deploy/*`, `config.v2.example.toml`.

---

## Decisions this plan makes (the spec left these open — challenge them here, not in code)

1. **The native crypto module is an Expo Module in Swift over CryptoKit, not a third-party JSI package.** *Rationale:* the operation we need is exactly HPKE `DHKEM(X25519, HKDF-SHA256)` + `AES-256-GCM` open, which CryptoKit provides natively (`Curve25519.KeyAgreement`, `HKDF<SHA256>`, `AES.GCM`) with no dependency, no OpenSSL vendoring, and a hardware-backed AES path. `react-native-quick-crypto` is measured as a control arm in Task 1 so the choice is evidenced, but it drags an OpenSSL build into an app whose entire selling point is auditability.
2. **The native API is batch-first and asynchronous.** `openBatch(records, …) → Promise<Uint8Array[]>` dispatched to a background `DispatchQueue`, with a synchronous `openOne` kept only as a measurement arm. *Rationale:* 3,683 individual JSI crossings is itself a cost worth measuring, and — more importantly — Phase 0's own data says the yield-between-chunks trick restores the garbage collector but not responsiveness. Work that runs off the JS thread is the only thing that does.
3. **`Store` stays synchronous; `expo-sqlite`'s sync API satisfies it.** `openDatabaseSync` + `runSync`/`getAllSync` exist in expo-sqlite 16. *Rationale:* `Client`'s **private** `commit()` (`net/client.ts:1258`, called from `:533,:551,:562,:619`) is synchronous and calls `store.save()`; widening `Store` to `Promise` ripples through every method of a class Phase 1 spent four review rounds hardening. The real problem with the file store is not that it is synchronous — it is that `save()` writes the entire `ClientState` **including `rows`**, which is O(log) bytes per command. Task 5 fixes that by splitting `rows` out behind a new `RowStore` seam, which is the change that actually matters.
4. **The same SQLite store implementation is tested under Bun.** `bun:sqlite` and `expo-sqlite` both expose a synchronous prepare/run/get shape; Task 5 puts a ~30-line driver seam between them so the **entire existing client suite (1,911 collected as of this plan's revision) runs against the SQLite store** under Bun. *Rationale:* an on-device-only store is an untested store, and this is the cheapest way to make the new persistence layer inherit Phase 1's whole test corpus.
5. **Materialized `State` lives in memory; SQLite is a projection, plus a device-local fold snapshot.** The UI reads SQLite only. After each chunk the fold's deltas are written to SQLite tables; on warm start the app restores `State` from a serialized snapshot rather than re-folding.

    **This is not §3.3's deferred compaction, and the argument has to answer the spec's literal text rather than talk past it.** §3.3:80 reads: *"the moment anything re-encodes an op it did not author — compaction, **a snapshot rewrite**, a migration that re-serializes — byte-inequality stops being cosmetic and becomes a chain break."* A reviewer sees "snapshot rewrite" listed by name, so the distinction must be made on the mechanism and not on the word. The sentence's hazard is *chain breakage*, and a chain break requires two things: (a) an op is re-serialized to different bytes than its author produced, and (b) **those bytes are hashed into a writer chain that someone else verifies.** Task 9's snapshot does neither. It serializes *materialized state* — `Txn` records, entity heads, rates — not ops; it is stored in local SQLite and uploaded nowhere; no `chainHash` is ever computed over it; and it is read only by the process that wrote it. §3.3:80's "snapshot rewrite" means writing a *replacement op-log prefix*, which is the thing that would re-chain. The falsifiable pin is Task 9 Step 1's fifth test: the snapshot is an input to no emitted op payload, ever. If that test can be made to fail, this decision is wrong. Separately, §3.3:81's head-registry reclamation does not apply either — the snapshot serializes heads verbatim and prunes nothing.
6. **Client-side reprocessing ships template-tier only, and says so in-product.** Phase 1 Decision 16 left the heuristic Go-only, so a client cannot reproduce a heuristic-parsed result, and there is no TypeScript `StructureSig`. *Rationale:* porting the heuristic into the RE2-safe dialect is a rewrite in service of a rung that always lands in `needs_review` anyway. Task 24 builds the template rung, adds the TS `StructureSig` (which the donation flow needs regardless), and shows a "this one was read by the fallback reader and can't be re-read on device" state rather than silently doing nothing. This is a limitation on the record, not a hidden one.
7. **The Gmail forward-verification email is read from the quarantine lane, with no special-casing anywhere.** Gmail sends its confirmation code to the inbound address from `google.com`; §3.2 and Phase 1's exit test (step 8, `409 forwarder_domain`) forbid promoting a forwarder domain, so that message is permanently quarantined **by design**. *Rationale:* the alternative is a Google-specific server-side plaintext read path, which is precisely the category Phase 3 must delete. The quarantine API already returns the raw body under `?include_blob=1`; the client renders it and offers a copy-code affordance. Flagged in "needs a human decision" because it is a UX consequence of a security rule, not an engineering choice.
8. **The closed beta's gate is a single-use invite code, not an identity allowlist.** *Rationale, and this corrects an earlier draft of this plan that was simply unimplementable:* an allowlist keyed on the IdP `subject` cannot be populated, because a subject is not knowable until that person's first sign-in — which is exactly the event being gated. And `admin/waitlist` cannot be the key either: `00012_waitlist.sql` is `waitlist(bank text PRIMARY KEY, demand bigint, first_seen, last_seen)`, a **bank-demand counter that contains no users at all**. Keying on the verified `email` claim was the other candidate and is rejected because Apple's `@privaterelay.appleid.com` relay addresses make it a special case per provider on the security-critical path. So: the operator mints a code, hands it over out of band, and the app presents it at `/api/v1/auth/exchange` alongside the ID token. It gates account *creation* only — an existing account signs in regardless — and it is consumed on use. Task 6 owns the migration.
9. **CSV import writes batched client-authored ops, not 3,683 singletons.** *Rationale:* the expensive shape spec §3.3:75 describes belongs to the *ingest* writer, which cannot batch. A device authoring its own history batches into ≤1 MiB blobs (max 8 per upload request), so a three-year import is a handful of blobs and a handful of opens. This is worth stating because it changes the risk profile: **no beta user reaches 3,683 ingest singletons for years.** It is *not* a reason to soften Task 1 — Phase 3 migrates the operator's full three-year history on day one, and a product with a designed-in year-three cliff is not shippable — but it is why a CONDITIONAL verdict is survivable where a FAIL is not.
10. **Key-backup UX is navigation slots and copy only, no fake keys.** Spec §5's "key UX built but crypto dormant" is built as: the settings rows exist, they are reachable, and they say what will happen in a labelled "not yet active" state. *Rationale:* a recovery-phrase screen that displays a phrase which recovers nothing is a screen that lies to a user about the safety of their data, and it is the single worst thing this app could ship. Task 27 builds the slots; Phase 3 fills them. Raised in "needs a human decision" because it is a deliberate under-delivery against a spec line.
11. **The oldest target device is a hard input, not a nice-to-have.** If the benchmark cannot be run on it, Task 1 **cannot return PASS** — only CONDITIONAL or FAIL. *Rationale:* Phase 0's single largest caveat is that its numbers came from the newest device in the house, and repeating that mistake would make Task 1 a second provisional pass dressed as a real one.

12. **The benchmark corpus uses envelope framing version 2 — the existing frame plus a 32-byte `enc` field — and this surfaces a real Phase 3 gap rather than inventing a format.** An earlier draft of this plan specified `0..32 enc | 32..44 nonce | 44..end ct‖tag`, which is **not** the envelope the code ships. The real frame (`client/src/wire/blob.ts`) is `VERSION(1) ‖ AAD_LEN(2) ‖ AAD ‖ NONCE(12) ‖ [ PAYLOAD_LEN(4) ‖ gzip payload ‖ zero padding ] ‖ TAG(16)`, padded up to one of seven buckets, with `openBlob` doing `validateEnvelope` → bucket check → version check → **byte-compare of the embedded AAD against `aadBytes(envelope)`** → bounds-check → `decompress`. The 12-byte nonce and 16-byte tag slots are **already present and zero-filled** (`blob.ts:57-60`), and `sealedRegion()` is the single function both seal and open derive offsets from.

    **The gap:** there is no `enc` slot. `overhead()` accounts for version, AAD length, AAD, nonce, payload length and tag — and nothing else. HPKE needs to carry a 32-byte ephemeral public key per sealed blob, so Phase 3 must either bump the frame version or adopt a per-user static ephemeral. **That is a Phase 3 design question this plan discovered and does not get to answer**, and it is recorded in Task 1's report and in `NEEDS-SALEH.md` rather than decided here.

    For the benchmark, the faithful move is to use the mechanism the frame already has: **`VERSION = 2` means version 1 with a 32-byte `enc` field inserted after the embedded AAD and before the nonce.** This is exactly the shape Phase 3 would ship if it takes the version-bump branch; the native module is then a genuine drop-in for `openBlob`'s sealed branch; and today's `openBlob` correctly rejects a v2 blob with `unsupported envelope version 2`, which is the versioning mechanism working as designed and is asserted as a test. No spec amendment is needed: `blob.ts:50` already says the version byte versions the **framing**, not the ops, so this is the mechanism used as intended rather than a change to it.

    **Three functions take a version branch, not one — and an earlier draft of this decision said "`sealedRegion().start` gains 32 and every other rule is unchanged", which is wrong and ships a bug.** All three derive offsets independently:
    - `sealedRegion()` (`blob.ts:192-206`) — `start` gains `ENC_SIZE`.
    - `embeddedAAD()` (`blob.ts:212-216`) — returns `subarray(VERSION_SIZE + AAD_LEN_SIZE, start − NONCE_SIZE)`. Left unbranched, `start` has moved but the slice end has not, so **the AAD compare reads the 32 bytes of `enc` as part of the AAD** and every open fails — or, worse, passes for the wrong reason if the generator makes the same mistake symmetrically.
    - `overhead()` (`blob.ts:158-160`) — sums `VERSION_SIZE + AAD_LEN_SIZE + aadLen + NONCE_SIZE + PAYLOAD_LEN_SIZE + TAG_SIZE`. Left unbranched, `bucketFor()` under-counts by 32 and a record near a bucket boundary silently overruns its bucket.

    Implement the branch in one place — a `frameLayout(version)` helper returning `{encSize}` that all three consult — rather than three independent `if (version === 2)` tests, which is how two of them end up agreeing and the third does not. Pin it with a test that seals a v2 blob whose payload lands one byte under the 1 KB boundary and opens it, and a test asserting `embeddedAAD()` of a v2 blob equals `aadBytes(envelope)` exactly. **Every benchmark record must fit the 1 KB bucket** — the generator asserts `record_size === 1024` and fails loudly on any source row that does not, rather than silently emitting a mixed-width corpus. (An earlier draft claimed records were both "1 KB-bucket-padded" *and* "fixed-width with a single `record_size`", which are only compatible if that assertion holds; now it is enforced instead of assumed.)

---

## What this phase deliberately does NOT do

- **No cryptography in the product path.** No HPKE sealing of real blobs, no DEK, no wraps, no recovery phrase, no passphrase, no Argon2id, no TOFU pinning, no comparison code, no upload jitter. Phase 3. The native module and the synthetic sealed corpus are benchmark instruments and live in `app/src/bench/`.
- **No Android.** iOS only. Do not add `android/` config beyond what `expo prebuild` generates.
- **No public `:443`, no autocert, no TLS work.** Tailscale HTTPS for the device. Phase 1's Task D4.
- **No backup relay.** Phase 1's Task D3, still blocked on the Vultr VPS. `mx2.sirdab.ae` still does not resolve; that stays true through Phase 2 and is a Phase 4 blocker, not this plan's.
- **No rich/decrypted push, no Notification Service Extension.** Content-free push only (§3.8).
- **No TypeScript heuristic tier** (Decision 6). Client reprocessing covers the template rung.
- **No automated FX.** Manual `rate_set` ops (§3.7).
- **No snapshots or compaction of the op log.** Decision 5's fold snapshot is device-local and is not that.
- **No migration of v1 data.** Phase 3.
- **No TestFlight, no App Review, no privacy page, no ToS.** Phase 4.
- **No PWA changes.** Do not build or touch `frontend/` or `internal/web/dist/`.

---

## Spec items that need a human decision BEFORE execution starts

**`docs/superpowers/NEEDS-SALEH.md` is the operator-facing register and the authority on what is actually blocked.** It already carries items 1–4, 6, 7 and 9 below. This section exists to tie each one to the task it gates and to record the two the register does not yet have. Anything added here must be added there in the same commit; a decision list that lives only inside a plan file is a decision list nobody reads.

Nothing here can be resolved by reading the spec harder.

| # | Decision | Gates | In `NEEDS-SALEH.md`? |
|---|---|---|---|
| 1 | **The oldest target device is never named.** §5 says "the oldest target iPhone" and defines no support floor. Decision 11 makes it a hard input. Proposed default **iPhone 11 / A13**. Needs a named device *and* a device in hand. | P2, Task 1 | yes (§2) |
| 2 | **There is no Mac.** §3.9's prebuild requirement means EAS Build + Apple Developer Program; §1 budgets the account but not the build path, and enrolment is calendar-blocked. | P1, Task 1 | yes (§1) |
| 3 | **The Gmail verification email is permanently quarantined by design** (Decision 7) — the forwarder-domain rule holds it, so onboarding's happy path routes through the quarantine lane and the first thing a new alpha sees is a held message. | Task 15 | yes (§5) |
| 4 | **"Key UX built but crypto dormant" is under-delivered on purpose** (Decision 10) — labelled inert slots, no recovery phrase that recovers nothing. | Task 27 | yes (§5) |
| 5 | **Home currency is one-shot and immutable, with account deletion as the only remedy** (§3.7). | Task 14 | yes (§5), but see the costed options below |
| 6 | **The closed beta's gate** — Decision 8 picks a single-use invite code because an identity allowlist is unkeyable before first sign-in. Needs confirmation of the mechanism and of what a code-less sign-in says to the person holding the phone. | Task 6, Task 13 | yes (§5) |
| 7 | **Client-side reprocessing cannot cover heuristic-tier results** (Decision 6). Accept template-tier-only, or fund the heuristic port into the dialect. | Task 24 | no — **add** |
| 8 | **§3.10 puts export and account deletion in Phase 2; §5's exit criterion names neither.** This plan builds both. Confirm they are in scope — the exit test will not catch their absence. | Task 26 | no — **add** |
| 9 | **The Phase 3 cutover promise: migrate or wipe.** Task 27's copy refers to "the migrate-or-delete commitment", "the retention limit" and "the alpha consent document" as if settled. **The consent document does not exist and no task in this plan writes it.** The copy *is* the promise, and it is very hard to walk back once someone has three months of their finances in the app. | Task 27, Task 16 | yes (§6) |
| 10 | **The iOS deployment-target floor**, which is a separate question from the device model: an iPhone 11 can run iOS 15 or iOS 26, and the answer changes API availability, the Keychain accessibility constants Task 13 uses, and the bundle size Task 1's `T_paint` is measured against. | P2, Task 3, Task 13 | no — **add** |
| 11 | **Phase 3 needs an `enc` slot the frozen frame does not have** (Decision 12). Either the envelope version bumps or HPKE uses a per-user static ephemeral. Not this plan's call; recorded so Phase 3 does not discover it at sealing time. | — (Phase 3) | no — **add** |

**Item 5 deserves designs, not a yes/no.** Presenting immutability as accept-or-don't gives the user nothing to choose between. Two costed options, either of which Task 14 can build:

- **(a) Mutable until the first freeze.** Allow `home_currency_set` to be superseded for as long as **no transaction has a non-null `amount_home_minor`** anywhere in the log. Replay already knows this — it is `pendingByCurrency` being total. Cost: one extra op type, one guard in `applyOp`, and a rule that is checkable and explainable ("you can still change this because nothing has been converted yet"). Covers the realistic mispick, which happens in the first minutes.
- **(b) A `home_currency_reset` op with a full re-freeze.** Every snapshot in the log is recomputed under the new base at the reset's position. Cost: it violates §3.7's "already-frozen snapshots are never rewritten" for one op type, so it needs its own determinism argument and its own invariant; and every historical rate has to be re-entered because `rate_micro` is *home units per foreign unit* and its meaning changes. Substantially more work, and it reopens a rule the rest of the system leans on.

Recommendation: **(a)**. It is cheap, it is provably safe (no frozen value can change because none exists), and it covers the case that actually occurs.

---

## File structure created by this plan

```
spike/phase2/
  .gitignore                        # contains "*" — nothing under here is ever committed
  work/                             # $W: corpus.db, corpus.bin, recipient keys, device reports
cmd/ledgerd/
  loadcorpus.go                     # `ledgerd load-corpus` — THE SEALED-CORPUS LOADER (Task 1)
internal/v2/blob/
  encv2.go                          # envelope framing version 2 (+32-byte enc), bench-only
cmd/gen-phase2-corpus/              # build-tagged generator; never runs under `go test ./...`
  main.go
app/
  .gitignore                        # node_modules/ ios/ android/ .expo/ — created BEFORE any git add
  package.json  app.json  eas.json  tsconfig.json  metro.config.js  babel.config.js
  index.ts
  modules/ledger-crypto/            # Expo Module, Swift/CryptoKit — BENCHMARK ONLY
    expo-module.config.json
    ios/LedgerCryptoModule.swift
    src/index.ts                    # openOne / openBatch / rssBytes / launchUptime
  src/
    bench/                          # Task 1 + Task 28 instruments, never in the product path
      BenchScreen.tsx  arms.ts  corpus.ts  report.ts
    platform/                       # Task 4: the RN half of client/src's four seams
      hash.ts  gzip.ts  signing.ts  bytes.ts  index.ts
    db/                             # Task 5, 7, 9
      driver.ts  schema.sql  store.ts  rowstore.ts  projection.ts  snapshot.ts
    sync/                           # Task 8, 10, 11, 12
      engine.ts  cold.ts  outbox.ts  checkpoint.ts  invariants.ts
    auth/                           # Task 13
      idp.ts  session.ts  keys.ts
    screens/                        # Tasks 14-27
      onboarding/  transactions/  review/  budget/  currencies/  quarantine/
      settings/  import/
    components/                     # shared UI, catalogued in app/src/components/README.md
    lib/                            # pure, framework-free, each with a co-located *.test.ts
  test/
    device/                         # on-device conformance + measurement scripts
client/src/
  platform.ts                       # Task 4: the injectable seam (Bun impl stays the default)
  store/store.ts                    # Task 5: RowStore split
  replay/replay.ts, state.ts        # Task 7: unparsed + zero-amount ops
internal/v2/
  api/templates.go                  # Task 24: GET /api/v1/templates
  api/dict.go                       # Task 20: POST /api/v1/dictionary/submissions
  api/sync.go, auth/*               # Task 6: allowlist, roster, rotation nonce
conformance/
  crypto/                           # Task 1: Phase-3-shaped sealed vectors, Go-authored
  import/                           # Task 23: CSV → normalized rows, dual-executor
docs/superpowers/specs/
  v2-phase2-crypto-gate.md          # Task 1's verdict — the gate of record
  v2-gmail-forwarding-record.md     # Task 2's measurement
  v2-phase2-exit-record.md          # Task 29
```

---

## Task map (31 build tasks + 3 prerequisites)

| Part | Tasks |
|---|---|
| 0 — Prerequisites (procurement, calendar-blocked, start day 0) | P1 Apple/EAS · P2 oldest device · P3 the pipeline up on `dinosaur` |
| A — Inherited state and the two unmeasured risks (in this order) | **0 Phase 1 inheritance check** · **1 native-crypto gate (HARD GATE)** · **1b the fold on Hermes (HARD GATE)** · 2 Gmail forwarding measurement |
| B — Foundations | 3 app scaffold · 4 platform seams · 5 SQLite store · 6 server beta-blockers · 7 unparsed ops in replay |
| C — The on-device data layer | 8 sync engine · 9 warm start + fold snapshot · 10 cold stream · 11 writer, outbox, checkpoints · 12 invariants + halt UX |
| D — Onboarding | 13 sign-in · 14 onboarding shell + home currency · 15 inbound address + forwarding · 16 bank picker, waitlist, donation · 17 quarantine lane |
| E — The product | 18 transactions · 19 review queue · 20 categorization + dictionary · 21 budget · 22 currencies + FX · 23 CSV import · 24 client reprocessing · 25 push + watchdog · 26 export + deletion · 27 key-UX slots |
| F — The gate that proves it | 28 Gate B (end-to-end measurement) · 29 the exit scenario |

**Dependency spine.** Corrected from an earlier draft that was materially wrong — a fresh implementer parallelising off it would have built the review queue on a `Txn` that has no `unparsed` field.

```
P1 ─────────────► 1 ──► 1b ──► 3 ──► 4 ──┬──► 5 ──┬──► 8 ──┬──► 9 ──┐
P2 ─────────────►                        │        │        ├──► 10 ─┤
0 (inheritance) ►                        │        │        └──► 11 ─┴──► 12
P3 ──► 2 ───────────────────────────────►│        │
                                         │        ├──► 18, 21, 22
6 ──┬──────────────────────────────────► 13 ──► 14 ──► 15 ──┬──► 16
    └──► (invite code, exchange nonce)                      └──► 17
7 ──┬──► 18   7 ──► 19 ──► 20   7 ──► 21   7 ──► 24
4, 5 ──► 13        5 ──► 23        {10, 7} ──► 24
{1, 1b, 8, 9, 5} ──► 28
{11, 12, 13..27, 28} ──► 29
```
Read the edges that are easy to miss: **`7 → {18, 19, 21, 24}`** (the review queue's unparsed lane, the transaction row's "couldn't read this one" state, the budget's unparsed exclusion, and reprocessing's target set all need Task 7's `Txn` fields); **`{4,5} → 13`** (sign-in needs the Ed25519 seam and the `SecretStore`); **`{10,7} → 24`** (reprocessing needs verified cold bodies *and* unparsed rows to target). Task 29 exercises Tasks 13–27, not merely `{11,12,28}`. Tasks 16, 23, 25, 26, 27 are leaves once their ancestor lands.

---

## Part 0 — Prerequisites (procurement; calendar-blocked; start on day 0)

These are not engineering tasks. They are here because Task 1 cannot start without P1 and Task 2 cannot start without P3, and both have lead times measured in days.

### P1: Apple Developer Program, EAS, device provisioning

- [ ] Enrol in the **Apple Developer Program** ($99/yr, budgeted in spec §1). Individual enrolment is usually same-day to 48 h; it is occasionally much longer, which is why this is day 0.
- [ ] Create an **Expo/EAS account** and run `bunx eas login` from the repo. Confirm the free-tier iOS build quota is sufficient for ~10 development-client builds over Phase 2; record the quota and any queue-priority caveat in the task report.
- [ ] Register the target device UDIDs with `bunx eas device:create` (this is what makes an ad-hoc internal-distribution build installable). Register **both** the oldest target device (P2) and the operator's daily driver, so results on the two are directly comparable.
- [ ] Create an **APNs key** in the Apple developer portal and upload it to Expo (`bunx eas credentials`). Needed by Task 25, not by Task 1, but it is the same portal visit.
- [ ] **Exit:** `bunx eas build:list` runs authenticated; `bunx eas device:list` shows both devices.

### P2: Name and acquire the oldest target device

- [ ] Decide the support floor (see "needs a human decision" item 1; proposed default **iPhone 11 / A13**). Record it in `docs/superpowers/specs/v2-phase2-crypto-gate.md`'s header when Task 1 writes it.
- [ ] Acquire or borrow one. Put it on the tailnet (Tailscale iOS app, same tailnet as `dinosaur`) and confirm it can reach `https://<dinosaur>.<tailnet>.ts.net/api/v1/healthz`.
- [ ] **Exit:** the device is in hand, on the tailnet, and its UDID is registered per P1. If it is not, Task 1's verdict may not be PASS (Decision 11).

### P3: Bring the Phase 1 pipeline up on `dinosaur` for Phase 2 use

Phase 1 closed with 38/38 build tasks but zero deployment tasks. Nothing is currently listening. This is the minimum to make Tasks 2, 15 and 29 possible, and it is deliberately *less* than Phase 1's D-series (no public `:443`, no relay).

- [ ] Provision a v2 PostgreSQL database on `dinosaur` (Postgres 16.14 is installed and its system service is **disabled** — enable it, or run the same throwaway-cluster pattern `internal/v2/pgtest` uses, and record which). Create the `ledgerd` role and database. Do **not** touch `/var/lib/ledger`.
- [ ] Build and install `ledgerd`, and a systemd unit modelled on `deploy/ledger.service`'s hardened sandbox. Config from `/etc/ledgerd/config.toml`, secrets from `/etc/ledgerd/ledgerd.env` (`LEDGER_ADMIN_TOKEN`, IdP client IDs; **never** in TOML).
- [ ] `http_listen = "127.0.0.1:8443"`, `admin_listen = "127.0.0.1:8079"` — both loopback, which is what `config.validate()` requires. Front the API on a **new** tailnet port:
  ```bash
  sudo tailscale serve status                                        # capture BEFORE
  sudo tailscale serve --bg --https=8444 http://127.0.0.1:8443
  sudo tailscale serve status                                        # capture AFTER; diff them
  ```
  **A bare `tailscale serve https / …` would replace the `/` proxy and take the operator's live v1 PWA offline**, and `--https=8443` is already claimed by the Storybook path serve. Both captures go in the task report. The device's base URL is `https://dinosaur.<tailnet>.ts.net:8444`.
- [ ] **Seed and publish the three templates.** `ledgerd` starts with an empty `templates` table, and Task 2 records `template_id` / `template_version` / `matched` / `tier` per message and needs "≥5 messages spanning all three seeded templates". Run Phase 1's seed path (`internal/v2/tmpl/seed/`) and promote each definition to `published`. **Exit condition for this bullet:** `GET /admin/templates` lists three published templates, and a replayed corpus message matches one of them.
- [ ] Open inbound `:25`: `sudo ufw allow 25/tcp` (and the v6 rule), and **check the Hetzner Cloud Firewall at the panel level** — Phase 0 explicitly did not inspect that layer and it can block upstream of the host. Confirm `mx1.sirdab.ae` is DNS-only (not Cloudflare-proxied) and resolves to `178.104.132.41`; confirm `in.sirdab.ae MX 10 → mx1.sirdab.ae`.
- [ ] Verify end to end: `swaks --to u-<token>@in.sirdab.ae --server in.sirdab.ae` from an external host delivers, and `GET /admin/diagnostics` shows the arrival.
- [ ] **Known and accepted:** `mx2.sirdab.ae` does not resolve (no relay VPS). A priority-20 MX pointing at nothing is harmless while mx1 is up and actively harmful when it is down. Record it as an open Phase 4 blocker; do not paper over it.
- [ ] **Exit:** an external SMTP delivery reaches `parse_diagnostics`, and the iPhone in P2 gets `{"status":"ok","db":"ok"}` from `/api/v1/healthz` over Tailscale HTTPS.

---

## Part A — Inherited state, and the two unmeasured risks

### Task 0: The Phase 1 inheritance check

Phase 2 was planned against a Phase 1 that was still moving. This task takes ten minutes and stops three tasks from being written against a tree that has changed underneath them. **It is verification, not a decision**, and it must run before Task 1 rather than being discovered at Task 6 or Task 11.

- [ ] **Step 1: The ingest-writer chain fix.**
  ```bash
  git log --oneline --all | grep -i 'cover the ingest chain'
  grep -n 'ensureIngestWriterTx' internal/v2/auth/writer.go internal/v2/auth/session.go
  ```
  **Verified landed as of this plan's revision: commit `f0ac846`.** (It was HEAD when this plan was revised and is now several commits back — this branch moves under three concurrent sessions, so re-run the grep rather than trusting the position.) `ensureIngestWriterTx` is called from `auth.UpsertUser` (`session.go:357`) and from writer registration (`writer.go:606`), inside the caller's transaction. Two client-side halves came with it and Tasks 11 and 12 must build on them rather than around them: `checkRosterCheckpoint` now iterates **all live roster writers** rather than the device subset, and `observedHead()` gained `pinnedBlobHashes` as a fourth evidence source.

  **An earlier draft of this plan got the defect wrong** and it is worth recording so nobody re-derives it: `auth.Writers.Roster` (`writer.go:639`) is `SELECT user_id, writer_id, kind, pubkey, … WHERE user_id = $1` with **no kind filter**, and `handleRoster` (`api/sync.go:319`) passes it through unchanged. The roster never filtered `ingest` out — the `writers` row simply never existed. If Step 1 ever fails on a fresh checkout, the fix is `ensureIngestWriterTx`, not a roster filter.

  If the grep comes back empty, **stop**: Phase 2 waits, because Tasks 11, 12 and 29 all assert on checkpoint coverage of the ingest chain. The `v2-phase1-exit-record.md` notice-list update belongs to whoever lands the Phase 1 fix, not to this plan — Task 6 must not touch that file (Global Constraints' shared-file rule).

- [ ] **Step 2: The I11 escape hatch.** `grep -n 'VIOLATION_ROSTER_COVERAGE\|VIOLATION_CHAIN_WITHHELD' client/src/invariants/check.ts`. Both ids existing means Phase 1's Task 14 fix round 2 landed — the benign "no checkpoint yet / roster grew" case and the adversarial "the server is withholding rows a peer has already witnessed" case have separate ids, so the push-time escape can cover only the benign one. **Verifying that it actually does is Task 11 Step 1**, which needs no app and may run any time from here; this step only records which ids exist.

- [ ] **Step 3: The baseline the whole plan measures against.**
  ```bash
  cd client && bun test 2>&1 | tail -4
  bash scripts/v2-check.sh
  git rev-parse --short HEAD
  ```
  Record all three verbatim in the task report. Measured as of this plan's revision: **1,911 collected / 1,875 pass / 35 skip / 1 fail**. The 35 skips are the e2e files self-skipping without `LEDGER_TEST_POSTGRES_URL`.

  **The 1 fail is Task 1b's first data point arriving early. Do not raise the limit.** `fx.test.ts`'s *"incremental application in seq order equals a full re-fold from 0, at EVERY prefix"* timed out at **5,708 ms against a 5,000 ms limit** — a fold-performance timeout, on the exact code path Task 1b exists to gate, on a fast Linux box under Bun, before Hermes and its slower BigInt are anywhere near it. Another session has attributed it to load from a concurrent run, and that may well also be true; both can be, and that is precisely why it must not be dismissed. An earlier draft of this step offered "raise the limit with a comment" as the first of two equal options; raising it now erases the earliest evidence available that inserting Task 1b was the right call.

  So: **record the failure verbatim, change nothing, and leave the limit where it is until Task 1b returns.** Re-run it three times on an otherwise idle box and record all three timings — that separates concurrent load from a genuine 14 % overshoot. Then:
  - Task 1b returns **CONFIRMS** → the limit may be raised, in Task 1b's own commit, with a comment citing Task 1b's measured `foldMs` as the justification.
  - Task 1b returns **RENEGOTIATES** or **BLOCKS** → this failure is **corroboration, not flake**, and it belongs in the gate document as an independent second observation of the same problem on a different engine.

- [ ] **Step 4: Migrations.** `ls internal/v2/pg/migrations/`. Highest today is **`00019_push_token_device_link.sql`**, so the next free number is **`00020`**. `00004` and `00015` are both vacant — `00004` by controller ruling (goose hard-fails if a migration appears below an applied version), `00015` unexplained. **Never claim either.** Re-run this listing at the moment you write a migration; three sessions are concurrent.

- [ ] **Step 5: Phase 1's unreviewed surface.** Phase 1's ledger records *"Critics still owed: 21, 23, 25, 26, 27, 28, 30, 31, 32, 35, 36, 37, 38"* — 13 of 38 tasks never adversarially reviewed at close, and fix rounds are in flight across `internal/v2/origin/`, `pushv2/`, `verify/` and the client. Record which of those tasks Phase 2 leans on (25/26 origin trust → Task 2; 27 quarantine → Tasks 15/17; 29 push → Task 25; 31 samples → Task 16; 33 dictionary → Task 20) so that a defect found later has a known blast radius. **Do not edit any file under an in-flight fix round.**

---

### Task 1: The native-crypto JSI benchmark and the Phase 2 gate (HARD GATE, RISK-FIRST)

**This task decides whether the rest of Phase 2 gets built as written.** Spec §5 makes it mandatory and first; `spike/phase0/RESULTS.md` conditions its PROVISIONAL PASS on it.

**Files:**
- Create: `spike/phase2/.gitignore` (contents: `*`) — **first, before anything else is written**
- Create: `cmd/gen-phase2-corpus/main.go` — build-tagged (`//go:build phase2corpus`) so `go test ./...` and `go build ./...` never trip it. Not a `_test.go` file: an earlier draft made it `internal/v2/blob/phase3vectors_test.go`, a generator disguised as a test that read `/var/lib/ledger` and wrote committed artifacts.
- Create: `internal/v2/blob/encv2.go` — envelope framing version 2 (Decision 12), bench-only, with a package doc saying so
- Create: `cmd/ledgerd/loadcorpus.go` — **`ledgerd load-corpus`, the sealed-corpus loader** (see Step 2; this is the deliverable both gates depend on)
- Create: `app/.gitignore` — **before** any `git add app`
- Create: `app/` minimal SDK-54 shell (`package.json`, `app.json`, `eas.json`, `tsconfig.json`, `babel.config.js`, `index.ts`) — Task 3 grows this into the product shell
- Create: `app/modules/ledger-crypto/` (Expo Module: `expo-module.config.json`, `ios/LedgerCryptoModule.swift`, `src/index.ts`)
- Create: `app/src/bench/{BenchScreen.tsx,arms.ts,corpus.ts,report.ts}`
- Create: `conformance/crypto/vectors.json` — **synthetic only** (Step 1)
- Create: `docs/superpowers/specs/v2-phase2-crypto-gate.md` — **the deliverable of record**
- Writes to `$W` (gitignored): `corpus.db`, `corpus.bin`, `recipient.key`, device report JSON

**Interfaces — the native module:**

```ts
// app/modules/ledger-crypto/src/index.ts
export interface OpenParams {
  recipientPriv: Uint8Array;   // 32 bytes, X25519
  info: Uint8Array;            // HPKE info string
}
/** One framed v2 blob. Synchronous, on the JS thread. Measurement arm only. */
export function openOne(record: Uint8Array, p: OpenParams): Uint8Array;
/**
 * Many framed v2 blobs, on a background DispatchQueue.
 *
 * Takes explicit offsets rather than a fixed record width: real blobs are
 * bucketed at seven sizes, so a `(records, recordSize)` signature is one
 * production can never call — which would make "the production candidate" arm
 * a measurement of an API that does not exist.
 */
export function openBatch(records: Uint8Array, offsets: Uint32Array, p: OpenParams): Promise<Uint8Array[]>;
/** A native call that does nothing. Isolates JSI crossing + marshalling cost. */
export function noopOne(record: Uint8Array): number;
export function noopBatch(records: Uint8Array, offsets: Uint32Array): Promise<Uint8Array[]>;
/** Resident set size in bytes, via mach task_info. Closes RESULTS.md Caveat 6. */
export function rssBytes(): number;
/** ProcessInfo.thermalState as "nominal"|"fair"|"serious"|"critical". Closes Phase 0's thermal gap. */
export function thermalState(): string;
/** systemUptime captured in application(_:didFinishLaunchingWithOptions:). */
export function launchUptime(): number;
/** Current systemUptime, same clock as launchUptime(). */
export function nowUptime(): number;
```

Swift side: `Curve25519.KeyAgreement.PrivateKey(rawRepresentation:)` → `sharedSecretFromKeyAgreement(with:)` → `HKDF<SHA256>.deriveKey(inputKeyMaterial:salt:info:outputByteCount: 32)` → `AES.GCM.open(AES.GCM.SealedBox(nonce:ciphertext:tag:), using:)`. `openBatch` uses `DispatchQueue.global(qos: .userInitiated)` and resolves on the main queue.

**The record format is the envelope the code already ships, at framing version 2 (Decision 12).** Read Decision 12 before writing a byte. Layout:

```
 0                       VERSION = 2
 1 .. 3                  AAD_LEN (uint16 BE)
 3 .. 3+aadLen           AAD bytes, cleartext, = aadBytes(envelope)
                         "<user_id>|<stream>|<writer_id>|<writer_counter>"
 +32                     enc: ephemeral X25519 public key   <-- the ONLY v2 addition
 +12                     nonce (random 96-bit; v1 leaves this zero)
 [ sealedRegion:  PAYLOAD_LEN (uint32 BE) ‖ gzip(op JSON) ‖ zero padding ]
 last 16 bytes           GCM tag (v1 leaves this zero)
```
`sealedRegion().start` gains 32 relative to v1; nothing else moves. The AES-GCM AAD is the **embedded AAD bytes**, so a native open reproduces `openBlob`'s byte-compare cryptographically instead of structurally — which is exactly the Phase 3 substitution. **Assert `record_size === 1024`** (every record in the 1 KB bucket) and fail the generator on any source row that does not fit; a mixed-width corpus would silently invalidate `offsets` and every per-blob figure derived from it.

- [ ] **Step 0: Confirm prerequisites.** P1 complete (`bunx eas device:list` shows the target), P2 complete (oldest device in hand and on the tailnet). **If the oldest device is not available, record it now** — the verdict may then be CONDITIONAL or FAIL but never PASS (Decision 11).

- [ ] **Step 1: Generate the corpus into `$W`. Nothing real is ever committed.**

  ```bash
  mkdir -p spike/phase2 && printf '*\n' > spike/phase2/.gitignore   # FIRST
  W=/root/Coding/ledger/.claude/worktrees/v2/spike/phase2/work && mkdir -p "$W"
  sudo sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup $W/corpus.db"
  sudo chown "$(id -un)" "$W/corpus.db"
  go run -tags phase2corpus ./cmd/gen-phase2-corpus \
      --db "$W/corpus.db" --out "$W/corpus.bin" --key-out "$W/recipient.key" \
      --manifest conformance/crypto/manifest.json
  ```
  Source query verbatim from `spike/phase0/blobgen` so counts and payload sizes stay comparable: `SELECT t.fingerprint, t.posted_at, t.amount, t.currency, t.direction, COALESCE(t.merchant_raw,''), COALESCE(c.bucket,''), t.status FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ORDER BY t.posted_at`.

  **What goes where, and this is the whole point of the step.** `corpus.bin`, `corpus.db` and `recipient.key` are the operator's three-year financial history and a private key; they live in `$W` and **are never committed, never copied to `conformance/`, and never printed to a terminal that ends up in a task report.** An earlier draft of this plan committed the sealed corpus and a `vectors.json` holding ten real transactions **in cleartext**, in a repo with a `gh pr create` workflow. That is the finding this step exists to prevent; it is recorded rather than quietly fixed.

  What is committed is `conformance/crypto/manifest.json`: `count`, `record_size` (asserted `1024`), `envelope_version` (`2`), `recipient_pub`, `aad_template` — **and the correctness reference as a salted digest, not as amounts.** An earlier draft put "three months of aggregate bucket totals" in the committed manifest, which is real AED figures and is exactly what Global Constraints forbid ("any file containing a real merchant or amount"). A monthly `need`/`want`/`saving` total is also small enough to be worth guessing at, so a digest is not theatre. The manifest carries:
  ```json
  "check": { "salt": "<32 random bytes, hex — generated once, committed>",
             "digest_alg": "sha256",
             "months": { "2026-06": { "blind": "<hex>", "home": "<hex>" }, … } }
  ```
  where each digest is `SHA-256(salt ‖ month ‖ bucket ‖ decimal-string total)` over the sorted buckets. Task 28 recomputes the digest from what the device materialized and compares; a mismatch fails the run and the **actual** totals are printed only to the device report in `$W`, never to a committed file. The salt is committed because it is not a secret — it exists so the digest is not a rainbow-table lookup of a four-figure AED amount, which an unsalted hash of a plausible total would be.

- [ ] **Step 1b: Synthetic cross-language vectors.**

  `conformance/crypto/vectors.json` holds **10 records generated from a seeded PRNG with fabricated merchants and amounts** (`--synthetic --seed 20260802`), each with its expected plaintext base64. These are the only sealed vectors that may be committed. They pin the format, which is all the cross-language check needs — a real transaction proves nothing a fabricated one does not. Include one record whose AAD deliberately mismatches, so an implementation that ignores AAD fails.

- [ ] **Step 2: Build `ledgerd load-corpus` — the sealed-corpus loader. Both gates depend on it and nothing else can produce this shape.**

  Neither gate is executable without this and an earlier draft of this plan assumed the corpus could simply be pulled from a running server. It cannot: P3 brings up an **empty** database, `POST /api/v1/sync` caps at 8 blobs / 12 MiB, the server rejects a client authoring as `ingest` with 403, and the only path that creates ingest singletons is real SMTP delivery — which is not going to deliver 3,683 messages. And the obvious workaround, client-authoring the corpus, yields ~5 batched blobs, i.e. `fetchMs` measured against a **batched** transport instead of 3,683 singletons. That is `RESULTS.md` Caveat 7 verbatim: the exact error this plan spends a page attacking.

  ```
  ledgerd load-corpus --user <uuid> --in $W/corpus.bin --manifest conformance/crypto/manifest.json
                      [--stream hot] [--singleton] [--envelope-version 2]
  ```
  Admin-only (Tailscale-bound listener, admin token), refuses to run against a database holding more than one user, and writes each record as **one hot blob under the `ingest` writer** at its real bucket size, allocating `seq` and the ingest chain through the same `oplog.Appender` the SMTP pipeline uses — so the rows are indistinguishable from real arrivals to every reader. Tests: N records in → N rows out with contiguous `ingest|hot` counters 1..N; the chain verifies from genesis; `--singleton` is not optional in Phase 2 and a batched mode is rejected with a message naming Caveat 7.

  **`T_rest`'s fetch component is measured against this shape and no other.** Any measurement taken against a batched upload is void and must be re-run.

- [ ] **Step 3: Scaffold `app/` at SDK 54, gitignore first, then prebuild a dev client.**

  ```bash
  mkdir -p app && cd app
  printf 'node_modules/\nios/\nandroid/\n.expo/\n*.ipa\n' > .gitignore   # BEFORE any git add
  bun init -y
  bun add expo@54.0.36 react@19.1.0 react-native@0.81.5 expo-sqlite@16.0.10 \
          expo-dev-client expo-status-bar@3.0.9 \
          @noble/curves@2.2.0 @noble/hashes@2.2.0 @noble/ciphers@2.2.0 fflate@0.8.3
  bun add -d typescript@5.9.2 @types/react@19.1.17
  ```
  **Do not run `create-expo-app@latest`** — it scaffolds SDK 57, which the App Store build of Expo Go and this plan's pins both refuse. Pin `"expo": "54.0.36"` exactly (Phase 0's `package.json` declared `^54.0.0` and leaned on `bun.lock`; do not repeat that). Then:
  ```bash
  bunx expo prebuild --platform ios --clean
  bunx eas build --profile development --platform ios
  ```
  Install the resulting build on the P2 device. Without the `.gitignore` first, Step 10's `git add app` sweeps the prebuilt `ios/` tree and `node_modules`.

- [ ] **Step 4: Write the cross-language conformance test first, and watch it fail.**

  `app/test/device/vectors.test.ts` (run under Bun against the `@noble` arm, and on-device against the native arm) asserts all 10 synthetic `conformance/crypto/vectors.json` records open to their expected plaintexts; that the AAD-mismatched record **throws**; and that today's `openBlob` rejects a v2 blob with `unsupported envelope version 2`, which is the framing-version mechanism working as designed. The AAD assertion is not optional — without it an implementation that ignores AAD entirely passes, the exact defect Phase 1's Task 10 caught in its own first draft.

  Run: `cd app && bun test test/device/vectors.test.ts` → FAIL (module missing).

- [ ] **Step 5: Implement the Swift module and the five arms.**

  | Arm | What it is | Why it is measured |
  |---|---|---|
  | `noble` | pure JS `@noble/curves` x25519 + `@noble/hashes` hkdf + `@noble/ciphers` gcm | **The control.** Reproduces Phase 0's 14.86 ms/blob *on this device*, so `R` is a within-device ratio and not a comparison across two iPhones. |
  | `noopOne` | a native call that returns immediately, per record | Isolates JSI crossing cost from crypto cost. Without it `nativeOne` conflates the two and a slow result is unattributable. |
  | `noopBatch` | one native call, all offsets, returns the arrays | Isolates **return marshalling** — `Promise<Uint8Array[]>` across the bridge at N=3,683 is itself an unmeasured cost. |
  | `nativeOne` | `openOne` per record, synchronously | Per-crossing overhead **plus** crypto; subtract `noopOne` for the crypto share. |
  | `nativeBatch` | `openBatch(records, offsets)` over chunks of 250, `await`ed | The production candidate, and the only arm that can be responsive. |

  Optional sixth arm `quickCrypto` (`react-native-quick-crypto`) if it installs cleanly — measured for evidence, not adopted (Decision 1).

  **Traps, each stated because a plausible implementation hits it:**
  - Every record uses a **distinct** ephemeral public key. Reusing one accidentally measures fallback F4 and reports a speedup the production design does not have.
  - Do not hoist the HKDF derive out of the loop. Phase 0 hoisted `derivePub` because it was constant; the per-record derive is not.
  - Warm once with 250 records and discard, then **5** timed passes per arm. Report median **and** full spread; report pass 1 separately (Phase 0's Run 1 was 12 % above its median and the discard the protocol called for never happened).

- [ ] **Step 6: The thermal protocol. Without it the medians are throttling artifacts.**

  Phase 0 recorded no thermal state at all and named it as a gap. The control arm alone is 5 × 3,683 × ~15 ms ≈ **274 s of continuous BigInt per arm**, which guarantees throttling *within* the arm, not merely between arms — and "force-quit and relaunch between arms," which an earlier draft of this plan offered as the control, does not cool a device.

  - Call `thermalState()` **before and after every pass** and record both. A pass that starts at anything other than `.nominal` is discarded and re-run.
  - Between passes and between arms, idle the device screen-off until `thermalState() === "nominal"`, with a floor of 120 s. Record the wait.
  - **Counterbalance arm order** across the 5 passes (e.g. pass 1 `noble → native`, pass 2 `native → noble`, alternating). A fixed order systematically advantages whichever arm runs first on a cool device.
  - If a pass ends at `.serious` or `.critical`, mark the whole run thermally-compromised in the report and treat its verdict as CONDITIONAL at best.

- [ ] **Step 6b: The control arm may not survive the floor device — plan the degradation.**

  An iPhone 11 has 4 GB of RAM, and Phase 0's pre-fix build was jetsam-adjacent at >500 MB on a *newer* phone. The control arm allocates ~6.7 GB and triggers ~1,643 GCs per pass. If `noble` is killed there is no within-device ratio, which is the entire point of the control.

  **Fallback protocol, decided now rather than improvised at 11pm:** run the control over a **500-record subsample** (deterministically chosen, every 7th record) and scale linearly to N, reporting it explicitly as `C_noble (extrapolated from 500)`. A linear scale is defensible for this workload because per-blob cost is independent (Phase 0's own per-blob figure is a straight division). If even 500 is killed, drop to 100. Record which subsample size produced the number; a jetsam kill degrades the measurement, it does not void the gate.

- [ ] **Step 7: Build the first-paint instrument — the thing Phase 0 never measured — and say which clock the criterion is against.**

  Two clocks, and they measure different things:

  - **Instrument clock:** `launchUptime()` (captured in `application(_:didFinishLaunchingWithOptions:)`) → `nowUptime()` in a `useLayoutEffect` that runs after the first commit containing real data. This **systematically under-reads**: it starts after exec and dyld, and it ends at commit, before the GPU has painted a pixel.
  - **Recording clock:** a 240 fps screen recording, measured tap-to-first-legible-number. This is what a person experiences.

  **The `T_paint` criterion is defined against the recording clock.** The instrument is reported alongside it as a decomposition, not as the gate — an earlier draft made the instrument the criterion and then called a >15 % disagreement "the instrument is wrong," which would have fired on every run by construction. Report both, and report the delta as the launch-and-present overhead it is.

  Two further conditions or the number is meaningless: **the measured build loads an embedded bundle, never Metro** (`npx expo start --no-dev --minify` at minimum, `preview` profile preferred), and **Task 3 re-measures `T_paint` after the shell lands**, because navigation, Reanimated and the screens will roughly triple the bundle. Task 1's 1,200 ms threshold is against a near-empty shell; Task 3 records the delta and Task 28 measures the real one.

- [ ] **Step 8: Measure `T_rest` against the loader's shape, not `all.bin`.**

  Phase 0's `fetchMs` (2.47 s) came from one bulk 3.7 MB GET over a DERP-relayed link and its own document disclaims it. Measure instead against a database loaded by Step 2's `ledgerd load-corpus --singleton`: a paged pull from the real `ledgerd` (P3) over Tailscale HTTPS on `:8444` — `GET /api/v1/sync?stream=hot&after=<cursor>&limit=500`, honouring the 4 MiB per-page byte budget — for the full corpus, plus `decodeMs`, `insertMs` and a `bucketDebits`-shaped aggregate. Report whether the tailnet link is direct or DERP-relayed (`tailscale status`); Phase 0's was relayed and did not say so until its caveats.

- [ ] **Step 9: Apply the decision rule and write the verdict.**

  Define, from the medians:
  - `C_noble`, `C_native` = ms/blob for the control and the best native arm; `R = C_noble / C_native` (the speedup, within-device).
  - `T_crypto = C_native × N` where `N` is the corpus record count.
  - `T_rest` = Step 6's fetch + decode + insert + aggregate + db-open.
  - `T_paint` = Step 5.

  **Evaluate in this order and stop at the first match. FAIL wins over CONDITIONAL wins over PASS** — an earlier draft listed the branches without an order, so `T_crypto + T_rest = 12 000 ms` with `T_paint = 1 500 ms` satisfied both FAIL and CONDITIONAL and the gate was not decidable.

  | Order | Branch | Condition | Consequence |
  |---|---|---|---|
  | 1 | **FAIL** | `T_crypto + T_rest > 10 000 ms` **or** `T_paint > 2 000 ms`, with the best arm | **STOP.** Do not build Tasks 3+ as written. Phase 0's PROVISIONAL PASS is formally **revoked** — spec §5 requires it revisited before proceeding. Escalate the ladder below with costings. |
  | 2 | **CONDITIONAL** | `T_crypto + T_rest > 6 000 ms` **or** `T_paint > 1 200 ms` **or** the P2 floor device was unavailable **or** the run was thermally compromised (Step 6) | Proceed, with three changes: **F1 (progressive restore)** becomes mandatory in Task 8 rather than optional; Task 28's Gate B becomes a hard stop rather than a check; the ladder below is costed (not built) before Task 8 starts. |
  | 3 | **PASS** | everything else | Proceed with Phase 2 as written. |

  **Print the implied minimum speedup before the run, so the gate is legible while it is happening.** With `T_rest ≈ 3 000 ms` and N ≈ 3,683, PASS needs `T_crypto ≤ 3 000 ms`, i.e. `C_native ≤ 0.81 ms/blob`, i.e. **`R ≳ 18×`** against Phase 0's 14.86 ms/blob — and CONDITIONAL's ceiling needs `R ≳ 7×`. Note what that means against the projection table this plan opens with: **the 10× row does not clear the PASS threshold.** It clears the *spec's* 10 s gate, which is what CONDITIONAL is for. The bench screen computes and displays this line from the measured `T_rest` before the arms run.

  **Why 6 s and not the spec's 10 s.** Task 1's `T_rest` deliberately excludes everything `spike/phase0/RESULTS.md` Caveat 9 lists as unmeasured: causality and supersede resolution, per-entity version-head tracking, writer-chain verification over every blob, the quarantine lane, and §3.7's FX conversion during replay. The 4 s reserve is for those plus device-to-device variance. Task 28 measures the real number against the real 10 s gate; Task 1's tighter budget is what makes it safe to *start building* before Task 28 exists.

  **The fallback ladder, if FAIL.** State all five; the first two are the ones to cost.

  - **F1 — Progressive restore.** Redefine cold restore as "time to a correct, usable app over the visible window," not "time to the whole history." Restore newest-window-first, fold each window in ascending `seq`, paint the budget screen from the first window, stream the rest behind a visible progress affordance. Phase 0 already shows rows landing in SQLite per chunk. **Cost, stated honestly:** §3.3's prefix-monotonicity is over *ascending* `seq`, so a newest-first restore is not simply a reordering — an op whose parent has not arrived must become *pending* rather than *refused*, which is a real change to `applyOp`'s contract and to `I9_version_contiguity`. And it reinterprets a spec exit criterion, which is the user's call, not an engineering one.
  - **F2 — An uploaded, DEK-sealed state snapshot.** Attack the 3,683 count rather than the per-open cost: a device that has folded the log seals a snapshot and uploads it; a second device or a reinstall restores from one open plus the tail.

    **Its real cost is not byte-canonicity — it is that tamper-evidence collapses for the snapshotted prefix.** A device restoring from a peer's snapshot **skips the op log it would otherwise verify**, so for every op below the snapshot point it is trusting the authoring device's materialization rather than the writer chain. That is a direct weakening of §3.3's integrity story and §3.4's "detectable, not impossible" claim, and it is the thing to argue about. (§3.3:80's byte-canonicity prerequisite does also apply if the snapshot is ever *re-encoded into ops*, but a state snapshot that is only ever read as state does not trip it — see Decision 5.) Any F2 design needs a story for re-verifying the skipped prefix lazily in the background.

    **And the reframing an earlier draft leaned on is false in the case that decides it.** "Only device #2 and reinstalls pay cold restore" is wrong for Phase 3's migration of the operator's three-year history, which is a cold restore, on device #1, on day one — the exact case Decision 9 identifies as the reason the gate cannot be softened. F2 helps the second device and the reinstall; it does not help the migration.
  - **F3 — Client-side re-sealing of cold history into batched blobs.** Overlaps F2; helps the cold stream specifically. The server can never do this after Phase 3 (it cannot open what it sealed).
  - **F4 — Change the HPKE shape so 3,683 opens are not 3,683 X25519 scalar multiplications.** The KEM is the expensive half; AEAD is cheap. HPKE's own multi-shot API establishes one sender context and seals many messages under it with incrementing nonces — standard and safe. Applied to the ingest writer, that is one KEM per epoch rather than one per email. **Cost:** the server holds sender-context state across messages, §3.4's per-blob nonce/AAD story needs re-review, and this is Phase 3 design territory. Escalate to a security design pass, do not improvise it.
  - **F5 — Abandon local-first for the beta** (server-side materialized view, thin client). Named only so the ladder has a floor. It kills spec goal #1 and §3.9 and requires the user to reopen §1's goal ordering. This plan does not propose it.

- [ ] **Step 10: Emit a machine-readable report, not a hand transcription.**

  Every on-device number in this phase is evidence, and hand-copying it into prose is how evidence goes stale and unverifiable. The bench screen serializes one JSON document — device model, iOS version, build profile, bundle mode (embedded vs Metro), per-pass timings, thermal state before and after each pass, arm order, RSS samples, missed-frame counts, `T_paint` on both clocks, the tailnet link type, `R`, and the computed verdict — and shares it via `expo-sharing`. Commit it to `docs/superpowers/specs/v2-phase2-crypto-gate.report.json` alongside the prose. It contains no financial data by construction (timings and counts only); assert that in a test over the report's key set.

- [ ] **Step 11: Write `docs/superpowers/specs/v2-phase2-crypto-gate.md`.** The prose deliverable: device (make, model, iOS version, and **whether it is the P2 floor device**); iOS deployment target; corpus count, record size and envelope version; the per-arm × per-pass table with medians, spreads and thermal states; `C_noble` (and whether it was subsampled per Step 6b), `C_native`, `R`, the implied-minimum-`R` line, `T_crypto`, `T_rest`, `T_paint` on both clocks; peak RSS; the arm-order counterbalance; the tailnet link type; the branch taken; and, if not PASS, the costed ladder. **Also record the `enc`-slot gap** (Decision 12) as a Phase 3 finding. Model it on `spike/phase0/RESULTS.md`'s honesty — that document names its own caveats before anyone else can, which is why it is trustworthy.

- [ ] **Step 12: Commit explicit paths, then verify, then stop for sign-off.**
  ```bash
  git add app/.gitignore spike/phase2/.gitignore app cmd/gen-phase2-corpus cmd/ledgerd/loadcorpus.go \
          internal/v2/blob/encv2.go conformance/crypto \
          docs/superpowers/specs/v2-phase2-crypto-gate.md docs/superpowers/specs/v2-phase2-crypto-gate.report.json
  git show --stat HEAD 2>/dev/null; git diff --cached --stat
  ```
  **Read that `--stat` before committing.** It must not contain `corpus.bin`, `corpus.db`, `recipient.key`, `node_modules/`, `ios/`, or anything under `spike/phase2/work/`. Then commit with `feat(v2): native crypto module, sealed-corpus loader, on-device benchmark, and the Phase 2 gate`.

  **Do not start Task 1b or Task 3 until the user has read the verdict.**

---

### Task 1b: The fold on Hermes — measuring the reserve instead of asserting it (HARD GATE)

Task 1's budget is 6 s rather than the spec's 10 s, and the 4 s difference is a reserve covering five terms `spike/phase0/RESULTS.md` Caveat 9 lists as unmeasured: causality/supersede resolution, per-entity version-head tracking, writer-chain verification, the quarantine lane, and §3.7's FX conversion during replay. This plan's own self-review concedes that number is "a judgement, not a measurement" and "the single most arguable figure in this plan" — and an earlier draft then measured none of them until Task 28, twenty-seven tasks later.

**One of the five is cheap to measure now and is the one most likely to bite.** `client/src` is `bigint` throughout in ten non-test modules — money, `seq`, writer counters, entity versions — and Hermes' BigInt is markedly slower than JSC's or V8's. Nobody has ever run `fold` on any device. Chain verification, by contrast, is bounded and small: it is sha256 linkage only (see Task 4's note on `ed25519Verify`), so it scales with bytes, not with op complexity. **Task 0 Step 3 already produced a signal worth taking seriously**: `fx.test.ts`'s "at EVERY prefix" test times out at 5,708 ms against a 5,000 ms limit *on a fast Linux box under Bun*.

This task is deliberately minimal: sha256 + gunzip only. No store, no network, no UI, no SQLite.

**Files:** `app/src/bench/fold.ts`, `app/test/device/fold.report.json` (generated).

- [ ] **Step 1: Build the fixture log.** Extend `cmd/gen-phase2-corpus` with `--ops-out $W/oplog.json`: N `txn_ingested` ops in `seq` order, plus a realistic mix the naive corpus lacks — ~5 % `txn_categorized` against real parent versions, ~1 % `txn_superseded` keyed by `ingest_id`, one `home_currency_set`, a dozen `rate_set` ops spread through the log, and ~30 foreign-currency transactions so §3.7's snapshot-and-backfill path is actually exercised. **This is the fixture Task 28 Step 3's correctness check also needs** (see I16): a corpus of transaction records alone carries no `home_currency_set` and no `rate_set`, so a currency-correct check against it is unsatisfiable. Ship both from one generator. Fixture stays in `$W`; only its manifest is committed.

- [ ] **Step 2: Wire the minimal seam.** `app/src/bench/fold.ts` imports `verifyChain` from `client/src/wire/chain.ts`, `decodeBlobOps` from `wire/op.ts`, `fold` from `replay/replay.ts` and `serializeState` — through Task 4's `Platform` seam with only `sha256` and `gunzip` implemented. Nothing else. If Task 4 has not landed yet, stub the seam inline here and let Task 4 replace it; this task must not wait on Task 4.

- [ ] **Step 3: Measure on the P2 device**, same protocol as Task 1 Step 6 (thermal state before/after, 5 passes, pass 1 reported separately, cooldown to `.nominal`):

  | Stage | What it is |
  |---|---|
  | `verifyMs` | `verifyChain` over all N blobs from genesis |
  | `decodeMs` | `decodeBlobOps` over all N — gunzip + JSON.parse + **bigint revival** |
  | `foldMs` | `fold` over all N ops: causality, entity heads, fork resolution, supersede, dedup, FX snapshot and backfill |
  | `serializeMs` | `serializeState` — Task 9's snapshot write path |
  | `heapPeak`, `rss` | sampled per chunk |

  Report `foldMs` per op as well as total. Also report it for a 500-op prefix and a 1,500-op prefix, so **whether the fold is linear in N** is a measured fact rather than an assumption — the entity-head registry grows with the log (§3.3:81) and a superlinear fold is a different problem from a slow one.

- [ ] **Step 4: The verdict, against Task 1's reserve.**

  | Branch | Condition | Consequence |
  |---|---|---|
  | **CONFIRMS** | `verifyMs + decodeMs + foldMs + serializeMs ≤ 2 500 ms` and the fold is linear in N | Task 1's 4 s reserve holds with ~1.5 s left for the quarantine lane and per-chunk projection. Proceed. |
  | **RENEGOTIATES** | in (2 500, 6 000] ms, or measurably superlinear | Task 1's verdict is **recomputed** with this figure substituted into `T_rest`, and re-run through Task 1 Step 9's ordered table. A PASS may become CONDITIONAL. Record the recomputation in the gate document; do not quietly keep the old verdict. |
  | **BLOCKS** | > 6 000 ms | The reserve is gone and the architecture, not the crypto library, is the problem. **Stop.** This is a materially different finding from Task 1 failing — it means `RESULTS.md`'s central conclusion ("nothing about the architecture is slow, one library is") is wrong, and it must be escalated in those words. Likely first move: profile whether it is BigInt, `JSON.parse`, or `Map` churn, because the three have completely different fixes. |

- [ ] **Step 5:** append the numbers and the branch to `docs/superpowers/specs/v2-phase2-crypto-gate.md`, emit the JSON report, commit explicit paths.

---

### Task 2: The Gmail forwarding measurement (RISK-FIRST; needs no app)

Spec §3.2 makes Gmail auto-forwarding the **primary onboarding path**. Phase 1's own ledger records the finding that matters most for the beta: **the 3-year corpus contains zero Gmail forwards.** All 56 forwards are Apple Mail, and 50 of those 56 are `>`-quoted `text/plain` from which the normalizer's unwrap stage recovers **no headers at all** — a deliberately ported v1 defect. The primary onboarding path is therefore tested against exactly one hand-constructed fixture. This task measures it. It can run concurrently with Task 1.

**Files:**
- Create: `docs/superpowers/specs/v2-gmail-forwarding-record.md`
- Create (if the measurement demands it): fixtures under `conformance/normalizer/` and a normalizer version bump — see Step 5's consequence.

- [ ] **Step 1: Prerequisites.** P3 complete (mail actually arrives). A dedicated Gmail account. An issued inbound address for a test user: `GET /api/v1/address` with a `--dev-auth` session, or via `ledgerd`'s admin console.

- [ ] **Step 2: Configure Gmail forwarding and capture the verification mail.**

  Gmail → Settings → Forwarding and POP/IMAP → *Add a forwarding address* → `u-<token>@in.sirdab.ae`. Gmail sends a confirmation code to that address from `forwarding-noreply@google.com`.

  Record: does it arrive; what does `GET /admin/diagnostics` say for it (`dkim_result`, `arc_result`, `sender_domain`, `outcome`); is it in the quarantine store; does `GET /api/v1/quarantine?include_blob=1` return a body from which the code is legible. **Expected, per Decision 7:** quarantined, never promotable (`POST /api/v1/quarantine/confirm {domain:"google.com"}` → `409 forwarder_domain`), and readable from the lane. If any of that is not what happens, that is a finding.

- [ ] **Step 3: Drive real bank mail through four arms and record each.**

  | Arm | How | What it tests |
  |---|---|---|
  | A — auto-forward, all mail | Gmail's global forwarding rule, after Step 2's confirmation | The spec's primary path |
  | B — auto-forward, filter | A Gmail filter `from:(dib.ae OR emiratesnbd.com)` → Forward to | The realistic path (users do not forward everything) |
  | C — manual forward, web | Gmail web UI "Forward" | The fallback a user will reach for |
  | D — manual forward, iOS app | Gmail iOS app "Forward" | Different body construction from web |

  **How to get real bank mail into Gmail.** Preferred: **resend byte-exact corpus messages** to the Gmail address over SMTP. DKIM signs headers and body, not the envelope, so a verbatim resend preserves the original `d=dib.ae` / `d=…` signature — which is precisely why DKIM survives forwarding at all. **Stated risk:** the envelope's SPF and DMARC alignment will fail, so Gmail may spam-file or reject. If it does, fall back to (i) IMAP-`APPEND`ing the `.eml` into the Gmail mailbox and using arms C and D only (Gmail's forwarding and filters run on *inbound SMTP*, not on APPEND, so arms A and B cannot be tested that way), and (ii) a live-mail window: point one real bank alert address at the Gmail account for a week and let arms A/B run on genuine deliveries. Report which method produced each row.

  Use ≥5 distinct messages spanning all three seeded templates (DIB Arabic, ENBD transaction, ENBD account alert).

- [ ] **Step 4: Record, per message per arm, exactly these fields.** All are already produced by Phase 1 — do not build new instrumentation:

  From `GET /admin/diagnostics`: `dkim_result`, `arc_result`, `sender_domain`, `inner_origin_domain`, `template_id`, `template_version`, `normalizer_version`, `matched`, `empty_groups`, `tier`, `outcome`, `structure_sig`, `body_size_bucket`.
  From the normalizer, by running `norm.Normalize` over the stored raw body: `partUsed`, `charset`, `forwarded`, `subject` (inner or outer?), `emailDate`, `dateSource`.
  From the pipeline: did the trusted-lane gate pass on the **attested inner origin**, and was the resulting transaction `needs_review`?

- [ ] **Step 5: Adjudicate and cost.** For each arm, one of:

  - **Clean** — inner origin attested from surviving DKIM, unwrap recovers inner subject and date, a published template matches, `needs_review = false`. Record it and move on.
  - **Broken, template-level** — the template's anchors do not survive Gmail's re-flow. Cost: a new template version, validated by Phase 1's Task 31 regression gate against the donated corpus. Contained.
  - **Broken, normalizer-level** — the unwrap stage does not recover the inner headers (the likely failure, given the `>`-quoted defect), or Gmail's quoted-printable re-wrapping changes the normalized text. **Cost this loudly:** a normalizer version bump changes stored text for every message, re-triggers Phase 1's full-corpus equivalence gate (Task 16, baseline `D1_trim_set: 4, other: 0`), and requires every published template to declare the new `normalizer_version`. Multi-day, and knowing it now rather than during onboarding is the entire point of position 2.

    **Two caveats on that cost estimate, because the gate it leans on is not in a state to be leaned on.** Task 16's last ledger word is *"fix round 1/5 in flight"*, and its reviewed defect was that **the gate passes on a 0-row corpus** — "the guard validates the path, never the content," which is precisely the typo-silently-disables-the-gate failure a hard gate must not have. Separately, `scripts/v2-check.sh` states in its own header that it does **not** run the full-corpus cross-executor diff, because that needs a snapshot of the operator's live mailbox. So "re-triggers the equivalence gate" means *a manual run of a gate that is mid-repair*, not *a build step that will catch it*. Whoever costs a normalizer bump must first confirm Task 16's fix landed and run the gate against a non-zero corpus.
  - **Broken, trust-level** — DKIM does not survive and no ARC chain attests the inner origin, so the mail can only ever be quarantined. This is the worst outcome and has no template fix: it means the primary onboarding path produces permanently-held mail, and §3.2's design needs revisiting.

- [ ] **Step 6: Write `docs/superpowers/specs/v2-gmail-forwarding-record.md`** — per-arm table, the verification-mail behaviour, the adjudication, and any resulting work items with their costs. If arms A and B could not be exercised, say so at the top rather than in a caveat; an untested primary path stays untested.

- [ ] **Step 7: Commit.**
  ```bash
  git add docs/superpowers/specs/v2-gmail-forwarding-record.md
  git commit -m "docs(v2): measured Gmail forwarding fidelity for the primary onboarding path"
  ```

---

## Part B — Foundations

### Task 3: Grow `app/` into the product shell

**Files:** `app/app.json`, `app/eas.json`, `app/metro.config.js`, `app/babel.config.js`, `app/tsconfig.json`, `app/src/app/{Root.tsx,Navigation.tsx,Theme.tsx}`, `app/src/components/README.md`, `app/vitest.config.ts` or `bunfig.toml`.

**Interfaces / pins.** Global Constraints say "every version exact, never a range," and an earlier draft of this task then listed ten packages with no version at all — the plan violating its own rule. The correct mechanism, because SDK-54-compatible versions are not memorable and guessing them produces a build that fails on the cloud builder twenty minutes later:

```bash
cd app && bunx expo install expo-secure-store expo-auth-session expo-crypto \
  expo-apple-authentication expo-notifications expo-file-system expo-sharing \
  expo-document-picker react-native-reanimated react-native-safe-area-context \
  react-native-screens @react-navigation/native @react-navigation/native-stack
```
`expo install` resolves the SDK-54-correct version for each. **Then record every resolved version in the task report and rewrite `package.json` to exact pins with no carets** — the install is how the numbers are discovered, not how they are held. `expo-apple-authentication` is in the list because native Sign in with Apple is the App-Store-expected path and an earlier draft omitted it while making Apple sign-in mandatory.

Already pinned from Task 1: `expo@54.0.36`, `react-native@0.81.5`, `react@19.1.0`, `expo-sqlite@16.0.10`, `@noble/*@2.2.0`, `fflate@0.8.3`, `ulid@2.3.0`, `typescript@5.9.2`.

- [ ] **Step 1: Metro must resolve `client/src`.** Add the repo root to `watchFolders` and `nodeModulesPaths` in `metro.config.js`, and a `"@ledger/client/*": ["../client/src/*"]` path in `tsconfig.json`. Verify with a throwaway import of `fold` from `@ledger/client/replay/replay.ts` that type-checks and bundles. **Do not copy `client/src` into `app/`** — a copy silently diverges from the conformance suite that guards it.
- [ ] **Step 2: Reanimated + Hermes.** Add the Reanimated babel plugin last in the plugin list. Confirm the app runs on the dev client from Task 1 and that a trivial `withTiming` animates.
- [ ] **Step 3: EAS profiles.** `development` (dev client, internal distribution, the P1 device UDIDs), `preview` (release build, internal distribution — this is what Task 28 measures on and what alphas would install), `production` (Phase 4). Record build times and quota consumption in the task report.
- [ ] **Step 4: Test runner.** `bun test` for pure logic under `app/src/lib/` and `app/src/db/`; a React Native Testing Library setup for components. **The on-device suites (`app/test/device/`) are not run by `bun test`** — they are driven from the bench screen and their results are recorded in task reports, because there is no CI service and no simulator on this box.
- [ ] **Step 5: `app/src/components/README.md`.** Seed it as the UI catalogue, mirroring `frontend/src/components/README.md`'s role: every shared component's purpose, when to use it and when not to, plus the mobile conventions (44 pt targets, 16 pt minimum input font, safe-area handling, `dvh`-equivalent insets). Every later task that adds a shared component updates this file **in the same commit**.
- [ ] **Step 6: The portal work Task 13 will otherwise be blocked on.** All of it is P1-class calendar-shaped work and an earlier draft of this plan listed none of it:
  - A **Google Cloud OAuth client ID of type iOS**, bound to the bundle identifier, plus its reversed-client-ID URL scheme.
  - The **Apple App ID with the Sign in with Apple capability** enabled, and a **Services ID** if any web-based leg is used.
  - `app.json`: `ios.bundleIdentifier`, `scheme`, `ios.associatedDomains` if needed, and the reversed-client-ID entry in `CFBundleURLTypes`. An earlier draft created `app.json` and never mentioned any of them.
  - The **iOS deployment target**, which is a decision, not a default (human-decision item 10) — it governs Keychain accessibility constants in Task 13 and the bundle Task 1's `T_paint` was measured against.
- [ ] **Step 7: Re-measure `T_paint` now that the shell exists.** Task 1's figure was taken against a near-empty bundle; navigation, Reanimated and the screen tree will roughly triple it. Re-run Task 1 Step 7's protocol (recording clock, embedded bundle, P2 device) and record the delta. **If `T_paint` has crossed 1 200 ms, say so here** and carry it into Task 28 as a known headwind rather than discovering it at the end.
- [ ] **Step 8:** `cd app && bun run typecheck && bun test` green; the dev client launches on device; commit explicit paths.

---

### Task 4: The four platform seams — `client/src` off Bun primitives

`client/src` is written against Bun and Node globals. Exactly four modules block it from running on Hermes, and the layer above them (`replay/`, `state.ts`, `fx.ts`, `tmpl/exec.ts`, `tmpl/dialect.ts`, `norm/unwrap.ts`, `norm/charset-tables.ts`) is already clean.

**Files:**
- Create: `client/src/platform.ts` (the seam), `client/src/platform.test.ts`
- Modify: `client/src/wire/chain.ts`, `client/src/wire/blob.ts`, `client/src/net/client.ts`, `client/src/invariants/check.ts`, `client/src/wire/op.ts`, `client/src/store/store.ts` (call sites only)
- Create: `app/src/platform/{hash.ts,gzip.ts,signing.ts,bytes.ts,index.ts}`

**Interfaces:**

```ts
// client/src/platform.ts
export interface Platform {
  sha256(data: Uint8Array): Uint8Array;
  gzip(data: Uint8Array): Uint8Array;
  /** Must enforce a decompressed-output cap and throw past it — the gzip-bomb guard. */
  gunzip(data: Uint8Array, maxOutputBytes: number): Uint8Array;
  ed25519GenerateKey(): { priv: Uint8Array; pub: Uint8Array };
  ed25519PublicKey(priv: Uint8Array): Uint8Array;
  ed25519Sign(priv: Uint8Array, msg: Uint8Array): Uint8Array;
  randomUUID(): string;
  randomBytes(n: number): Uint8Array;
  toHex(b: Uint8Array): string;
  fromHex(s: string): Uint8Array;
  toBase64(b: Uint8Array): string;
  fromBase64(s: string): Uint8Array;
  utf8Encode(s: string): Uint8Array;
  utf8Decode(b: Uint8Array): string;
}
export function setPlatform(p: Platform): void;
export function platform(): Platform;   // throws if unset
export const bunPlatform: Platform;     // the default, installed on import under Bun
```

**The complete call-site inventory, verified as of this plan's revision (`f0ac846`).** An earlier draft published a partial table under the instruction "verified, do not re-derive" — which tells the implementer not to look, while being incomplete. **Before implementing, re-run this and reconcile against the table:**

```bash
cd client/src && grep -rnE 'Bun\.|node:|Buffer|Text(En|De)coder|fetch|URLSearchParams|new Date|new RegExp|process\.|from "ulid"|import\.meta' . --include=*.ts | grep -v '\.test\.ts'
```

*Must be converted to the seam:*

| File:line | Today | Becomes |
|---|---|---|
| `wire/chain.ts:67` | `new Bun.CryptoHasher("sha256")` | `platform().sha256` |
| `wire/chain.ts:158` | `Buffer` → hex | `platform().toHex` |
| `wire/blob.ts:47` | `import { gunzipSync, gzipSync } from "node:zlib"` | `platform().gzip` / `gunzip` |
| `wire/blob.ts:300-311` | zlib `maxOutputLength: MAX_PLAINTEXT+1`, `let out: Buffer` | `gunzip(data, cap)` returning `Uint8Array`. **The cap is load-bearing and `fflate` has no equivalent** — the 1 MiB top bucket can carry a stream inflating to ~1 GB on an attacker-influenced path, so the RN impl must bound output during inflation, not merely check the length afterwards. Test with a real bomb. |
| `wire/blob.ts:141` | `new TextEncoder()` | seam |
| `wire/op.ts:373,613,648,654,663,705,706` | `TextDecoder`/`TextEncoder`/`Buffer` (incl. **strict** base64 decode at `:663`) | seam; strictness must survive |
| `net/client.ts:42` | `node:crypto`: `generateKeyPairSync`, `createPrivateKey`, `createPublicKey`, `sign`, `randomUUID` | `platform().ed25519*` / `randomUUID` |
| `net/client.ts:198,204,217,611,613,1210,1345,1364,1365` | `Buffer` hex/base64/base64url, `TextEncoder` | seam |
| `invariants/check.ts:270,271` | `Buffer` hex, `TextDecoder` | seam |
| `store/store.ts:246,252` | `Buffer` hex | seam |
| `store/store.ts:49,50` | **`node:fs`** (`chmodSync`, `mkdirSync`, `readFileSync`, `renameSync`, `unlinkSync`, `writeFileSync`) and `node:path` | **not a shim — this is why Task 5 exists.** `fileStore()` is entirely Node fs: 0600 chmod, temp-file-plus-rename, a sidecar `.gitignore`. `Platform` deliberately has **no** filesystem method; `sqliteStore` replaces the whole thing. |

*Must be handled, but not by the seam:*

| Site | Handling |
|---|---|
| `net/client.ts:329,330,362,367` — global `fetch` | **Already injectable.** `ClientOptions.fetch?: typeof fetch` and `this.doFetch = opts.fetch ?? fetch`. The app passes RN's `fetch` explicitly rather than relying on the global default, because RN's is not spec-identical (no `Response.bytes()`, different body semantics). No seam needed — this is a correction to an earlier framing that called it a missing shim. |
| `net/client.ts:663,788,1235` — `URLSearchParams` | Present in Hermes via RN's polyfill. **Assert it on-device in Step 4** rather than assuming; it is one line and the failure mode is a silently malformed cursor. |
| `net/client.ts:44,847` — the `ulid` package | Generates every `op_id`, and seeds from `Math.random` or `crypto` **by environment**. On Hermes it must seed from `expo-crypto`'s `getRandomBytes`, not `Math.random`: a `Math.random`-seeded ULID from two offline devices can collide, and `op_id` is an identity. Pass an explicit PRNG. |
| `norm/charset.ts:87` — `new TextDecoder("utf-8", {ignoreBOM:true, fatal:false})` | **Leave the call, pin the behaviour.** Hermes' support for those options is the risk. Tested on-device in **Step 4** (not Step 3 — Step 3 is the Bun equivalence gate). Note `norm/charset-tables.ts` exists precisely because `TextDecoder` *cannot* stand in for the Go charmap; do not "simplify" it. |
| Wall clock — `replay/state.ts:296`, `net/client.ts:850`, `wire/op.ts:311,327`, `norm/unwrap.ts:175`, `norm/norm.ts:338` | **`state.ts:296` is the one that matters**: `new Date(parseInstantMs(t.posted_at)).toISOString().slice(0,10)` sits inside **`fingerprint()`**, so Hermes `Date` parsing is inside the value that fork resolution and duplicate detection compare. (`state.ts:13`'s "No wall clock" comment is about `Date.now()` only and does not cover this.) Step 4 must assert `fingerprint()` is byte-identical between Bun and Hermes over ≥200 corpus transactions including a DST boundary, a leap day, and a fractional-second timestamp. |
| 16 `new RegExp` sites — `tmpl/dialect.ts:132`, `tmpl/exec.ts:443-445` | See Step 5; Hermes is a different engine. |
| `client/src/cli/main.ts` **in full** (`process.env`, `process.argv`, `process.exit`, `import.meta.main`, `Buffer`) | **Explicitly out of scope.** The CLI is Phase 1's exit-test instrument and is never bundled into `app/`. `metro.config.js` must have a resolver rule that fails the build if `cli/` is reachable from the app's entry graph, so this stays true by construction rather than by intent. |
| `client/tsconfig.json` `"types": ["bun"]` | `app/tsconfig.json` sets its own types; ensure the client's does not leak into the RN type graph. |

*Verified absent — recorded so nobody re-derives it:* no `String.normalize`, no `Intl`, no `structuredClone`, no `atob`/`btoa`, no `Math.random`, no `Date.now()`, no `\p{…}` property escapes, no lookaround (the dialect bans it).

**One deliberate omission, which is correct and must be stated rather than left to look like a gap:** `Platform` has **no `ed25519Verify`**. `net/client.ts:42` imports `sign` and not `verify`, and `verifyChain` / `verifyHashList` / `verifyFetchedRange` are **sha256 linkage only**. **The client never verifies a signature.** Two consequences the plan must carry rather than imply: "writer-chain verification" means *the blobs form an unbroken sha256 chain*, not *an authenticated writer produced them* — the signature only ever gates writer *registration*, server-side; and Task 28's cost model is correspondingly smaller, because chain verification scales with bytes hashed, not with any asymmetric operation. If Phase 3 ever wants clients to verify blob signatures, that is new work and a new seam method.

RN implementations: `sha256` from `@noble/hashes`, gzip from `fflate`, Ed25519 from `@noble/curves`, `randomBytes`/`randomUUID` from `expo-crypto`. **Copy the exact import specifiers from `spike/phase0/replay-app`, which already pins the same majors and imports them successfully** — `@noble` 2.x moved to `.js`-suffixed subpaths (`@noble/hashes/sha2.js`, `@noble/curves/ed25519.js`) and writing them from memory produces a resolution error that looks like a bundler bug. Hex and base64 are hand-rolled (~20 lines each) rather than pulling the `buffer` polyfill, which is 50 KB of Hermes bundle for two functions.

- [ ] **Step 1: Write the seam test first.** `client/src/platform.test.ts` asserts every method against fixed vectors: a known sha256, a gzip round-trip, a gzip bomb that must throw at the cap, an Ed25519 sign/verify against RFC 8032 test vector 1, hex/base64 round-trips including a leading zero byte and a 0xFF byte, and UTF-8 round-trips including a 4-byte codepoint and a lone surrogate. Run under Bun with `bunPlatform`. FAIL first.
- [ ] **Step 2: Implement the seam and convert every call site above.** Purely mechanical. No behaviour change.
- [ ] **Step 3: The equivalence gate (under Bun).** `cd client && bun test` must show **no pre-existing test removed, skipped or weakened, and a collected count no lower than Task 0 Step 3's baseline** (1,911 at `f0ac846`) — this task adds `platform.test.ts`, so the count *rises*; an absolute-equality gate would be unsatisfiable, which is what an earlier draft wrote. `bash scripts/v2-check.sh` must print `v2-check: OK (go + client + conformance)`. Record collected/pass/skip/fail verbatim.
- [ ] **Step 4: The on-device half.** `app/src/platform/index.ts` builds the RN `Platform` and calls `setPlatform` at module load. `app/test/device/platform.test.ts` runs the **same vectors** from Step 1 on the dev client via the bench screen, plus the four Hermes-specific assertions the table above assigns here: `URLSearchParams` round-trips a `bigint`-derived cursor string; `norm/charset.ts:87`'s `TextDecoder` options behave; `serializeState`'s bigint handling survives (`JSON.stringify` throws on bigint — it is already handled, assert it rather than trust it); and **`fingerprint()` is byte-identical between Bun and Hermes** over ≥200 corpus transactions including a DST boundary, a leap day and a fractional-second timestamp. Emit the machine-readable report (Task 1 Step 10's shape).
- [ ] **Step 5: Hermes is a different regex engine, and the dialect is calibrated to Bun. Re-measure here, not at Task 24.**

  `client/src/tmpl/dialect.ts:50-63` fixes `MAX_BOUND_PRODUCT = 64` and `MAX_UNBOUNDED_PER_BRANCH = 1` against numbers its own comment marks *"Measured in Bun 1.3.14"*: `[0-9]+[0-9]+z` at 86 ms on 800 chars, `[0-9]+[0-9]+[0-9]+[0-9]+z` at **88,191 ms** on 400, `[^\n]+X[^\n]+Y` at 31,680 ms on 8,000. Those bounds protect the client from ReDoS on **attacker-writable inbound mail**, and Phase 2 moves the client to a different engine. Separately, Phase 1 recorded a *correctness* divergence with an explicit instruction attached: *"Bun disagrees with Go, V8 AND WebKit on `/[a-z]/iu` vs U+212A — a Bun bug. No rule added… **Re-measure if the client ever moves to Hermes.**"* This is that move, and an earlier draft of this plan never mentioned it.

  On the P2 device: (a) re-run the U+212A case-folding case and record whether Hermes agrees with Go/V8/WebKit or with Bun; (b) re-run every pattern in `conformance/dialect/patterns.json` against its 20 hostile inputs and record per-pattern wall clock; (c) re-derive `MAX_UNBOUNDED_PER_BRANCH` and `MAX_BOUND_PRODUCT` from Hermes' measurements.

  **State the consequence up front so it is not a surprise:** if Hermes is worse, the dialect tightens, `patterns.json` regenerates, and **already-published templates may need revalidation** — which is server work, a `tmpl` version bump, and a conformance-suite regeneration. Doing this at Task 4 costs a day; discovering it at Task 24 costs the same day plus everything built on the old bounds.
- [ ] **Step 6: Commit** `client/src/platform.ts` + call sites + `app/src/platform/` with `feat(v2): platform seam so the client library runs on Hermes`.

---

### Task 5: The SQLite store — replacing the file store and the whole-state write

**Files:**
- Modify: `client/src/store/store.ts` (split `rows` out; keep `fileStore` and `memStore` working)
- Modify: `client/README.md` (Decision: what Phase 2 reuses and what it replaces)
- Create: `app/src/db/{driver.ts,schema.sql,store.ts,rowstore.ts}`
- Create: `app/src/db/store.test.ts`

**The problem, precisely.** `Store` is `{ location, load(): ClientState, save(state: ClientState): void }` and `ClientState` contains `rows: Record<Stream, WireRow[]>` — every verified row, forever. `Client.commit()` calls `store.save(this.st)` after every mutation, so each command rewrites the whole log. `client/src/store/store.ts`'s own module doc says exactly this: *"O(log) work per command and O(log) bytes on disk … the correct trade for a test instrument and the wrong one for a phone."*

**Interfaces:**

```ts
// client/src/store/store.ts — additive; ClientState loses `rows`
export interface RowStore {
  append(stream: Stream, rows: readonly WireRow[]): void;
  /** Ascending by seq, from exclusive `afterSeq`, at most `limit`. THE ONLY READ PATH. */
  range(stream: Stream, afterSeq: bigint, limit: number): WireRow[];
  count(stream: Stream): number;
  prune(stream: Stream, beforeSeq: bigint): void;   // Task 10's cold window
}
```
**There is deliberately no `all(stream)`.** An earlier draft had one, documented as *"every row for a stream, ascending — only `check`/`materialize` call this"* — and `check` and `materialize` are exactly the on-device callers. Loading 3,683 blobs into one JS array is the >500 MB shape that froze the Phase 0 build; putting it behind a method named `all()` makes it look sanctioned. `check` and `materialize` are refactored onto `range()` with the same 250-row chunking and yields Task 8 mandates, and the equivalence gate in Step 4 is what proves the refactor changed no result. If a caller genuinely needs a full pass, it iterates `range()`; the memory ceiling is then a property of the loop rather than of the callee.

```ts
export interface Store {
  readonly location: string;
  load(): ClientState;
  save(state: ClientState): void;
  rows(): RowStore;
}
export function memStore(server?: string): Store;
export function fileStore(dir: string, profile: string): Store;   // unchanged behaviour
export function sqliteStore(db: SqlDriver, server?: string): Store; // NEW
```

```ts
// client/src/store/driver.ts — the interface and the Bun impl live in client/, NOT app/
export interface SqlStatement { run(...args: unknown[]): void; all(...args: unknown[]): unknown[]; }
export interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
}
export function bunDriver(path: string): SqlDriver;    // bun:sqlite, tests only

// app/src/db/driver.ts — the RN impl only
export function expoDriver(name: string): SqlDriver;   // expo-sqlite openDatabaseSync
```
**The interface and `bunDriver` belong to `client/`, not `app/`.** Step 4 runs `client/`'s own suite against the SQLite store, which would otherwise require `client/` to import from `app/` — a dependency inversion that makes the library depend on the application. `sqliteStore` also lives in `client/src/store/`; `app/` contributes exactly one function.

- [ ] **Step 1: Verify the sync API exists.** Confirm `expo-sqlite@16.0.10` exposes `openDatabaseSync`, `execSync`, `prepareSync`, `runSync`, `getAllSync` and `withTransactionSync` (Phase 0's `spike/phase0/replay-app/replay.ts` already uses `openDatabaseSync`, `withTransactionSync` and prepared statements, so this is confirmation not discovery). **If any is missing, stop and re-open Decision 3** — the fallback is widening `Store` to async, which ripples through every `Client` method.
- [ ] **Step 2: Write the failing tests.** `app/src/db/store.test.ts` under Bun with `bunDriver(":memory:")`:
  ```ts
  test("save() does not write rows", () => { /* 10_000 appended rows; save(); assert the state row's byte length is < 8 KiB */ });
  test("range() is ascending, exclusive on afterSeq, and honours limit", () => {});
  test("append() is idempotent for a byte-identical re-append at the same seq", () => {});
  test("prune() removes cold rows below a seq and leaves hot untouched", () => {});
  test("a reopened store returns the identical ClientState", () => { /* every bigint, every Map, every pinned hash */ });
  test("secrets are not in the rows table", () => { /* sessionToken and the Ed25519 `d` never appear in any row blob */ });
  ```
- [ ] **Step 3: Implement.** Schema: `client_state(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)` for the small state, and `wire_rows(stream TEXT, seq TEXT, writer_id TEXT, writer_counter TEXT, type_flag TEXT, size_bucket INTEGER, blob_hash TEXT, prev_hash TEXT, created_at TEXT, blob BLOB, PRIMARY KEY(stream, seq))` for the log. `seq` is a decimal **string** because SQLite integers are 64-bit signed and the wire format is a decimal string; sort with `ORDER BY length(seq), seq` or store a padded key — pick one and test it against a seq that crosses a digit-count boundary (9 → 10, 99 → 100), because plain lexicographic ordering is wrong there and it is exactly the bug that would survive a small-N test.
- [ ] **Step 4: The equivalence gate — run the whole existing client suite against the new store.** Add a `LEDGER_CLIENT_STORE=sqlite` mode to whatever constructs stores in `client/test/` and `client/src/**/*.test.ts`, and run:
  ```bash
  cd client && bun test                                   # file/mem store, must be unchanged
  cd client && LEDGER_CLIENT_STORE=sqlite bun test        # the same suite, SQLite-backed
  ```
  Both green, **no pre-existing test removed, skipped or weakened, collected count no lower than Task 0's baseline** in either mode. This is the exit condition that matters: it makes the phone's persistence layer inherit Phase 1's whole test corpus instead of being a fresh, untested surface. It also covers the `all()` → `range()` refactor above — if that changed a result, this is what catches it.

  **Do not over-claim what this task achieves.** It fixes the whole-state *write*: `save()` no longer rewrites the log. It does **not** fix retention — the `wire_rows` table still keeps every hot blob forever, which is the second of `client/README.md`'s three objections and is Task 10's rolling window for cold plus an open question for hot. Step 6's README rewrite must say which of the three are actually addressed here (the whole-state write, and the plain-file key via Step 5) and which is not.
- [ ] **Step 5: Secrets go to the Keychain, not SQLite.** The session token and the Ed25519 private key move to `expo-secure-store` (`app/src/auth/keys.ts`, Task 13 consumes it). `sqliteStore` accepts a `SecretStore` for those two fields. The Step 2 test that asserts they are absent from SQLite is the pin.
- [ ] **Step 6: Update `client/README.md`.** State precisely what Phase 2 reuses (the protocol logic in `Client`, the whole `wire`/`replay`/`invariants`/`norm`/`tmpl` stack) and what it replaces (the file store, the whole-state write, the plain-file key). Delete or qualify the "must not be built by growing this one" line so it no longer reads as forbidding the reuse this plan depends on. Explain *why* reimplementing the protocol logic is the thing not to do.
- [ ] **Step 7: `bash scripts/v2-check.sh` green; commit.**

---

### Task 6: Server changes the beta blocks on

Four Phase 1 carry-forwards, each named in the exit record or the progress ledger, each small, each a beta blocker. They are one task because they are one review.

**Files:** `internal/v2/api/sync.go`, `internal/v2/api/addresses.go`, `internal/v2/auth/session.go`, `internal/v2/api/quarantine.go`, `internal/v2/pg/migrations/00020_invite_codes.sql`. **Re-run `ls internal/v2/pg/migrations/` at the moment you write it** — highest today is `00019`, so the next free is `00020`; `00004` and `00015` are both vacant and neither may be claimed. Three sessions are concurrent, so a number correct when this plan was written may not be.

**This task does not touch `docs/superpowers/specs/v2-phase1-exit-record.md`.** That file is owned by whoever lands Phase 1's ingest-chain fix (Task 0 Step 1), and it is exactly the shared-file collision Global Constraints warns about.

- [ ] **Step 1: Bind a real nonce on address rotation — and say what happens to the exchange path.**
  `api/addresses.go:170` passes an empty `auth.VerifyOpts{}`, so "fresh IdP re-auth" checks nothing: any currently-valid ID token satisfies factor 2. The mechanism already exists unused in the same commit — `address_rotation_challenges` is a 32-byte `crypto/rand` nonce, 5-minute TTL, consumed once. Pass it as `VerifyOpts{Nonce: …}` plus `MaxAge: 5 * time.Minute`, matching the account-deletion path. Tests: no nonce claim → 403; replayed nonce → 403; token older than 5 minutes → 403; all three with the byte-identical `rotation_rejected` body.

  **`sync.go:193` carries the same empty `auth.VerifyOpts{}` on the sign-in exchange path, and this task deliberately leaves it.** Phase 1 recorded the residual: a captured Apple/Google ID token is a replayable bearer credential at `/api/v1/auth/exchange` for its lifetime. Deferring it was the right Phase 1 call; **Task 13 Step 2 sends a nonce on sign-in anyway** so the server can start enforcing it without a client change, and closing it server-side is named here as known, deliberate and Phase-4-blocking rather than left as a silent asymmetry between two adjacent call sites.

- [ ] **Step 2: The closed beta's gate — a single-use invite code (Decision 8).**

  Read Decision 8 first: an identity allowlist is **unkeyable**. An IdP `subject` is not knowable until the first sign-in, which is the event being gated, so `ledgerd allow-signup --subject <sub>` can never be run in time; and `admin/waitlist` cannot be the key either, because `00012_waitlist.sql` is `waitlist(bank text PRIMARY KEY, demand bigint, first_seen, last_seen)` — a bank-demand counter with no users in it. An earlier draft of this plan proposed both and neither is implementable.

  ```sql
  -- 00020_invite_codes.sql
  CREATE TABLE invite_codes (
    code_hash   BYTEA PRIMARY KEY,          -- SHA-256 of the code; the code itself is never stored
    note        TEXT,                       -- operator's own words
    created_at  TIMESTAMPTZ NOT NULL,
    redeemed_at TIMESTAMPTZ,
    redeemed_by UUID REFERENCES users(id) ON DELETE SET NULL
  );
  ```
  `POST /api/v1/auth/exchange` accepts an optional `invite_code`. If the identity resolves to an **existing** user, sign in and ignore the field entirely. If it does not, require an unredeemed code, redeem it in the same transaction as `UpsertUser`, and return `403 {"error":"not_invited"}` otherwise. `ledgerd mint-invite --note "<who>"` prints a fresh code once and stores only its hash.

  Tests: a valid code creates exactly one account and marks the code redeemed; the same code a second time → 403 and **no account created**; an existing user signs in with no code; a wrong code → 403; **every other authentication failure stays the byte-identical 401** — `not_invited` is the only distinguishable rejection, and it is distinguishable on purpose because the person holding the phone needs to know it is not a credentials problem. Also assert redemption is atomic under two concurrent requests with the same code.

- [ ] **Step 3: A distinguishable response for a deleted account.**
  Task 29 Step 8 and Task 26 both need a device to learn that its account is gone. Today that is a 401, which is indistinguishable from an expired session — and wiping local data on a 401 is a data-loss footgun that would fire on every token expiry. Add `410 {"error":"account_deleted"}` from the session middleware when the session's user row is absent but the session token parsed. Tests: an expired session → 401 and the client keeps its data; a deleted account → 410. **Task 26 Step 4 and Task 29 Step 8 both key on the 410 and never on the 401.**

- [ ] **Step 4: Rate-limit and bound `POST /api/v1/quarantine/confirm`.**
  Phase 1's ledger flags it: confirm now re-ingests held mail inside a user-facing, unrate-limited request (batch cap 500). Add it to the existing token-bucket table at 1/min burst 10, matching the address and account budgets, and assert the `Incomplete` flag round-trips so the client can page.

- [ ] **Step 5:** `bash scripts/v2-check.sh` green. Run the e2e suite **with `LEDGER_TEST_POSTGRES_URL` exported and assert it actually ran** — those 35 tests self-skip without it, so "`exit.test.ts` green" is otherwise satisfiable by skipping. Commit explicit paths.

---

### Task 7: `unparsed` and zero-amount ops in the replay engine

Phase 1 left this open: *"`unparsed` + zero-amount ops remain undecodable by the replay engine (absent from `TxnPayload` **and** `Txn`). No message in the exit run was unparsed, so the gap is unexercised, not closed."* The pipeline appends these ops (step 7 of Phase 1's Task 29: nothing is dropped, `tier = "none"`, `needs_review = true`, `unparsed: true`), so a real alpha inbox will contain them from week one and the client will currently set every one aside as unreadable. **The review queue cannot be built on top of that**, which is why this is a foundation task and not a review-queue detail.

**Files:** `client/src/replay/state.ts`, `client/src/replay/replay.ts`, `client/src/replay/replay.test.ts`, `client/src/invariants/check.ts`.

**Interfaces — `Txn` gains three fields:**

```ts
export interface Txn {
  // ... existing fields unchanged ...
  unparsed: boolean;          // tier === "none": nothing extracted
  tier: "template" | "heuristic" | "none";
  parse_error: string | null; // the pipeline's reason, from a closed set; never body text
}
```
`amount_minor` stays `bigint` and may be `0n` for an unparsed op; `currency` may be `""`; `direction` may be `""` — **and every aggregate must exclude such a row from money math rather than treating it as a zero-amount debit.** That is the actual bug this task prevents: a 3,683-row budget total silently absorbing a hundred zero-amount unparsed rows is arithmetically invisible and product-fatal.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  test("a txn_ingested with unparsed:true materializes rather than becoming unreadable", () => {});
  test("an unparsed txn is needs_review and excluded from bucket totals", () => {});
  test("a zero-amount parsed txn is kept, and is NOT the same thing as unparsed", () => {});
  test("an unparsed txn can be superseded by a template fix and becomes parsed", () => {
    // the exact case reprocessing exists for; the supersede must recompute FX fresh at its own position
  });
  test("fingerprint() of an unparsed txn does not collide with every other unparsed txn", () => {
    // last4|amount|direction|merchant|day is "" |0|""|""|day for all of them — without a guard
    // every unparsed message on a given day becomes a "possible duplicate" of every other
  });
  ```
  That last one is not hypothetical: Phase 1's exit run already produced 18 `possible_duplicate` anomalies from a thin corpus, and unparsed rows collapse the fingerprint to a constant per day.
- [ ] **Step 2: Implement.** Decode the three fields; make `fingerprint()` return a value that cannot collide for unparsed rows (fold `ingest_id` in when `unparsed`); exclude unparsed rows from `pendingByCurrency` (there is no currency to convert).
- [ ] **Step 3: Invariants.** `I12_money_shape` must accept `0n`/`""` **only** when `unparsed` is true, and reject them otherwise. Add the mutant: flipping that guard must fail a named test.
- [ ] **Step 4:** `bun test` green at a higher count, `bash scripts/v2-check.sh` green, commit.

---

## Part C — The on-device data layer

### Task 8: The sync engine — chunked, yielding, resumable, one connection

**Files:** `app/src/sync/engine.ts`, `app/src/db/projection.ts`, `app/src/sync/engine.test.ts`, `app/src/db/projection.test.ts`.

**Interfaces:**

```ts
export type SyncPhase = "idle" | "pulling" | "folding" | "projecting" | "pushing" | "halted";
export interface SyncProgress { phase: SyncPhase; rowsPulled: number; rowsTotal: number | null;
                                opsApplied: number; chunk: number; }
export interface SyncResult { pulled: number; applied: number; violations: Violation[];
                              halted: boolean; }
export class SyncEngine {
  constructor(client: Client, db: SqlDriver, opts?: { chunkSize?: number });
  readonly progress: SyncProgress;
  subscribe(fn: (p: SyncProgress) => void): () => void;
  /** Idempotent and re-entrant-safe: a second call while running returns the in-flight promise. */
  sync(opts?: { stream?: Stream }): Promise<SyncResult>;
  halt(reason: string): void;
}
```

**The three mandatory rules, each with a named regression test.** All three come from the Phase 0 catastrophic run (>500 MB RSS, JS FPS 0, frozen after the second restore).

1. **`CHUNK_SIZE = 250`, with `await new Promise(r => setTimeout(r, 0))` between chunks.** Two tests, because a call-count assertion alone checks that the mechanism is *present*, not that it *works* — and Phase 0 measured total `yieldMs` at 1.9–4.2 ms across a 58 s restore, i.e. the yields buy almost no event-loop time. What they buy is collector headroom, so assert **that**: `foldsInChunksAndYieldsBetweenThem` (construction: `ceil(n/250) - 1` scheduler ticks) **and** `rssIsBoundedAcrossChunks` — sample `rssBytes()` per chunk over the full corpus and assert the ceiling holds and the trend is flat rather than monotonically rising. The second is the one that would have caught the Phase 0 crash; the first only proves somebody wrote a `setTimeout`.
2. **One SQLite connection for the app's lifetime.** `openDatabaseSync` has no connection cache; Phase 0 leaked a native connection per press. Test: `openingTheStoreTwiceReturnsTheSameDriver`, plus an explicit close on teardown.
3. **`isRunning` guard.** Phase 0's ~39-request / 144 MB fetch storm came from a user re-pressing a button on a frozen JS thread. Test: `concurrentSyncCallsIssueOneRequestSet` — call `sync()` five times without awaiting and assert the injected fetch saw exactly one page sequence.

**Ordering (do not reorder — Phase 1 spent four review rounds on this).** The canonical order is `pull → verify → **pin** → fold → attest → push`, and in this engine that expands to: `pull` → `verifyChain` against the pinned head → **persist the new pinned head** → persist rows → fold the decoded ops in ascending `seq` → project into SQLite → advance the cursor → persist. **`pin` is not optional and an earlier draft of this paragraph omitted it** — a checkpoint built from unpinned heads claims genesis for chains that are merely un-pinned rather than empty, which is the defect Phase 1's Task 14 fix round 1 existed to close. A chunk's rows are persisted **before** they are folded, so a crash mid-fold resumes from a verified log rather than re-fetching.

- [ ] **Step 1: Write the failing tests**, including the three above, plus: a mid-sync interruption resumes at the persisted cursor with no duplicate application; a server-side dropped row raises `I2`/`I3` and halts; a server-side reordered row raises `I3` and halts; an undecodable blob does **not** halt but lands in `state.unreadable` and the cursor still advances (spec §3.3:74); an op with `v > SCHEMA_VERSION` **does** halt with `UnknownNewerVersionError`.
- [ ] **Step 2: Implement `engine.ts`** on `Client`'s existing `pull()`/`materialize()`/`check()` — call them, do not reimplement them.
- [ ] **Step 3: Implement `projection.ts`.** SQLite tables the UI reads: `txn(id TEXT PRIMARY KEY, ingest_id, amount_minor TEXT, currency, direction, posted_at, merchant_raw, last4, category, needs_review INTEGER, provenance, amount_home_minor TEXT NULL, unparsed INTEGER, tier, superseded_by TEXT NULL, possible_duplicate_of TEXT NULL, version INTEGER)` plus `txn_split`, `rule`, `rate`, `fork_notice`, `anomaly`. **Money columns are TEXT holding decimal strings** — SQLite has no unsigned 64-bit and the UI must never see a `number` for money. Indices: `(posted_at)`, `(needs_review)`, `(category, posted_at)`, `(superseded_by)`.
- [ ] **Step 4: Prove the projection agrees with `State`.** `projectionMatchesState` folds a fixture log, projects it, reads every row back and compares field-by-field against `State.txns` — **including `amount_minor`, `category`, `direction`, `splits` and `provenance`.** Phase 1's Task 13 review found its equivalent check compared only `amount_home_minor` and existence, which certified a reordered fork winner as clean. Do not repeat that.
- [ ] **Step 5: If Task 1 returned CONDITIONAL, implement fallback F1 here** (newest-window-first restore with pending-parent handling) per Task 1's ladder. Otherwise note in the task report that it was not required.
- [ ] **Step 6:** tests green, commit.

---

### Task 9: Warm start — the device-local fold snapshot

Cold restore is once per install. Every subsequent launch must not re-fold. Phase 0's 13 ms "warm start" measured a `SELECT COUNT(*)`, not a fold.

**Files:** `app/src/db/snapshot.ts`, `app/src/db/snapshot.test.ts`.

**Interfaces:**

```ts
/** Serialize/restore the in-memory fold State. Device-local only. */
export function saveSnapshot(db: SqlDriver, s: State, cursor: { hot: bigint; cold: bigint }): void;
export function loadSnapshot(db: SqlDriver): { state: State; cursor: { hot: bigint; cold: bigint } } | null;
export const SNAPSHOT_VERSION = 1;
```

**Why this is not §3.3's deferred compaction, stated so nobody has to re-derive it** (Decision 5): the snapshot never enters the op log, is never hashed into a writer chain, is never uploaded, and is never re-encoded by a party that did not author it. §3.3:80's byte-canonicity prerequisite is a statement about *re-encoding foreign ops*; §3.3:81's head-registry reclamation is about *pruning entity heads*, which this does not do — it serializes them verbatim. The snapshot is a cache of a pure function of a prefix of the log, and its correctness is checkable by recomputing that function.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  test("save then load reproduces a byte-identical serializeState()", () => {});
  test("a snapshot at cursor C plus ops after C equals a full re-fold from genesis", () => {
    // the property that makes the snapshot safe; run it over the fixture log at 5 different cursors
  });
  test("a snapshot with a mismatched SNAPSHOT_VERSION is discarded, not migrated", () => {});
  test("a corrupt snapshot is discarded and the app re-folds rather than showing wrong data", () => {});
  test("nothing in the snapshot ever reaches an emitted op", () => {
    // grep the emit path: the snapshot is an input to no op payload, ever
  });
  ```
- [ ] **Step 2: Implement.** Reuse `serializeState()`'s canonical JSON (it already sorts and handles bigints) plus the fields `serializeState` omits (`appliedAtCursor`, per `notWitnessed()`), stored as one row. Measure the size at 3,683 txns; if it exceeds ~4 MB, split `txns` into its own table rather than one blob.
- [ ] **Step 3: `loadSnapshot` has a measured ceiling, because warm first paint is a gate.**
  A ~4 MB canonical-JSON parse with bigint revival on an A13 is a large fraction of the 2 s budget, and an earlier draft measured only the snapshot's *size*, which is not the quantity that matters. **Exit condition: `loadSnapshot` completes in ≤ 400 ms at the full corpus on the P2 device, measured with Task 1 Step 6's thermal protocol.** Over that, the snapshot must be split so the budget screen's slice loads first and the rest hydrates behind it — which is a design change, so discovering it here rather than at Task 28 is the point.
- [ ] **Step 4: A periodic integrity re-fold — budgeted, not background-and-hope.**
  Once per N launches (start at N=20, a named constant with a comment), re-fold from genesis and compare `serializeState()`. **This is the 58-second operation**, and an earlier draft scheduled it "in the background" with no budget and had it call `all()` — which no longer exists (Task 5). Constraints: it iterates `range()` in 250-row chunks with yields; it runs only on mains power **and** with the app foregrounded **and** at `thermalState() === "nominal"`, abandoning cleanly if any stops holding; it shows a visible, cancellable indicator; and it never blocks a user action. A mismatch is a hard finding, not a silent repair: log it, surface it in Task 12's Integrity screen, and fall back to the re-folded state.
- [ ] **Step 5:** tests green, commit.

---

### Task 10: The cold stream — lazy window, pinned hash list, range verification

**Files:** `app/src/sync/cold.ts`, `app/src/sync/cold.test.ts`.

**Interfaces:**

```ts
export const COLD_WINDOW_DAYS = 90;
export interface ColdSync {
  /** Pull and pin the compact hash list; needs zero bodies. */
  pinHashes(): Promise<{ pinned: number }>;
  /** Fetch bodies for a seq range, verified against the pinned hashes. */
  fetchRange(fromSeq: bigint, toSeq: bigint): Promise<number>;
  /** Fetch one body by ingest id, for the review queue's "show me the email". */
  fetchBody(ingestId: string): Promise<Uint8Array | null>;
  prune(): void;   // drop bodies older than COLD_WINDOW_DAYS
}
```

- [ ] **Step 1: Failing tests.** Pin from genesis and advance; a body with one flipped byte is refused by `I3b_cold_hash_list` and **persists nothing** (Phase 1's exit test step 11 already proves the server side of this — assert the client side); pinning must be **cold-only** (Phase 1's Task 14 fix found that pinning a hot head from the hash list puts it ahead of the hot bodies and makes the next pull an unclearable chain break — pin that as a named test); `prune()` never drops a body inside the window and never drops a *pinned hash*.
- [ ] **Step 2: Implement** on `Client.pullColdHashes()` and the `sync?stream=cold` range pull.
- [ ] **Step 3: Guarantee progress.** Phase 1's Task 14 minor: neither the cold-hash loop nor the range loop has a progress guarantee — a non-advancing `next` with `complete: false` spins forever. Assert progress on every page and throw a named error rather than looping.
- [ ] **Step 4:** tests green, commit.

---

### Task 11: The writer — outbox, offline queue, chains, checkpoints

This is the most fragile code in the system. Read Phase 1's progress ledger entries for Tasks 13 and 14 before writing a line.

**Files:** `app/src/sync/outbox.ts`, `app/src/sync/checkpoint.ts`, and their tests.

- [ ] **Step 1: Verify the I11 escape hatch. This needs no app and no UI — run it alongside Task 6 rather than waiting until task 11 of 31.** Task 0 Step 2 recorded that both `VIOLATION_ROSTER_COVERAGE` and `VIOLATION_CHAIN_WITHHELD` exist in `client/src/invariants/check.ts`, which means Phase 1's split landed: the benign "no checkpoint yet / roster grew" case and the adversarial "the server is withholding rows a peer has already witnessed" case have separate ids, and the push-time escape *may* cover only the benign one. Whether it *does* is a different question, and it is the one that matters. **Verify by test, not by reading:** construct the reviewer's scenario — dev-a pushes to hot counter 4, dev-b checkpoints `dev-a|hot=4`, the server truncates dev-a to counter 2 (a clean prefix, no chain break), dev-c pushes — and assert dev-c does **not** author a checkpoint claiming genesis, and that `VIOLATION_CHAIN_WITHHELD` is not escapable. If it is escapable, that is a Critical to fix here before anything else in this task.
- [ ] **Step 2: The contracts, restated so they are not rediscovered.**
  - `CHECKPOINT_NAMES_THE_ROSTER`: a checkpoint names every `(roster writer × stream)` pair, using `{counter: 0, hash: <64 zeros>}` for a chain that has never been written. Building it from *observed* heads makes `I11` hard-stop forever with no emittable checkpoint that could clear it.
  - **A checkpoint can never attest the blob it rides in** — the payload would need the hash of the blob sealing it. So a device's first checkpoint necessarily claims 0 for its own chain, and the notice clears on the next one. Verified genuine in Phase 1, not an ordering artifact.
  - **Sync before attesting.** `push`/`checkpoint` must pull and pin first; a checkpoint built from unpinned heads claims genesis for chains that are merely un-pinned rather than empty.
  - **`I11`-only hard stops are escapable during push**, because an enrolled-but-unattested writer otherwise deadlocks every device including the one that must write the healing checkpoint. That escape must cover `VIOLATION_ROSTER_COVERAGE` and never `VIOLATION_CHAIN_WITHHELD`.
  - Phase 1's ledger notes the `.every` boundary in that escape is asserted but **not pinned** — no scenario has `I11` co-occurring with another hard stop, so mutating `.every` to `.some` is caught by no test. Add that scenario and that test here.
- [ ] **Step 3: The outbox.** Ops emitted while offline queue in `client_state.pending` (already the shape `Client.emit()` uses) and persist across launch. On reconnect: sync, then push. `POST /api/v1/sync` caps at 8 blobs and 12 MiB, so the outbox pages. A `409 chain_break` on upload means the local chain and the server head disagree — surface it as a hard stop, never retry blindly.
- [ ] **Step 4: Airplane-mode tests.** Two simulated writers, both offline, both emitting against the same parent version; on reconnect assert both materialize the later `authored_at` and both report **exactly one** `ForkNotice` with the same winner/loser op ids. **Separate the two emits by ≥5 ms** — `authored_at` has millisecond resolution and a tie falls through to a `writer_id` comparison, which makes the winner depend on how fast the machine is. Phase 1's exit test does exactly this, deliberately.
- [ ] **Step 5:** tests green, commit.

---

### Task 12: The invariant checker on-device, and the halt surfaces

Spec §3.4: on a key-history mismatch or writer-chain break the client **halts sync and shows a non-dismissable warning**. Spec §3.3:74: an unreadable blob does **not** hard-stop — it is set aside with a visible warning. Those are two different UI states and conflating them is the failure mode.

**Files:** `app/src/sync/invariants.ts`, `app/src/screens/settings/IntegrityScreen.tsx`, `app/src/components/HaltBanner.tsx`, tests.

- [ ] **Step 1: Three surfaces, three rules.**
  | Severity | Trigger | UI |
  |---|---|---|
  | `hard_stop` | chain break, `UnknownNewerVersionError`, `VIOLATION_CHAIN_WITHHELD`, **and `VIOLATION_ROSTER_COVERAGE` (`I11`)** | Full-screen, **non-dismissable**, sync stopped, plain-language explanation, no "continue anyway". Data already on device stays readable. |
  | `notice` | everything else in the 17 | A row in an Integrity screen reachable from Settings, with a count badge. Never a modal. |
  | unreadable blob | `state.unreadable` non-empty | A persistent but dismissable banner naming the count, plus rows in the Integrity screen. The cursor advanced; nothing is lost. |

  **`I11` is a hard stop and an earlier draft of this table filed it under "everything else."** Task 11 Step 2 establishes that `VIOLATION_ROSTER_COVERAGE` *is* a hard stop — escapable during push, specifically and only so an enrolled-but-unattested writer cannot deadlock every device including the one that must write the healing checkpoint. Leaving it in the notice lane means a user reaches a hard stop with no screen behind it. Its copy must be distinct from the withholding case's: one says "this device hasn't been vouched for yet, and the fix is to open the app on a device that has," the other says "the server is withholding data another of your devices has already seen." They are the same invariant family and completely different situations.
- [ ] **Step 2: Do not drown the user in notices.** Phase 1's exit run produced, per device per stream, several `I11` notices that are *routine* (a checkpoint head on a stream this pull did not cover) plus `I14` reporting 18 `possible_duplicate` anomalies from a thin corpus. Classify the routine ones and collapse them: the Integrity screen shows categories with counts, expandable to detail. **A notice list nobody reads is the same as no invariants** — Phase 1's exit record says exactly that, which is why it printed the list in full rather than summarising it.
- [ ] **Step 3: Tests.** A chain break produces the non-dismissable state and stops the engine; an unreadable blob does not; `UnknownNewerVersionError` produces an "update the app" message distinct from the tamper message, because they mean completely different things to a user.
- [ ] **Step 4:** tests green, `app/src/components/README.md` updated, commit.

---

## Part D — Onboarding

### Task 13: Sign in with Apple and Google

**Files:** `app/src/auth/{idp.ts,session.ts,keys.ts}`, `app/src/screens/onboarding/SignInScreen.tsx`, tests.

- [ ] **Step 1:** `expo-auth-session` for both providers, identity scopes only (`openid email name` for Apple; `openid email profile` for Google — **never** a Gmail data scope: §3.8 says non-sensitive scopes precisely to stay clear of OAuth verification and CASA). App Store rules oblige Apple sign-in if Google is offered; both ship.
- [ ] **Step 2: Nonce discipline, which is the point of this task — and Apple hashes it.**
  Every authorize call passes a **server-issued nonce**. Sign-in's is currently unbound server-side (Task 6 Step 1 records why it stays that way for now); pass it anyway so the server can begin enforcing without a client change. **Address rotation** and **account deletion** take theirs from `POST /api/v1/address/challenge` and `POST /api/v1/account/challenge`, and Task 6 Step 1 makes the server verify the former.

  **The trap:** for native Sign in with Apple, the ID token's `nonce` claim is **`SHA-256(raw nonce)` hex**, not the raw value — Google's is the raw value. An earlier draft of this step specified the test as "the nonce reaching Apple/Google is the one the server issued, byte for byte," which is simply false for Apple, and the dangerous failure mode is an implementer relaxing the *server's* check until the test passes. So: the client sends the raw nonce to Apple and stores the raw nonce; **`auth.VerifyOpts.Nonce` must compare `SHA-256(issued)` against Apple's claim and `issued` against Google's**, selected by provider, and Task 6 Step 1's tests must cover both shapes with a named test per provider. Never relax the server to match a client bug.
- [ ] **Step 3: Secrets in the Keychain.** Session token and the device Ed25519 private key go to `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` — the **device identity key is not iCloud-synced** (§3.4: "device Keychain (not synced)"). Do not confuse it with the device *wrap* key, which is synced and is Phase 3.
- [ ] **Step 4: Writer enrolment.** First device: generate the key, `POST /api/v1/writers/challenge`, sign `registrationMessage(nonce, writerId, pub)` with Ed25519, `POST /api/v1/writers/register`. Second device: the same, signed by an already-enrolled key. `writer_id` is a stable per-install ULID stored beside the key. **Use strict base64** everywhere — Phase 1's ledger notes `--pubkey` used non-strict base64 so a typo'd key silently enrolled a writer nobody holds the key for.
- [ ] **Step 5: The not-invited path.** Task 6's `403 not_invited` gets a real screen explaining the beta is closed and offering the waitlist. Test it.
- [ ] **Step 6:** tests green, on-device sign-in against the P3 server succeeds, commit.

---

### Task 14: The onboarding shell and the one-shot home-currency picker

**Files:** `app/src/screens/onboarding/*`, `app/src/lib/onboarding.ts` (+ test).

- [ ] **Step 1: The step machine**, as a pure reducer in `lib/onboarding.ts` with a co-located test: `signed_in → invited → bank_picked → address_issued → forwarding_configured → first_mail_confirmed → home_currency_set → done`, each step resumable after a force-quit. The reducer is pure; the screens are thin. Test every transition and every resume point.
- [ ] **Step 2: The home-currency picker.** Emits `home_currency_set(<ccy>)` — **log state, never a device setting** (§3.7). If the choice is AED, also emit `rate_set("USD", 3672500n)` in the same push, per §3.7's seeded peg; for any other home currency, seed nothing.
- [ ] **Step 3: The immutability confirmation.** §3.7 makes this one-shot with **no in-product way to change it afterward**; the only remedy is account deletion. The confirmation must say that in those words — not "you can change this later in settings," which would be false. Two-step confirm, the chosen currency echoed back. (See open decision item 5.)
- [ ] **Step 4: Tests.** The reducer's full transition table; a second `home_currency_set` is refused client-side and, if one somehow reaches the log, `replay` records a `home_currency_reset` anomaly (it already does — assert it).
- [ ] **Step 5:** tests green, commit.

---

### Task 15: The inbound address and the forwarding-setup flow

**This is the screen Task 2 measured.** Do not start it until Task 2's record exists.

**Files:** `app/src/screens/onboarding/{AddressScreen.tsx,ForwardingScreen.tsx,VerificationScreen.tsx}`, `app/src/screens/settings/RotateAddressScreen.tsx`.

- [ ] **Step 1: Issue and display.** `GET /api/v1/address` mints on first read. Show the address with a large copy target (≥44 pt) and a QR, because typing a 26-character base32 token on a phone keyboard is how onboarding dies.
- [ ] **Step 2: Provider-specific instructions**, written from Task 2's measured record and not from memory. Gmail is the primary path and gets step-by-step screenshots-in-copy. Include whichever arm Task 2 found actually works (global forward vs. filter), and say plainly if a manual forward is required.
- [ ] **Step 3: The verification-code step** (Decision 7). Poll `GET /api/v1/quarantine?include_blob=1`, find the held message from `google.com`, extract the code, and show it with a copy affordance and a link. Fall back to rendering the message body when no code is found — never a dead end. Copy must explain why this message is held: it came from Google's forwarder, not from a bank, and the app deliberately does not trust forwarder identity.

  **This runs a pattern over attacker-controlled content**, which is the exact risk class Task 4 Step 5 and Task 24 Step 4 guard elsewhere; it does not get an exemption for being onboarding. Bound it: a fixed literal-anchored pattern with no unbounded quantifier (Gmail's code is a 9-digit run, so `[0-9]{9}` after a literal anchor), applied to at most the first 8 KB of the normalized body, with a wall-clock guard. Pin it with the same hostile inputs `conformance/dialect/patterns.json` uses.
- [ ] **Step 4: The first-real-mail step.** §3.2 makes confirming the first genuine bank email an onboarding step. Poll the quarantine lane; when a message arrives whose **verified** signing domain or **attested** inner origin is a bank, show the trust sheet (Task 17) inline. Show the verified domain — or a prominent "unauthenticated" state — never attacker-rendered content.
- [ ] **Step 5: Rotation.** Settings → rotate: `POST /api/v1/address/challenge` → IdP re-auth carrying that nonce (Task 13 step 2) → Ed25519 signature → `POST /api/v1/address/rotate`. The UI must state the consequences §3.2 names: it breaks the existing forward rule and any bank-side registration, both must be redone, and the old address accepts for **7 days**. Show the grace deadline from `grace_until`.
  **Bug to avoid, already found once:** `Predecessor` is one hop, so a user who rotates twice within a week has an older address whose allowlist carry-over the UI will misreport. Show only what the API returns and do not infer a chain.
- [ ] **Step 6: Tests + a real device run.** Complete the flow end to end on the P2 device against the P3 server with a real Gmail account. Record it.
- [ ] **Step 7:** commit.

---

### Task 16: Bank picker, waitlist, and the donation flow with redaction preview

**Files:** `app/src/screens/onboarding/BankScreen.tsx`, `app/src/screens/review/DonateSheet.tsx`, `app/src/lib/redaction.ts` (+ test).

- [ ] **Step 1: The picker.** Supported banks are the three seeded templates (DIB Arabic, ENBD transactions, ENBD account alerts). Unsupported → waitlist + the setup-time donation invitation. §3.5 is explicit that **consent at setup converts and consent at the moment of failure does not** — so the invitation belongs here, in onboarding, not only in the review queue.
- [ ] **Step 2: The default is content-free.** `POST /api/v1/samples/report {sender_domain, structure_sig}` sends a layout fingerprint and nothing else. **This needs a TypeScript `StructureSig`, which does not exist** (Phase 1's Task 31 concern). Port it from the Go implementation, add it to the conformance suite as a `(raw message → sig)` fixture set, and require Go/TS agreement. Same-layout-different-amounts must give the same signature; different layout must give a different one.
- [ ] **Step 3: The donation, and the preview that makes consent real.** `POST /api/v1/samples/donate {ingest_id, consent}`. The server copies the body from the user's own cold stream — it never accepts an uploaded body — so the client must first ensure the cold body is synced. The preview shows **the actual message that will be sent**, rendered from the local cold blob, with the consent identifier (`donate-sample-v1`) and, verbatim from §2, that a donated sample is a complete email of theirs — amounts, merchants, card digits, everything — readable by the operator for up to **180 days**.
- [ ] **Step 4: Tests.** Go/TS `StructureSig` agreement over ≥200 corpus messages; the preview renders the same bytes the server will copy (compare against the cold blob's `ingest_id`); donate is never callable without the consent string.
- [ ] **Step 5:** `bash scripts/v2-check.sh` green (the conformance suite grew), commit.

---

### Task 17: The quarantine lane and "trust this sender"

**Files:** `app/src/screens/quarantine/*`, `app/src/lib/quarantine.ts` (+ test).

- [ ] **Step 1: The list.** `GET /api/v1/quarantine` with keyset paging (`after` + `after_id`). Each row shows the **verified** signing domain, or a prominent "unauthenticated" state, plus the attestation source (`attested_by`), the DKIM and ARC results, and the arrival time. **Never** render body content as the basis for a trust decision — §3.2 is explicit that the decision must not be made from attacker-rendered content.
- [ ] **Step 2: Expiry, warned in advance.** Show `delete_after`, not `expires_at` — a late-warned item outlives its stated `expires_at` and the API returns both deliberately. Items with `warned_at` set get a countdown. Quarantined arrivals count as "action needed" in the watchdog (Task 25). §2's drop policy is "nothing is dropped without a user-visible notice"; this screen is that notice.
- [ ] **Step 3: Confirm.** `POST /api/v1/quarantine/confirm {domain, scope}`. Handle the two 409s with real copy: `forwarder_domain` ("this is your forwarder, not your bank — trust the bank behind it") and `origin_unproven` ("nothing we're holding carries a verified signature from that domain"). Confirming re-ingests held mail; surface `Report` counts and page on `Incomplete`.
- [ ] **Step 4: Tests.** Both 409 paths; a confirm that re-ingests N messages results in N new transactions after the next sync; the "unauthenticated" state renders when `attested` is false; `delete_after` beats `expires_at` in the UI.
- [ ] **Step 5:** commit.

---

## Part E — The product

### Task 18: Transactions — list, detail, edit

**Files:** `app/src/screens/transactions/*`, `app/src/lib/transactions.ts` (+ test).

- [ ] **Step 1: Port the pure logic, not the components — and cost the money-type change honestly.** `frontend/src/lib/{transactions,money,format,scope,split,txSplit}.ts` are framework-free and already tested; copy them into `app/src/lib/` with their tests. **"Adapt only the money type to `bigint`" understates it**, and an earlier draft of this step said exactly that: v1's `money.ts`/`format.ts` are `number`-based, so every division, every rounding decision and every `toFixed` changes shape — `bigint` has no fractional division, so each site needs an explicit rounding rule, and half-up must match `client/src/replay/fx.ts`'s exactly or two parts of the app disagree about the same amount. Budget it as a rewrite with the v1 tests as a specification, and add cases the v1 suite has no reason to contain: the largest amount in the corpus, a negative-zero-adjacent split remainder, and a value above `2^53`.

  **These are forks, not shared modules.** `frontend/` stays on `number` for the v1 PWA; there is no shared source. Record that in `app/src/lib/README.md` so a later "let's dedupe these" produces a design decision rather than a silent regression.
- [ ] **Step 2: The list reads SQLite only**, paged, sorted by `posted_at DESC`, with the filter chips the v1 UX established. **Never** hold the whole table in a JS array — bind the query to the list's window.
- [ ] **Step 3: Edits emit ops.** A category change is `txn_categorized` carrying `parent_version` = the entity's current head version; an amount/merchant/date correction is `txn_edited`; a split is `txn_split` whose parts must sum to the parent (`I8_split_sum`). The head version comes from the projection, and a stale head must be re-read before emit, never assumed.
- [ ] **Step 4: Provenance is visible.** §3.3 requires the UI to distinguish server-ingested from user-authored, because the ingest writer's chain proves storage integrity and **nothing about operator honesty**. A small, permanent marker on ingest-provenance rows; explained once in Settings.
- [ ] **Step 5: Tests** for the pure logic, plus a render test that an unparsed row (Task 7) shows as "couldn't read this one" and not as a 0.00 transaction.
- [ ] **Step 6:** commit.

---

### Task 19: The review queue

**Files:** `app/src/screens/review/*`, `app/src/lib/review.ts` (+ test).

- [ ] **Step 1: Four lanes, one queue**, ordered by how much the user can actually do about them:
  1. `needs_review` **parsed** transactions — heuristic-tier results, which §3.2 says are *always* flagged in v2 and never auto-trusted. Confirm or correct.
  2. `unparsed` (`tier === "none"`) — nothing extracted. Offer: enter it by hand, donate the sample (Task 16), or dismiss.
  3. `possible_duplicate` — the fingerprint heuristic. **Both rows stay live**; this is a notice, never a silent drop (§3.3:73). Offer "these are different purchases" (dismiss) or "this is a duplicate" (emit an edit that marks it).
  4. `ForkNotice` — a concurrent edit was resolved. Show what won, what lost, and when. Never silent (§3.3).
- [ ] **Step 2: The swipe deck**, ported in spirit from v1's categorizer: one card, a category grid, a large undo. 44 pt minimum targets.
- [ ] **Step 3: Every action writes back a rule.** Confirming a merchant→category emits `rule_added` so the same merchant never needs review again — v1's self-improving-rules principle, client-side. Offer (opt-in, off by default) submission to the global dictionary (Task 20).
- [ ] **Step 4: Tests.** Each lane's query; the unparsed lane is non-empty when `tier === "none"` rows exist; a `possible_duplicate` dismissal does not delete either row; confirming emits both `txn_categorized` and `rule_added` in one push.
- [ ] **Step 5:** commit.

---

### Task 20: Categorization — rules, the global dictionary, on-device matching

**Files:** `app/src/lib/categorize.ts` (+ test), `app/src/db/dictionary.ts`, `internal/v2/api/dict.go` (submission route), migration.

- [ ] **Step 1: Matching order**, on-device, no network: user rules by priority (`contains` / `exact` / `regex`), then the global dictionary (`contains` / `exact` — **never regex**, §3.6), then uncategorized. Pure function, exhaustively tested including precedence ties and case folding.
- [ ] **Step 2: Dictionary sync.** `GET /api/v1/dictionary?since=<version>` returns `{version, entries, removed}`. Store locally; apply `removed`; re-categorize only rows that are still uncategorized — **never** rewrite a user's own decision.
- [ ] **Step 3: Submission (server work).** No submission route exists; `dict.Submit` is written and unexposed. Add `POST /api/v1/dictionary/submissions {pattern, match, category}`, opt-in, rate-limited at the samples budget (1/min burst 60). It must write **no `user_id`** — §3.6 forbids a (user, merchant) table outright — only `submitter_hmac`, a day-granular `created_at` and the `key_epoch`, exactly as `dict.Submit` already does. Tests: the route stores no user id; a submission for an already-published entry stores no identifier at all; the k=3 threshold suppresses publication.
- [ ] **Step 4: The consent copy** must state §2's caveat honestly: at closed-beta scale the operator can enumerate its own small user list against the HMAC, so this is a bounded but real linkage for as long as the row exists, and the row is deleted the moment the entry reaches k=3.
- [ ] **Step 5:** `bash scripts/v2-check.sh` green, commit.

---

### Task 21: The budget screen

**Files:** `app/src/screens/budget/*`, `app/src/lib/budget.ts` (+ test).

- [ ] **Step 1: The math is a SQL aggregate**, not a JS loop. Phase 0's strongest single result is a full 3,683-row `GROUP BY`/`CASE`/`SUM` budget aggregate in **0.65 ms**; do not throw that away by materializing rows into JS to add them up.
- [ ] **Step 2: 50/30/20 over confirmed transactions**, home-currency amounts only. **Null `amount_home_minor` is not zero.** Rows with no rate are excluded from the totals and surfaced in a "not counted yet" strip linking to Task 22's add-rate action. Unparsed rows (Task 7) are excluded from money math entirely. Test both exclusions explicitly — a budget total that silently absorbs unconverted or unparsed rows is wrong in a way no user can see.
- [ ] **Step 3: "Budget warming up."** §3.9 requires a deliberate first-weeks presentation instead of a blank 50/30/20 screen. Below a threshold of confirmed history (start at 14 days *or* 10 transactions, whichever first), show what has arrived, what is still needed, and a link to CSV import (Task 23).
- [ ] **Step 4: Tests** for the aggregate against a fixture log with mixed currencies, missing rates, unparsed rows and splits.
- [ ] **Step 5:** commit.

---

### Task 22: Currencies — manual FX, staleness, missing rates, recompute

**Files:** `app/src/screens/currencies/*`, `app/src/lib/fxUi.ts` (+ test).

`client/src/replay/fx.ts` already implements every rule; this task builds UI on it and adds nothing to the math.

- [ ] **Step 1: The list.** One row per currency with a rate: `rate_micro` rendered as a decimal, and **`updated_at` rendered as an age** ("USD set 41 days ago"). §3.7 calls this out as new client work — v1's API returned `updated_at` and v1's own `CurrenciesPage.tsx` never rendered it. A staleness affordance past a threshold (start at 30 days).
- [ ] **Step 2: Entry.** A numeric field that is a **string draft** until commit. `Number("") === 0` is the springback bug the v1 harness found by typing into things; the same class of bug here writes a rate of zero into the log, permanently, and freezes snapshots against it. Test: clearing the field leaves it clear; committing an empty field is refused; a value with more than 6 decimal places is refused rather than rounded silently.
- [ ] **Step 3: The missing-rates list** with an inline "add rate" that emits `rate_set` and, on the next fold, backfills every transaction of that currency still null as of that position — and touches nothing already frozen. Test the non-retroactivity directly.
- [ ] **Step 4: `rate_unset`** as a delete action, with copy explaining it is not retroactive: transactions after this position snapshot null until a later `rate_set`; already-frozen ones are untouched.
- [ ] **Step 5: "Recompute at current rate"**, per transaction. §3.7 requires this to emit a `txn_edited` that **carries the resulting home-currency amount explicitly in its payload** — not a pointer telling replay to recompute later — so replay stays a pure function of logged data. Test the payload shape, not just the resulting number.
- [ ] **Step 6:** commit.

---

### Task 23: Client-side CSV import and the first-week backfill

**Files:** `app/src/screens/import/*`, `client/src/importer/{csv.ts,map.ts,normalize.ts}` (+ tests), `conformance/import/*.json`.

§3.9 makes this a churn mitigation: onboarding ends with a working pipeline and zero history. It also names the obligation most easily missed — the normalization logic from `internal/importer/` **joins the dual-executor conformance suite**.

- [ ] **Step 1: Port `internal/importer/`'s normalization to TypeScript** under `client/src/importer/`, and add `conformance/import/` fixtures executed by **both** executors, wired into `scripts/v2-check.sh`. Disagreement fails the build, exactly as for the normalizer and the template executor.
- [ ] **Step 2: The mapping UI.** `expo-document-picker` for the file, a column-mapping screen modelled on `docs/map.example.toml`'s fields, and a preview of the first 20 parsed rows before anything is emitted.
- [ ] **Step 3: Emit as batched client-authored ops** (Decision 9). Ops carry `provenance: "user"` — never `"ingest"`, which the server rejects at upload anyway (403). Respect the upload caps: ≤8 blobs per request, ≤1 MiB per blob, ≤12 MiB per body. Test a 3,683-row import and assert the blob count is single digits, not thousands.
- [ ] **Step 4: Dedup is the fingerprint heuristic, and it makes review items, never drops** (§3.3:73). An imported row matching an ingested one becomes a `possible_duplicate` in Task 19's lane. Test with a CSV that overlaps live mail.
- [ ] **Step 5: Time the import on-device at 3,683 rows, against a threshold.** This is the one Phase 2 feature that manufactures a large log on day one, so it gets a number rather than an observation: **≤ 20 s end to end on the P2 device, with a visible progress affordance throughout and no JS-thread block over 250 ms** (the same responsiveness bound Task 28 Step 2 applies — it is the same failure mode). Over that, chunk the emit path the way Task 8 chunks the fold.
- [ ] **Step 6:** `bash scripts/v2-check.sh` green, commit.

---

### Task 24: Client-side reprocessing over the cold stream

§3.5:117's "fix the parser, backfill" surviving E2E at zero server compute. Template tier only (Decision 6).

**Files:** `internal/v2/api/templates.go` (new public route), `app/src/sync/reprocess.ts` (+ test).

- [ ] **Step 1: Server — publish templates to clients.** No public template route exists; templates are authored and published only through the tailnet admin console. Add `GET /api/v1/templates?since=<version>` returning `{version, templates: [{id, bank, version, normalizer_version, definition, status}], removed: [...]}`, published status only, session-authenticated, same wire conventions (int64s as decimal strings). Tests: a draft is never served; `since` is a cursor; the payload validates against `tmpl.ValidateDefinition` on the way out.
- [ ] **Step 2: Client — reprocess, and decide what "in the cold window" means.** On a new template version: for each `unparsed` or heuristic-tier transaction, fetch the **chain-verified** cold body (Task 10), run `norm.normalize` then `tmpl.execute`, and on a successful extraction emit a supersede op keyed by the same `ingest_id`. **Never parse an unverified cold body** — §3.3:78 is explicit that a malicious server could otherwise swap a body and launder a poisoned transaction through the client's own trusted writer chain. Test that path directly: a body whose hash does not match the pinned entry is refused and nothing is emitted.

  **The 90-day cold window and "fix the parser, backfill" are in tension and an earlier draft left it unresolved.** Task 10 prunes bodies older than `COLD_WINDOW_DAYS`, but the client can re-fetch any range from the server, so the window is a *cache* policy, not a *capability* limit. Two coherent options, pick one and state it in-product: **(a) unbounded backfill** — reprocessing re-fetches whatever ranges it needs, pruning them again afterwards, so §3.5's promise holds in full at the cost of a large one-off download; or **(b) 90-day-bounded backfill** — a real degradation of "fix the parser, backfill" that must be *said out loud in the UI* ("we re-read the last 90 days"), never silently applied. Recommendation: **(a)**, gated on Wi-Fi and with a progress affordance, because a silent 90-day horizon on a recovery feature is the kind of limitation users discover at the worst moment.
- [ ] **Step 3: The heuristic limitation, in-product.** A heuristic-tier transaction cannot be re-read on device (no TS heuristic). Show "this one was read by the fallback reader and can't be re-checked on your phone" rather than silently skipping it.
- [ ] **Step 4: ReDoS.** Phase 1 measured a dialect-legal pattern (`[0-9]+[0-9]+[0-9]+[0-9]+z`) taking **88 seconds on 400 characters in Bun** — Go's RE2 is immune, the client is not, and the input path is attacker-writable. Confirm Task 20 of Phase 1's added ban landed in `client/src/tmpl/dialect.ts`; if it did not, this is where it lands, with a `patterns.json` regeneration. Run every published template against the 20 hostile inputs in `conformance/dialect/patterns.json` **on device** and assert a per-message time bound.
- [ ] **Step 5:** `bash scripts/v2-check.sh` green, commit.

---

### Task 25: Push registration, content-free notifications, and the watchdog

**Files:** `app/src/push/*`, `app/src/lib/watchdog.ts` (+ test).

- [ ] **Step 1: Register.** `expo-notifications` for permission and the Expo push token; `POST /api/v1/push/tokens {token, platform}` on grant; `DELETE /api/v1/push/tokens/{token}` on sign-out. Token must match `^[\x21-\x7e]+$` and be ≤512 chars or the server 400s.
- [ ] **Step 2: Content-free, and verify it.** The server sends exactly `{"to": tok, "title": "New transaction", "body": ""}` — no amount, no merchant, no count, ever. On tap, open the app and sync. **Assert the received payload contains no transaction data** in an on-device test; §3.8's guarantee is worth a test that would catch a future convenience.
- [ ] **Step 3: Enable it.** `cfg.Push.Enabled` defaults false in Phase 1 because no app existed. Turn it on in the P3 deployment and confirm a real delivery end to end.
- [ ] **Step 4: The client-side watchdog** (§3.2). Only the client knows what normal looks like: compute a per-user arrival baseline from local history and alert on "no mail in N days vs. your own baseline." Pure function in `lib/watchdog.ts` with a test over synthetic arrival histories including a sparse-but-normal user (a Gmail forwarding rule silently disabled after sustained failures is invisible to us and is exactly what this catches). Quarantined arrivals count as "action needed."

  **State the limitation rather than implying more than it does.** iOS gives a foregrounded-only app no reliable background execution, so a watchdog evaluated on launch fires *when the user opens the app* — which is roughly when they would notice the silence themselves. That makes it a useful confirmation and a poor alarm. Two options if it needs to be a real alarm, neither in scope here: `expo-task-manager`'s background fetch, which iOS schedules opportunistically and may not run for days; or a **server-side** silence detector, which would need the server to know a user's expected arrival cadence — plausible from `parse_diagnostics`, which already holds per-user arrival times unencrypted (§2 discloses this), but it is a new server surface and a §2 change. Record which, if either, the beta wants.
- [ ] **Step 5:** commit.

---

### Task 26: Export and account deletion

Both are §3.10 requirements. Deletion is also App Review guideline 5.1.1(v), and §3.10 puts it in Phase 2 explicitly, "before any external tester touches the system with crypto on."

**Files:** `app/src/screens/settings/{ExportScreen.tsx,DeleteAccountScreen.tsx}`, `app/src/lib/export.ts` (+ test).

- [ ] **Step 1: Export is on-device and the server is not involved.** Generate JSON and CSV from local SQLite, write with `expo-file-system`, share via `expo-sharing`. Include transactions, splits, rules, rates, home currency and the fork/anomaly log. Money as decimal strings — never a float, and never a JS `number` that would round a large `bigint`. **Threshold: a 3,683-row export completes in ≤ 10 s on the P2 device with no JS-thread block over 250 ms**, and the largest amount in the corpus round-trips exactly (assert the string, not a parsed value). Size is recorded as an observation; the time and the round-trip are gates.
- [ ] **Step 2: Deletion is three factors.** `POST /api/v1/account/challenge` → nonce; IdP re-auth with `iat` within 5 minutes carrying that nonce; Ed25519 signature over `DeletionMessage(nonce, user_id)`; `DELETE /api/v1/account`. All of that already exists server-side — build the client half and do not weaken it.
- [ ] **Step 3: The confirmation must be honest.** State what is destroyed (everything on the server, immediately) and what is not (backups age out on their own retention schedule; after Phase 3 their copies are ciphertext whose keys no longer exist anywhere — say so precisely rather than claiming instant global erasure). Offer export first, in the same flow.
- [ ] **Step 4: After success**, wipe local SQLite, the Keychain entries and the outbox, and return to sign-in. Test that no residue survives — in particular the Ed25519 key and the session token.

  **On the deleting device that is unambiguous. On the user's *other* devices it is not, and this is a data-loss footgun.** Device A learns its account is gone only from a server response, and a 401 is also what an expired session, a revoked session and a server restart look like. **Wipe only on `410 account_deleted`** (Task 6 Step 3), never on a 401 — a 401 signs the user out and keeps every local row. Two named tests: an expired session leaves local data intact and offers re-sign-in; a 410 wipes. Getting this backwards deletes a user's history because their token expired overnight.
- [ ] **Step 5:** commit.

---

### Task 27: Key-UX slots, crypto dormant

Deliberately small (Decision 10, open decision item 4).

**Files:** `app/src/screens/settings/SecurityScreen.tsx`.

- [ ] **Step 1: Build the rows** — "Recovery phrase", "Recovery passphrase (optional)", "Verify another device", "This device's key" — each reachable, each explaining in plain language what it will do, each in an explicit **"not yet active — your data is not encrypted at rest in this beta"** state.
- [ ] **Step 2: Do not display a recovery phrase.** A phrase that recovers nothing is a lie about the safety of a user's financial history, and it is the single worst thing this app could ship. If a placeholder is wanted, it is a description, not a phrase.
- [ ] **Step 3: Show the device's Ed25519 public key fingerprint** — that one *is* real (Phase 1 Decision 9) and is genuinely useful for support.
- [ ] **Step 4: A plain-language plaintext disclosure — but it is blocked, and this task must not invent the promise.**
  An earlier draft said "matching the alpha consent document: Phase 2 runs unencrypted, the retention limit, and the migrate-or-delete commitment at the Phase 3 cutover" — as if all three were settled. **They are not. The alpha consent document does not exist and no task in this plan writes it**, and whether an alpha's existing plaintext history gets *migrated* into the sealed format or *wiped* at the Phase 3 cutover is a genuine call with real cost on both sides (migration means building a re-sealing path and keeping plaintext readable until it runs; wiping is trivial and means telling people up front that the beta's data is disposable).

  **The copy is the promise, and it is very hard to walk back once someone has three months of their finances in the app.** So: this step writes the two facts that *are* settled — Phase 2 stores data unencrypted, and the operator can read it — and leaves a single, clearly-marked placeholder for the cutover commitment. It does not ship to an alpha until human-decision item 9 is answered and the consent document exists. Task 16's donation-consent copy has the same dependency.
- [ ] **Step 5:** commit.

---

## Part F — The gate that proves it

### Task 28: Gate B — the end-to-end measurement (HARD GATE)

Task 1 was permission to build. **This is the proof.** Note precisely what that means against the spec: §5 asks for a *projection* — "the native-crypto benchmark … **projects** a cold restore and first paint that both fit Phase 0's budget." Task 1 satisfies the criterion as literally written. Task 28 **exceeds** it by measuring instead of projecting, which is the right call for a number this load-bearing, and it is stated as an addition rather than mis-cited as the spec's own requirement.

**Files:** `app/src/bench/gateB.ts`, `docs/superpowers/specs/v2-phase2-crypto-gate.md` (append a Gate B section).

- [ ] **Step 1: Get the sealed corpus into the system.** Phase 2 blobs are plaintext, so a restore of real Phase 2 data measures a gunzip and proves nothing about Phase 3.
  ```bash
  ledgerd load-corpus --user <bench-uuid> --in $W/corpus.bin \
      --manifest conformance/crypto/manifest.json --stream hot --singleton --envelope-version 2
  ```
  Task 1 Step 2 built this; without it there is no path that produces 3,683 ingest singletons. The blob-open path routes through the **native module** for the v2-framed blobs it now sees — the version byte selects the opener, so no flag is needed at the read site.

  **The bench build is a separate EAS profile, not a runtime toggle.** An earlier draft asked for the `preview` profile *with* the bench flag on and, in the same run, an assertion that the flag is off in `preview` — which needs two builds. So: profile **`bench`** is `preview` plus `EXPO_PUBLIC_BENCH=1`, identical in every other respect (release, embedded bundle, same optimizer settings), and the measurement is taken on `bench`. A **separate** unit test asserts that `preview` builds with the flag unset and that the native module is unreachable from the product's blob-open path when it is. Two artifacts, two assertions, no contradiction.

- [ ] **Step 2: Measure on the P2 device**, `bench` profile (a release build, not the dev client — Hermes bytecode and dead-code elimination both matter), under Task 1 Step 6's thermal protocol:
  - **Cold restore**: fresh install → sign in → full sync of the corpus → budget screen showing correct totals. Instrument every stage: `fetch`, `open`, `decode`, `chainVerify`, `fold`, `project`, `snapshot`, `paint`. **`chainVerify` and `fold` are what Phase 0 never measured** (Caveat 9) and what Task 1's 6 s budget reserved for; compare them against Task 1b's figures and explain any divergence rather than reporting the newer number silently.
  - **First paint, warm**: force-quit ×5, measured on the **recording clock** (Task 1 Step 7), with the instrument clock reported alongside.
  - **Peak RSS** via `rssBytes()`, sampled per chunk. Ceiling **250 MB**; exceeding it fails the run.
  - **Responsiveness**: a frame heartbeat counting missed ticks. **Threshold, not an observation: the longest single JS-thread block must be ≤ 250 ms.** An earlier draft said only "report the longest block" — for a metric that exists because the Phase 0 build froze at FPS 0 in ~3.8 s slabs, and which sat next to an RSS figure that did have a ceiling. A number nobody can fail is not a gate.
  - Five runs each, median and full spread, run 1 reported separately.
- [ ] **Step 3: Correctness gate, unconditional — and the reference is the manifest, not the server.**
  **v2's server computes no budget totals.** It is blind by design (§3.9 is local-first; §3.3's table list has no `fx_rates`), so an earlier draft's "must match a server-side computation" named a reference that does not exist. The reference is `conformance/crypto/manifest.json`'s `check` block — the **salted digests** Task 1 Step 1 commits, computed by the generator from the same source rows. Recompute `SHA-256(salt ‖ month ‖ bucket ‖ decimal-string total)` from what the device materialized and compare digest to digest; on mismatch, print the actual totals to the device report in `$W` for diagnosis and never to a committed file.

  **And the currency-correct check needs ops the transaction corpus does not carry.** A corpus of `txn_ingested` records alone has no `home_currency_set` and no `rate_set`, so §3.7's conversion path is unreachable and the check degenerates to Phase 0's currency-blind `SUM` — the exact thing `RESULTS.md` says "is not the check §3.7's real client-side FX conversion would need to pass." **Task 1b Step 1's fixture is the one to load here**: it carries `home_currency_set`, a dozen positional `rate_set` ops and ~30 foreign-currency transactions, so snapshot-and-backfill is genuinely exercised. That is why each month in the `check` block carries **two** digests — `blind` (currency-blind, comparable to Phase 0) and `home` (after §3.7 conversion, the real one). Assert both.
- [ ] **Step 4: The verdict.**
  | Branch | Condition | Consequence |
  |---|---|---|
  | **PASS** | cold ≤ 10 000 ms **and** warm first paint ≤ 2 000 ms on the P2 device, RSS under ceiling, correctness green | Spec §5's Phase 2 performance criterion is **met and measured**, not projected. Record it. |
  | **FAIL** | either exceeds | Phase 2 does not exit. Escalate Task 1's fallback ladder with real numbers this time — F1 and F2 are now costable against measurement rather than projection. |
- [ ] **Step 5: Append to `docs/superpowers/specs/v2-phase2-crypto-gate.md`** — the same honesty standard as Task 1: device, build profile, network path, per-stage medians and spread, RSS, longest block, correctness result, verdict, and what the measurement does *not* cover.
- [ ] **Step 6:** commit.

---

### Task 29: The Phase 2 exit scenario

Spec §5's second Phase 2 exit clause, in executable form: *"a fresh install onboards, imports a statement, syncs, categorizes, and survives airplane-mode edits on two devices without invariant violations."*

**Files:** `app/test/device/exit.md` (the scripted protocol), `docs/superpowers/specs/v2-phase2-exit-record.md`.

Two real devices, both on the tailnet, against the real `ledgerd` from P3. Scripted and recorded, because there is no simulator on this box and no CI service.

- [ ] **Step 1: Fresh install, device A.** Sign in (allowlisted), pick a bank, get an address, configure Gmail forwarding using Task 2's measured arm, read the verification code from the quarantine lane, confirm the first real bank email, set the home currency. **Assert:** the onboarding reducer reaches `done`; the first transaction materializes; `checkAll` returns zero `hard_stop`.
- [ ] **Step 2: Import a statement.** A real CSV of ≥500 rows. **Assert:** the projection row count matches; the blob count is single digits; overlapping rows become `possible_duplicate` review items and **not** drops; the budget screen leaves "budget warming up".
- [ ] **Step 3: Categorize.** Work the review queue to empty. **Assert:** each confirmation emitted both `txn_categorized` and `rule_added`; a later transaction from the same merchant is auto-categorized with no network call.
- [ ] **Step 4: Enrol device B**, signed by device A's key. **Assert:** device B pulls, folds, and produces a `serializeState()` **byte-identical** to device A's; the checkpoint names every `(roster writer × stream)` pair **including `ingest`** (Phase 1's `f0ac846`, verified at Task 0 Step 1).
- [ ] **Step 5: Airplane mode, both devices.** On A, categorize transaction T as `dining`. On B, categorize the same T as `groceries`, at least 5 ms later by `authored_at`. Reconnect B first, then A. **Assert:** both converge on the later `authored_at`'s category; both report **exactly one** `ForkNotice` with the same winner and loser op ids; the notice is surfaced in the UI, not just in state.
- [ ] **Step 6: The supersede round-trip.** Publish a corrected template version; device A reprocesses over its cold window and emits a supersede. **Assert:** one live transaction per `ingest_id` on both devices; the FX snapshot is recomputed **fresh at its own position** and not inherited.
- [ ] **Step 7: Invariants.** `checkAll` on both devices, both streams. **Assert zero `hard_stop`**, and print the full notice list — summarising it is how a notice list stops being read.
- [ ] **Step 8: Data rights.** Export on A and verify the file. Delete the account from B and verify the server purge (`ledgerd verify --json` → `findings: []`). **Assert A receives `410 account_deleted` and wipes on that**, and — in the same step, because this is the pair that matters — that A does **not** wipe when handed a plain 401 (expire A's session first and confirm it signs out with its data intact).
- [ ] **Step 9: Write `docs/superpowers/specs/v2-phase2-exit-record.md`** in the shape of `v2-phase1-exit-record.md`: the numbered steps with pass/fail, the fork notice verbatim, the checkpoint verbatim, the full notice list, and — separately and explicitly — every criterion that could **not** be tested and why.
- [ ] **Step 10:** commit.

---

## Exit criteria checklist (spec §5, Phase 2)

> *Exit: the native-crypto benchmark, applied to Phase 0's cold-restore decomposition, projects a cold restore **and** first paint that both fit Phase 0's budget (<10s cold, <2s warm) on the oldest target device — a raw speedup ratio in the 10–100× range is not sufficient on its own; if the projected budget isn't met, Phase 0's provisional pass must be revisited before proceeding; and a fresh install onboards, imports a statement, syncs, categorizes, and survives airplane-mode edits on two devices without invariant violations.*

- [ ] **The native-crypto benchmark landed** — Task 1, on the P2 device, with a `@noble` control measured in the same session so the ratio is within-device.
- [ ] **Applied to the cold-restore decomposition, not reported as a ratio** — Task 1 step 7 reports `T_crypto + T_rest`, and the verdict table has no branch that passes on `R` alone.
- [ ] **Cold restore < 10 s, measured not projected** — Task 28 step 2, `preview` build, real sync, real fold, real chain verification, against a Phase-3-shaped sealed corpus (Task 28 step 1, without which the number is meaningless).
- [ ] **First paint < 2 s** — Task 1 step 5 builds the instrument Phase 0 never had; Task 28 step 2 measures it on the release build, cross-checked against a 240 fps recording.
- [ ] **On the oldest target device** — P2. If it is unavailable, Task 1 cannot return PASS (Decision 11), and the exit criterion is not met however good the numbers look.
- [ ] **Fresh install onboards** — Task 29 step 1, including the Gmail path Task 2 measured.
- [ ] **Imports a statement** — Task 29 step 2.
- [ ] **Syncs** — Task 29 step 4, byte-identical `serializeState()` on two devices.
- [ ] **Categorizes** — Task 29 step 3, with rule write-back.
- [ ] **Survives airplane-mode edits on two devices without invariant violations** — Task 29 steps 5 and 7: one `ForkNotice`, identical on both, zero `hard_stop`.
- [ ] **Additional gates this plan adds because the spec makes them prerequisites:**
  - [ ] **The sealed-corpus loader exists and both gates ran against its shape** (`ledgerd load-corpus --singleton`, Task 1 Step 2) — without it neither gate is executable, and the obvious workaround measures a batched transport, which is `RESULTS.md` Caveat 7 all over again.
  - [ ] **The fold was measured on Hermes before the app was built** (Task 1b) — the 4 s reserve is confirmed or renegotiated at task 3, not discovered at task 28.
  - [ ] The Gmail forwarding path is **measured**, not assumed (Task 2) — the corpus has zero Gmail forwards and it is the primary onboarding path.
  - [ ] `client/src` runs on Hermes with **no pre-existing client test removed, skipped or weakened and the collected count no lower than Task 0's baseline** (Task 4 Step 3), and the SQLite store passes the same suite (Task 5 Step 4).
  - [ ] The regex dialect's ReDoS bounds and the U+212A case-folding divergence are **re-measured on Hermes** (Task 4 Step 5) — they were calibrated in Bun and Phase 1 left an explicit instruction to re-measure on this exact move.
  - [ ] `unparsed` ops materialize and are excluded from money math (Task 7) — otherwise the review queue is built on sand and budget totals are quietly wrong.
  - [ ] The ingest chain is covered by device checkpoints (Task 0 Step 1 verifies Phase 1's ingest-chain fix) — Phase 1's named tamper-evidence blind spot, closed in Phase 1, inherited here.
  - [ ] Address rotation actually verifies a nonce, **in Apple's hashed form and Google's raw form** (Task 6 Step 1 + Task 13 Step 2) — recorded by Phase 1 as "blocking for beta".
  - [ ] An invite gate exists (Task 6 Step 2) — a closed beta is not implementable without one, and an identity allowlist cannot be keyed before first sign-in.
  - [ ] A deleted account is distinguishable from an expired session (Task 6 Step 3, `410`) — wiping on a 401 would delete a user's history because their token expired overnight.
  - [ ] **No real financial data was committed** — every task's final `git add` names explicit paths and its `--stat` was read (Global Constraints; Task 1 Step 12 in particular).
  - [ ] Every on-device measurement produced a **machine-readable report** committed alongside its prose (Task 1 Step 10) — a phase whose evidence base is on-device numbers cannot rest on hand transcription.
  - [ ] Go/TS agreement extends to `StructureSig` (Task 16) and the CSV importer (Task 23), both wired into `scripts/v2-check.sh`.
  - [ ] Export and account deletion ship (Task 26) — §3.10 requires them in Phase 2 even though §5's exit clause does not name them.
  - [ ] Peak RSS stays under a stated ceiling and the longest JS-thread block is reported (Task 28) — the Phase 0 catastrophic run is the reason both are gates and not observations.

---

## Self-review notes

- **This is revision 2.** An adversarial pre-execution review found 8 Critical, 30 Important and 16 Minor against revision 1; all are addressed above, most by rewriting the offending step and *recording what the earlier draft said* so the same mistake is not re-derived. Three of the review's own claims were checked and corrected in the process: the ingest-writer roster fix **has landed** (`f0ac846` — the review saw it uncommitted); the next free migration is **`00020`**, not `00018`; and global `fetch` is **already injectable** via `ClientOptions.fetch`, so it needs an explicit argument rather than a shim.

- **Spec coverage.** §3.1 → P3, Task 6, Task 24 (the two new public routes). §3.2 → Tasks 2, 15, 17, 25. §3.3 → Tasks 7–12, 29. §3.4 → Tasks 13 (device identity keys, capability rules) and 27 (slots only); everything else in §3.4 is Phase 3 and Global Constraints says so. §3.5 → Tasks 16, 24. §3.6 → Task 20. §3.7 → Tasks 14, 21, 22. §3.8 → Tasks 13, 25. §3.9 → the whole of Parts C–E. §3.10 → Task 26. §5's Phase 2 clause → Tasks 1, 1b, 28, 29.

- **The three structural decisions a reviewer should push on first.**
  1. **Two gates, not one (Tasks 1 and 28).** Task 1 is a projection and exists to fail fast; Task 28 is a measurement and is what the spec's criterion actually asks for. The alternative — one gate at the end — means discovering a FAIL after 27 tasks of work. The alternative — one gate at the front — means calling a projection a proof, which is exactly what Phase 0 was criticised for and explicitly declined to do.
  2. **Reusing `Client`'s protocol logic against `client/README.md`'s own instruction (Decision 3, Global Constraints).** If this is wrong, Tasks 5, 8, 10, 11 and 12 all move together and the app grows its own pull/verify/attest stack. The argument for reuse is empirical: Phase 1's ledger records four review rounds of subtle, security-relevant bugs in exactly that ordering, at least one of which (the I11 escape laundering a real withholding into a routine notice) was found only by a reviewer building the attack end to end.
  3. **The device-local fold snapshot is not §3.3's deferred compaction (Decision 5, Task 9).** If a reviewer disagrees, warm start becomes a full re-fold and Task 9 becomes a performance problem instead of a caching one. The discharge rests on the snapshot never being re-encoded by a non-author and never entering a chain; Task 9 step 1's fifth test is the pin.

- **The one structural addition revision 2 makes: Task 1b.** Revision 1 identified five unmeasured terms, covered them with a 4 s reserve, called that reserve "the single most arguable figure in this plan," and then measured none of them until Task 28 — twenty-seven tasks later. Task 1b measures the cheapest and riskiest of the five (the fold, in Hermes, over `bigint`-heavy code nobody has run on a device) before the app shell exists. If a reviewer thinks one gate too many, this is the one to argue about; the argument for it is that a `RENEGOTIATES` verdict at task 3 costs a day and the same verdict at task 28 costs the phase.

- **Known thin spots a reviewer should push on.**
  (a) **Task 2 may not be able to exercise its own primary arm.** Gmail's forwarding and filters run on inbound SMTP, not on IMAP `APPEND`, and a verbatim resend of a corpus message will fail SPF/DMARC alignment and may be rejected or spam-filed. The plan names three methods and requires reporting which produced each row, but if all three fail for arms A and B, the primary onboarding path stays unmeasured and Task 15 is written from guesswork. That would be a genuine finding and must be reported as one, not worked around.
  (b) **Task 1's `T_rest` is still incomplete even after Task 1b.** Task 1b measures verify + decode + fold + serialize; the quarantine lane and per-chunk projection remain in the reserve. The 6 s budget is now defensible rather than arbitrary, but it is not derived — a reviewer should push on whether 2,500 ms is the right CONFIRMS threshold for Task 1b, since that number is what makes the reserve hold.
  (c) **Task 11 depends on Phase 1 fixes whose landing state is verified once, at Task 0, and then assumed.** Five fix rounds are in flight across `internal/v2/origin/`, `pushv2/`, `verify/` and the client, and 13 of Phase 1's 38 tasks were never adversarially reviewed at close. Task 0 Step 5 records the blast radius; it does not eliminate it. If a Phase 1 fix lands mid-Phase-2 and changes checkpoint semantics, Tasks 11, 12 and 29 all move.
  (g) **Nothing in this plan has been executed.** Every threshold in it — 6 s, 2,500 ms, 250 MB, 250 ms, 400 ms, 20 s, 10 s — is a judgement calibrated from Phase 0's numbers and one Linux-box test run. The first three tasks exist to replace judgements with measurements, and a reviewer should treat any threshold not yet touched by Tasks 1, 1b or 3 as provisional.
  (d) **Decision 9 argues that no beta user reaches 3,683 ingest singletons for years**, which is true and is also the most dangerous sentence in this plan. It is stated because it correctly distinguishes a survivable CONDITIONAL from a fatal FAIL — and it is explicitly *not* a reason to soften Task 1, because Phase 3 migrates the operator's full three-year history on day one and a designed-in year-three cliff is not shippable.
  (e) **Task 27 under-delivers against §5's "key UX built"** on purpose, and the justification is a product-ethics argument rather than an engineering one. A reviewer who disagrees should say so before Task 27, not after.
  (f) **Nothing in this plan tests the app under a poor network.** The device reaches `ledgerd` over Tailscale on a local link; Phase 0's one real network finding (a 4th fetch timing out entirely) came from exactly the conditions this plan does not reproduce. Sync resumability is tested by simulated interruption, which is not the same thing. Named here rather than discovered by an alpha on cellular.
</content>
</invoke>
