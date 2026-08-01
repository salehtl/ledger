# v2 Phase 1 — Backend, Plaintext Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete v2 server (Postgres, auth, hardened SMTP ingest with cryptographic DKIM/ARC origin trust, append-only op-log sync with both integrity chains, quarantine, versioned normalizer + template store + dual-executor conformance suite, diagnostics, backup relay) plus a headless sync client that authenticates, pulls, replays, checks invariants and round-trips its own ops — all **in plaintext**, so Phase 3 only has to swap the sealing.

**Architecture:** One Go binary (`cmd/ledgerd`) with modes: `serve` (SMTP :25 + HTTPS API :443 + Tailscale-bound admin), `relay` (SMTP :25 + spool + forward), `verify` (offline structural checker), plus three operator subcommands (`seed-dictionary`, `purge-user`, `parse-rate`). All server state lives in Postgres, reached through `pgxpool`, schema managed by embedded goose migrations. The client half is a TypeScript package (`client/`) run under Bun: it holds the normalizer, template executor, op-log replay engine, FX math and the invariant checker — the same code Phase 2's Expo app will port. A shared JSON fixture corpus (`conformance/`) is executed by **both** the Go and the TypeScript implementations; disagreement fails `scripts/v2-check.sh`.

**Tech Stack:** Go 1.25 (module `ledger`), `github.com/jackc/pgx/v5` + `pgxpool`, `github.com/pressly/goose/v3` (embedded migrations), `github.com/emersion/go-smtp` v0.24.0, `github.com/emersion/go-msgauth` v0.7.0 (ships `authres`, `dkim`, `dmarc` — **and no ARC package**; ARC is implemented in-repo, Decision 10), `github.com/emersion/go-message` v0.18.2 (MIME, already a dependency), `github.com/coreos/go-oidc/v3` (IdP token verification, Decision 12), `github.com/google/uuid`, `github.com/oklog/ulid/v2`, `modernc.org/sqlite` (read-only corpus copy only, already a dependency), PostgreSQL 16, TypeScript + Bun for `client/`.

---

## Global Constraints

Every task's requirements implicitly include this section. Violating any of these is a task failure regardless of whether tests pass.

- **PHASE 1 IS PLAINTEXT. Do not add encryption.** No HPKE, no DEK, no AES-GCM, no key wraps, no recovery phrase, no Argon2id. All of that is Phase 3 (spec §5). Blobs are stored **unencrypted**. What Phase 1 *must* build is the **shape**: padding buckets, the AAD-binding field set `(user_id, stream, writer_id, writer_counter)` carried in and verified against every blob, per-writer hash chains over the **stored blob bytes**, compress-then-seal ordering, and **byte-identical framing** — the 12-byte nonce slot and 16-byte tag slot are reserved and zero-filled now so Phase 3 does not change a single offset or bucket assignment. Phase 3 replaces exactly one interface implementation (`blob.Sealer`) and nothing else. An implementer who "helpfully" adds encryption now breaks the migration path and will be reverted.
- **Padding happens inside the sealed region, before sealing.** The plaintext is padded to its bucket *and then* sealed, so the length field lands inside the ciphertext. A cleartext `payloadLen` outside the sealed region would reveal the exact compressed size and make bucket padding cosmetic (spec §2 lists padding as a required metadata mitigation). See Task 4's frozen wire format.
- **`spike/phase0/`'s blob format must not be reused.** The Phase 0 replay spike used a zero nonce and no AAD to measure decrypt throughput. It is a benchmark artifact, not a wire format. Nothing in this plan may import from or imitate it.
- **Money is `int64` minor units (Go) / `bigint` (TypeScript), never floats.** Amounts are always positive; `direction` is `'debit' | 'credit'`. No `float64`, no JS `number`, in any money or FX path. FX conversion is `(amountMinor * rateMicro + 500_000) / 1_000_000`, half-up, integer only.
- **Nothing is dropped without a user-visible notice** (spec §2 drop policy). Every inbound message ends in exactly one of: an appended op, a quarantine row, a user-scoped rejection recorded in `parse_diagnostics`, or — for a recipient that does not exist and therefore has no user to scope a row to — an increment of the aggregated `smtp_rejections` counter. Quarantine expiry is warned in advance. Fingerprint-dedup collisions become review items, never silent discards.
- **`seq` is gap-free and strictly monotone per user.** A committed `seq` implies every lower `seq` for that user is committed. §3.7's FX determinism depends on this; the sync endpoint must never expose a value with a possible gap behind it. `seq` is a **single per-user total order spanning both streams**; it is not per-stream.
- **Hash chains are per `(writer_id, stream)`, not per writer** (Decision 13). The `hot` and `cold` streams are chained independently so that a hot-only pull is fully verifiable with zero cold traffic, which is what spec §3.3:70's lazy cold sync requires. Cursors are per-stream. Cold-stream contiguity is verified against the server's compact per-blob hash list, pinned once and re-checked on every range fetch (spec §3.3:72).
- **Cold blobs carry no state-mutating ops.** The cold stream holds raw email bodies and nothing else. Materialized state is a pure function of the hot stream, which is what makes a hot-only sync a complete and correct materialization. This is asserted as an invariant (`I16_cold_carries_no_ops`), not merely a convention.
- **Never touch the live v1 system.** Never bind `:8080`. Do not read, write or open `/var/lib/ledger/ledger.db` from any v2 code, test, or ad-hoc command — **the single sanctioned exception is one `sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup ..."` invocation, run as root, whose output copy is placed in the session scratch directory**; every later corpus step reads that copy and never the original. v1 packages under `internal/` (except new `internal/v2/...`) are **read-only references** — do not edit them; `main` keeps serving the running single-user instance.
- **The corpus scratch directory is a fixed literal path**, so a fresh subagent with no conversation history can resolve it:
  ```
  S=/tmp/claude-0/-root-Coding-ledger/bcc8cb5e-1dd4-451e-94e9-031572dd88c7/scratchpad
  mkdir -p "$S"
  ```
  Every task that needs the corpus uses `$S/corpus.db`. If it does not exist, re-run the sanctioned `.backup` above.
- **FX determinism rules (spec §3.7), verbatim binding:** `snapshot(T) = convert(amount(T), head_rate(ccy(T), P))` where `P` is the smallest log position ≥ `pos(T)` at which a head rate for `ccy(T)` exists in the synced prefix; null if no such position exists yet. `head_rate(ccy, P)` is the last `rate_set`/`rate_unset` for `ccy` at a position ≤ `P`, **resolved purely by fold-by-`seq`, never by wall clock or author timestamp.** `rate_set`/`rate_unset` are **parent-free and append-only** — never versioned entities, never fork-resolved. A later `rate_set` backfills only transactions still null *as of that position*; already-frozen snapshots are never rewritten. A **supersede recomputes fresh at its own log position and never inherits its predecessor's snapshot.** Home currency is log state (`home_currency_set`), one-shot and immutable, never a device-local setting; the home currency carries no rate row (implicit `rate_micro = 1_000_000`).
- **Ops carry a schema version.** A client encountering an unknown *newer* op version hard-stops sync. Unreadable blobs do **not** hard-stop — they are set aside with a visible warning and the cursor still advances (spec §3.3:68). Hard-stop is reserved for chain breaks and unknown-newer versions.
- **The inbound SMTP path is attacker-writable.** Treat every byte from it as hostile: 1 MB DATA cap, per-IP invalid-RCPT rate limiting with tarpit, ~50 msgs/day/address, no unverified header trusted, no regex that can backtrack. **Text recovered by the forwarded-message unwrap stage is content, never trust** — the trusted-lane decision is made solely from cryptographically verified DKIM/ARC (Tasks 25–26), never from an unwrapped `From:` line, which is attacker-authored body text.
- **Diagnostics are bounded on purpose.** Only the fields enumerated in Task 23 are stored unencrypted. Adding a field to `parse_diagnostics` requires updating spec §2's breach inventory in the same commit.
- **Server-side plaintext read paths are Phase-1-only and must be labelled.** Phase 1 legitimately reads user mail on the server (reprocess, confirm-and-re-ingest, donated-sample pull, parse-rate adjudication) because Phase 1 *is* the unencrypted alpha phase under signed consent. Every such path carries a `// PHASE 1 ONLY — deleted at the Phase 3 cutover` banner and appears in the Phase-1-only inventory in Task 30. None of them survives HPKE sealing, and the plan does not pretend otherwise.
- **Repo conventions** (CLAUDE.md / AGENTS.md): `gofmt`; Go tests co-located `*_test.go`; conventional commits (`feat(v2): ...`); TDD ordering — write the failing test, run it, see it fail, then implement. Do not build or touch `frontend/` or `internal/web/dist/`; Phase 1 ships no PWA change.
- **All v2 Go code lives under `internal/v2/...` and `cmd/ledgerd/`.** All v2 client code lives under `client/`. Shared fixtures live under `conformance/`. The only files outside those trees this plan may change are: `go.mod`, `go.sum`, `scripts/v2-check.sh`, `config.v2.example.toml`, `deploy/ledgerd.service`, `docs/superpowers/specs/*` (including the §2 breach-inventory update mandated by Task 23) and `spike/phase0/RESULTS.md` (Task D2's port-25 record).

---

## Decisions this plan makes (spec left these open — challenge them here, not in code)

1. **Migration tool: `pressly/goose/v3` used as an embedded library**, `//go:embed migrations/*.sql`, applied at server start and by the test harness. *Rationale:* Phase 1 has a real multi-user relational schema with destructive changes ahead, which v1's `CREATE TABLE IF NOT EXISTS` + `addColumn` idiom cannot express — and goose is the only mainstream option that keeps the repo's "single static binary, no external tooling at deploy time" property, because the migrations ship inside the binary.
2. **Local test Postgres: a throwaway cluster started by the test harness itself** (`internal/v2/pgtest`), using the system `initdb`/`postgres` binaries, into a temp directory on a unix socket, with `fsync=off`. *Rationale:* this box has no Docker and no Postgres service, `testcontainers` is therefore unusable and `embedded-postgres` cannot run as root (verified: `initdb: error: cannot be run as root`) — booting our own cluster lets us drop privileges explicitly, needs no network, and never touches a system cluster. **One cluster per `scripts/v2-check.sh` run, not per package:** the script boots it once and exports `LEDGER_TEST_POSTGRES_URL`, because ~20 v2 packages × one `initdb` each is minutes of wall clock for no benefit. Per-package boot remains the fallback when the variable is unset, so a single `go test ./internal/v2/pg/` still works.
3. **`seq` allocation: a per-user counter row locked inside the appending transaction** (`UPDATE oplog_seq SET next_seq = next_seq + $n WHERE user_id = $1 RETURNING next_seq - $n`), rather than a sequence plus a published watermark. *Rationale:* holding the row lock until commit makes commit order identical to `seq` order, so gap-freeness is structural rather than something a watermark has to reconstruct — and per-user append rates (a few bank alerts plus batched device blobs) make the serialization free. *Accepted caveat:* the lock is held across the blob write, so a 1 MB cold-blob insert serialises that one user's inbound SMTP for the duration. It is bounded, per-user, and worth a comment in the code rather than a redesign.
4. **Template definition format: JSON**, stored in `templates.definition jsonb`. *Rationale:* it is the only format both the Go server and the TypeScript client parse with zero extra dependencies and canonicalize byte-identically for conformance hashing, and it stores natively in Postgres.
5. **Regex dialect: an RE2 subset that bans the Go/JS divergences and the *unbounded* group quantifiers** — specifically: `\s`/`\S`, `\b`/`\B`, inline flags, lookaround, backreferences, unicode classes/escapes, `\A`/`\z`/`\Z`, a **bare `.`**, and `*`/`+`/`{n,}` applied to a group; plus no unbounded quantifier anywhere inside a quantified group. **`?` and `{n,m}` on a group are allowed** — they are bounded and cannot backtrack catastrophically, and the corpus's optional-currency-prefix shape `(?P<ccy>[A-Z]{3} )?` is inexpressible without them. Flags are declared per-pattern and the only permitted flag is `"i"`; named groups are stored `(?P<n>...)` and mechanically rewritten to `(?<n>...)` for JavaScript, which compiles with the `u` flag. *Rationale:* see Task 18's rule table, which states the engine-divergence reason for each ban.
6. **The TypeScript executor lands in Phase 1, not Phase 2.** *Rationale:* a conformance suite with one executor cannot fail on disagreement, so deferring it would let Phase 1 publish templates whose cross-executor equivalence is merely asserted — and the divergences that matter (`\s`, U+00A0, `.` vs line terminators, trim semantics, BigInt FX overflow) are exactly what alpha traffic will exercise while the contract is still being fixed.
7. **Size buckets: 1 / 4 / 16 / 64 / 256 / 512 / 1024 KB.** The first four are spec §2 verbatim; 256, 512 and 1024 KB are added because cold-stream raw bodies (gzipped, capped by the 1 MB DATA limit) exceed 64 KB for image-heavy bank HTML, and the measured corpus clusters around ~314 KB where a 64→256 KB jump would triple stored size. *Rationale:* the alternative — rejecting or splitting oversized cold blobs — leaks more (a size-driven split count) than three extra buckets do. **Spec §2's bucket list is updated to match in Task 23; it is user-facing privacy copy and may not silently disagree with the code.**
8. **Merchant-dictionary threshold: `k = 3` distinct submitting users, plus operator moderation.** *Rationale:* with 3–5 alphas, `k = 3` means the Phase 1 dictionary is effectively operator-seeded only (correct — no crowd exists yet), and 3 is the smallest threshold at which a rare merchant stops being a single-user identifier.
9. **Device identity keys (Ed25519) and the key-history table ship in Phase 1.** *Rationale:* §3.4's capability rule ("a stolen session token cannot inject a writer") is an authentication property, not a data-at-rest one — it does not touch `blob.Sealer`, it costs one stdlib package, and without it the public `:443` writer-registration endpoint is protected by a bearer token alone.
10. **ARC (RFC 8617) verification is implemented in-repo** (`internal/v2/arc`), **and it is attempted first, in Task 2, not last.** *Rationale:* `emersion/go-msgauth` v0.7.0 ships `authres`, `dkim` and `dmarc` and **no ARC package** (verified against the module source at `$GOMODCACHE/github.com/emersion/go-msgauth@v0.7.0/`), and no maintained Go ARC library was found — so this is the single largest unknown in the plan and belongs at the front, where a NO-GO still leaves the schedule intact. The corpus holds **1,218 messages with complete ARC sets**, of which **136 are genuine two-hop `cv=none`→`cv=pass` chains** sealed by `google.com`, `icloud.com` and `microsoft.com`, and **zero ARC-Message-Signatures carry an `x=` expiry tag** — so ARC fixtures are permanently time-stable.
11. **Client tests run under `bun test`;** the client is a standalone package, not part of `frontend/`. *Rationale:* the repo already depends on Bun, the headless client has no DOM, and reusing `frontend/`'s single-fork vitest config would drag jsdom into a Node-only program.
12. **IdP token verification uses `github.com/coreos/go-oidc/v3`, not hand-rolled JWT parsing.** *Rationale:* alg confusion, `kid` selection, embedded-JWK injection, `iss` validation, Apple's multi-audience token shape and JWKS rotation are each a well-known way to hand-roll an authentication bypass, and goal #1 of the spec is security. go-oidc is pure Go and preserves the static-binary property. It is constructed with `oidc.NewRemoteKeySet` + `oidc.NewVerifier` (never `NewProvider`, which performs network discovery at construction), so tests point it at an `httptest` JWKS and stay hermetic. Audience is checked explicitly against the configured set with `SkipClientIDCheck: true`, because Apple issues tokens whose `aud` is the app bundle ID and whose `aud` claim may be a single string or an array. The negative tests in Task 6 are kept regardless of the library.
13. **Hash chains are per `(writer_id, stream)`; sync cursors are per-stream; cold verification uses the hash list.** *Rationale:* spec §3.3:70 makes the cold stream lazily synced with a rolling client-side window, and §3.3:72 already specifies the mechanism (a compact per-blob hash list, verified contiguously once against a pinned head, then re-checked on every range fetch). A single chain spanning both streams would make a hot-only pull unverifiable — every hot blob's `prev_hash` would point at a cold blob the client deliberately did not fetch — and would make per-writer counter contiguity fail *by design* for any client keeping a 90-day cold window. Splitting the chain per stream makes hot self-contained and confines the lazy-sync problem to cold, where §3.3:72's mechanism is the answer. Both halves are built: the chain split (Task 8) **and** the hash-list wiring (Tasks 9, 10, 13).
14. **A forwarded message is parsed against its unwrapped inner subject and inner date.** v1's pipeline is `BodyText` → `Unwrap(from, subject, body)` → cascade (`internal/parse/forward.go`), and Gmail forwarding is the primary onboarding path (spec §3.2:47) and the named Phase 1 fragility (§3.5:111). v2 ports `Unwrap` as normalizer stage 9, and fixes the two ambiguities the spec left open:
    - **Subject**: `Match.SubjectContains` and any `Extract` with `"source": "subject"` see the **inner** subject when the message is an inline forward, and the outer `Subject:` with a leading `Fwd:`/`FW:` stripped otherwise. This is exactly v1's behavior, and it is load-bearing: `enbd_alert.go` reads the account last4 **only** from the subject, so an outer-envelope subject would silently lose `last4` on every forwarded ENBD alert.
    - **Date**: `"date_from": "email"` means the **inner forwarded `Date:` value** when the unwrap recovered one and it parses under one of the four `ParseForwardDate` layouts, else the SMTP arrival time. Again exactly v1 (`internal/parse/processor.go:73-76`), and again load-bearing: without it a forward that arrives days late dates the transaction to the forward, not the purchase.
    - **Trust is unaffected.** The unwrapped `From:` is attacker-authored body text and is never an input to the trusted-lane gate, the `Match.SenderDomain` check, or the allowlist. Those read only the cryptographically verified signing domain (Tasks 25–26).
15. **Dependency versions are pinned, never `@latest`.** *Rationale:* 38 tasks are executed by 38 fresh sessions over days; `go get …@latest` makes the dependency set a function of when a task ran. Task 1 pins every version in one `go get` and later tasks add nothing that is not already listed in the Tech Stack line.
16. **The heuristic tier stays Go-only and outside the regex dialect.** The heuristic is server-side, never published, never executed by a client, and Phase 1 ships no TypeScript heuristic. Go's RE2 cannot backtrack, so its three `\b`-bearing quantified-alternation patterns carry no ReDoS risk in the only engine that runs them. Porting it into the dialect now would be a rewrite in service of an executor that does not exist. The consequence is stated as a limitation, not hidden: **a Phase 2 client reprocessing a heuristic-parsed message cannot reproduce the server's result**, so the heuristic must be converted to the dialect and entered into the conformance suite before client-side reprocessing ships. See Task 28.

---

## What this phase deliberately does NOT do

- **No cryptography.** No HPKE, DEK, wraps, recovery phrase, passphrase, padding-time jitter, TOFU pinning or comparison code. Phase 3. (Ed25519 *writer authentication* is in — see Decision 9 — because it is auth, not sealing.)
- **No Expo app, no React Native, no iOS, no Android, no native JSI crypto benchmark.** Phase 2. The Phase 1 client is a headless Bun CLI.
- **No AI anywhere.** No extraction fallback, no categorization fallback, no `internal/anthropic` usage. Deterministic cascade only, and heuristic-tier results are always `needs_review`.
- **No rich/decrypted push, no Notification Service Extension.** Content-free push only.
- **No client-side categorization, no budget math, no insights, no review-queue UI, no CSV import.** Phase 2. Phase 1 ships only the merchant-dictionary *server* surface.
- **No client-side reprocessing.** Spec §3.5:109's "clients pull new template versions and reprocess locally" is Phase 2 work; Phase 1's reprocessing is server-side and is explicitly Phase-1-only (Task 30). What Phase 1 *does* build of §3.3:72 is the **verification** half — the client pins cold chain heads and validates the hash list — because that is what makes Phase 2's client-side reprocessing safe to build on.
- **No TypeScript heuristic tier** (Decision 16). The conformance suite covers the template rung only; the heuristic rung is Go-only and its divergence risk is stated rather than papered over.
- **No automated FX rates.** Manual `rate_set` ops only (spec §3.7); the vendor research stays shelved.
- **No throwaway PWA materialized view.** Spec §5 says the existing PWA "may additionally" serve alphas via a temporary server-side view; this plan does not build it, because the exit test is the headless client and a server-side materialized view is exactly the plaintext read path Phase 3 must delete. Alphas in Phase 1 interact through mail forwarding plus the operator's admin console.
- **No snapshots/compaction of the op log.** Deferred deliberately (spec §3.3).
- **No account deletion UX.** Server-side purge only (Task 34); the in-app self-service flow is Phase 2 (spec §3.10).

---

## File structure created by this plan

```
cmd/ledgerd/
  main.go                    # mode dispatch: serve | relay | verify
                             #   + seed-dictionary | purge-user | parse-rate
internal/v2/
  config/config.go           # TOML + env; LEDGER_MAIL_DOMAIN and friends
  pg/pg.go                   # pgxpool open + goose migrate (embedded)
  pg/migrations/*.sql        # goose migrations, numbered
  pgtest/pgtest.go           # throwaway cluster + per-test database
  corpus/corpus.go           # read-only reader over the root-made .backup copy
  corpus/cmd/extract-fixtures/  # .eml + recorded-DNS fixture extractor
  arc/arc.go                 # RFC 8617 ARC chain verification
  blob/blob.go               # buckets, Envelope/AAD, Sealer, PlaintextSealer
  oplog/op.go                # op wire model + canonical encoding + raw-body records
  oplog/append.go            # gap-free seq allocation + append
  oplog/chain.go             # per-(writer,stream) hash chains
  oplog/read.go              # per-stream cursor reads, cold hash lists
  auth/idp.go                # Apple + Google ID-token verification (go-oidc)
  auth/session.go            # opaque server-side sessions
  auth/writer.go             # writer registration, Ed25519 challenge, key history
  norm/norm.go               # versioned normalizer (v1 == v1's BodyText + Unwrap)
  tmpl/def.go                # template definition types + JSON canonicalization
  tmpl/dialect.go            # RE2-safe-subset validator
  tmpl/exec.go               # Go template executor
  tmpl/store.go              # templates table: draft/testing/published, versions
  tmpl/seed/                 # the four seed definitions + the corpus gate
  heuristic/heuristic.go     # ported bank-agnostic fallback (always needs_review)
  smtpd/smtpd.go             # go-smtp receiver, RCPT gate, limits, tarpit
  smtpd/limiter.go           # per-IP invalid-RCPT limiter + tarpit, per-address quota
  origin/dkim.go             # DKIM verification + verified signing domain
  origin/inner.go            # inner-origin attestation (direct DKIM, then ARC)
  origin/trust.go            # allowlist, trusted-lane promotion
  diag/diag.go               # parse_diagnostics (bounded fields) + structure_sig
  ingest/pipeline.go         # normalize -> template -> heuristic -> ops + diagnostics
  ingest/reprocess.go        # PHASE 1 ONLY server-side reprocess
  quarantine/quarantine.go   # chain-free TTL store, sync channel, confirm
  addresses/addresses.go     # inbound address issue/rotate/grace
  dict/dict.go               # merchant dictionary, k-threshold, moderation
  samples/samples.go         # donated samples queue
  pushv2/push.go             # Expo push, content-free
  api/                       # HTTP handlers, one file per resource
  admin/                     # Tailscale-bound admin handlers
  relay/relay.go             # relay mode: replica, spool, forward
  verify/verify.go           # server-side structural checker + accounting
  purge/purge.go             # user purge + retention enforcement
client/
  package.json, tsconfig.json
  src/wire/op.ts             # op wire model, mirror of oplog/op.go
  src/wire/blob.ts           # bucket + AAD + plaintext open
  src/wire/chain.ts          # per-(writer,stream) chain + cold hash list
  src/norm/norm.ts           # normalizer, mirror of internal/v2/norm
  src/tmpl/exec.ts           # template executor + mirrored dialect check
  src/replay/replay.ts       # entity heads, causality, forks, supersede
  src/replay/fx.ts           # BigInt FX + snapshot determinism
  src/invariants/check.ts    # the invariant checker
  src/net/client.ts          # auth + sync transport
  src/cli/main.ts            # headless client entry point
  test/e2e/                  # the exit-test harness and scenario
conformance/
  blob/*.bin, manifest.json  # sealed blobs shared by both executors
  normalizer/*.json          # raw message -> normalized text (base64-encoded)
  templates/*.json           # (template, normalized text) -> extraction
  dialect/patterns.json      # pattern -> accepted/rejected
  fx/*.json                  # op sequence -> snapshots
scripts/v2-check.sh          # the pre-merge gate: Go tests + client tests + conformance
```

---

## Task map (38 build tasks + 6 deployment tasks)

| Part | Tasks |
|---|---|
| A — Foundations | 1 Postgres harness · 2 Corpus fixtures + ARC spike · 3 config + `ledgerd` · 4 blob envelope + op model |
| B — Op-log server core | 5 `op_log` + `seq` · 6 auth · 7 writers · 8 chains · 9 sync API |
| C — Client half | 10 TS wire · 11 replay · 12 FX · 13 invariants · 14 headless CLI |
| D — Normalizer + templates | 15 normalizer (Go) · 16 corpus-equivalence gate · 17 normalizer (TS) · 18 dialect · 19 Go executor + store · 20 TS executor · 21 seed corpus gate |
| E — Ingestion | 22 addresses · 23 diagnostics · 24 SMTP · 25 DKIM · 26 inner origin · 27 quarantine · 28 heuristic · 29 pipeline + push · 30 reprocess |
| F — Admin, intake, rights, relay | 31 samples · 32 admin · 33 dictionary · 34 purge · 35 relay · 36 verifier + accounting |
| G — Exit test | 37 harness · 38 exit scenario |
| H — Deployment | D1 domain · D2 port 25 · D3 relay · D4 TLS · D5 Postgres · D6 alphas |
---

## Part A — Foundations

### Task 1: Postgres test harness and embedded migrations

**Files:**
- Create: `internal/v2/pg/pg.go`, `internal/v2/pg/pg_test.go`
- Create: `internal/v2/pg/migrations/00001_users_sessions.sql`
- Create: `internal/v2/pgtest/pgtest.go`
- Modify: `go.mod`, `go.sum`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pg.Open(ctx context.Context, dsn string) (*pgxpool.Pool, error)`
  - `pg.Migrate(ctx context.Context, pool *pgxpool.Pool) error` — applies embedded goose migrations, idempotent.
  - `pg.MigrateDown(ctx context.Context, pool *pgxpool.Pool) error` — applies every `-- +goose Down` block, so the down path is exercised rather than assumed.
  - `pgtest.Main(m *testing.M) int` — every v2 package that needs Postgres calls this from its own `TestMain`.
  - `pgtest.New(t *testing.T) *pgxpool.Pool` — a freshly created, fully migrated, uniquely-named database; dropped on cleanup.
  - Tables after this task: `users(id uuid pk, idp text, idp_sub_hash bytea, created_at timestamptz)` with `unique(idp, idp_sub_hash)`; `sessions(token_hash bytea pk, user_id uuid, created_at, expires_at, revoked_at)`.

- [ ] **Step 1: Install PostgreSQL server binaries (one-time host setup)**

```bash
sudo apt-get update && sudo apt-get install -y postgresql
sudo systemctl disable --now postgresql || true   # we never use the system cluster
ls /usr/lib/postgresql/*/bin/initdb
```

Expected: the `ls` prints a path such as `/usr/lib/postgresql/16/bin/initdb`. We disable the system service on purpose: the harness boots its own cluster, and a stray system cluster on `:5432` is exactly the "hand-started Postgres" this plan forbids depending on.

- [ ] **Step 2: Add the dependencies — pinned, never `@latest` (Decision 15)**

```bash
cd /root/Coding/ledger/.claude/worktrees/v2
go get github.com/jackc/pgx/v5@v5.7.2 \
       github.com/pressly/goose/v3@v3.24.1 \
       github.com/google/uuid@v1.6.0 \
       github.com/oklog/ulid/v2@v2.1.0
```

If a pinned version is unavailable, pick the nearest published one, **record the substitution in this step**, and use that exact version everywhere afterwards. Never resolve a version implicitly.

- [ ] **Step 3: Write the failing test**

`internal/v2/pg/pg_test.go`:

```go
package pg_test

import (
	"context"
	"os"
	"testing"

	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

func TestMigrationsCreateUsersAndSessions(t *testing.T) {
	pool := pgtest.New(t)
	ctx := context.Background()
	var n int
	err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables
		  WHERE table_schema='public' AND table_name IN ('users','sessions')`).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected users+sessions tables, found %d", n)
	}
}

func TestEachTestGetsAnIsolatedDatabase(t *testing.T) {
	ctx := context.Background()
	a, b := pgtest.New(t), pgtest.New(t)
	if _, err := a.Exec(ctx, `INSERT INTO users (id, idp, idp_sub_hash, created_at)
		VALUES (gen_random_uuid(), 'apple', '\x00'::bytea, now())`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := b.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("databases are not isolated: second pool sees %d users", n)
	}
}

func TestMigrationsAreReversible(t *testing.T) {
	// goose's Down path is dead code unless something runs it; a broken Down
	// block is only discovered during an emergency rollback otherwise.
	pool := pgtest.New(t)
	ctx := context.Background()
	if err := pg.MigrateDown(ctx, pool); err != nil {
		t.Fatalf("down: %v", err)
	}
	var n int
	pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
	                     WHERE table_schema='public' AND table_name='users'`).Scan(&n)
	if n != 0 {
		t.Fatal("Down left the users table behind")
	}
	if err := pg.Migrate(ctx, pool); err != nil {
		t.Fatalf("re-up: %v", err)
	}
}
```

- [ ] **Step 4: Run it and watch it fail**

Run: `go test ./internal/v2/pg/ -run TestMigrations -v`
Expected: FAIL — `package ledger/internal/v2/pgtest is not in std`.

- [ ] **Step 5: Write the migration**

`internal/v2/pg/migrations/00001_users_sessions.sql`:

```sql
-- +goose Up
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idp          text NOT NULL CHECK (idp IN ('apple','google')),
  idp_sub_hash bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idp, idp_sub_hash)
);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- +goose Down
DROP TABLE sessions;
DROP TABLE users;
```

- [ ] **Step 6: Implement `internal/v2/pg/pg.go`**

```go
// Package pg owns the v2 Postgres connection pool and the embedded migration set.
package pg

import (
	"context"
	"embed"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Open creates a pool with conservative limits: this process is the only
// writer, and a beta-scale user count needs far fewer connections than the
// server's default 100.
func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MaxConns = 16
	cfg.MinConns = 2
	return pgxpool.NewWithConfig(ctx, cfg)
}

// Migrate applies every embedded migration. Idempotent.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	return goose.UpContext(ctx, db, "migrations")
}

// MigrateDown reverses every migration. Used only by tests; a Down block that
// nobody runs is a rollback that does not work.
func MigrateDown(ctx context.Context, pool *pgxpool.Pool) error {
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	return goose.DownToContext(ctx, db, "migrations", 0)
}
```

- [ ] **Step 7: Implement `internal/v2/pgtest/pgtest.go`**

Three load-bearing details:
1. `initdb` and `postgres` **refuse to run as root**, and agent sessions run as root. The harness chowns its runtime directory to an unprivileged uid and sets `SysProcAttr.Credential` on both child processes.
2. It listens on a **unix socket only** (`listen_addresses=''`), so no TCP port is ever bound and there is no port race with anything on the box.
3. The locale is **`C.UTF-8`, matching what Task D5 creates in production**. `--locale=C` would give the test cluster a different collation from production, which is exactly the class of bug (ordering, `LIKE`, index usability) that only shows up after deploy.

```go
// Package pgtest boots a throwaway PostgreSQL cluster for tests. It never
// touches a system cluster, never binds TCP, and needs no running service.
//
// Host requirement: apt-get install -y postgresql (for initdb/postgres).
// Set LEDGER_TEST_POSTGRES_URL to reuse an already-running server instead —
// scripts/v2-check.sh does exactly that so one cluster serves the whole run.
package pgtest

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/pg"
)

var (
	adminDSN string
	dbSeq    atomic.Int64
)

// Main boots one cluster for the whole package run and tears it down after.
func Main(m *testing.M) int {
	stop, dsn, err := boot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "pgtest: %v\n", err)
		return 1
	}
	adminDSN = dsn
	code := m.Run()
	stop()
	return code
}

// New returns a pool on a freshly created, fully migrated database.
func New(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("t%d_%d", os.Getpid(), dbSeq.Add(1))
	admin, err := pgxpool.New(ctx, adminDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	pool, err := pg.Open(ctx, adminDSN+"&database="+name)
	if err != nil {
		t.Fatal(err)
	}
	if err := pg.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}
```

and the `boot` helper in the same file. Note that `run` deliberately does **not** preset `Stdout`/`Stderr`: `exec.Cmd.CombinedOutput` returns `exec: Stdout already set` if it does, so the one-shot `initdb` call and the long-running `postgres` process are wired differently.

```go
func boot() (func(), string, error) {
	if u := os.Getenv("LEDGER_TEST_POSTGRES_URL"); u != "" {
		return func() {}, u, nil
	}
	bin, err := filepath.Glob("/usr/lib/postgresql/*/bin/initdb")
	if err != nil || len(bin) == 0 {
		return nil, "", fmt.Errorf("initdb not found; run: apt-get install -y postgresql")
	}
	binDir := filepath.Dir(bin[len(bin)-1])
	dir, err := os.MkdirTemp("", "pgtest-")
	if err != nil {
		return nil, "", err
	}
	data := filepath.Join(dir, "data")
	cred, err := unprivileged()
	if err != nil {
		return nil, "", err
	}
	if cred != nil {
		// initdb refuses to run as root; the whole tree must be owned by the
		// unprivileged user that will own the server process.
		if err := os.Chown(dir, int(cred.Uid), int(cred.Gid)); err != nil {
			return nil, "", err
		}
	}
	// No Stdout/Stderr here: CombinedOutput() below sets both itself.
	cmd := func(name string, args ...string) *exec.Cmd {
		c := exec.Command(filepath.Join(binDir, name), args...)
		if cred != nil {
			c.SysProcAttr = &syscall.SysProcAttr{Credential: cred}
		}
		return c
	}
	if out, err := cmd("initdb", "-D", data, "-U", "postgres", "-A", "trust",
		"--encoding=UTF8", "--locale=C.UTF-8").CombinedOutput(); err != nil {
		return nil, "", fmt.Errorf("initdb: %v: %s", err, out)
	}
	port := 5433
	srv := cmd("postgres", "-D", data, "-k", dir, "-p", strconv.Itoa(port),
		"-c", "listen_addresses=", "-c", "fsync=off", "-c", "full_page_writes=off",
		"-c", "synchronous_commit=off")
	srv.Stdout, srv.Stderr = os.Stderr, os.Stderr // long-running: stream, never capture
	if err := srv.Start(); err != nil {
		return nil, "", err
	}
	dsn := fmt.Sprintf("postgres://postgres@/postgres?host=%s&port=%d&sslmode=disable", dir, port)
	if err := waitReady(dsn); err != nil {
		_ = srv.Process.Kill()
		return nil, "", err
	}
	stop := func() {
		_ = srv.Process.Signal(syscall.SIGQUIT)
		_, _ = srv.Process.Wait()
		_ = os.RemoveAll(dir)
	}
	return stop, dsn, nil
}

// unprivileged returns the credential to run the server under, or nil when
// this process is already unprivileged.
func unprivileged() (*syscall.Credential, error) {
	if os.Geteuid() != 0 {
		return nil, nil
	}
	name := os.Getenv("LEDGER_TEST_PG_USER")
	if name == "" {
		name = "nobody"
	}
	u, err := user.Lookup(name)
	if err != nil {
		return nil, fmt.Errorf("lookup %q: %w", name, err)
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	return &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}, nil
}

func waitReady(dsn string) error {
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		pool, err := pgxpool.New(context.Background(), dsn)
		if err == nil {
			if err = pool.Ping(context.Background()); err == nil {
				pool.Close()
				return nil
			}
			pool.Close()
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("postgres did not become ready")
}
```

- [ ] **Step 8: Run the tests**

Run: `go test ./internal/v2/pg/ -v`
Expected: PASS — three tests green. First run takes ~5s (initdb).

- [ ] **Step 9: Commit**

```bash
git add go.mod go.sum internal/v2/pg internal/v2/pgtest
git commit -m "feat(v2): postgres pool, embedded goose migrations, throwaway test cluster"
```

---

### Task 2: Corpus fixture extraction and the ARC verification spike (RISK-FIRST)

> **Why this is Task 2 and not Task 26.** ARC has no Go library and is the single largest unknown in this plan. Attempting it now means a NO-GO costs two days and reshapes the trust design while 36 tasks are still unwritten; attempting it at the end means a NO-GO arrives after everything else is built around it. This task also produces the `.eml` + recorded-DNS fixtures that Tasks 25, 26 and 37 all consume, so it front-loads shared work rather than duplicating three ad-hoc extractors.

**Files:**
- Create: `internal/v2/corpus/corpus.go`, `internal/v2/corpus/corpus_test.go`
- Create: `internal/v2/corpus/cmd/extract-fixtures/main.go`
- Create: `internal/v2/arc/arc.go`, `internal/v2/arc/arc_test.go`
- Create: `internal/v2/origin/testdata/*.eml`, `internal/v2/origin/testdata/dns.json`, `internal/v2/origin/testdata/manifest.json`
- Create: `docs/superpowers/specs/v2-arc-spike.md` (the GO/NO-GO record)

**Interfaces:**
- Consumes: `github.com/emersion/go-msgauth/dkim` (canonicalization + signing primitives), `go-msgauth/authres` (parsing an ARC-Authentication-Results value), `modernc.org/sqlite` (already a dependency).
- Produces:

```go
// package corpus — read-only access to the root-made .backup copy of v1's DB.
type Message struct {
	ID         int64
	ReceivedAt time.Time
	FromAddr   string
	Subject    string
	RawBody    []byte // gunzipped if it began with 1f 8b
}
func Open(path string) (*DB, error)              // refuses any path under /var/lib/ledger
func (d *DB) Each(fn func(Message) error) error  // streams; the corpus is ~75 MB
func (d *DB) Count() (int, error)
```

```go
// package arc — RFC 8617. go-msgauth v0.7.0 ships dkim/dmarc/authres and no ARC
// package (verified against the module source), so the chain verifier lives here.
type ChainResult struct {
	Status      string   // "pass" | "fail" | "none"
	Instances   int
	SealDomains []string // d= of each ARC-Seal, instance order
	AARValues   []string // the raw ARC-Authentication-Results value per instance
}
type LookupTXT func(ctx context.Context, name string) ([]string, error)
func Verify(ctx context.Context, raw []byte, lookupTXT LookupTXT) (ChainResult, error)
```

**Corpus facts, verified — use these numbers, do not re-derive them casually:**
- **6,994** messages in `ingest_log` (an earlier count of 6,996 included WAL rows; the `.backup` copy is the authority).
- All 6,994 are DKIM-signed. Body hashes recomputed offline: **6,994/6,994 DKIM `bh=` match and 1,354/1,354 ARC-Message-Signature `bh=` match** — so `raw_body` is byte-exact original RFC822 and is genuinely usable as an offline fixture source.
- **1,218** messages carry complete ARC sets; **136** are genuine two-hop `cv=none`→`cv=pass` chains sealed by `google.com` / `icloud.com` / `microsoft.com`.
- **Zero ARC-Message-Signatures carry an `x=` tag**, so ARC fixtures never expire.
- **DKIM expiry hazard:** DIB signs with a ~1-year `x=` tag and **4,702 of the 6,932 signatures carrying `x=` have already expired.** `go-msgauth` enforces expiry at `dkim/verify.go:261-270` **before** key lookup, and its clock is a package-private `var now = time.Now` (`dkim/dkim.go:21`) that an external test cannot stub. The **62 ENBD messages carry no `x=` tag at all** and are the only permanently stable DKIM fixtures in the corpus. ~2,229 DIB messages still have unexpired signatures today.
- DIB signs `d=dib.ae` with selectors `selector1` and `selector2`, both live in DNS.
- **ARC de-risk:** for the 1,158 Gmail-delivered corpus messages, the original `d=dib.ae` DKIM signature **survives the forward intact and its body hash still matches.** Direct DKIM on the inner origin therefore establishes bank identity for the common case *without ARC at all* — which is what Task 26 builds on, making ARC the fallback rather than the load-bearing path.

- [ ] **Step 1: Make the corpus copy (the one sanctioned touch of the live DB)**

```bash
S=/tmp/claude-0/-root-Coding-ledger/bcc8cb5e-1dd4-451e-94e9-031572dd88c7/scratchpad
mkdir -p "$S"
sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup '$S/corpus.db'"
sqlite3 "$S/corpus.db" "select count(*) from ingest_log"
```
Expected: `6994`. If it prints something else, record the number here and use *that* everywhere below — the corpus grows as the live instance runs, and a stale constant baked into a test is a future false failure. **From this point on nothing reads `/var/lib/ledger/ledger.db` again.**

- [ ] **Step 2: Implement `internal/v2/corpus/corpus.go`** with a test asserting `Open("/var/lib/ledger/ledger.db")` returns an error naming the constraint, and that `Count()` on `$S/corpus.db` matches Step 1.

- [ ] **Step 3: Write `extract-fixtures`**

```bash
LEDGER_CORPUS_DB=$S/corpus.db go run ./internal/v2/corpus/cmd/extract-fixtures \
  --out internal/v2/origin/testdata
```

It writes, as `.eml`:
- 1 DIB message whose DKIM signature is **still unexpired** (checked against `x=` at extraction time),
- 1 ENBD transfer and 1 ENBD alert drawn from the **62 messages with no `x=` tag** (permanently stable),
- 3 Gmail-forwarded messages carrying complete two-hop ARC sets,
- 1 Gmail-forwarded message whose inner `d=dib.ae` DKIM signature survived intact (the Task 26 de-risk case),

plus two JSON side-files:
- `dns.json` — every DKIM/ARC public key resolved at extraction time, keyed by `<selector>._domainkey.<domain>`, so no test ever touches DNS.
- `manifest.json` — per fixture: `{file, kind, dkim_d, dkim_selector, has_x_tag, x_expires_at, arc_instances, arc_seal_domains}`. **`has_x_tag`/`x_expires_at` are the point:** they are what makes Task 25's expiry canary possible.

- [ ] **Step 4: Write the failing ARC tests**

```go
func TestVerifyRealGmailForwardedARCChain(t *testing.T) {
	raw := mustRead(t, "../origin/testdata/gmail-forward-1.eml")
	got, err := Verify(ctx, raw, staticTXT(loadDNS(t)))
	if err != nil { t.Fatal(err) }
	if got.Status != "pass" || got.Instances < 2 {
		t.Fatalf("%+v", got)
	}
}

func TestTamperedBodyBreaksTheAMS(t *testing.T)   { /* flip a body byte -> "fail" */ }
func TestRemovedInstanceBreaksTheChain(t *testing.T) { /* drop i=1's AS -> "fail" */ }
func TestForgedAARIsNotTrusted(t *testing.T) {
	// rewrite instance 1's AAR to claim dkim=pass header.d=dib.ae, leaving the
	// seals intact -> chain must fail.
}
func TestNoARCHeadersIsNone(t *testing.T)         { /* -> "none", 0 instances */ }
func TestARCFixturesCarryNoExpiryTag(t *testing.T) {
	// manifest.json: every arc fixture has arc_instances > 0 and no AMS x= tag,
	// so these fixtures cannot rot. Guards the "time-stable" claim.
}
```

- [ ] **Step 5: Run and watch fail**

Run: `go test ./internal/v2/arc/ -v`
Expected: FAIL — `undefined: Verify`.

- [ ] **Step 6: Implement `arc.go`**

**ARC verification algorithm (implement exactly; this is the part with no library):**
1. Collect all `ARC-Seal` (AS), `ARC-Message-Signature` (AMS) and `ARC-Authentication-Results` (AAR) headers; group by their `i=` instance tag. Instances must be `1..N` with no gaps and no duplicates, else `fail`.
2. Verify the **highest-instance AMS**: it is a DKIM signature whose header field name is `ARC-Message-Signature` — same canonicalization, same `bh=` body hash, same `h=` header list, same key lookup at `<s>._domainkey.<d>`. Reuse `go-msgauth/dkim`'s canonicalization and verification code path with the header name substituted.
3. Verify each `ARC-Seal` from instance 1 upward. An AS signs, in order, for each instance `1..i`: the AAR, the AMS, and the AS (with the current instance's `b=` value emptied) — with **no body hash** (`bh=` is absent from an AS). `cv=` must be `none` for instance 1 and `pass` for every later instance.
4. Any verification failure at any instance → `Status = "fail"`; zero ARC headers → `"none"`; otherwise `"pass"`.
5. On `pass`, instance 1's AAR is parsed with `authres` and its `dkim=pass` `header.d` is carried out in `AARValues` for Task 26 to interpret. **This task does not decide trust** — it reports a verified chain and nothing more.

- [ ] **Step 7: Timebox and record the verdict**

**Scope guard (unchanged in intent from the original plan, corrected in its claim):** if the AS-over-header-set signing input proves larger than one working session, stop and ship `Status = "none"` with a `TODO(arc)`. Do not weaken any other check to compensate.

**But do not describe the degraded mode as "safe" without qualification — the original framing was wrong.** If ARC ships `none`, spec §3.2:51 would leave *all* forwarded mail permanently quarantined, and the only escape would be confirming with `scope:"outer"` on a forwarder domain — i.e. allowlisting `gmail.com`, exactly the failure §3.2:51 exists to prevent (and which Task 27 now refuses outright). So an ARC NO-GO is not "more mail quarantined"; it is "the alpha phase cannot run as designed."

**What makes the degraded mode genuinely safe is Task 26's direct-DKIM inner-origin path**, which the corpus proves works for the Gmail-forwarded subset (the original `d=dib.ae` signature survives intact, body hash matching, on all 1,158 Gmail-delivered messages). With that path in place, an ARC NO-GO costs only those forwarders that *rewrite* the body and thus break the original signature. Record which of the two paths is load-bearing in the spike document.

Write `docs/superpowers/specs/v2-arc-spike.md`: date, GO or NO-GO, which fixtures passed, the exact failure if NO-GO, and — either way — a one-paragraph statement of what Task 26 may now assume.

- [ ] **Step 8: Run the tests**

Run: `go test ./internal/v2/arc/ ./internal/v2/corpus/ -v`
Expected: PASS (6 arc tests + 2 corpus tests) on a GO. On a NO-GO, the four chain tests are `t.Skip`ped with the spike document referenced by name, and `TestNoARCHeadersIsNone` plus `TestARCFixturesCarryNoExpiryTag` still pass.

- [ ] **Step 9: Commit**

```bash
git add internal/v2/arc internal/v2/corpus internal/v2/origin/testdata \
        docs/superpowers/specs/v2-arc-spike.md go.mod go.sum
git commit -m "feat(v2): corpus fixture extraction and RFC 8617 ARC chain verification spike"
```

---

### Task 3: v2 config and `cmd/ledgerd` skeleton

**Files:**
- Create: `internal/v2/config/config.go`, `internal/v2/config/config_test.go`
- Create: `cmd/ledgerd/main.go`
- Create: `config.v2.example.toml`

**Interfaces:**
- Consumes: `pg.Open`, `pg.Migrate` (Task 1).
- Produces:
  - `config.Config` with fields: `Mode`, `Server{HTTPListen, AdminListen, DSN}`, `Mail{Domain, SMTPListen, MaxMessageBytes, PerAddressDaily, InvalidRcptBurst, TarpitBase}`, `Relay{Enabled, PrimaryURL, SpoolDir, Token}`, `Push{Enabled, ExpoURL}`, `Auth{AppleClientIDs, GoogleClientIDs, SessionTTL}`.
  - `config.Load(path string) (Config, error)` — TOML then env overrides then validate.
  - Env names: `LEDGER_MAIL_DOMAIN`, `LEDGER_PG_DSN`, `LEDGER_HTTP_LISTEN`, `LEDGER_ADMIN_LISTEN`, `LEDGER_SMTP_LISTEN`, `LEDGER_RELAY_TOKEN`, `LEDGER_RELAY_PRIMARY_URL`, `LEDGER_APPLE_CLIENT_IDS`, `LEDGER_GOOGLE_CLIENT_IDS`, `LEDGER_EXPO_ACCESS_TOKEN`, `LEDGER_ADMIN_TOKEN`, `LEDGER_DICT_HMAC_KEY`.
  - `config.InboundSuffix() string` — returns `"@in." + Mail.Domain`.
  - `cmd/ledgerd` dispatching on `os.Args[1]`: `serve`, `relay`, `verify`, `seed-dictionary`, `purge-user`, `parse-rate`. **Every mode in this list has a `case` in the switch; there is no mode named in a comment that the code does not implement.**

**The domain is not chosen yet.** `Mail.Domain` has **no default** and is required for `serve` and `relay`; every consumer derives its addresses from it. Nothing else in this plan may hardcode a domain.

- [ ] **Step 1: Write the failing test**

`internal/v2/config/config_test.go`:

```go
package config

import "testing"

func TestMailDomainIsRequiredAndDrivesInboundSuffix(t *testing.T) {
	c := defaults()
	c.Server.DSN = "postgres:///x"
	if err := c.validate(); err == nil {
		t.Fatal("expected validate() to reject an empty mail.domain")
	}
	c.Mail.Domain = "example.test"
	if err := c.validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if got := c.InboundSuffix(); got != "@in.example.test" {
		t.Fatalf("InboundSuffix() = %q", got)
	}
}

func TestRefusesV1ProductionSurfaces(t *testing.T) {
	c := defaults()
	c.Mail.Domain = "example.test"
	c.Server.DSN = "postgres:///x"
	c.Server.HTTPListen = "127.0.0.1:8080"
	if err := c.validate(); err == nil {
		t.Fatal("expected validate() to refuse binding :8080 (v1 production)")
	}
}

func TestEveryDispatchModeHasACase(t *testing.T) {
	// cmd/ledgerd's help text and its switch must not drift apart.
	for _, m := range Modes() {
		if !modeIsImplemented(m) {
			t.Fatalf("mode %q is advertised but has no case", m)
		}
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./internal/v2/config/ -v`
Expected: FAIL — `undefined: defaults`.

- [ ] **Step 3: Implement the config package**

Mirror v1's `internal/config` shape (TOML struct tags, `defaults()`, `Load`, `validate`), with these rules in `validate()`:

```go
func (c Config) validate() error {
	if c.Mail.Domain == "" {
		return fmt.Errorf("mail.domain is required (LEDGER_MAIL_DOMAIN); v2 derives every inbound address from it")
	}
	if c.Server.DSN == "" {
		return fmt.Errorf("server.dsn is required (LEDGER_PG_DSN)")
	}
	// Hard rail: v1 owns :8080 and /var/lib/ledger on this box.
	for _, addr := range []string{c.Server.HTTPListen, c.Server.AdminListen, c.Mail.SMTPListen} {
		if strings.HasSuffix(addr, ":8080") {
			return fmt.Errorf("refusing to bind %q: :8080 belongs to the running v1 instance", addr)
		}
	}
	if strings.Contains(c.Server.DSN, "/var/lib/ledger") {
		return fmt.Errorf("refusing a dsn pointing at the v1 data directory")
	}
	if c.Mail.MaxMessageBytes <= 0 || c.Mail.MaxMessageBytes > 1<<20 {
		return fmt.Errorf("mail.max_message_bytes must be 1..1048576 (spec §3.2 caps DATA at 1 MB)")
	}
	return nil
}
```

Defaults: `HTTPListen: "127.0.0.1:8443"`, `AdminListen: "127.0.0.1:8079"`, `SMTPListen: ":25"`, `MaxMessageBytes: blob.MaxColdMail`, `PerAddressDaily: 50`, `InvalidRcptBurst: 5`, `TarpitBase: 2 * time.Second`, `SessionTTL: 30 * 24 * time.Hour`.

> **Amended during Task 9.** Two of these drifted from what the code enforces, and `config.v2.example.toml` had drifted with them:
> - `HTTPListen` is **loopback**, not `:443`, and `validate()` *refuses* a non-loopback value. `runServe` serves plain HTTP, and this listener carries a session bearer token on every request plus the user's whole op log; **Task D4** is the change that adds autocert to `runServe` (TLS terminated in-process on the public domain — there is no proxy and no tailnet in front of v2) and lifts the rail in the same commit.
> - `MaxMessageBytes` defaults to `blob.MaxColdMail` (1,000,000), **not** `1 << 20`. A message is stored base64'd inside a JSON cold record, so incompressible mail reaches gzip already inflated 4/3 and a message in the top fraction of a percent of the 1 MiB range frames past the largest size bucket.
>
> `config.TestTheShippedExampleConfigActuallyLoads` now loads `config.v2.example.toml` through `Load()`, so this class of drift between the plan text, the example file and the validator cannot recur silently.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/config/ -v`
Expected: PASS.

- [ ] **Step 5: Write `cmd/ledgerd/main.go`**

```go
// Command ledgerd is the v2 multi-user server. It shares no state, no port and
// no database with the v1 `ledger` binary.
package main

func main() {
	mode := "serve"
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		mode = os.Args[1]
		os.Args = append(os.Args[:1], os.Args[2:]...)
	}
	var cfgPath string
	flag.StringVar(&cfgPath, "config", "", "path to config.toml")
	flag.Parse()

	cfg, err := config.Load(cfgPath)
	if err != nil { log.Fatalf("config: %v", err) }

	switch mode {
	case "serve":           err = runServe(cfg)
	case "relay":           err = runRelay(cfg)
	case "verify":          err = runVerify(cfg)
	case "seed-dictionary": err = runSeedDictionary(cfg)   // Task 33
	case "purge-user":      err = runPurgeUser(cfg)        // Task 34
	case "parse-rate":      err = runParseRate(cfg)        // Task 36, PHASE 1 ONLY
	default:
		err = fmt.Errorf("unknown mode %q (%s)", mode, strings.Join(config.Modes(), "|"))
	}
	if err != nil { log.Fatal(err) }
}
```

`runServe` for now: open the pool, migrate, log "ledgerd serve: migrations applied", and block on a signal. Every other `run*` returns `errors.New("not implemented")` with the task number that fills it in — Tasks 33, 34, 35, 36.

- [ ] **Step 6: Verify the binary builds and refuses a bad config**

```bash
CGO_ENABLED=0 go build -o /tmp/ledgerd ./cmd/ledgerd && LEDGER_PG_DSN=postgres:///x /tmp/ledgerd serve 2>&1 | head -1
```
Expected: `config: mail.domain is required (LEDGER_MAIL_DOMAIN); v2 derives every inbound address from it`

- [ ] **Step 7: Write `config.v2.example.toml`** with every key, a `# domain: NOT YET CHOSEN — spec §6` comment on `mail.domain`, and a header stating that secrets are env-only.

- [ ] **Step 8: Commit**

```bash
git add internal/v2/config cmd/ledgerd config.v2.example.toml
git commit -m "feat(v2): config with required mail.domain and ledgerd mode dispatch"
```

---

### Task 4: Blob envelope and op wire model — the two frozen contracts

> These were separate tasks in the first draft. They are merged because both are small, neither has a dependency, and Phase 3's migration reads them together: the blob framing and the op encoding are the pair that must not move.

**Files:**
- Create: `internal/v2/blob/blob.go`, `internal/v2/blob/blob_test.go`
- Create: `internal/v2/oplog/op.go`, `internal/v2/oplog/op_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces (blob):
  - `blob.Buckets = []int{1 << 10, 4 << 10, 16 << 10, 64 << 10, 256 << 10, 512 << 10, 1024 << 10}` — **seven** buckets (Decision 7).
  - `blob.BucketFor(n int) (int, error)` — smallest bucket ≥ n, where `n` is the **total framed length**; error above 1 MB.
  - `type Envelope struct { UserID uuid.UUID; Stream string; WriterID string; WriterCounter int64 }` with `func (e Envelope) AAD() []byte` — canonical `user_id|stream|writer_id|writer_counter`, `|`-joined, writer_counter decimal.
  - `type Sealed struct { Bytes []byte; SizeBucket int }`
  - `type Sealer interface { Seal(e Envelope, plaintext []byte) (Sealed, error); Open(e Envelope, s Sealed) ([]byte, error) }`
  - `type PlaintextSealer struct{}` implementing it.
  - `blob.Hash(prev [32]byte, s Sealed) [32]byte` — `SHA256(prev || s.Bytes)`; `blob.ZeroHash` is the chain genesis.

**Wire format (frozen — Phase 3 changes only what the sealed region *contains*, never any offset):**

```
[1B version=1][2B BE aadLen][aad bytes][12B nonce][sealed region][16B tag]
total length == size bucket, exactly
```
where the sealed region is
```
[4B BE payloadLen][payload][zero padding]
```
and `payload = gzip(plaintext)` — **compress then seal**, so Phase 3's ciphertext is incompressible by construction.

Three details are load-bearing and were each wrong in the first draft:

1. **Padding is inside the sealed region.** `payloadLen` sits *within* the bytes Phase 3 will encrypt, so a stolen blob reveals its bucket and nothing finer. A cleartext length field outside the sealed region would have made bucket padding purely cosmetic — spec §2 lists padding as a required metadata mitigation, not a decoration.
2. **The nonce and tag slots are reserved now.** In Phase 1 they are 12 and 16 zero bytes. If they were added in Phase 3 instead, every blob whose plaintext sits near a bucket boundary would grow past its bucket at the moment sealing turned on, silently re-bucketing (and re-fingerprinting) part of the corpus. Reserving them makes `len(sealed.Bytes)` identical before and after.
3. **`Open` recomputes the AAD from the caller's `Envelope` and rejects a mismatch** with `subtle.ConstantTimeCompare`. That is the replay protection Phase 3's AEAD provides cryptographically and Phase 1 provides structurally.

So `Seal` computes `overhead = 1 + 2 + len(aad) + 12 + 4 + 16` and picks `BucketFor(overhead + len(gzip(plaintext)))`.

**Interfaces (op model)** — this is the contract Task 10's TypeScript mirrors exactly:

```go
const SchemaVersion = 1

type OpType string
const (
	OpTxnIngested      OpType = "txn_ingested"
	OpTxnSuperseded    OpType = "txn_superseded"
	OpTxnCategorized   OpType = "txn_categorized"
	OpTxnSplit         OpType = "txn_split"
	OpTxnEdited        OpType = "txn_edited"
	OpRuleAdded        OpType = "rule_added"
	OpRateSet          OpType = "rate_set"
	OpRateUnset        OpType = "rate_unset"
	OpHomeCurrencySet  OpType = "home_currency_set"
	OpWriterCheckpoint OpType = "writer_checkpoint"
)

type EntityRef struct { Kind string `json:"kind"`; ID string `json:"id"` }

type Op struct {
	V             int             `json:"v"`
	Type          OpType          `json:"type"`
	OpID          string          `json:"op_id"`          // ULID, author-assigned
	AuthoredAt    time.Time       `json:"authored_at"`    // RFC3339 UTC; fork tiebreak ONLY
	Entity        *EntityRef      `json:"entity,omitempty"`
	ParentVersion *int64          `json:"parent_version"` // nil = create, or parent-free op
	IngestID      string          `json:"ingest_id,omitempty"` // hex sha256 of the raw body
	Payload       json.RawMessage `json:"payload"`
}

func (t OpType) ParentFree() bool
func (o Op) Validate() error
func EncodeBlob(ops []Op) ([]byte, error)   // {"v":1,"kind":"ops","ops":[...]}
func DecodeBlob(b []byte) ([]Op, error)     // rejects v > SchemaVersion with ErrUnknownNewerVersion
var ErrUnknownNewerVersion = errors.New("op schema version newer than supported")

// Cold blobs are NOT op blobs. The cold stream carries raw email bodies and
// nothing that mutates state, which is what makes a hot-only sync a complete
// materialization (Global Constraints; invariant I16).
type RawBody struct {
	V          int       `json:"v"`
	Kind       string    `json:"kind"`        // always "raw_body"
	IngestID   string    `json:"ingest_id"`   // hex sha256, joins to the hot op
	ReceivedAt time.Time `json:"received_at"`
	RawBase64  string    `json:"raw_base64"`
}
func EncodeRawBody(r RawBody) ([]byte, error)
func DecodeRawBody(b []byte) (RawBody, error)
func KindOf(b []byte) (string, error)        // "ops" | "raw_body"; used by I16
```

`ParentFree()` returns true for `OpRateSet`, `OpRateUnset`, `OpHomeCurrencySet`, `OpWriterCheckpoint`.

Payload shapes (all money fields are JSON **strings** holding a decimal integer, so a JS `JSON.parse` cannot silently produce a lossy `number`):

```
txn_ingested / txn_superseded:
  { "amount_minor":"25000", "currency":"AED", "direction":"debit",
    "posted_at":"2026-06-05T00:00:00Z", "merchant_raw":"...", "last4":"3701",
    "is_transfer":false, "tier":"template"|"heuristic"|"none", "needs_review":true,
    "unparsed":false, "template_id":"dib.card.v1", "template_version":1,
    "normalizer_version":1 }
txn_categorized: { "category":"groceries" }
txn_split:       { "parts":[{"category":"a","amount_minor":"1000"}, ...] }
txn_edited:      { "merchant":"...", "amount_home_minor":"91800"|null, ... }  // see §3.7 recompute
rule_added:      { "match":"contains", "pattern":"CARREFOUR", "category":"groceries", "priority":100 }
rate_set:        { "currency":"USD", "rate_micro":"3672500" }
rate_unset:      { "currency":"USD" }
home_currency_set:{ "currency":"AED" }
writer_checkpoint:{ "heads":[ {"writer_id":"dev-a","stream":"hot","counter":"12","hash":"<hex>"}, ... ] }
```

`writer_checkpoint.heads` is an **array sorted by `(writer_id, stream)`**, not a map, so its canonical encoding is unambiguous in both languages — and it names a stream, because chains are per `(writer_id, stream)` (Decision 13).

- [ ] **Step 1: Write the failing blob tests**

`internal/v2/blob/blob_test.go`:

```go
package blob

import (
	"bytes"
	"testing"

	"github.com/google/uuid"
)

func env() Envelope {
	return Envelope{UserID: uuid.MustParse("11111111-1111-1111-1111-111111111111"),
		Stream: "hot", WriterID: "dev-a", WriterCounter: 7}
}

func TestSealRoundTripsAndPadsToBucket(t *testing.T) {
	s := PlaintextSealer{}
	msg := []byte(`{"type":"txn_ingested"}`)
	sealed, err := s.Seal(env(), msg)
	if err != nil { t.Fatal(err) }
	if sealed.SizeBucket != 1<<10 || len(sealed.Bytes) != 1<<10 {
		t.Fatalf("want 1KB bucket, got bucket=%d len=%d", sealed.SizeBucket, len(sealed.Bytes))
	}
	got, err := s.Open(env(), sealed)
	if err != nil { t.Fatal(err) }
	if !bytes.Equal(got, msg) { t.Fatalf("round trip lost data: %q", got) }
}

func TestOpenRejectsAADMismatch(t *testing.T) {
	s := PlaintextSealer{}
	sealed, _ := s.Seal(env(), []byte("x"))
	wrong := env(); wrong.WriterCounter = 8
	if _, err := s.Open(wrong, sealed); err == nil {
		t.Fatal("expected AAD mismatch to be rejected (blob replayed across positions)")
	}
	wrong = env(); wrong.Stream = "cold"
	if _, err := s.Open(wrong, sealed); err == nil {
		t.Fatal("expected AAD mismatch to be rejected (blob replayed across streams)")
	}
}

func TestBucketLadder(t *testing.T) {
	for _, tc := range []struct{ in, want int }{
		{1, 1 << 10}, {1024, 1 << 10}, {1025, 4 << 10}, {70000, 256 << 10},
		{300000, 512 << 10}, {600000, 1 << 20}, {1 << 20, 1 << 20},
	} {
		got, err := BucketFor(tc.in)
		if err != nil || got != tc.want {
			t.Fatalf("BucketFor(%d) = %d, %v; want %d", tc.in, got, err, tc.want)
		}
	}
	if _, err := BucketFor((1 << 20) + 1); err == nil {
		t.Fatal("expected oversize to error")
	}
}

func TestNonceAndTagSlotsAreReservedAndZeroInPhase1(t *testing.T) {
	// Phase 3 fills these. If they are not reserved NOW, every blob near a
	// bucket boundary silently re-buckets the day sealing turns on.
	s := PlaintextSealer{}
	sealed, _ := s.Seal(env(), []byte("hello"))
	aadLen := int(sealed.Bytes[1])<<8 | int(sealed.Bytes[2])
	nonce := sealed.Bytes[3+aadLen : 3+aadLen+12]
	tag := sealed.Bytes[len(sealed.Bytes)-16:]
	if !bytes.Equal(nonce, make([]byte, 12)) { t.Fatal("nonce slot is not reserved") }
	if !bytes.Equal(tag, make([]byte, 16)) { t.Fatal("tag slot is not reserved") }
}

func TestPhase1PayloadIsReadableInTheClear(t *testing.T) {
	// This is the migration tripwire, and it works because it asserts something
	// Phase 3 makes FALSE. (The earlier version of this test asserted the AAD
	// was readable — but the AAD stays cleartext in Phase 3 by definition, so it
	// passed with encryption fully on and defended nothing.)
	s := PlaintextSealer{}
	sealed, _ := s.Seal(env(), []byte("hello"))
	if !bytes.Contains(sealed.Bytes, []byte{0x1f, 0x8b}) {
		t.Fatal("expected the gzip payload to be readable in the clear in Phase 1; " +
			"if this fails, someone turned sealing on early — see Global Constraints")
	}
}
```

- [ ] **Step 2: Write the failing op tests**

```go
func TestDecodeBlobRejectsUnknownNewerVersion(t *testing.T) {
	_, err := DecodeBlob([]byte(`{"v":2,"kind":"ops","ops":[]}`))
	if !errors.Is(err, ErrUnknownNewerVersion) { t.Fatalf("want ErrUnknownNewerVersion, got %v", err) }
}

func TestRateOpsAreParentFree(t *testing.T) {
	for _, ty := range []OpType{OpRateSet, OpRateUnset, OpHomeCurrencySet, OpWriterCheckpoint} {
		if !ty.ParentFree() { t.Fatalf("%s must be parent-free (spec §3.7)", ty) }
	}
	for _, ty := range []OpType{OpTxnIngested, OpTxnCategorized, OpTxnSplit, OpTxnEdited, OpRuleAdded} {
		if ty.ParentFree() { t.Fatalf("%s must participate in causality", ty) }
	}
}

func TestValidateRejectsParentOnParentFreeOp(t *testing.T) { /* rate_set with ParentVersion -> error */ }
func TestValidateRequiresIngestIDOnIngestOps(t *testing.T) { /* txn_superseded without ingest_id -> error */ }
func TestEncodeDecodeRoundTrip(t *testing.T)               { /* encode 2 ops, decode, compare */ }

func TestRawBodyIsNotAnOpBlob(t *testing.T) {
	b, _ := EncodeRawBody(RawBody{V: 1, Kind: "raw_body", IngestID: strings.Repeat("a", 64),
		ReceivedAt: time.Now().UTC(), RawBase64: "aGk="})
	if k, _ := KindOf(b); k != "raw_body" { t.Fatalf("KindOf = %q", k) }
	if _, err := DecodeBlob(b); err == nil {
		t.Fatal("a raw-body blob must not decode as an op list (invariant I16)")
	}
}

func TestCheckpointHeadsAreSortedAndStreamed(t *testing.T) {
	// canonical encoding of a writer_checkpoint payload sorts by (writer_id, stream)
	// and every entry names a stream — chains are per (writer_id, stream).
}
```

- [ ] **Step 3: Run and watch fail**

Run: `go test ./internal/v2/blob/ ./internal/v2/oplog/ -v`
Expected: FAIL — `undefined: PlaintextSealer`, `undefined: DecodeBlob`.

- [ ] **Step 4: Implement `blob.go`** to the frozen wire format. `Seal`: gzip, build the header, reserve nonce+tag, compute the bucket over the **total framed length**, allocate and copy. `Open`: check the version byte, read `aadLen`, compare the embedded AAD to `e.AAD()` with `subtle.ConstantTimeCompare`, skip the nonce, read `payloadLen`, reject a `payloadLen` that runs past the sealed region (hostile input), gunzip with a decompressed-size cap of 1 MB (a gzip bomb from the inbound path is otherwise a memory DoS).

- [ ] **Step 5: Implement `op.go`.** `Validate()` enforces: `V >= 1 && V <= SchemaVersion`; non-empty `OpID` and `Type`; non-zero `AuthoredAt`; parent-free ops carry no `Entity` and no `ParentVersion`; non-parent-free ops carry an `Entity`; `OpTxnIngested`/`OpTxnSuperseded` carry a 64-hex-char `IngestID`; `Payload` is non-empty valid JSON.

- [ ] **Step 6: Run the tests**

Run: `go test ./internal/v2/blob/ ./internal/v2/oplog/ -v`
Expected: PASS (6 blob + 7 op tests).

- [ ] **Step 7: Add a package doc comment to `blob`** stating: this package defines the Phase-3 swap point. `Sealer` is the ONLY interface Phase 3 replaces; the wire header, the nonce/tag reservations, the bucket ladder, the AAD field set and the chain-hash input are frozen now so that swap is a one-file change. Note explicitly that `spike/phase0/`'s zero-nonce, no-AAD blob format is a benchmark artifact and must not be reused.

- [ ] **Step 8: Commit**

```bash
git add internal/v2/blob internal/v2/oplog
git commit -m "feat(v2): frozen blob envelope with in-ciphertext padding, and the op wire model"
```
---

## Part B — Op-log server core

### Task 5: `op_log` table, gap-free `seq` allocation, append

**Files:**
- Create: `internal/v2/pg/migrations/00002_oplog.sql`
- Create: `internal/v2/oplog/append.go`, `internal/v2/oplog/append_test.go`

**Interfaces:**
- Consumes: `pgtest.New` (Task 1), `blob.Sealed`/`blob.Hash` (Task 4), `oplog.Op` (Task 4).
- Produces:
  - `type Row struct { UserID uuid.UUID; Seq int64; Stream string; WriterID string; WriterCounter int64; TypeFlag string; Blob []byte; SizeBucket int; BlobHash []byte; PrevHash []byte; CreatedAt time.Time }`
  - `type Appender struct { Pool *pgxpool.Pool }`
  - `func (a *Appender) Append(ctx context.Context, rows []Row) ([]int64, error)` — allocates a contiguous `seq` block inside one transaction and returns the assigned seqs in order. All rows must share a `user_id`. Rows **may** span streams (the ingest writer appends one hot and one cold row per message).
  - `func (a *Appender) MaxSeq(ctx, userID) (int64, error)`
  - `func EnsureSeqRow(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error` — called from `auth.UpsertUser` **inside the user-creation transaction**, so the `oplog_seq` row always exists before the first append and the `ON CONFLICT` race path in `Append` is dead code rather than a live concurrency hazard.

Schema:

```sql
-- +goose Up
CREATE TABLE oplog_seq (
  user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  next_seq bigint NOT NULL DEFAULT 1
);

CREATE TABLE op_log (
  user_id        uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq            bigint NOT NULL,
  stream         text   NOT NULL CHECK (stream IN ('hot','cold')),
  writer_id      text   NOT NULL,
  writer_counter bigint NOT NULL,
  type_flag      text   NOT NULL CHECK (type_flag IN ('ingest','edit')),
  blob           bytea  NOT NULL,
  size_bucket    int    NOT NULL,
  blob_hash      bytea  NOT NULL,
  prev_hash      bytea  NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, seq),
  -- Chains are per (writer_id, stream) — Decision 13. The uniqueness key must
  -- include the stream or two independent chains would collide on counter 1.
  UNIQUE (user_id, writer_id, stream, writer_counter)
);
CREATE INDEX op_log_stream_idx ON op_log (user_id, stream, seq);

-- +goose Down
DROP TABLE op_log;
DROP TABLE oplog_seq;
```

`type_flag` is deliberately coarse — spec §2 discloses only "that *something* was ingested/edited, not what". Do not add the op type to this column.

- [ ] **Step 1: Write the failing test**

```go
func TestAppendAssignsContiguousSeqs(t *testing.T) {
	pool := pgtest.New(t); u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	seqs, err := a.Append(ctx, rowsFor(u, "dev-a", "hot", 1, 3))
	if err != nil { t.Fatal(err) }
	if !reflect.DeepEqual(seqs, []int64{1, 2, 3}) { t.Fatalf("got %v", seqs) }
}

func TestConcurrentAppendsAreGapFreeAndCommitOrderMatchesSeqOrder(t *testing.T) {
	pool := pgtest.New(t); u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for c := 1; c <= 25; c++ {
				if _, err := a.Append(ctx, rowsFor(u, fmt.Sprintf("dev-%d", w), "hot", int64(c), 1)); err != nil {
					t.Error(err); return
				}
			}
		}(w)
	}
	wg.Wait()
	rows, _ := pool.Query(ctx, `SELECT seq FROM op_log WHERE user_id=$1 ORDER BY seq`, u)
	var got []int64
	for rows.Next() { var s int64; rows.Scan(&s); got = append(got, s) }
	for i, s := range got {
		if s != int64(i+1) { t.Fatalf("gap at index %d: seq=%d", i, s) }
	}
	if len(got) != 200 { t.Fatalf("want 200 rows, got %d", len(got)) }
}

func TestOneCallMaySpanStreamsAndCountersAreIndependent(t *testing.T) {
	// one hot row (counter 1) + one cold row (counter 1) in a single Append:
	// two seqs, and the unique index tolerates the shared counter value.
}

func TestSeqRowExistsBeforeTheFirstAppend(t *testing.T) {
	// after insertUser, oplog_seq already holds a row for that user, so Append's
	// ON CONFLICT path never runs in production.
}

func TestAppendRejectsMixedUsers(t *testing.T) { /* two user_ids in one call -> error */ }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./internal/v2/oplog/ -run TestAppend -v`
Expected: FAIL — `undefined: Appender`.

- [ ] **Step 3: Implement `Append`**

Use **two statements inside one transaction** — not a single fiddly `ON CONFLICT … RETURNING` expression, which the first draft got wrong:

```go
tx, err := a.Pool.Begin(ctx)
...
// The oplog_seq row is normally pre-created with the user (EnsureSeqRow); this
// INSERT is belt-and-braces for a user created before that change landed.
_, err = tx.Exec(ctx, `INSERT INTO oplog_seq (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, user)
var start int64
err = tx.QueryRow(ctx,
	`UPDATE oplog_seq SET next_seq = next_seq + $2 WHERE user_id = $1 RETURNING next_seq - $2`,
	user, int64(len(rows))).Scan(&start)
```

Then batch-insert the rows with `seq = start + i` and commit.

Two comments the implementer must actually write into the code:

```go
// Locking the per-user counter row for the life of the transaction makes commit
// order identical to seq order, so a committed seq implies every lower seq is
// committed. This is the gap-free guarantee §3.3 requires; do NOT replace it
// with a sequence + watermark.

// Accepted cost: the row lock is held across the blob INSERT, so a 1 MB cold
// blob serialises this one user's inbound SMTP for the duration of that write.
// Bounded, per-user, and cheaper than reconstructing gap-freeness elsewhere.
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/oplog/ -race -v`
Expected: PASS. The concurrency test must pass under `-race`.

- [ ] **Step 5: Commit**

```bash
git add internal/v2/pg/migrations/00002_oplog.sql internal/v2/oplog/append.go internal/v2/oplog/append_test.go
git commit -m "feat(v2): op_log table with gap-free per-user seq allocation"
```

---

### Task 6: Auth — IdP token verification and opaque sessions

**Files:**
- Create: `internal/v2/auth/idp.go`, `internal/v2/auth/idp_test.go`
- Create: `internal/v2/auth/session.go`, `internal/v2/auth/session_test.go`

**Interfaces:**
- Consumes: `pgtest.New`, `users`/`sessions` tables (Task 1), `oplog.EnsureSeqRow` (Task 5), `config.Config.Auth` (Task 3), `github.com/coreos/go-oidc/v3/oidc` (Decision 12).
- Produces:
  - `type Identity struct { IdP string; Subject string }`
  - `type Verifier interface { Verify(ctx context.Context, idToken string) (Identity, error) }`
  - `func NewOIDCVerifier(idp, issuer, jwksURL string, audiences []string, now func() time.Time) Verifier`
  - `func SubjectHash(idp, subject string) []byte` — `SHA256("v2|" + idp + "|" + subject)`; the raw subject is never stored.
  - `type Sessions struct { Pool *pgxpool.Pool; TTL time.Duration; Now func() time.Time }`
  - `func (s *Sessions) Issue(ctx, userID uuid.UUID) (token string, err error)` — 32 random bytes, base64url; stores only `SHA256(token)`.
  - `func (s *Sessions) Resolve(ctx, token string) (uuid.UUID, error)` — rejects expired/revoked.
  - `func (s *Sessions) Revoke(ctx, token string) error`
  - `func (s *Sessions) RevokeAllForUser(ctx, userID uuid.UUID) error`
  - `func UpsertUser(ctx context.Context, pool *pgxpool.Pool, id Identity) (uuid.UUID, error)` — creates the user **and** its `oplog_seq` row in one transaction.

**Construction rules (Decision 12), which the tests pin:**
- Build with `oidc.NewRemoteKeySet(ctx, jwksURL)` + `oidc.NewVerifier(issuer, keySet, cfg)`. Never `oidc.NewProvider`, which performs network discovery at construction and would make every test non-hermetic.
- `cfg.SkipClientIDCheck = true` and the audience is checked in our own code against the configured set, because Apple's `aud` may be a bare string or an array and Google issues a different client ID per platform.
- Reject `alg: none` and every symmetric algorithm explicitly (`cfg.SupportedSigningAlgs = []string{"RS256","ES256"}`).

- [ ] **Step 1: Write the failing tests**

```go
func TestSessionTokenIsNeverStoredInTheClear(t *testing.T) {
	pool := pgtest.New(t); u := insertUser(t, pool)
	s := &Sessions{Pool: pool, TTL: time.Hour, Now: time.Now}
	tok, err := s.Issue(ctx, u)
	if err != nil { t.Fatal(err) }
	var raw []byte
	pool.QueryRow(ctx, `SELECT token_hash FROM sessions`).Scan(&raw)
	if bytes.Contains(raw, []byte(tok)) { t.Fatal("session table contains the bearer token itself") }
	got, err := s.Resolve(ctx, tok)
	if err != nil || got != u { t.Fatalf("resolve: %v %v", got, err) }
}

func TestExpiredSessionIsRejected(t *testing.T) { /* TTL 1m, advance Now 2m -> error */ }

func TestSubjectHashIsStableAndNotReversible(t *testing.T) {
	a := SubjectHash("apple", "001234.abc")
	if len(a) != 32 { t.Fatal("want a 32-byte digest") }
	if bytes.Equal(a, SubjectHash("google", "001234.abc")) { t.Fatal("idp must be part of the hash input") }
}
```

and the negative-verification set, which exists whether or not a library is used, because these are the failure modes that turn an IdP integration into an authentication bypass. Serve a JWKS from `httptest` with two locally generated keys (one enrolled, one not):

```go
func TestVerifierRejectsWrongAudience(t *testing.T)          { /* aud = someone else's client id */ }
func TestVerifierRejectsWrongIssuer(t *testing.T)            { /* iss = https://evil.test */ }
func TestVerifierRejectsAlgNone(t *testing.T)                { /* {"alg":"none"} with no signature */ }
func TestVerifierRejectsHS256SignedWithTheJWKSModulus(t *testing.T) {
	// classic alg-confusion: an RSA public key used as an HMAC secret.
}
func TestVerifierRejectsAnEmbeddedJWKHeader(t *testing.T) {
	// a token carrying its own "jwk" header must be verified against the JWKS,
	// never against the key it brought with it.
}
func TestVerifierRejectsAKeyNotInTheJWKS(t *testing.T)       { /* signed by key #2 */ }
func TestVerifierRejectsExpiredAndNotYetValid(t *testing.T)  { /* exp in the past; nbf in the future */ }
func TestVerifierAcceptsAppleMultiAudienceArray(t *testing.T) { /* aud: ["a","b"] where b is configured */ }
func TestVerifierRefetchesJWKSAfterRotation(t *testing.T) {
	// rotate the served JWKS to a new kid, mint a token under it -> accepted
	// without restarting the verifier.
}
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/auth/ -v`
Expected: FAIL — `undefined: Sessions`.

- [ ] **Step 3: Add the dependency (pinned)**

```bash
go get github.com/coreos/go-oidc/v3@v3.11.0
```

- [ ] **Step 4: Implement `session.go`** (`crypto/rand` token, `sha256` storage, single `SELECT` resolving with `expires_at > now AND revoked_at IS NULL`) and **`idp.go`** per the construction rules above.

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/v2/auth/ -v`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add internal/v2/auth go.mod go.sum
git commit -m "feat(v2): IdP token verification via go-oidc and opaque server-side sessions"
```

---

### Task 7: Writers, key history, Ed25519 challenge registration

**Files:**
- Create: `internal/v2/pg/migrations/00003_writers.sql`
- Create: `internal/v2/auth/writer.go`, `internal/v2/auth/writer_test.go`

**Interfaces:**
- Consumes: `Sessions` (Task 6).
- Produces:
  - `type Writer struct { UserID uuid.UUID; WriterID string; Kind string; PubKey ed25519.PublicKey; RegisteredAt, RevokedAt time.Time }`
  - `type Writers struct { Pool *pgxpool.Pool; Now func() time.Time }`
  - `func (w *Writers) Challenge(ctx, userID uuid.UUID) (nonce []byte, err error)` — 32 random bytes, single-use, 5-minute TTL.
  - `func RegistrationMessage(nonce []byte, writerID string, pub ed25519.PublicKey) []byte` — the exact bytes that get signed: `"ledger-v2-writer-registration\x00" || nonce || 0x00 || writerID || 0x00 || pub`.
  - `func (w *Writers) Register(ctx, userID uuid.UUID, writerID string, pub ed25519.PublicKey, nonce, sig []byte) error`
  - `func (w *Writers) Roster(ctx, userID uuid.UUID) ([]Writer, error)`
  - `func (w *Writers) EnsureIngestWriter(ctx, userID uuid.UUID) (string, error)` — the fixed server-side writer, `writer_id = "ingest"`, `kind = 'ingest'`, no public key.

**The signature binds the enrollment, not merely the nonce.** The first draft verified `ed25519.Verify(enrolledKey, nonce, sig)`, which authorizes "some enrollment" rather than "*this* enrollment": an attacker who observes a signature over a nonce can substitute a different `writer_id` and a different public key and present the same signature. The signed message is therefore `nonce ‖ writer_id ‖ pubkey` under a domain-separation prefix, and `RegistrationMessage` is exported so the client (Task 14) and the server cannot drift.

Registration rules:
- First writer for a user: self-signature (`pub` signs `RegistrationMessage(nonce, writerID, pub)`) — TOFU bootstrap, spec §3.4 ("a fresh device's first bootstrap trusts the server").
- Every later writer: the signature must verify under an **already-enrolled, non-revoked** key.
- Every accepted registration appends to `key_history`.

Schema: `writers(user_id, writer_id, kind check in ('device','ingest'), pubkey bytea, registered_at, revoked_at, primary key (user_id, writer_id))`; `key_history(id bigserial, user_id, writer_id, pubkey bytea, event text check in ('registered','revoked'), at timestamptz)` — **append-only**, no `UPDATE`/`DELETE` path in code; `writer_challenges(nonce bytea pk, user_id, expires_at, used_at)`.

- [ ] **Step 1: Write the failing test**

```go
func TestSecondWriterRequiresProofOfKeyPossession(t *testing.T) {
	pool := pgtest.New(t); u := insertUser(t, pool)
	w := &Writers{Pool: pool, Now: time.Now}
	pubA, privA, _ := ed25519.GenerateKey(nil)
	n1, _ := w.Challenge(ctx, u)
	if err := w.Register(ctx, u, "dev-a", pubA, n1,
		ed25519.Sign(privA, RegistrationMessage(n1, "dev-a", pubA))); err != nil {
		t.Fatalf("first writer (TOFU): %v", err)
	}
	pubB, privB, _ := ed25519.GenerateKey(nil)
	n2, _ := w.Challenge(ctx, u)
	// A stolen session token can present a fresh key and sign with it, but it
	// cannot sign with an ALREADY-ENROLLED key. That must be rejected.
	if err := w.Register(ctx, u, "dev-b", pubB, n2,
		ed25519.Sign(privB, RegistrationMessage(n2, "dev-b", pubB))); err == nil {
		t.Fatal("self-signed second writer must be rejected (spec §3.4 capability rules)")
	}
	n3, _ := w.Challenge(ctx, u)
	if err := w.Register(ctx, u, "dev-b", pubB, n3,
		ed25519.Sign(privA, RegistrationMessage(n3, "dev-b", pubB))); err != nil {
		t.Fatalf("second writer signed by an enrolled key must be accepted: %v", err)
	}
}

func TestSignatureIsBoundToTheWriterIDAndKey(t *testing.T) {
	// Sign RegistrationMessage(nonce, "dev-b", pubB) with the enrolled key, then
	// submit it as writer_id "dev-evil" with pubEvil -> rejected. A signature
	// over the bare nonce would have accepted this.
}

func TestChallengeIsSingleUse(t *testing.T)          { /* replay the same nonce -> error */ }
func TestChallengeExpires(t *testing.T)              { /* advance Now past the 5-minute TTL -> error */ }
func TestRevokedKeyCannotAuthorizeANewWriter(t *testing.T) { /* revoke dev-a, then sign with it -> error */ }
func TestRegistrationAppendsToKeyHistory(t *testing.T) { /* two registrations -> exactly 2 rows */ }
func TestClientCannotRegisterTheIngestWriterID(t *testing.T) { /* writer_id "ingest" -> error */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/auth/ -run TestSecondWriter -v`
Expected: FAIL — `undefined: Writers`.

- [ ] **Step 3: Implement `writer.go`** and the migration.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/auth/ -v`
Expected: PASS (19 tests total in the package).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/pg/migrations/00003_writers.sql internal/v2/auth/writer.go internal/v2/auth/writer_test.go
git commit -m "feat(v2): writer registration binding nonce+writer_id+pubkey, with append-only key history"
```

---

### Task 8: Hash chains per `(writer_id, stream)`

**Files:**
- Create: `internal/v2/oplog/chain.go`, `internal/v2/oplog/chain_test.go`
- Modify: `internal/v2/oplog/append.go` (call the chain check inside the append transaction)

**Interfaces:**
- Consumes: `Appender` (Task 5), `blob.Hash`/`blob.ZeroHash` (Task 4), `Writers.Roster` (Task 7).
- Produces:
  - `func (a *Appender) Head(ctx, userID uuid.UUID, writerID, stream string) (counter int64, hash [32]byte, err error)` — `(0, ZeroHash)` for a `(writer, stream)` pair with no rows.
  - `func (a *Appender) AppendClient(ctx context.Context, userID uuid.UUID, writerID, stream string, rows []Row) ([]int64, error)`
  - `func (a *Appender) AppendIngest(ctx context.Context, userID uuid.UUID, rows []Row) ([]int64, error)` — the server **computes** counters and hashes for the `ingest` writer, **per stream**; callers pass rows with `WriterCounter`/`PrevHash`/`BlobHash` unset. A call may contain both a hot and a cold row; each gets the next counter *in its own stream*.
  - `var ErrChainBreak = errors.New("writer hash chain break")`

**Chain rule (frozen, identical in Go and TypeScript):** for each `(writer_id, stream)` independently, `blob_hash[n] = SHA256(blob_hash[n-1] || blob_bytes[n])`, with 32 zero bytes as `prev` for `n = 1`. The hash is over the **stored blob bytes**, which in Phase 3 are ciphertext — so the formula does not change when sealing turns on.

**Why per-stream (Decision 13, restated where the implementer will read it):** a single chain per writer would interleave hot and cold blobs, so a hot-only pull would see counters 1, 3, 5, … with `prev_hash` values pointing at cold blobs the client deliberately did not fetch. Spec §3.3:70 makes cold lazily synced with a rolling client-side window, so those gaps are permanent and by design. Splitting the chain per stream makes the hot chain self-verifying from hot rows alone, and confines lazy verification to cold, where spec §3.3:72's hash list is the mechanism (Task 9).

`AppendClient` takes one writer and one stream per call. In Phase 1 clients author only `hot` blobs — the cold stream is raw email bodies, which only the ingest writer produces — but the parameter is explicit rather than assumed, so the shape generalizes without a signature change.

**Ordering rule the implementer must honor:** take the `oplog_seq` row lock **first**, then read the chain head, then verify, then insert. Reading the head before taking the lock lets two concurrent appends from the same writer both observe the same head and race to counter N+1; the unique index would catch it, but as a constraint violation rather than an `ErrChainBreak`, which is the wrong error to hand a client.

- [ ] **Step 1: Write the failing test**

```go
func TestClientAppendRejectsCounterGap(t *testing.T) {
	// append hot counters 1,2 then attempt 4 -> ErrChainBreak, op_log still has 2 rows
}
func TestClientAppendRejectsForgedPrevHash(t *testing.T) {
	// append counter 1; submit counter 2 with prev_hash = random -> ErrChainBreak
}
func TestClientAppendRejectsRecomputedHashMismatch(t *testing.T) {
	// submit a row whose BlobHash != SHA256(prev||blob) -> ErrChainBreak
}
func TestChainBreakRollsBackTheWholeBatch(t *testing.T) {
	// batch of 3 where the 3rd has a bad prev_hash -> no rows appended at all
}
func TestIngestChainIsServerComputedAndPerStream(t *testing.T) {
	// AppendIngest three times, each with one hot + one cold row.
	// Assert: hot counters 1,2,3 and cold counters 1,2,3 — NOT 1..6 interleaved.
	// Assert per stream: hash[n] == SHA256(hash[n-1]||blob[n]).
}
func TestHotAndColdChainsAreIndependent(t *testing.T) {
	// Head(u,"ingest","hot") and Head(u,"ingest","cold") advance separately;
	// a cold append never changes the hot head.
}
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/oplog/ -run Chain -v`
Expected: FAIL — `undefined: ErrChainBreak`.

- [ ] **Step 3: Implement `chain.go`** and refactor `Append` into an unexported `appendRows` used by both `AppendClient` and `AppendIngest`, so `seq` allocation stays in one place.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/oplog/ -race -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/v2/oplog
git commit -m "feat(v2): per-(writer,stream) hash chains with verify-on-append and server ingest chain"
```

---

### Task 9: Sync API — per-stream pull, upload, roster, cold hash list

**Files:**
- Create: `internal/v2/oplog/read.go`, `internal/v2/oplog/read_test.go`
- Create: `internal/v2/api/api.go` (router + session middleware), `internal/v2/api/sync.go`, `internal/v2/api/sync_test.go`
- Modify: `cmd/ledgerd/main.go` (`runServe` mounts the API)

**Interfaces:**
- Consumes: Tasks 5–8.
- Produces the HTTP contract the TypeScript client codes against:

```
POST /api/v1/auth/exchange     {idp, id_token}                  -> {session_token, user_id}
POST /api/v1/writers/challenge {}                               -> {nonce}
POST /api/v1/writers/register  {writer_id, pubkey, nonce, sig}  -> 204
GET  /api/v1/writers                                            -> {writers:[{writer_id,kind,pubkey,registered_at,revoked_at}]}
GET  /api/v1/sync?stream=hot&after=<seq>&limit=<n>              -> {stream, rows:[Row], next:<seq>, complete:bool}
GET  /api/v1/sync/hashes?stream=cold&after=<seq>&limit=<n>      -> {stream, hashes:[{seq,writer_id,writer_counter,blob_hash}], next:<seq>, complete:bool}
POST /api/v1/sync                                               -> {seqs:[...]}
     {writer_id, stream, blobs:[{writer_counter,prev_hash,blob_hash,type_flag,size_bucket,blob:<base64>}]}
```

`Row` on the wire: `{seq, stream, writer_id, writer_counter, type_flag, size_bucket, blob_hash, prev_hash, created_at, blob:<base64>}`.

- **Cursors are per stream.** `after` is a `seq` value, but it is the caller's cursor *for that stream*, and the response's `next` is the largest `seq` returned for that stream. `seq` remains a single per-user total order spanning both streams, so a hot-only pull legitimately observes a sparse sequence (1, 3, 5, …). That is not a gap: gap detection is the writer chain's job (spec §3.3:65), and the chain is now per-stream and therefore contiguous within a stream (Task 8).
- `func Read(ctx, pool, userID uuid.UUID, stream string, after int64, limit int) ([]Row, error)` — `WHERE stream = $2 AND seq > $3 ORDER BY seq LIMIT $4`. Because `seq` allocation is commit-ordered (Task 5), the unfiltered log is already a contiguous committed prefix, and a stream filter over a contiguous prefix is itself complete for that stream; no watermark logic is needed.
- `func Hashes(ctx, pool, userID, stream string, after int64, limit int) ([]HashRow, error)` — spec §3.3:72's compact per-blob hash list. This is what a client uses to verify the **cold** chain contiguously without downloading a single cold body, and to check each later range fetch against a pinned hash. It is served for `hot` too, so a client that has pruned local hot blobs can re-verify cheaply.
- All handlers require `Authorization: Bearer <session_token>`; every query is scoped by the resolved `user_id` — never by a user id taken from the request.

- [ ] **Step 1: Write the failing test**

```go
func TestSyncReturnsOnlyTheCallersRows(t *testing.T) {
	// two users with rows; user A's token must never see user B's seqs
}

func TestHotOnlyPullIsCompleteForItsStream(t *testing.T) {
	// interleave 10 hot and 10 cold appends. Pull stream=hot only.
	// Assert: 10 rows, seqs strictly increasing but NOT contiguous in the global
	// space, and hot writer_counters exactly 1..10 with a verifiable chain.
	// This is the property §3.3:70 actually requires and the first draft never
	// exercised.
}

func TestSyncCursorPagesWithoutGapsWithinAStream(t *testing.T) {
	// append 250 hot rows, page with limit=100, assert the concatenated
	// writer_counters are 1..250
}

func TestHashListCoversEveryColdBlobAndMatchesTheStoredHashes(t *testing.T) {
	// hashes(cold) length == cold row count; each blob_hash equals the row's
	// blob_hash; the list verifies as a chain from ZERO_HASH
}

func TestUploadRejectsAWriterIDTheCallerDoesNotOwn(t *testing.T) { /* 403, nothing appended */ }
func TestUploadRejectsIngestWriterID(t *testing.T)               { /* a client must never author as "ingest" -> 403 */ }
func TestUploadRejectsBlobWhoseAADDoesNotMatchTheRow(t *testing.T) {
	// blob sealed with writer_counter=5 but submitted as counter=6 -> 400
}
func TestUploadRejectsOversizeAndBadBucket(t *testing.T) {
	// len(blob) != declared size_bucket -> 400 ; > 1 MB -> 413
}
func TestUploadRejectsColdStreamFromAClient(t *testing.T) {
	// Phase 1: only the ingest writer authors cold blobs -> 400
}
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/api/ -v`
Expected: FAIL — package does not compile.

- [ ] **Step 3: Implement `api.go`**: `type Server struct { Pool; Cfg; Sessions; Writers; Appender }`, `func (s *Server) Handler() http.Handler` using Go 1.22 method+pattern routing (`mux.HandleFunc("GET /api/v1/sync", ...)`), a `requireSession` wrapper, and a catch-all `/api/` returning 404 JSON so nothing else swallows API paths.

- [ ] **Step 4: Implement `sync.go`** — the seven handlers above. On upload, for each blob: `blob.PlaintextSealer{}.Open(envelope, sealed)` purely as an AAD check (discard the plaintext; the server does not need it and in Phase 3 could not read it).

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/v2/api/ ./internal/v2/oplog/ -v`
Expected: PASS.

- [ ] **Step 6: Wire `runServe`** to build the pool, migrate, and `http.ListenAndServe(cfg.Server.HTTPListen, srv.Handler())` (plain HTTP for now — TLS/autocert is deployment Task D4).

- [ ] **Step 7: Commit**

```bash
git add internal/v2/api internal/v2/oplog/read.go internal/v2/oplog/read_test.go cmd/ledgerd
git commit -m "feat(v2): sync API - per-stream cursors, blob upload, writer roster, cold hash list"
```
---

## Part C — The client half and the invariant checker

### Task 10: TypeScript client scaffold — wire model, blob open, chain verification

**Files:**
- Create: `client/package.json`, `client/tsconfig.json`, `client/.gitignore`
- Create: `client/src/wire/op.ts`, `client/src/wire/op.test.ts`
- Create: `client/src/wire/blob.ts`, `client/src/wire/blob.test.ts`
- Create: `client/src/wire/chain.ts`, `client/src/wire/chain.test.ts`

**Interfaces:**
- Consumes: the frozen formats from Tasks 4 and 8.
- Produces:
  - `export const SCHEMA_VERSION = 1`
  - `export type OpType = "txn_ingested" | "txn_superseded" | "txn_categorized" | "txn_split" | "txn_edited" | "rule_added" | "rate_set" | "rate_unset" | "home_currency_set" | "writer_checkpoint"`
  - `export interface Op { v: number; type: OpType; op_id: string; authored_at: string; entity?: {kind: string; id: string}; parent_version: number | null; ingest_id?: string; payload: unknown }`
  - `export function isParentFree(t: OpType): boolean`
  - `export class UnknownNewerVersionError extends Error {}`
  - `export class BlobDecodeError extends Error {}` — thrown for a blob that cannot be decoded at all. Callers **set it aside**, they never abort (spec §3.3:68).
  - `export function kindOf(bytes: Uint8Array): "ops" | "raw_body"`
  - `export function decodeBlobOps(bytes: Uint8Array): Op[]` — throws `UnknownNewerVersionError` on `v > SCHEMA_VERSION`.
  - `export function decodeRawBody(bytes: Uint8Array): { ingest_id: string; received_at: string; raw: Uint8Array }`
  - `export interface Envelope { userId: string; stream: "hot" | "cold"; writerId: string; writerCounter: bigint }`
  - `export function aad(e: Envelope): Uint8Array`
  - `export function openBlob(e: Envelope, bytes: Uint8Array): Uint8Array` — mirrors `blob.PlaintextSealer.Open`, throws on AAD mismatch.
  - `export function chainHash(prev: Uint8Array, blobBytes: Uint8Array): Uint8Array` (SHA-256)
  - `export const ZERO_HASH: Uint8Array` (32 zero bytes)
  - `export type ChainKey = string` — `` `${writerId}|${stream}` ``, the key every pinned head and every chain check is filed under.
  - `export function verifyChain(key: ChainKey, rows: {writer_counter: bigint; prev_hash: Uint8Array; blob_hash: Uint8Array; blob: Uint8Array}[], pinnedHead: {counter: bigint; hash: Uint8Array}): void` — throws `ChainBreakError`. Rows must all belong to one `(writer_id, stream)`.
  - `export function verifyHashList(key: ChainKey, list: {seq: bigint; writer_counter: bigint; blob_hash: Uint8Array}[], pinnedHead: {counter: bigint; hash: Uint8Array}): {counter: bigint; hash: Uint8Array}` — spec §3.3:72: verifies the compact per-blob hash list is contiguous from the pinned head and returns the new head. **The hash list alone cannot prove `blob_hash[n] = SHA256(blob_hash[n-1] ‖ blob[n])`** without the bodies; what it proves is that the *server committed* to this exact sequence of hashes at this moment. Every later range fetch is then checked against the pinned entry, which is what makes a swapped cold body detectable.
  - `export function verifyFetchedRange(pinned: Map<bigint, Uint8Array>, rows: {...}[]): void` — throws if a fetched cold body's recomputed hash differs from the pinned one.

`client/package.json`:

```json
{
  "name": "ledger-v2-client",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "cli": "bun run src/cli/main.ts"
  },
  "devDependencies": { "typescript": "5.9.2", "@types/bun": "1.2.19" },
  "dependencies": { "ulid": "2.3.0" }
}
```

Versions are exact, not caret ranges (Decision 15).

- [ ] **Step 1: Add a Go fixture writer so the two sides share bytes**

In `internal/v2/blob/blob_test.go`, add `TestWriteConformanceFixtures` (guarded by `-run`) that seals three known plaintexts — one hot op blob, one cold raw-body blob, one blob whose plaintext lands one byte under a bucket boundary — and writes `conformance/blob/*.bin` plus a `manifest.json` giving each fixture's envelope, its expected plaintext (base64) and its expected bucket. Run it once:

```bash
go test ./internal/v2/blob/ -run TestWriteConformanceFixtures -v && ls conformance/blob/
```
Expected: PASS, and three `.bin` files plus `manifest.json`.

- [ ] **Step 2: Scaffold and write the failing test**

```bash
mkdir -p client/src/wire && cd client && bun install
```

`client/src/wire/blob.test.ts`:

```ts
import { expect, test } from "bun:test";
import { aad, openBlob, type Envelope } from "./blob";

const manifest = await Bun.file(`${import.meta.dir}/../../../conformance/blob/manifest.json`).json();

const env: Envelope = {
  userId: "11111111-1111-1111-1111-111111111111",
  stream: "hot", writerId: "dev-a", writerCounter: 7n,
};

test("aad is the canonical pipe-joined field set", () => {
  expect(new TextDecoder().decode(aad(env)))
    .toBe("11111111-1111-1111-1111-111111111111|hot|dev-a|7");
});

test("openBlob round-trips the Go-sealed fixture", async () => {
  const f = manifest.fixtures.find((x: any) => x.file === "hot-dev-a-7.bin");
  // Bun.file() returns a BunFile, not bytes — .bytes() is the accessor.
  const bytes = await Bun.file(`${import.meta.dir}/../../../conformance/blob/${f.file}`).bytes();
  const got = openBlob(env, bytes);
  expect(Buffer.from(got).toString("base64")).toBe(f.expect_plaintext_base64);
});

test("openBlob rejects an envelope that does not match the sealed AAD", async () => {
  const bytes = await Bun.file(`${import.meta.dir}/../../../conformance/blob/hot-dev-a-7.bin`).bytes();
  expect(() => openBlob({ ...env, writerCounter: 8n }, bytes)).toThrow();
  expect(() => openBlob({ ...env, stream: "cold" }, bytes)).toThrow();
});
```

The first draft of this test loaded the fixture and then passed `new Uint8Array(0)` to `openBlob`, so it threw for the wrong reason and would have passed against an implementation that ignored the AAD entirely.

- [ ] **Step 3: Run it and watch it fail**

Run: `cd client && bun test src/wire/blob.test.ts`
Expected: FAIL — cannot resolve `./blob`.

- [ ] **Step 4: Implement `op.ts`, `blob.ts`, `chain.ts`.** Use `Bun.gunzipSync`/`Bun.gzipSync` for the payload and `new Bun.CryptoHasher("sha256")` for chain hashes. Parse money fields as `BigInt(str)` — never `Number`. Skip the reserved 12-byte nonce and 16-byte tag slots exactly as Go does.

- [ ] **Step 5: Write the chain tests**

```ts
test("verifyChain detects a dropped blob within a stream", () => {
  const rows = [mk(1n), mk(2n), mk(4n)];       // counter 3 removed by a hostile server
  expect(() => verifyChain("dev-a|hot", rows, { counter: 0n, hash: ZERO_HASH })).toThrow(ChainBreakError);
});

test("verifyChain detects a reordered blob", () => {
  const rows = [mk(1n), mk(3n), mk(2n)];
  expect(() => verifyChain("dev-a|hot", rows, { counter: 0n, hash: ZERO_HASH })).toThrow(ChainBreakError);
});

test("verifyChain accepts a contiguous chain continuing from a pinned head", () => { /* ... */ });

test("hot and cold chains are verified independently", () => {
  // the same counter value 1 appears in both streams; verifying hot must not
  // consult cold, and vice versa. This is the property that makes a hot-only
  // pull verifiable (Decision 13).
});

test("verifyHashList pins a cold head without any cold bodies", () => {
  const head = verifyHashList("ingest|cold", coldHashList, { counter: 0n, hash: ZERO_HASH });
  expect(head.counter).toBe(BigInt(coldHashList.length));
});

test("verifyFetchedRange rejects a cold body swapped after pinning", () => {
  const pinned = pinnedFrom(coldHashList);
  const rows = [{ ...coldRow(5n), blob: tamper(coldRow(5n).blob) }];
  expect(() => verifyFetchedRange(pinned, rows)).toThrow();
});
```

- [ ] **Step 6: Run the tests**

Run: `cd client && bun test`
Expected: PASS (all wire tests).

- [ ] **Step 7: Commit**

```bash
git add client conformance/blob internal/v2/blob/blob_test.go
git commit -m "feat(v2): TypeScript wire model, plaintext blob open, per-stream chains and cold hash-list verification"
```

---

### Task 11: Replay engine — entity heads, causality, fork resolution, supersede

**Files:**
- Create: `client/src/replay/state.ts`, `client/src/replay/replay.ts`, `client/src/replay/replay.test.ts`

**Interfaces:**
- Consumes: Task 10's `Op`.
- Produces:

```ts
export interface Txn {
  id: string; ingest_id: string;
  amount_minor: bigint; currency: string; direction: "debit" | "credit";
  posted_at: string; merchant_raw: string; last4: string;
  category: string | null; needs_review: boolean; provenance: "ingest" | "user";
  amount_home_minor: bigint | null;      // frozen snapshot, set by Task 12
  splits: { category: string; amount_minor: bigint }[];
  superseded_by: string | null;          // op_id of the txn_superseded that replaced it
  possible_duplicate_of: string | null;  // fingerprint heuristic, spec §3.3:67
  version: number;
}
export interface ForkNotice { entity: {kind: string; id: string}; winner_op: string; loser_op: string; at_seq: bigint }
export interface Anomaly { kind: string; detail: string; at_seq: bigint }
export interface Unreadable { writer_id: string; stream: string; writer_counter: bigint; seq: bigint; reason: string }
export interface State {
  txns: Map<string, Txn>;
  liveByIngestID: Map<string, string>;    // ingest_id -> txn id (at most one live)
  byFingerprint: Map<string, string[]>;   // fingerprint -> live txn ids
  rules: Map<string, {pattern: string; match: string; category: string; priority: number; version: number}>;
  homeCurrency: string | null;
  rates: Map<string, bigint | null>;      // maintained by Task 12
  pendingByCurrency: Map<string, Set<string>>;
  checkpoints: {writer_id: string; stream: string; counter: bigint; hash: string}[]; // latest seen
  forks: ForkNotice[];
  anomalies: Anomaly[];
  unreadable: Unreadable[];
  cursors: { hot: bigint; cold: bigint };
}
export function emptyState(): State
export function applyOp(s: State, op: Op, seq: bigint): void   // mutates s, in seq order
export function fold(ops: {op: Op; seq: bigint}[], s?: State): State
export function fingerprint(t: Txn): string    // `${last4}|${amount_minor}|${direction}|${merchant_raw}|${day(posted_at)}`
```

**Causality rules (implement exactly — this is spec §3.3):**
1. `applyOp` is only ever called in ascending `seq` order.
2. For a non-parent-free op naming entity `E` with `parent_version = P`:
   - `P === null` → create. If `E` already exists, record an `Anomaly{kind:"duplicate_create"}` and skip.
   - `P === head(E).version` → apply; `head(E).version += 1`.
   - `P < head(E).version` → **true concurrent fork.** Compare this op against the op currently owning the head: the winner is the later `authored_at`; on an exact tie the lexicographically greater `writer_id`. Advance `head(E).version += 1` **unconditionally** (so version numbering is a deterministic function of the total order), apply the *winner's* payload, and push a `ForkNotice`. Never delete or rewrite anything at an earlier position.
   - `P > head(E).version` → impossible in a gap-free prefix; record `Anomaly{kind:"future_parent"}` and skip.
3. **Dedup is by ingest identity.** `txn_ingested` with an `ingest_id` already in `liveByIngestID` → record an `Anomaly{kind:"duplicate_ingest"}` and skip (the server should have superseded instead). `txn_superseded` replaces the live transaction for that `ingest_id`: the previous txn is marked `superseded_by`, removed from `liveByIngestID` **and from `byFingerprint`**, and the new one inserted. **Exactly one live transaction per ingest ID, always.**
4. **Fingerprint duplicates are a client-side notice, never a drop.** After a `txn_ingested`/`txn_superseded` is applied, compute `fingerprint(t)`. If another *live* transaction already carries it, set `possible_duplicate_of` on the new transaction and record an `Anomaly{kind:"possible_duplicate"}`. Both transactions stay live and fully visible — spec §3.3:67 is explicit that genuine same-card same-day duplicate purchases exist. **This lives in the client, not the server**, because only the client can see decrypted history; a server-side fingerprint index would be another plaintext read path Phase 3 must delete.
5. `txn_split` replaces `splits` wholesale; the parts must sum to `amount_minor` or an `Anomaly{kind:"split_sum"}` is recorded and the op is not applied.
6. `writer_checkpoint` replaces `state.checkpoints` wholesale with its payload's `heads` array (the latest checkpoint wins; earlier ones are historical).
7. Ops with `v > SCHEMA_VERSION` never reach `applyOp` — `decodeBlobOps` has already thrown.
8. A blob that fails to decode is appended to `state.unreadable` by the *caller* and never reaches `applyOp`. Replay does not abort (spec §3.3:68).

- [ ] **Step 1: Write the failing tests**

```ts
test("sequential re-categorization is an ordinary edit, not a fork", () => {
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, categorized("t1", 1, "groceries", "dev-a", "2026-06-01T10:00:00Z")),
    at(3n, categorized("t1", 2, "dining",   "dev-a", "2026-06-01T11:00:00Z")),
  ]);
  expect(s.txns.get("t1")!.category).toBe("dining");
  expect(s.forks).toHaveLength(0);
});

test("two ops naming the same parent fork, resolve by later authored_at, and are surfaced", () => {
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, categorized("t1", 1, "groceries", "dev-a", "2026-06-01T10:00:00Z")),
    at(3n, categorized("t1", 1, "dining",    "dev-b", "2026-06-01T12:00:00Z")),
  ]);
  expect(s.txns.get("t1")!.category).toBe("dining");
  expect(s.forks).toHaveLength(1);
  expect(s.txns.get("t1")!.version).toBe(3);
});

test("fork ties break on writer_id, deterministically in both orders", () => {
  const a = fold([at(1n, ingested("i1","t1")),
                  at(2n, categorized("t1",1,"x","dev-a","2026-06-01T10:00:00Z")),
                  at(3n, categorized("t1",1,"y","dev-b","2026-06-01T10:00:00Z"))]);
  expect(a.txns.get("t1")!.category).toBe("y");   // dev-b > dev-a
});

test("supersede keeps exactly one live transaction per ingest id", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", { amount_minor: "25000" })),
    at(2n, superseded("i1", "t2", { amount_minor: "25900" })),
  ]);
  expect(s.liveByIngestID.get("i1")).toBe("t2");
  expect([...s.txns.values()].filter(t => !t.superseded_by)).toHaveLength(1);
  expect(s.txns.get("t2")!.amount_minor).toBe(25900n);
});

test("a split whose parts do not sum to the parent is refused and recorded", () => {
  const s = fold([at(1n, ingested("i1","t1",{amount_minor:"1000"})),
                  at(2n, split("t1", 1, [["a","600"],["b","300"]]))]);
  expect(s.txns.get("t1")!.splits).toHaveLength(0);
  expect(s.anomalies.map(a => a.kind)).toContain("split_sum");
});

test("a fingerprint collision becomes a review notice, never a discard", () => {
  const same = { last4: "3701", amount_minor: "25000", direction: "debit",
                 merchant_raw: "CARREFOUR", posted_at: "2026-06-05T09:00:00Z" };
  const s = fold([at(1n, ingested("i1","t1", same)),
                  at(2n, ingested("i2","t2", {...same, posted_at: "2026-06-05T17:00:00Z"}))]);
  expect(s.txns.size).toBe(2);                       // both live, nothing dropped
  expect(s.txns.get("t2")!.possible_duplicate_of).toBe("t1");
  expect(s.anomalies.map(a => a.kind)).toContain("possible_duplicate");
});

test("a superseded transaction stops matching fingerprints", () => {
  // t1 superseded by t2 with identical fields must NOT flag t2 as its own duplicate
});

test("the latest writer_checkpoint replaces the earlier one", () => { /* ... */ });

test("fold is prefix-monotone: chunked folding equals a single fold", () => {
  const ops = sampleOps();                 // ~200 deterministic ops
  const whole = fold(ops);
  let chunked = emptyState();
  for (const chunk of chunksOf(ops, 7)) chunked = fold(chunk, chunked);
  expect(serialize(chunked)).toEqual(serialize(whole));
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd client && bun test src/replay/replay.test.ts`
Expected: FAIL — cannot resolve `./replay`.

- [ ] **Step 3: Implement `state.ts` and `replay.ts`** to the rules above.

- [ ] **Step 4: Run the tests**

Run: `cd client && bun test src/replay/`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/replay
git commit -m "feat(v2): op-log replay with causality, fork resolution, ingest-id supersede and duplicate notices"
```

---

### Task 12: FX — BigInt conversion, positional snapshots, prefix-monotone proof

**Files:**
- Create: `client/src/replay/fx.ts`, `client/src/replay/fx.test.ts`
- Create: `conformance/fx/*.json` (at least 10 cases)
- Modify: `client/src/replay/replay.ts` (call the FX hooks)

**Interfaces:**
- Consumes: Task 11's `State`.
- Produces:
  - `export const HOME_IDENTITY_MICRO = 1_000_000n`
  - `export function convert(amountMinor: bigint, rateMicro: bigint): bigint` — `(amountMinor * rateMicro + 500_000n) / 1_000_000n`. **BigInt only**; `amountMinor` is always positive so BigInt's truncating division is half-up here, and that assumption is asserted in the function.
  - `export function onHomeCurrencySet(s: State, ccy: string, seq: bigint): void`
  - `export function onRateSet(s: State, ccy: string, micro: bigint, seq: bigint): void`
  - `export function onRateUnset(s: State, ccy: string, seq: bigint): void`
  - `export function freezeIfPossible(s: State, txnId: string, seq: bigint): void` — called by `applyOp` for every `txn_ingested` / `txn_superseded`.

**Algorithm (spec §3.7, implement exactly):**
- `s.rates: Map<ccy, bigint | null>` is the *head* rate.
- `home_currency_set(H)`: sets `s.homeCurrency = H`, inserts `H → 1_000_000n`, **and backfills** — every transaction already pending in `pendingByCurrency[H]` freezes at the identity rate right there. Without the backfill, a home-currency transaction ingested before the onboarding op stays null forever, which violates §3.7:133's "P is the smallest log position ≥ pos(T) at which a head rate exists". A second `home_currency_set` records `Anomaly{kind:"home_currency_reset"}` and is ignored (one-shot and immutable, §3.7:122).
- `rate_set(H, …)` **for the home currency itself** records `Anomaly{kind:"rate_set_for_home_currency"}` and is ignored. Applying it would silently re-denominate every subsequent home-currency snapshot — the exact re-denomination §3.7:122 says the beta does not solve — and it would do so invisibly, with no user-facing signal. The home currency carries no rate row by construction; an op claiming otherwise is an anomaly, not an instruction.
- `freezeIfPossible`: if `s.rates.get(t.currency)` is a non-null bigint → `t.amount_home_minor = convert(t.amount_minor, rate)` and remove from `pendingByCurrency`; else `t.amount_home_minor = null` and add to `pendingByCurrency[ccy]`.
- `onRateSet(ccy, micro)`: `s.rates.set(ccy, micro)`; then for every txn id in `pendingByCurrency[ccy]`, freeze at `micro` and clear the set. Transactions already frozen are **never** touched.
- `onRateUnset(ccy)`: `s.rates.set(ccy, null)`. Pending stays pending; frozen stays frozen.
- **Supersede never inherits.** `txn_superseded` creates a new transaction record whose snapshot is computed by `freezeIfPossible` at its own position — including the case where the fix changed the currency. It also **removes the superseded transaction from `pendingByCurrency`**: a superseded row is no longer a live transaction, and leaving it in the pending set makes a later `rate_set` freeze a snapshot onto a row nothing displays and every re-fold recomputes differently.
- `txn_edited` carrying `amount_home_minor` sets it verbatim (§3.7's "recompute at current rate" action carries the value, never a recompute instruction).

- [ ] **Step 1: Write the failing tests**

```ts
test("BigInt is required because the INTERMEDIATE product overflows a double", () => {
  const amount = 25_000_000_000n, rate = 3_672_500n;
  // The hazard is amount*rate ≈ 9.18e16, not the 9.18e10 result.
  expect(Number(amount * rate)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  expect(convert(amount, rate)).toBe(91_812_500_000n);
  // and the naive float path is measurably wrong on the intermediate:
  expect(Number(amount) * Number(rate)).not.toBe(Number(amount * rate));
});

test("half-up rounding matches Go's ConvertToAEDFils", () => {
  expect(convert(1n, 1_500_000n)).toBe(2n);      // 1.5 -> 2
  expect(convert(1n, 1_499_999n)).toBe(1n);
});

test("a transaction with no rate stays visible with a null snapshot", () => {
  const s = fold([at(1n, homeCurrency("AED")), at(2n, ingested("i1","t1",{currency:"USD"}))]);
  expect(s.txns.get("t1")!.amount_home_minor).toBeNull();
});

test("home_currency_set backfills home-currency transactions ingested before it", () => {
  const s = fold([
    at(1n, ingested("i1","t1",{currency:"AED",amount_minor:"10000"})),
    at(2n, homeCurrency("AED")),
  ]);
  expect(s.txns.get("t1")!.amount_home_minor).toBe(10000n);
});

test("a rate_set for the home currency is an anomaly, not a re-denomination", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("AED","2000000")),
    at(3n, ingested("i1","t1",{currency:"AED",amount_minor:"10000"})),
  ]);
  expect(s.txns.get("t1")!.amount_home_minor).toBe(10000n);   // identity, unchanged
  expect(s.anomalies.map(a => a.kind)).toContain("rate_set_for_home_currency");
});

test("a later rate_set backfills only the still-null transactions", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1","t1",{currency:"USD",amount_minor:"10000"})),
    at(3n, rateSet("USD","3672500")),
    at(4n, ingested("i2","t2",{currency:"USD",amount_minor:"10000"})),
    at(5n, rateSet("USD","4000000")),
  ]);
  expect(s.txns.get("t1")!.amount_home_minor).toBe(367250n);   // frozen at seq 3
  expect(s.txns.get("t2")!.amount_home_minor).toBe(367250n);   // frozen at seq 4
});

test("rate_unset leaves earlier freezes alone and makes later transactions pending", () => {
  const s = fold([
    at(1n, homeCurrency("AED")), at(2n, rateSet("USD","3672500")),
    at(3n, ingested("i1","t1",{currency:"USD",amount_minor:"10000"})),
    at(4n, rateUnset("USD")),
    at(5n, ingested("i2","t2",{currency:"USD",amount_minor:"10000"})),
  ]);
  expect(s.txns.get("t1")!.amount_home_minor).toBe(367250n);
  expect(s.txns.get("t2")!.amount_home_minor).toBeNull();
});

test("a supersede recomputes at its own position and never inherits", () => {
  const s = fold([
    at(1n, homeCurrency("AED")), at(2n, rateSet("USD","3672500")),
    at(3n, ingested("i1","t1",{currency:"USD",amount_minor:"10000"})),
    at(4n, rateSet("USD","4000000")),
    // template fix: it was actually AED all along
    at(5n, superseded("i1","t2",{currency:"AED",amount_minor:"10000"})),
  ]);
  expect(s.txns.get("t1")!.amount_home_minor).toBe(367250n);
  expect(s.txns.get("t2")!.amount_home_minor).toBe(10000n);   // AED identity, not inherited
});

test("a superseded pending transaction is not backfilled by a later rate_set", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1","t1",{currency:"USD",amount_minor:"10000"})),   // pending
    at(3n, superseded("i1","t2",{currency:"AED",amount_minor:"10000"})), // now AED
    at(4n, rateSet("USD","3672500")),
  ]);
  expect(s.txns.get("t1")!.amount_home_minor).toBeNull();  // superseded, left alone
  expect(s.txns.get("t2")!.amount_home_minor).toBe(10000n);
});

test("snapshots are identical whether synced in one chunk or ten", () => {
  const ops = fxSampleOps();       // deterministic generator, 300 ops, 4 currencies
  const whole = fold(ops);
  let inc = emptyState();
  for (const c of chunksOf(ops, 10)) inc = fold(c, inc);
  for (const [id, t] of whole.txns) {
    expect(inc.txns.get(id)!.amount_home_minor).toBe(t.amount_home_minor);
  }
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd client && bun test src/replay/fx.test.ts`
Expected: FAIL — cannot resolve `./fx`.

- [ ] **Step 3: Implement `fx.ts`** and wire the hooks into `applyOp`.

- [ ] **Step 4: Run the tests**

Run: `cd client && bun test src/replay/`
Expected: PASS (19 tests across replay + fx).

- [ ] **Step 5: Export each FX test as a `conformance/fx/*.json` case** in the shape `{"name":..., "ops":[{"seq":1,"op":{...}}, ...], "expect":{"snapshots":{"t1":"367250","t2":null},"anomalies":["rate_set_for_home_currency"]}}`. Task 17's runner replays these; the Phase 3 migration tool's Go-side replay reuses them.

- [ ] **Step 6: Commit**

```bash
git add client/src/replay/fx.ts client/src/replay/fx.test.ts conformance/fx
git commit -m "feat(v2): positional FX snapshots with BigInt conversion and prefix-monotone proof"
```

---

### Task 13: The invariant checker

**Files:**
- Create: `client/src/invariants/check.ts`, `client/src/invariants/check.test.ts`

**Interfaces:**
- Consumes: Tasks 10–12.
- Produces:
  - `export interface Violation { id: string; severity: "hard_stop" | "notice"; detail: string }`
  - `export function checkAll(input: CheckInput): Violation[]`
  - `export interface CheckInput { stream: "hot" | "cold"; rows: SyncRow[]; hashList: HashRow[]; ops: {op: Op; seq: bigint}[]; state: State; roster: Writer[]; pinnedHeads: Map<ChainKey, {counter: bigint; hash: Uint8Array}>; cursorBefore: bigint }`

**The seventeen invariants (each has its own `id` and its own test):**

| id | severity | statement |
|---|---|---|
| `I1_stream_cursor_monotone` | hard_stop | within the pulled stream, `seq` values are strictly increasing and all `> cursorBefore`; the last equals the response's `next`. **Global `seq` contiguity is deliberately not asserted** — a hot-only pull legitimately sees 1, 3, 5, … because `seq` is one total order across both streams (Decision 13). Detecting a *dropped* row is I2's job, per spec §3.3:65. |
| `I2_writer_counters` | hard_stop | per `(writer_id, stream)`, `writer_counter` values are contiguous from the pinned head, no gaps, no duplicates. For a lazily-synced cold stream this is checked against the **hash list**, not the fetched bodies — which is what makes a 90-day rolling window legal instead of a permanent violation. |
| `I3_chain` | hard_stop | per `(writer_id, stream)`, `blob_hash[n] === SHA256(blob_hash[n-1] ‖ blob[n])`, genesis `ZERO_HASH`, continuing from the pinned head. Applies to every blob whose bytes are present. |
| `I3b_cold_hash_list` | hard_stop | the cold hash list is contiguous from the pinned cold head, and every cold body actually fetched hashes to its pinned entry (spec §3.3:72). A cold body swapped after pinning fires here. |
| `I4_aad` | hard_stop | each blob's embedded AAD equals `(user_id, stream, writer_id, writer_counter)` from its row |
| `I5_bucket` | hard_stop | `blob.length === size_bucket` and `size_bucket` is one of the **seven** buckets |
| `I6_schema_version` | hard_stop | no op has `v > SCHEMA_VERSION` (thrown earlier; the checker re-asserts it) |
| `I7_one_live_per_ingest` | hard_stop | `liveByIngestID` has exactly one live txn per ingest id, and every live txn is reachable from it |
| `I8_split_sum` | hard_stop | every applied split's parts sum exactly to its parent's `amount_minor` |
| `I9_version_contiguity` | hard_stop | every entity's applied versions are `1…head`, no gaps |
| `I10_fx_prefix_monotone` | hard_stop | re-folding all ops from position 0 reproduces every `amount_home_minor` in `state` |
| `I11_roster_checkpoint` | hard_stop / notice | **defined behavior when no checkpoint exists** (below) |
| `I12_money_shape` | hard_stop | every `amount_minor` is a positive BigInt; every `direction` ∈ {debit, credit}; no `number` appears in any money field |
| `I13_supersede_has_origin` | notice | every `txn_superseded` names an ingest id that a prior `txn_ingested` introduced |
| `I14_forks_surfaced` | notice | `state.forks.length` and `state.anomalies.length` are reported, never zero-suppressed — including every `possible_duplicate` |
| `I15_unreadable_set_aside` | notice | every blob that failed to decode appears in `state.unreadable` with its `(writer_id, stream, writer_counter, seq)`, and **no unreadable blob aborted the session** (spec §3.3:68: hard-stop is reserved for chain breaks and unknown-newer versions) |
| `I16_cold_carries_no_ops` | hard_stop | every fetched cold blob decodes as a `raw_body` record and never as an op list. This is what licenses a hot-only sync to be a *complete* materialization; if a cold blob ever carried state, every hot-only client would be silently wrong. |

**`I11_roster_checkpoint`, fully defined** — the first draft left the no-checkpoint case undefined, so the invariant passed vacuously and Task 38's "zero hard stops" was green with the whole feature absent:
- **No `writer_checkpoint` op anywhere in the synced prefix, and the roster has exactly one writer besides `ingest`:** emit `notice` `I11_roster_checkpoint` with detail `"no checkpoint yet (single writer)"`. A brand-new single-device user has nothing to cross-check.
- **No checkpoint, and the roster has two or more device writers:** emit **`hard_stop`**. Spec §3.4 makes checkpoints the mechanism that stops the server silently omitting a whole writer at bootstrap; with multiple devices enrolled and no checkpoint, that protection does not exist and sync must not proceed as if it did.
- **A checkpoint exists:** `hard_stop` if any device writer in the server roster is absent from the latest checkpoint, or if any checkpoint head `counter` exceeds the observed chain head for that `(writer_id, stream)`.

`checkAll` returns every violation found; the caller decides. `hard_stop` violations must abort a sync session; `notice` violations must be printed.

- [ ] **Step 1: Write the failing tests** — one per invariant, each constructing a deliberately-broken input and asserting the specific `id` appears, plus a clean-input test. Examples:

```ts
test("I1 does NOT fire on a legitimate hot-only pull with sparse global seqs", () => {
  const input = cleanInput({ stream: "hot", seqs: [1n, 3n, 5n, 7n] });
  expect(checkAll(input).map(v => v.id)).not.toContain("I1_stream_cursor_monotone");
});

test("I1 fires when the server reorders a stream", () => {
  const input = cleanInput({ stream: "hot", seqs: [1n, 5n, 3n] });
  expect(checkAll(input).map(v => v.id)).toContain("I1_stream_cursor_monotone");
});

test("I2 fires when the server skips a hot writer_counter", () => {
  const input = cleanInput();
  input.rows = input.rows.filter(r => r.writer_counter !== 3n);
  expect(checkAll(input).map(v => v.id)).toContain("I2_writer_counters");
});

test("I2 does not fire on a cold stream synced as a 90-day window", () => {
  // bodies for counters 40..50 only, but the hash list covers 1..50
  const input = coldWindowInput({ have: [40n, 50n], hashList: range(1n, 50n) });
  expect(checkAll(input).filter(v => v.severity === "hard_stop")).toHaveLength(0);
});

test("I3b fires when a cold body is swapped after its hash was pinned", () => { /* ... */ });

test("I11 hard-stops when two writers are enrolled and no checkpoint exists", () => {
  const input = cleanInput({ writers: ["dev-a", "dev-b"], checkpoints: [] });
  const v = checkAll(input).find(v => v.id === "I11_roster_checkpoint")!;
  expect(v.severity).toBe("hard_stop");
});

test("I11 is only a notice for a single-writer user with no checkpoint", () => {
  const input = cleanInput({ writers: ["dev-a"], checkpoints: [] });
  expect(checkAll(input).find(v => v.id === "I11_roster_checkpoint")!.severity).toBe("notice");
});

test("I11 fires when the server omits a writer from the roster", () => {
  const input = cleanInput();          // checkpoint lists dev-a and dev-b
  input.roster = input.roster.filter(w => w.writer_id !== "dev-b");
  expect(checkAll(input).map(v => v.id)).toContain("I11_roster_checkpoint");
});

test("I15: an undecodable blob is a notice and never a hard stop", () => {
  const input = cleanInput({ corruptBlobAt: 4n });
  const vs = checkAll(input);
  expect(vs.map(v => v.id)).toContain("I15_unreadable_set_aside");
  expect(vs.filter(v => v.severity === "hard_stop")).toHaveLength(0);
});

test("I16 fires when a cold blob decodes as an op list", () => { /* ... */ });

test("a clean pull produces no hard stops", () => {
  expect(checkAll(cleanInput()).filter(v => v.severity === "hard_stop")).toHaveLength(0);
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd client && bun test src/invariants/`
Expected: FAIL — cannot resolve `./check`.

- [ ] **Step 3: Implement `check.ts`.** Keep each invariant a small named function returning `Violation[]`, and `checkAll` a `flatMap` over them, so a new invariant is one function plus one test.

- [ ] **Step 4: Run the tests**

Run: `cd client && bun test src/invariants/`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/invariants
git commit -m "feat(v2): op-log invariant checker (17 invariants, the Phase 1 exit instrument)"
```

---

### Task 14: The headless client CLI

**Files:**
- Create: `client/src/net/client.ts`, `client/src/net/client.test.ts`
- Create: `client/src/store/store.ts` (JSON-file persistence of cursors, pinned heads, writer key)
- Create: `client/src/cli/main.ts`
- Create: `client/README.md`

**Interfaces:**
- Consumes: Tasks 9–13.
- Produces the CLI contract every later task and the exit test drive:

```
bun run cli login      --server <url> --idp apple|google --id-token <jwt>
bun run cli enroll     --writer <id> [--sign-with <other-writer-id>]
bun run cli pull       [--stream hot|cold] [--limit n]     # default: hot only
bun run cli pull-cold-hashes                               # refresh the pinned cold head
bun run cli replay                        # fold local ops, print a state summary
bun run cli check                         # run checkAll, exit 1 on any hard_stop
bun run cli emit       --type <op_type> --json '<payload>' [--entity txn:<id> --parent <n>]
bun run cli checkpoint                    # emit a writer_checkpoint over every known head
bun run cli push                          # batch pending ops into padded blobs and upload
bun run cli state      --json             # dump materialized state for assertions
```

- **Per-stream cursors.** Local state holds `cursors: { hot: bigint; cold: bigint }` and `pinnedHeads: Map<ChainKey, {counter, hash}>` keyed by `` `${writerId}|${stream}` ``. `pull --stream hot` advances only the hot cursor and only the `*|hot` heads. **`pull` with no `--stream` pulls hot only** — that is the normal client mode (spec §3.3:70 makes cold lazy), and the default must be the mode the product actually ships.
- `pull-cold-hashes` fetches `/api/v1/sync/hashes?stream=cold`, runs `verifyHashList`, and persists the pinned per-blob hashes. Any later `pull --stream cold` range is checked against them by `verifyFetchedRange` before a single body is used. This is the whole of spec §3.3:72 that Phase 1 owns; the *consumer* (client-side reprocessing) is Phase 2.
- `Client.pull()` verifies chains **before** any op is applied, persists the new pinned heads only after `checkAll` reports no `hard_stop`, and advances the cursor atomically with them. A blob that fails to decode is recorded in `state.unreadable` and the cursor still advances (spec §3.3:68).
- `Client.push()` batches pending ops into blobs, pads via the bucket ladder, sets `writer_counter`/`prev_hash`/`blob_hash` **against the `hot` chain head**, and uploads. **The ingest writer never batches** (server-side); the client always may.
- `Client.checkpoint()` emits a `writer_checkpoint` op whose `heads` array covers every **`(roster writer × stream)`** pair — *not* every pair this client has observed — sorted, using `counter: "0"` and the 64-zero genesis hash for a chain that holds no blobs (`CHECKPOINT_NAMES_THE_ROSTER`; see Task 14 step 4 and `client/src/invariants/check.ts`). A checkpoint built from observed chains can never name an enrolled writer that has authored nothing, which makes `I11_roster_checkpoint` unsatisfiable in the exit test's own configuration. `push` emits one automatically whenever the writer roster it sees has changed since the last checkpoint it wrote — so a two-device user gets checkpoints without anyone remembering to ask, which is the only way spec §5's "both chains + checkpoints" is actually true of a running system.
  - **A zero entry is a gap in coverage, not coverage.** `I11` cannot distinguish "that chain is genuinely empty" from "I have never synced that chain", so a client whose checkpoint fills unobserved pairs from its own pinned heads provides no trusted head for those chains — most importantly `ingest|cold`, which a hot-only client never pulls and where the raw email bodies live. `checkAll` reports each such chain as a notice once the reader has evidence the chain is non-empty; it cannot be a hard stop, because a checkpoint older than the rows reaches the same state on a correct log (Task 38 checkpoints at step 4 and delivers mail at step 5). Closing it properly means a device that has synced a chain re-checkpointing it, which is Phase 2 work.
- Local state lives in `--state-dir` (default `./.ledger-client`), one JSON file per user; it is a scratch artifact, never committed.

- [ ] **Step 1: Write the failing test**

```ts
test("pull refuses to advance the cursor when a hard-stop invariant fires", async () => {
  const srv = fakeServer({ dropWriterCounter: 3n });   // a Bun.serve fixture
  const c = new Client({ server: srv.url, state: memState() });
  await expect(c.pull()).rejects.toThrow(/I2_writer_counters/);
  expect(c.cursor("hot")).toBe(0n);                    // unchanged
});

test("a hot-only pull succeeds against a log that interleaves cold blobs", async () => {
  const srv = fakeServer({ interleaveCold: true });
  const c = new Client({ server: srv.url, state: memState() });
  await c.pull();                                      // no --stream: hot only
  expect(c.cursor("hot")).toBeGreaterThan(0n);
  expect(c.cursor("cold")).toBe(0n);
  expect(c.check().filter(v => v.severity === "hard_stop")).toHaveLength(0);
});

test("push assigns contiguous writer counters and a valid chain", async () => {
  const srv = fakeServer({});
  const c = new Client({ server: srv.url, state: memState(), writerId: "dev-a" });
  await c.emit(rateSetOp("USD", "3672500"));
  await c.emit(rateSetOp("EUR", "3900000"));
  await c.push();
  expect(srv.uploaded.map(b => b.writer_counter)).toEqual([1n]);   // one batched blob
  expect(srv.uploaded[0].prev_hash).toEqual(ZERO_HASH);
});

test("an undecodable blob is set aside and the cursor still advances", async () => {
  const srv = fakeServer({ corruptAt: 2n });
  const c = new Client({ server: srv.url, state: memState() });
  await c.pull();
  expect(c.state().unreadable).toHaveLength(1);
  expect(c.cursor("hot")).toBeGreaterThan(0n);
});

test("push emits a checkpoint when the roster changes", async () => {
  // enroll dev-b on the server between two pushes -> the second push carries a
  // writer_checkpoint op covering every (writer, stream) head
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd client && bun test src/net/`
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 3: Implement `client.ts`, `store.ts` and `main.ts`.**

- [ ] **Step 4: Round-trip against the real server**

```bash
# terminal 1
LEDGER_MAIL_DOMAIN=example.test LEDGER_PG_DSN="$TEST_DSN" LEDGER_HTTP_LISTEN=127.0.0.1:8091 \
  go run ./cmd/ledgerd serve --dev-auth
# terminal 2
cd client && bun run cli login --server http://127.0.0.1:8091 --idp apple --id-token "dev:alice"
bun run cli enroll --writer dev-a
bun run cli emit --type rate_set --json '{"currency":"USD","rate_micro":"3672500"}'
bun run cli push && bun run cli pull && bun run cli checkpoint && bun run cli push && bun run cli check
```
Expected: `check` prints `invariants: 17 checked, 0 hard stops, 2 notices` before the checkpoint lands — `I11_roster_checkpoint`'s single-writer case **and** `I14_forks_surfaced`, which reports unconditionally — and `0 hard stops, 1 notice` after, `I14` alone. Exits 0 throughout.

**`I14` is not zero-suppressed and must not be made so.** "Forks and anomalies are surfaced, never zero-suppressed" is a property of the *report*, not a predicate over the state: an operator who only sees the line when it is non-empty cannot tell a clean sync from a broken reporting path. Task 13 implements it literally, so `0 forks, 0 anomalies` is a notice like any other. The first draft of this line expected one notice and zero after, which is only reachable by silencing the invariant.

**`checkpoint` must name the ROSTER, not the observed chains (`CHECKPOINT_NAMES_THE_ROSTER`).** `Client.checkpoint()` emits one head for every (roster writer × stream) pair, using `counter: "0"` and the 64-zero genesis hash for a chain that holds no blobs. A checkpoint built only from *observed* heads can never name an enrolled writer that has authored nothing — it has no head to observe — so `dev-b` at step 2 below would hard-stop `I11` on every sync forever, with no checkpoint any device could emit able to clear it. A zero entry asserts nothing false, because `0 > observed` is never true.

Add two test-only server flags in this task, both refused unless `LEDGER_HTTP_LISTEN` is a loopback address, and both documented in `config.v2.example.toml` as test-only:
- `--dev-auth` — accepts `dev:<subject>` as an id token.
- `--dns-fixtures <path>` — loads a recorded `dns.json` (Task 2) and serves it as the DKIM/ARC `lookupTXT` for the whole process, so the exit test can drive real signed corpus mail through a real server with no DNS. Without it, Task 38 step 4 has no way to make DKIM verification deterministic.

- [ ] **Step 5: Write `client/README.md`** — the nine commands, the state directory, the per-stream cursor model, and a one-paragraph statement that this is Phase 1's exit-test instrument, not a product.

- [ ] **Step 6: Commit**

```bash
git add client cmd/ledgerd
git commit -m "feat(v2): headless sync client - per-stream pull, replay, check, emit, checkpoint, push"
```
---

## Part D — Normalizer contract and templates

### Task 15: Normalizer v1 (Go), including the forwarded-message unwrap stage

**Files:**
- Create: `internal/v2/norm/norm.go`, `internal/v2/norm/norm_test.go`
- Create: `internal/v2/norm/unwrap.go`, `internal/v2/norm/unwrap_test.go`
- Create: `internal/v2/norm/conformance_test.go`
- Create: `conformance/normalizer/*.json`
- Create: `docs/superpowers/specs/v2-normalizer-v1.md` (the written algorithm)

**Interfaces:**
- Consumes: `github.com/emersion/go-message` (existing dependency).
- Produces:
  - `const CurrentVersion = 1`
  - `func Normalize(version int, raw []byte, receivedAt time.Time) (Result, error)`
  - ```go
    type Result struct {
        Text        string    // the normalized, unwrapped body templates match against
        PartUsed    string    // "html" | "plain" | "raw"
        Charset     string
        Subject     string    // EFFECTIVE subject — inner when forwarded (Decision 14)
        From        string    // EFFECTIVE From — inner when forwarded. CONTENT ONLY, never trust.
        Forwarded   bool
        EmailDate   time.Time // inner forwarded Date when parseable, else receivedAt
        DateSource  string    // "forward_header" | "received"
    }
    ```
  - `func Versions() []int`

**The v1 algorithm (this document IS the contract — copy it verbatim into `docs/superpowers/specs/v2-normalizer-v1.md`):**

1. Parse the message with `go-message`. On an unrecoverable parse error, fall back to `PartUsed = "raw"`: everything after the first `\r\n\r\n` (or `\n\n`), treated as `text/plain`, no charset conversion. **This fallback is new in v2** — v1's `BodyText` returns an error and the message becomes `unparsed`. It exists because §2's drop policy makes "we could not parse the MIME, so we recorded nothing about the body" unacceptable, and it is one of the two deliberate divergences Task 16's gate expects.
2. Walk the MIME tree depth-first, descending every `multipart/*`. Record the **first** `text/html` leaf and the **first** `text/plain` leaf. Decode each leaf's `Content-Transfer-Encoding` (base64, quoted-printable) and convert its charset to UTF-8. An undecodable leaf is skipped, not fatal.
3. **Validate UTF-8 and substitute.** After charset decoding — and unconditionally in the `raw` fallback — replace every invalid byte sequence using the **WHATWG UTF-8 decoder error handling** (one U+FFFD per maximal subpart, *not* Go's `strings.ToValidUTF8`, which emits one U+FFFD per contiguous invalid run). This is what `TextDecoder` does in the TypeScript executor; without it the two executors disagree on every message with a broken charset declaration, and the disagreement is invisible until a real one arrives. ~20 lines; test it with the fixtures from step 6.
4. Choose the HTML leaf if non-empty, else the plain leaf, else fail with `ErrNoTextPart`.
5. If the HTML leaf was chosen, strip in this exact order:
   a. `(?is)<script[^>]*>.*?</script>` → `" "`
   b. `(?is)<style[^>]*>.*?</style>` → `" "`
   c. literal `<br>`, `<br/>`, `</p>`, `</tr>`, `</div>` → `"\n"` (case-sensitive, exactly these five)
   d. `(?s)<[^>]+>` → `"\n"`
6. Decode exactly these six entities, no others: `&nbsp;`→U+0020, `&amp;`→`&`, `&lt;`→`<`, `&gt;`→`>`, `&quot;`→`"`, `&#39;`→`'`.
7. Collapse every run of characters in `{U+0009, U+0020, U+00A0}` to a single U+0020.
8. Split on `"\n"`. Trim each line of the **explicit set** `{U+0009, U+000A, U+000B, U+000C, U+000D, U+0020, U+00A0, U+FEFF}` — **not** `strings.TrimSpace` and **not** JavaScript's `String.trim()`, because those two sets differ (Go trims U+0085, U+2000–U+200A and U+202F; JS trims U+2000–U+200A and U+FEFF). This explicit set is what makes the Go and TypeScript normalizers byte-identical, and it is the other deliberate divergence from v1 that Task 16's gate expects.
9. Drop empty lines. Join the rest with `"\n"`.
10. **Unwrap an inline forward** (`unwrap.go`, a direct port of `internal/parse/forward.go`, operating on the joined text exactly as v1 does). This stage is **new to the normalizer contract and was missing entirely from the first draft of this plan**, which meant Task 21's gate would have compared v1-*with*-`Unwrap` against v2-*without* it against a zero-mismatch bar.
    - Find the first line matching `(?i)^ *(begin forwarded message:|-+ *forwarded message *-+) *$` (Apple Mail and Gmail).
    - No marker → `Forwarded = false`; `Subject` is the message's own `Subject:` with a leading `Fwd:`/`FW:`/`Fw:` stripped; `From` is the message's own `From:`; `Text` is unchanged.
    - Marker found → scan forward for `from|to|subject|date|reply-to|cc|sent` header lines, tolerating Apple Mail's value-on-the-next-line layout and Gmail's value-on-the-same-line layout, stopping at the first non-header line after at least one header was seen. `Subject`/`From` take the recovered inner values when non-empty; `Text` becomes the remainder, trimmed with the **explicit set from step 8** (not `strings.TrimSpace` — this is where v1's TrimSpace divergence also shows up).
    - `EmailDate`: parse the recovered inner `Date:` value with the four closed layouts `"Jan 2, 2006 at 3:04 PM"`, `"Mon, Jan 2, 2006 at 3:04 PM"`, `"2 January 2006 at 15:04:05"`, `"2 January 2006 at 15:04"`, first replacing U+202F and U+00A0 with U+0020 (Apple Mail inserts a narrow no-break space before AM/PM on recent OSes) and retrying once with the final space-delimited token removed (a trailing zone token such as `GMT+4`; forward dates are treated as naive). On success `DateSource = "forward_header"`; otherwise `EmailDate = receivedAt` and `DateSource = "received"`.

**Decision 14, restated where the implementer will read it.** `Result.Subject` and `Result.EmailDate` are what `Match.SubjectContains`, `"source":"subject"` and `"date_from":"email"` consume. Both are the **inner** values for a forwarded message. This is not cosmetic:
- `enbd_alert.go` reads the account last4 **only** from the subject (`account ending with 3701`; the body's account number is masked), so an outer-envelope subject silently drops `last4` on every forwarded ENBD alert.
- A forward that arrives days after the purchase would otherwise date the transaction to the forward.

**`Result.From` is content, not trust.** It is derived from attacker-authored body text — anyone can write `Begin forwarded message:` / `From: alerts@dib.ae` into an email. It exists for diagnostics and template authorship only. The trusted-lane gate (Task 29) and `Match.SenderDomain` (Task 19) read the **cryptographically verified signing domain** from Tasks 25–26 and nothing else. A reviewer should treat any use of `Result.From` in a trust decision as a defect.

- [ ] **Step 1: Write the failing tests**

```go
func TestNormalizeCollapsesNBSPAndTrimsExplicitSet(t *testing.T) {
	raw := []byte("Content-Type: text/html; charset=utf-8\r\n\r\n" +
		"<div>  AED 100.00 </div><div>﻿ x </div>")
	got, err := Normalize(1, raw, time.Now())
	if err != nil { t.Fatal(err) }
	if got.Text != "AED 100.00\nx" { t.Fatalf("got %q", got.Text) }
}

func TestNormalizeDecodesQuotedPrintableAndCharset(t *testing.T) { /* windows-1256 Arabic + QP */ }
func TestNormalizeFallsBackToRawOnBrokenMIME(t *testing.T)       { /* PartUsed == "raw" */ }
func TestNormalizeUnknownVersionIsAnError(t *testing.T)          { /* Normalize(2, ...) -> error */ }

func TestInvalidUTF8BecomesWHATWGReplacementChars(t *testing.T) {
	// a windows-1256 body mislabelled utf-8: assert the exact U+FFFD placement,
	// one per maximal subpart. This is the byte-for-byte contract with TextDecoder.
}

func TestUnwrapRecoversInnerSubjectFromAppleMailForward(t *testing.T) {
	got, _ := Normalize(1, mustFixture(t, "apple-forward-enbd-alert.eml"), time.Now())
	if !got.Forwarded { t.Fatal("expected a detected forward") }
	if !strings.Contains(got.Subject, "account ending with") {
		t.Fatalf("inner subject lost: %q — enbd_alert reads last4 from here", got.Subject)
	}
}

func TestUnwrapRecoversInnerSubjectFromGmailForward(t *testing.T)  { /* same-line header layout */ }
func TestUnwrapUsesTheInnerDateNotTheArrivalTime(t *testing.T) {
	recv := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	got, _ := Normalize(1, mustFixture(t, "gmail-forward-1.eml"), recv)
	if got.DateSource != "forward_header" { t.Fatalf("DateSource = %q", got.DateSource) }
	if !got.EmailDate.Before(recv) { t.Fatal("a late forward must date to the original message") }
}
func TestUnwrapHandlesNarrowNoBreakSpaceBeforeAMPM(t *testing.T)   { /* U+202F */ }
func TestNonForwardStripsOnlyTheFwdPrefix(t *testing.T)            { /* "Fwd: x" -> "x", body untouched */ }
func TestUnwrapNeverAffectsTrust(t *testing.T) {
	// a hostile body containing "Begin forwarded message:\nFrom: alerts@dib.ae"
	// changes Result.From and NOTHING else the pipeline uses for trust; assert
	// Result has no field a trust decision reads.
}
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/norm/ -v`
Expected: FAIL — `undefined: Normalize`.

- [ ] **Step 3: Implement `norm.go` and `unwrap.go`** per the algorithm above.

- [ ] **Step 4: Export conformance fixtures**

Add `TestWriteNormalizerFixtures` that writes ~34 `conformance/normalizer/*.json` cases in the shape:

```json
{"name":"...", "normalizer_version":1, "received_at":"2026-06-05T09:00:00Z",
 "raw_base64":"...", "expect_text_base64":"...", "expect_part":"html",
 "expect_subject_base64":"...", "expect_forwarded":true,
 "expect_email_date":"2026-06-05T09:00:00Z", "expect_date_source":"forward_header"}
```

**`expect_text` and `expect_subject` are base64, not JSON strings.** A JSON string cannot represent the normalizer's output when charset resolution fails and the raw fallback yields bytes that are not valid UTF-8 — the fixture writer would silently substitute, the TypeScript reader would substitute differently, and the conformance suite would compare two different corrections to the same corruption. Base64 makes the fixture the exact bytes.

Include, deliberately: 3 real DIB Arabic messages, 2 real ENBD messages, 1 real ENBD alert, 1 Apple-Mail forward of an ENBD alert, 1 Gmail forward with a full ARC set, 1 quoted-printable-wrapped body, 1 windows-1256 body, 1 body mislabelled `utf-8` that is actually windows-1256 (the U+FFFD case), 1 broken-MIME body (the `raw` fallback), 1 body containing U+00A0 and U+FEFF, 1 body with nested `multipart/related` inside `multipart/alternative`, 1 base64 part with a continuation indent (spaces inside the base64 — see Task 17). Redact nothing — these are the operator's own messages and stay in this private repo.

```bash
S=/tmp/claude-0/-root-Coding-ledger/bcc8cb5e-1dd4-451e-94e9-031572dd88c7/scratchpad
LEDGER_CORPUS_DB=$S/corpus.db go test ./internal/v2/norm/ -run TestWriteNormalizerFixtures -v \
  && ls conformance/normalizer | wc -l
```
Expected: PASS, and at least 30 files.

- [ ] **Step 5: Add the fixture-driven test** `TestNormalizerConformance` reading every `conformance/normalizer/*.json` and asserting `Normalize` reproduces `expect_text_base64`, `expect_subject_base64`, `expect_part`, `expect_forwarded` and `expect_date_source` exactly.

Run: `go test ./internal/v2/norm/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/v2/norm conformance/normalizer docs/superpowers/specs/v2-normalizer-v1.md
git commit -m "feat(v2): versioned normalizer v1 with forwarded-message unwrap and conformance fixtures"
```

---

### Task 16: The full-corpus normalizer-equivalence gate (HARD GATE)

> Split out of Task 15 because it is a gate, not an implementation step: it runs over 6,994 messages, it will fail on the first attempt, and the work is *adjudicating differences* rather than writing code. Giving it its own task means its failure does not look like Task 15 being incomplete.

**Files:**
- Create: `internal/v2/norm/corpus_test.go`
- Modify: `docs/superpowers/specs/v2-normalizer-v1.md` (the divergence record)

**Interfaces:**
- Consumes: `internal/v2/corpus` (Task 2), `internal/v2/norm` (Task 15), v1's `internal/parse` (read-only reference).
- Produces: a recorded pass, and the divergence list that goes into the normalizer spec.

**What is compared.** For every `ingest_log` row in `$S/corpus.db`:
- v1 side: `parse.BodyText(raw)` → `parse.Unwrap(row.FromAddr, row.Subject, text)` → `(from, subject, fwdDate, body)`.
- v2 side: `norm.Normalize(1, raw, row.ReceivedAt)` → `Result`.
- Compare `body` vs `Result.Text`, `subject` vs `Result.Subject`, and `parse.ParseForwardDate(fwdDate)` vs `Result.EmailDate` where v1 parsed one.

**The bar is not "0 differences" — that was unachievable by construction, and stating it that way would have forced the implementer to either fake the number or quietly weaken the comparison.** Two divergences are *designed in* (Task 15 steps 1 and 8) and are expected:

| class | cause | how the test classifies it |
|---|---|---|
| `D1_trim_set` | v2 trims the explicit set; v1 uses `strings.TrimSpace`, which additionally trims U+0085, U+2000–U+200A and U+202F, and does not trim U+FEFF | re-run the comparison with v1's trim substituted for v2's; if the two then agree, it is `D1` |
| `D2_raw_fallback` | v2 falls back to the raw body on a MIME parse error; v1 returns an error and the row is `unparsed` | v1 errored **and** `Result.PartUsed == "raw"` |

**Pass criterion:** `other == 0`. Every `D1` and `D2` is counted and reported; **any difference that is neither is a failure**, and the response is to fix `norm.go` or — if v2 is right and v1 was wrong — to record the divergence in `docs/superpowers/specs/v2-normalizer-v1.md` with an explicit justification before proceeding. **Fix the definitions, not the comparison.** If the classification rules start growing new cases to absorb failures, that is the signal that the normalizer is wrong, not that the gate is too strict.

- [ ] **Step 1: Ensure the corpus copy exists**

```bash
S=/tmp/claude-0/-root-Coding-ledger/bcc8cb5e-1dd4-451e-94e9-031572dd88c7/scratchpad
ls -l "$S/corpus.db" || sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup '$S/corpus.db'"
```

- [ ] **Step 2: Write `corpus_test.go`**, skipped unless `LEDGER_CORPUS_DB` is set. It streams rows via `internal/v2/corpus`, gunzips `raw_body` when it starts with `1f 8b`, runs both sides, classifies each difference, and logs:

```
corpus: 6994 messages, D1_trim_set: N, D2_raw_fallback: M, other: 0
```

`t.Fatalf` on `other != 0`, printing the first 20 offending `ingest_log.id` values with a unified diff of the two texts.

- [ ] **Step 3: Run it and watch it fail**

```bash
LEDGER_CORPUS_DB=$S/corpus.db go test ./internal/v2/norm/ -run TestCorpusEquivalence -v -timeout 20m
```
Expected on the first run: FAIL with a non-zero `other` and a diff log. **6,994 is the number to expect** — an earlier count of 6,996 included WAL rows the `.backup` copy does not have. If the count differs, the live instance has ingested more mail since Task 2; use the number the copy reports and say so in the record.

- [ ] **Step 4: Iterate to green, then record**

Append to `docs/superpowers/specs/v2-normalizer-v1.md`: the corpus size, the date the gate was run, the `D1`/`D2` counts, and every additional divergence accepted with its justification. Phase 1 does not ship without this section showing a pass.

- [ ] **Step 5: Commit**

```bash
git add internal/v2/norm/corpus_test.go docs/superpowers/specs/v2-normalizer-v1.md
git commit -m "test(v2): full-corpus normalizer equivalence gate against v1 BodyText+Unwrap"
```

---

### Task 17: TypeScript normalizer and the cross-executor conformance runner

> **Size this honestly — it is the largest single-file task in the plan.** `internal/parse/body.go` is 109 first-party lines, but the behavior it inherits is not: it transitively pulls in
> - **`go-message/charset`'s registry**, which is a four-step resolution — `ianaindex.MIME.Encoding(label)`, then a retry with a `"cs"` prefix, then `htmlindex.Get(label)` (the WHATWG table), plus two hand-added quirks (`ansi_x3.110-1983` → ISO-8859-1, `x-utf_8j` → UTF-8) with no JavaScript analogue;
> - **Go's `mime/quotedprintable`**, which is deliberately lenient about malformed `=XX` sequences and bare `=` at end of line in ways a strict decoder is not;
> - **`go-message`'s `whitespaceReplacingReader`** (`encoding.go:70-77`), which rewrites spaces and tabs to LF *inside base64 bodies before decoding*, so a base64 part with a continuation indent decodes in Go and fails in a naive JS decoder.
>
> Budget two sessions. Do not start by writing `normalize()`; start by writing the failing conformance test and reading the three behaviors above.

**Files:**
- Create: `client/src/norm/norm.ts`, `client/src/norm/mime.ts`, `client/src/norm/charset.ts`, `client/src/norm/unwrap.ts`
- Create: `client/src/norm/norm.test.ts`, `client/src/norm/conformance.test.ts`
- Create: `scripts/v2-check.sh`

**Interfaces:**
- Consumes: `conformance/normalizer/*.json` (Task 15).
- Produces:
  - `export const CURRENT_VERSION = 1`
  - `export function normalize(version: number, raw: Uint8Array, receivedAt: string): { text: string; partUsed: "html"|"plain"|"raw"; charset: string; subject: string; from: string; forwarded: boolean; emailDate: string; dateSource: "forward_header"|"received" }`
  - `scripts/v2-check.sh` — the pre-merge gate. This repo has no CI service, so "disagreement fails the build" means **this script is the build** and every task from here on ends by running it.

`scripts/v2-check.sh` boots **one** Postgres cluster and exports `LEDGER_TEST_POSTGRES_URL` for the whole run (Decision 2) — roughly twenty v2 packages each running their own `initdb` is minutes of wall clock for no isolation benefit, since `pgtest.New` already gives every test its own database:

```bash
#!/usr/bin/env bash
set -euo pipefail
cleanup() { [[ -n "${PG_STOP:-}" ]] && $PG_STOP || true; }
trap cleanup EXIT
eval "$(go run ./internal/v2/pgtest/cmd/boot)"   # prints LEDGER_TEST_POSTGRES_URL= and PG_STOP=
export LEDGER_TEST_POSTGRES_URL
go vet ./internal/v2/... ./cmd/ledgerd
go test ./internal/v2/... ./cmd/ledgerd
( cd client && bun run typecheck && bun test )
echo "v2-check: OK (go + client + conformance)"
```

**MIME parsing in TypeScript:** implement the subset the contract needs (boundary splitting, `Content-Type`/`Content-Transfer-Encoding` headers, RFC 2047 encoded-word decoding for `Subject:`, base64 and quoted-printable) in `mime.ts` — do **not** add an npm MIME library, because the point is that the two implementations agree on *this* contract, not on some library's interpretation.

**Charset conversion** uses the platform `TextDecoder` (Bun ships full ICU) behind an explicit label map in `charset.ts` covering exactly the labels the corpus contains, plus the `"cs"`-prefix retry and the two go-message quirks. Derive the label set empirically rather than guessing:

```bash
S=/tmp/claude-0/-root-Coding-ledger/bcc8cb5e-1dd4-451e-94e9-031572dd88c7/scratchpad
LEDGER_CORPUS_DB=$S/corpus.db go run ./internal/v2/corpus/cmd/extract-fixtures --charset-histogram
```
and map every label it prints. A label the map does not know is an **error**, never a silent fallback to UTF-8 — a silent fallback is how a windows-1256 Arabic body becomes 400 U+FFFDs that still "parse".

- [ ] **Step 1: Write the failing conformance test**

```ts
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { normalize } from "./norm";

const dir = `${import.meta.dir}/../../../conformance/normalizer`;
for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
  const c = await Bun.file(`${dir}/${f}`).json();
  test(`normalizer conformance: ${c.name}`, () => {
    const got = normalize(c.normalizer_version, Buffer.from(c.raw_base64, "base64"), c.received_at);
    expect(Buffer.from(got.text, "utf8").toString("base64")).toBe(c.expect_text_base64);
    expect(Buffer.from(got.subject, "utf8").toString("base64")).toBe(c.expect_subject_base64);
    expect(got.partUsed).toBe(c.expect_part);
    expect(got.forwarded).toBe(c.expect_forwarded);
    expect(got.dateSource).toBe(c.expect_date_source);
    if (c.expect_date_source === "forward_header") expect(got.emailDate).toBe(c.expect_email_date);
  });
}
```

- [ ] **Step 2: Run and watch fail**

Run: `cd client && bun test src/norm/`
Expected: FAIL — cannot resolve `./norm`.

- [ ] **Step 3: Implement `mime.ts`, `charset.ts`, `unwrap.ts` and `norm.ts`** exactly per `docs/superpowers/specs/v2-normalizer-v1.md`. The four divergence traps, each of which has a fixture:
  1. Use the explicit trim set, never `String.prototype.trim`.
  2. Never use `\s` in any regex here.
  3. Strip whitespace from base64 payloads before decoding (`whitespaceReplacingReader`).
  4. Let `TextDecoder`'s U+FFFD substitution be the reference, and make Go match it (Task 15 step 3) rather than the other way around.

- [ ] **Step 4: Run the tests**

Run: `cd client && bun test src/norm/`
Expected: PASS — all ~34 fixtures.

- [ ] **Step 5: Write `scripts/v2-check.sh`, make it executable, run it**

Run: `bash scripts/v2-check.sh`
Expected: exit 0, final line `v2-check: OK (go + client + conformance)`.

- [ ] **Step 6: Commit**

```bash
git add client/src/norm scripts/v2-check.sh internal/v2/pgtest
git commit -m "feat(v2): TypeScript normalizer and the dual-executor conformance gate"
```

---

### Task 18: Template definition format and the RE2-safe-subset validator

**Files:**
- Create: `internal/v2/tmpl/def.go`, `internal/v2/tmpl/def_test.go`
- Create: `internal/v2/tmpl/dialect.go`, `internal/v2/tmpl/dialect_test.go`
- Create: `conformance/dialect/patterns.json`
- Create: `docs/superpowers/specs/v2-template-format.md`

**Interfaces:**
- Consumes: nothing.
- Produces:

```go
type Definition struct {
	ID                string    `json:"id"`
	Version           int       `json:"version"`
	Bank              string    `json:"bank"`
	NormalizerVersion int       `json:"normalizer_version"`
	Match             Match     `json:"match"`
	DefaultCurrency   string    `json:"default_currency"`
	DateFrom          string    `json:"date_from"`   // "body" | "email"
	Extract           []Extract `json:"extract"`
	Required          []string  `json:"required"`
}
type Match struct {
	SenderDomain    []string `json:"sender_domain"`              // VERIFIED signing-domain suffixes
	SubjectContains []string `json:"subject_contains,omitempty"`
	BodyContains    []string `json:"body_contains,omitempty"`
	BodyNotContains []string `json:"body_not_contains,omitempty"`
}
type Extract struct {
	Field    string            `json:"field"`     // amount|date|merchant|last4|direction|is_transfer
	Type     string            `json:"type"`      // amount|date|text|last4|const|flag
	Source   string            `json:"source"`    // body|subject
	Patterns []string          `json:"patterns,omitempty"`
	Flags    []string          `json:"flags,omitempty"`    // only {"i"} is permitted
	Layouts  []string          `json:"layouts,omitempty"`  // date only, closed enum, tried in order
	Value    string            `json:"value,omitempty"`    // const/flag only
	Override bool              `json:"override,omitempty"` // see below — used exactly once
	OnMatch  map[string]string `json:"on_match,omitempty"`
}

func ParseDefinition(b []byte) (Definition, error)
func (d Definition) Canonical() ([]byte, error)     // stable key order, for hashing
func ValidateDefinition(d Definition) []error
func ValidatePattern(p string, flags []string) []error
func ToJS(p string) string                          // (?P<n>...) -> (?<n>...)
```

`Canonical()` must use a `json.Encoder` with `SetEscapeHTML(false)` and explicitly sorted keys. Go's default marshaller escapes `<`, `>` and `&` as `<`, `>`, `&`, so a template whose merchant anchor contains `&` would hash differently in Go and in TypeScript — the exact class of silent cross-executor disagreement this format exists to prevent.

**Dialect rules (`ValidatePattern` rejects each with a distinct message):**

| Rejected | Reason |
|---|---|
| `\s` `\S` | Go RE2 `\s` is `[\t\n\f\r ]`; JS `\s` additionally includes U+00A0, U+FEFF and the Unicode space separators |
| `\b` `\B` | word-boundary semantics differ once non-ASCII is involved (this corpus is Arabic) |
| `(?i)` `(?m)` `(?s)` and any `(?flags)` group | JS has no inline flags; use the `flags` field |
| `(?=` `(?!` `(?<=` `(?<!` | lookaround is a backtracking construct and RE2 lacks it |
| `\1`–`\9` | backreferences: not in RE2, and unbounded cost in JS |
| `\p{...}` `\x{...}` `\u{...}` | unicode class/escape syntax differs between the engines |
| `\A` `\z` `\Z` | not in JS |
| a **bare `.`** (outside a character class, not `\.`) | Go's `.` excludes only U+000A; JS's `.` also excludes `\r`, U+2028 and U+2029. Write `[^\n]`, which is identical in both engines. `(.+)` appears in five of the six v1 seed anchors, so this rule is load-bearing, not theoretical. |
| `*`, `+` or `{n,}` applied directly after `)` | an **unbounded** quantifier on a group is the catastrophic-backtracking shape, and the inbound path is attacker-writable |
| any **unbounded** quantifier (`*`, `+`, `{n,}`) anywhere **inside** a quantified group | this is the `(a+)+` nesting that turns bounded work exponential |
| a `flags` entry other than `"i"` | `m` is banned because JS's `m` treats `\r`, U+2028 and U+2029 as line terminators for `^`/`$` and Go's does not; no v1 pattern uses `m`, so the ban is free |
| pattern length > 512 | bounded cost |
| more than 8 capture groups | bounded cost |
| the product of all `{n,m}` upper bounds along any nesting path > 64 | bounded match length |

**Explicitly allowed — and this is a correction, not an oversight.** `?` and `{n,m}` **may** be applied to a group. They are bounded: `(X)?` tries X at most once and `(X){n,m}` at most `m` times, so neither can backtrack catastrophically. The first draft banned "a quantifier applied directly after `)`" outright, which was self-contradictory — its own acceptance test required `المبلغ\n(?P<ccy>[A-Z]{3} )?(?P<amt>…)` to pass — and it propagated: `dib.go:21`, `enbd_alert.go:25`, `enbd_alert.go:26` and `fields.go:13` all use exactly that optional-currency-prefix shape, so Task 21's hard gate would have been unreachable. A blanket "no quantifier nested inside a quantified group" has the same defect (`(?P<ccy>[A-Z]{3} )?` nests `{3}` inside a `?`), which is why the rule above bans only **unbounded** quantifiers in that position.

Everything else is allowed: literals, character classes, `\d \w \n \t \r \\ \. \( \)` etc., anchors, alternation, and quantifiers on single characters or classes.

Named groups: stored as `(?P<name>...)`; `ToJS` rewrites to `(?<name>...)`. Required group names by type — `amount`: `amt` (required) and `ccy` (optional); `date`: `d`; everything else: `v`.

**JavaScript compiles every pattern with the `u` flag** (`new RegExp(toJS(p), flags.join("") + "u")`). Without it, JS's case-insensitive matching excludes non-ASCII→ASCII foldings that Go's RE2 performs (the Kelvin sign is the standard example), and quantifiers apply to UTF-16 code units rather than code points. With `u`, both engines operate on code points and fold identically, and every escape this dialect bans becomes a hard `SyntaxError` rather than a silent reinterpretation — a second, free layer of enforcement.

Date layouts (closed enum, both executors implement exactly these three; `Layouts` is a list tried in order):
`DD-MM-YYYY`, `DD/Mon/YYYY hh:mm A`, `DD/Mon/YYYY`.

**`Override`** exists for exactly one case and `ValidateDefinition` warns when a definition uses it more than once: v1's `dib.go:79-83` re-derives `direction` from the uppercased description suffix (`strings.HasSuffix(up, "DEBIT")`) *after* the four-way cascade has already set it. Rule 3 of the executor ("`on_match` sets additional fields only if not already set") forbids that, so without an explicit override flag the DIB account template cannot reproduce v1 and Task 21's gate is unreachable. A definition using `Override` must carry a `"why"` comment field; the seed's says so.

- [ ] **Step 1: Write the failing tests**

```go
func TestValidatePatternRejectsTheDivergentAndUnsafeConstructs(t *testing.T) {
	for _, p := range []string{
		`AED\s+([0-9]+)`, `\bAED\b`, `(?i)aed`, `(?=x)`, `(a)\1`,
		`\p{Arabic}`, `\x{0623}`, `\Ax`,
		`(ab)+c`, `(ab)*c`, `(ab){2,}c`,     // unbounded quantifier on a group
		`([0-9]+)?`, `(a|b*)?`,               // unbounded quantifier INSIDE a quantified group
		`Debit Amount:\n(.+)`,                // bare dot
		strings.Repeat("a", 513),
	} {
		if errs := ValidatePattern(p, nil); len(errs) == 0 {
			t.Errorf("pattern %q must be rejected", p)
		}
	}
	if errs := ValidatePattern(`x`, []string{"m"}); len(errs) == 0 {
		t.Error(`flag "m" must be rejected`)
	}
}

func TestValidatePatternAcceptsTheSeedShapes(t *testing.T) {
	for _, p := range []string{
		`المبلغ\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]*\.[0-9]{2})`,
		`Debit Amount:\n(?P<amt>[^\n]+)`,
		`account ending with (?P<v>[0-9]{4})`,
		`بتاريخ (?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})`,
		`(?P<amt>(?:[A-Z]{3} )?[0-9][0-9,]*\.[0-9]{2})[ \n]has been[ \n](?:withdrawn|debited)[ \n]from your account`,
	} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("pattern %q rejected: %v", p, errs)
		}
	}
}

func TestToJSRewritesNamedGroups(t *testing.T) {
	if got := ToJS(`(?P<amt>[0-9]+)`); got != `(?<amt>[0-9]+)` { t.Fatalf("got %q", got) }
}

func TestCanonicalDoesNotHTMLEscape(t *testing.T) {
	d := mustParse(t, `{"id":"x","version":1,"extract":[{"field":"merchant","type":"text","source":"body","patterns":["A & B"]}]}`)
	b, _ := d.Canonical()
	if bytes.Contains(b, []byte(`&`)) {
		t.Fatal("Canonical must set SetEscapeHTML(false) or Go and TS hash differently")
	}
}

func TestCanonicalIsStableAcrossKeyOrder(t *testing.T)          { /* two JSON orderings -> same bytes */ }
func TestValidateDefinitionRequiresAmountAndDirection(t *testing.T) { /* ... */ }
func TestValidateDefinitionRejectsMultipleOverrides(t *testing.T)   { /* ... */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/tmpl/ -v`
Expected: FAIL — `undefined: ValidatePattern`.

- [ ] **Step 3: Implement `dialect.go` and `def.go`.** The validator is a hand-written scanner over the pattern (not a regex over a regex), tracking character-class and escape state so `[.]` and `\.` are not mistaken for a bare `.`, and tracking group nesting with each group's quantifier so the "unbounded inside quantified" rule can be decided. It reports the offending offset. After the structural checks pass it must additionally `regexp.Compile` the pattern, so a syntactically-broken pattern is caught too.

- [ ] **Step 4: Export `conformance/dialect/patterns.json`** — every rejected pattern above with its reason code, plus the accepted set, so Task 20's TypeScript mirror is tested against exactly the same list.

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/v2/tmpl/ -v`
Expected: PASS (7 tests).

- [ ] **Step 6: Write `docs/superpowers/specs/v2-template-format.md`** — the JSON schema above, the dialect table with the engine-divergence reason for each ban, the group-name rules, the three date layouts, the `Override` rule and why it exists, and a worked DIB example.

- [ ] **Step 7: Commit**

```bash
git add internal/v2/tmpl conformance/dialect docs/superpowers/specs/v2-template-format.md
git commit -m "feat(v2): template definition format and backtracking-safe regex dialect validator"
```
---

### Task 19: Go template executor and the template store

**Files:**
- Create: `internal/v2/tmpl/exec.go`, `internal/v2/tmpl/exec_test.go`
- Create: `internal/v2/tmpl/store.go`, `internal/v2/tmpl/store_test.go`
- Create: `internal/v2/pg/migrations/00004_templates.sql`

**Interfaces:**
- Consumes: Tasks 15, 18.
- Produces:

```go
type Extraction struct {
	AmountMinor int64
	Currency    string
	Direction   string
	PostedAt    time.Time      // zero when DateFrom == "email"; the caller supplies norm.Result.EmailDate
	Merchant    string
	Last4       string
	IsTransfer  bool
	EmptyGroups []string       // named groups that matched but captured nothing — diagnostics
	Matched     bool
}
func Execute(d Definition, subject, normalizedBody string) (Extraction, error)
func ValidateExtraction(e Extraction, d Definition) error

type Store struct { Pool *pgxpool.Pool }
func (s *Store) Publish(ctx, d Definition) error             // status draft -> published, version must be new
func (s *Store) Published(ctx) ([]Definition, error)          // cached in memory by the ingest pipeline
func (s *Store) ForSenderDomain(ctx, domain string) ([]Definition, error)
func (s *Store) SetStatus(ctx, id string, version int, status string) error
```

**Execution semantics (identical in TypeScript):**
1. `Match` gates: `sender_domain` is a suffix match against the **verified** signing domain (Tasks 25–26 supply it — never `norm.Result.From`); `subject_contains` matches the **effective** subject from `norm.Result.Subject` (inner when forwarded, Decision 14); `body_contains` and `body_not_contains` are literal substring checks on the normalized text. All listed conditions must hold; `body_not_contains` must match none.
2. `Extract` entries are evaluated in order. Within one entry, patterns are tried in order.
3. **Typed conversion failure falls through; it never yields a zero value and never aborts.** This is the rule the first draft left ambiguous — it said both "first match wins" and "a date parse failure is an error", which cannot both be true, and `ParseENBDDate`'s try-`DD/Mon/YYYY hh:mm A`-then-`DD/Mon/YYYY` behavior needs the ambiguity resolved. Precisely:
   - a pattern that does not match → try the next pattern in the entry;
   - a pattern that matches but whose captured text fails typed conversion (date layouts exhausted, amount without two decimals, `last4` with no digits) → try the next pattern in the entry;
   - all patterns in the entry exhausted → the entry yields nothing; move to the next `Extract` entry for that field;
   - **the first entry that produces a value for a given `field` wins for that field**; later entries for the same field are skipped, unless the entry sets `"override": true`, which replaces an already-set value (see rule 9);
   - a field named in `Required` that no entry produced → `Matched = false` with an error naming it.
4. `on_match` sets additional fields (typically `direction`) **only if not already set**.
5. `amount`: the `amt` group is stripped of `,`, the decimal point removed, parsed as `int64` minor units. If `ccy` matched, it is the currency (trimmed); else `default_currency`. A missing decimal part is a conversion failure (rule 3), not a guess — bank alert formats in this corpus always carry two decimals.
6. `date`: the captured text is trimmed. For each declared layout in order, attempt a full-string parse; if that fails, attempt a parse of the text **up to the first U+0020**. The first success wins. This second attempt is what reproduces v1's `strings.Fields(s)[0]` fallback in `ParseENBDDate` without needing a second `Extract` entry. Every layout failing on both attempts is a conversion failure (rule 3) — **never a zero time**.
7. `last4`: all non-digit characters are removed from the captured text; the last four digits are taken. Fewer than one digit is a conversion failure.
8. `const` / `flag` entries: if any pattern matches the source (or the entry has no patterns at all, making it an unconditional default), the field is set to `Value`. An unconditional `const` entry placed last is how a conditional default is expressed — which is exactly the shape of v1's four-way DIB direction cascade whose `default` branch is itself conditional.
9. `override: true` on an entry means "set this field even if an earlier entry already set it". Used exactly once, by `dib.account.v1`, to reproduce `dib.go:79-83`'s description-suffix direction override. Every use must carry a `"why"` string.
10. Named groups that matched the pattern but captured an empty string are appended to `EmptyGroups` — this is what feeds spec §3.5's "which named capture groups were empty" diagnostic.

Schema: `templates(id text, version int, bank text, normalizer_version int, definition jsonb NOT NULL, status text CHECK (status IN ('draft','testing','published')), created_at, published_at, PRIMARY KEY (id, version))` plus a partial unique index guaranteeing at most one `published` row per `id`.

- [ ] **Step 1: Write the failing test**

```go
func TestExecuteDIBCardPurchase(t *testing.T) {
	d := mustLoad(t, "testdata/dib.card.v1.json")
	body := "إشعار مشتريات\nالمبلغ\nAED 250.00\nبتاريخ 05-06-2026\nالدفع الى\nCARREFOUR DUBAI\nرقم البطاقة\nXXXX1234"
	e, err := Execute(d, "", body)
	if err != nil { t.Fatal(err) }
	if e.AmountMinor != 25000 || e.Currency != "AED" || e.Direction != "debit" ||
		e.Merchant != "CARREFOUR DUBAI" || e.Last4 != "1234" {
		t.Fatalf("%+v", e)
	}
}

func TestDateLayoutsAreTriedInOrderAndFallBackToTheFirstToken(t *testing.T) {
	// "05/Jun/2026 04:25 PM" matches layout 1;
	// "05/Jun/2026" matches layout 2;
	// "05/Jun/2026 garbage" matches layout 2 via the first-token attempt.
	// Reproduces v1 ParseENBDDate exactly.
}

func TestAConversionFailureFallsThroughRatherThanZeroing(t *testing.T) {
	// a date entry whose only pattern captures "not a date" -> the field is unset,
	// PostedAt stays zero, and Required decides. Never time.Time{} presented as a value.
}

func TestOverrideReplacesAnAlreadySetDirection(t *testing.T) {
	// dib.account: the cascade sets credit, the description ends "DEBIT",
	// the override entry wins. Without override:true this is unreproducible.
}

func TestBodyNotContainsSeparatesTheTwoDIBLayouts(t *testing.T) {
	// dib.account.v1 must NOT match a body containing "إشعار مشتريات"
}

func TestExecuteRecordsEmptyCaptureGroups(t *testing.T)             { /* merchant line present but blank */ }
func TestExecuteFailsClosedOnMissingRequiredField(t *testing.T)     { /* Matched == false */ }
func TestSubjectSourceUsesTheEffectiveSubject(t *testing.T) {
	// enbd.alert reads last4 from the subject; pass the unwrapped inner subject.
}
func TestPublishRejectsADefinitionWithAnInvalidPattern(t *testing.T) { /* dialect gate at publish time */ }
func TestPublishRejectsReusingAVersionNumber(t *testing.T)           { /* ... */ }
func TestOnlyOneTemplateVersionCanBePublished(t *testing.T)          { /* partial unique index */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/tmpl/ -run Execute -v`
Expected: FAIL — `undefined: Execute`.

- [ ] **Step 3: Implement `exec.go` and `store.go` + the migration.** `Publish` must call `ValidateDefinition` **and** `ValidatePattern` on every pattern before writing — the dialect gate is a publish-time gate (spec §3.5), not a lint.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/tmpl/ -v`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/tmpl internal/v2/pg/migrations/00004_templates.sql
git commit -m "feat(v2): Go template executor and versioned template store with publish-time dialect gate"
```

---

### Task 20: TypeScript template executor and template conformance

**Files:**
- Create: `client/src/tmpl/dialect.ts`, `client/src/tmpl/exec.ts`
- Create: `client/src/tmpl/dialect.test.ts`, `client/src/tmpl/conformance.test.ts`
- Create: `conformance/templates/*.json` (written by a Go test)

**Interfaces:**
- Consumes: Tasks 18, 19.
- Produces:
  - `export function validatePattern(p: string, flags: string[]): string[]` — the mirrored dialect check, run at template **load** time on the client so a hand-edited or server-substituted template cannot slip a backtracking bomb past.
  - `export function toJS(p: string): string`
  - `export function compile(p: string, flags: string[]): RegExp` — always `new RegExp(toJS(p), flags.join("") + "u")`. The `u` flag is not optional: it is what aligns case folding and code-point semantics with Go's RE2 (Task 18).
  - `export function execute(d: Definition, subject: string, normalizedBody: string): Extraction`
  - `export interface Extraction { amount_minor: bigint; currency: string; direction: "debit" | "credit" | ""; posted_at: string; merchant: string; last4: string; is_transfer: boolean; empty_groups: string[]; matched: boolean }`

- [ ] **Step 1: Add a Go fixture writer**

In `internal/v2/tmpl/exec_test.go`, add `TestWriteTemplateFixtures`, which for every published seed template × every corpus message from that sender writes a `conformance/templates/*.json` case:

```json
{"name":"...", "definition":{...}, "subject_base64":"...", "normalized_body_base64":"...",
 "expect":{"matched":true,"amount_minor":"25000","currency":"AED","direction":"debit",
           "posted_at":"2026-06-05T00:00:00Z","merchant":"...","last4":"1234","empty_groups":[]}}
```

Subject and body are base64 for the same reason the normalizer fixtures are (Task 15 step 4). Cap the corpus at 500 cases per template (sampled evenly across the three years) so the fixture set stays reviewable; the *full* corpus run is Task 21's gate, not this fixture set.

- [ ] **Step 2: Write the failing conformance test**

```ts
const dir = `${import.meta.dir}/../../../conformance/templates`;
for (const f of readdirSync(dir)) {
  const c = await Bun.file(`${dir}/${f}`).json();
  test(`template conformance: ${c.name}`, () => {
    const got = execute(c.definition,
      Buffer.from(c.subject_base64, "base64").toString("utf8"),
      Buffer.from(c.normalized_body_base64, "base64").toString("utf8"));
    expect(got.matched).toBe(c.expect.matched);
    if (c.expect.matched) {
      expect(got.amount_minor).toBe(BigInt(c.expect.amount_minor));
      expect(got.currency).toBe(c.expect.currency);
      expect(got.direction).toBe(c.expect.direction);
      expect(got.posted_at).toBe(c.expect.posted_at);
      expect(got.merchant).toBe(c.expect.merchant);
      expect(got.last4).toBe(c.expect.last4);
      expect(got.empty_groups).toEqual(c.expect.empty_groups);
    }
  });
}
```

and `dialect.test.ts` driven by `conformance/dialect/patterns.json`, asserting the TypeScript validator accepts and rejects exactly the same patterns as Go's, **with the same reason code**. Add one test that goes further than parity:

```ts
test("every accepted pattern actually compiles under the u flag", () => {
  for (const p of accepted) expect(() => compile(p.pattern, p.flags ?? [])).not.toThrow();
});
```

- [ ] **Step 3: Run and watch fail**

Run: `cd client && bun test src/tmpl/`
Expected: FAIL — cannot resolve `./exec`.

- [ ] **Step 4: Implement `dialect.ts` and `exec.ts`.** Parse amounts through `BigInt`. Implement the three date layouts by hand (no `Date.parse`, which is implementation-defined for these shapes), including the first-token fallback from Task 19 rule 6, and emit RFC3339 UTC.

- [ ] **Step 5: Run the whole gate**

Run: `bash scripts/v2-check.sh`
Expected: exit 0. **Any single conformance disagreement fails here — that is the dual-executor guarantee doing its job.**

- [ ] **Step 6: Commit**

```bash
git add client/src/tmpl conformance/templates internal/v2/tmpl/exec_test.go
git commit -m "feat(v2): TypeScript template executor with mirrored dialect check and shared conformance"
```

---

### Task 21: Seed the three parsers as templates — the corpus gate (HARD GATE)

**Files:**
- Create: `internal/v2/tmpl/seed/dib.card.v1.json`, `dib.account.v1.json`, `enbd.transfer.v1.json`, `enbd.alert.v1.json`
- Create: `internal/v2/tmpl/seed/seed.go` (embeds them, `Seed() []Definition`)
- Create: `internal/v2/tmpl/seed/corpus_gate_test.go`
- Create: `docs/superpowers/specs/v2-seed-validation.md` (the result record)

**Interfaces:**
- Consumes: Tasks 15, 16, 18, 19, and `internal/v2/corpus` (Task 2); v1's `internal/parse` (read-only reference).
- Produces: `seed.Seed() []tmpl.Definition` — the four published definitions the ingest pipeline and the admin console start from. (Four, not three: v1's `DIBParser` handles two distinct layouts — card purchase and account transaction — behind one `Matches`; splitting them is what makes each a declarative template rather than a Go `switch`.)

**The gate (this is spec §3.5's "ported templates must reproduce the existing three parsers' output over the full 3-year corpus before Phase 1 ships"):**

For every row in the corpus `ingest_log`:
1. Decompress `raw_body`; run v1's `parse.BodyText` → `parse.Unwrap` → v1's `Cascade{Parsers: [DIB, ENBD, ENBDAlert], Heuristic: …, AI: nil}` with `fallbackDate = row.ReceivedAt`.
2. Run v2's `norm.Normalize(1, raw, row.ReceivedAt)` then `tmpl.Execute` over each seed definition whose `Match` gates pass, supplying `Result.EmailDate` for `date_from: "email"`. **Both sides get the same `receivedAt`**, so a date difference is a real difference and not an artifact of the harness.
3. Compare, field by field: `status` (parsed / unparsed), `amount_minor`, `currency`, `direction`, `posted_at`, `merchant`, `last4`, `is_transfer`.

**Pass criterion, no exceptions:**
- Every message where v1's **template tier** produced a result must produce an identical v2 result on all eight fields. Count of mismatches must be **0**.
- Every message where v1's template tier produced a result must produce a v2 result at all. Count of v2 misses must be **0**.
- v2 may additionally match messages v1's template tier missed (a strict improvement) — these are reported as `new_matches: N` and are allowed, but each must be eyeballed and listed in `v2-seed-validation.md`.

**Iterate on the JSON definitions, never on the comparison.** If a mismatch is tempting to absorb by loosening the comparison, that is the signal the template is wrong.

- [ ] **Step 1: Write the four seed definitions** by transcribing the regexes from `internal/parse/dib.go`, `enbd.go` and `enbd_alert.go` into the JSON format and converting each to the safe dialect.

**The dialect conversion table** (the normalizer has already collapsed runs of `{tab, space, U+00A0}` to one space, trimmed every line and dropped empty lines, so these rewrites are exact, not approximate):

| v1 | seed JSON | why |
|---|---|---|
| `\s*\n\s*` | `\n` | every line is already trimmed |
| `\s+` between two tokens | `[ \n]` | after collapsing, exactly one space or exactly one newline separates them |
| `\s*` after a currency code | ` ` (a literal space) | same |
| `(.+)` | `([^\n]+)` | Go's `.` and JS's `.` disagree on `\r`/U+2028/U+2029 (Task 18) |
| `(?i)` prefix | `"flags":["i"]` | no inline flags |
| `(\S+)` | `([^ \n]+)` | `\S` is banned; this is its exact meaning on normalized text |
| `\b(\d{2}-\d{2}-\d{4})\b` | *(heuristic only — not converted, Decision 16)* | |

**⚠ Transcribe the Arabic anchors byte-for-byte. Do not "correct" them.** They are multi-word with internal literal spaces, and one is spelled **without the hamza** — `الدفع الى`, not `الدفع إلى` — because that is how DIB actually writes it. A well-meaning spelling fix while copying into JSON produces a template that compiles, validates, publishes, and silently matches nothing across all 6,864 DIB messages. The same applies to `المبلغ`, `بتاريخ`, `المعاملة`, `رقم البطاقة`, `من حساب`, `إشعار مشتريات`, `إشعار إيداع`, `إشعار خصم`, `إشعار سحب`, `من الحساب`. Copy them out of `dib.go` with an editor, not by retyping.

**`dib.go` is roughly half control flow, and all of it has to be expressed declaratively.** Budget for this; it is the reason this task is sized as a gate rather than a transcription:
- **A two-layout discriminator with an early return** (`isCard := strings.Contains(textBody, "إشعار مشتريات")`) → two templates, `dib.card.v1` with `body_contains: ["إشعار مشتريات"]` and `dib.account.v1` with `body_not_contains: ["إشعار مشتريات"]`.
- **A four-way direction cascade whose `default` is itself conditional** → four ordered `Extract` entries of type `const` on `direction`: `إشعار إيداع`→credit; `إشعار خصم|إشعار سحب`→debit; `من الحساب`→debit; then an unconditional entry→credit. First entry to produce a value wins (Task 19 rule 3), which is exactly the cascade.
- **A direction override from the uppercased description suffix** (`strings.HasSuffix(up, "DEBIT")` / `"CREDIT"`) → one `Extract` entry with `"override": true` and a `"why"` field, placed after the cascade (Task 19 rule 9). Note it matches on the **uppercased** description, so the pattern carries `"flags":["i"]` and anchors with `$`.
- **`IsTransfer`** from `strings.Contains(up, "TRNSFER") || strings.Contains(up, "TRANSFER")` (the misspelling is DIB's, not a typo here) → a `flag`-type entry.

- [ ] **Step 2: Write the failing gate test**

```go
func TestSeedTemplatesReproduceV1OverTheFullCorpus(t *testing.T) {
	dbPath := os.Getenv("LEDGER_CORPUS_DB")
	if dbPath == "" { t.Skip("set LEDGER_CORPUS_DB to a root-made .backup copy") }
	// ... iterate, compare, accumulate
	t.Logf("corpus: %d messages, v1 template hits: %d, mismatches: %d, v2 misses: %d, new matches: %d",
		total, v1Hits, mismatch, misses, newMatches)
	if mismatch != 0 || misses != 0 {
		t.Fatalf("SEED VALIDATION FAILED: %d mismatches, %d misses", mismatch, misses)
	}
}
```

The failure log must print, per mismatching message, the `ingest_log.id`, the template that matched (or none), and a field-by-field diff — otherwise iterating on 6,994 messages is guesswork.

- [ ] **Step 3: Run it and watch it fail**

```bash
S=/tmp/claude-0/-root-Coding-ledger/bcc8cb5e-1dd4-451e-94e9-031572dd88c7/scratchpad
LEDGER_CORPUS_DB=$S/corpus.db go test ./internal/v2/tmpl/seed/ -run TestSeed -v -timeout 30m
```
Expected: FAIL on the first run with a non-zero mismatch count and a per-message diff log.

- [ ] **Step 4: Run until green**

```bash
LEDGER_CORPUS_DB=$S/corpus.db go test ./internal/v2/tmpl/seed/ -run TestSeed -v -timeout 30m
```
Expected: PASS with `mismatches: 0, v2 misses: 0` over ~6,994 messages.

- [ ] **Step 5: Record the result** in `docs/superpowers/specs/v2-seed-validation.md`: corpus size, date range, per-template hit counts, the `new_matches` list with a one-line justification each, and the date the gate was run. Phase 1 does not ship without this document showing a pass.

- [ ] **Step 6: Commit**

```bash
git add internal/v2/tmpl/seed docs/superpowers/specs/v2-seed-validation.md
git commit -m "feat(v2): seed templates for DIB/ENBD ported and validated against the full 3-year corpus"
```
---

## Part E — Ingestion

### Task 22: Inbound addresses — issue, rotate, 7-day grace

**Files:**
- Create: `internal/v2/pg/migrations/00005_inbound_addresses.sql`
- Create: `internal/v2/addresses/addresses.go`, `internal/v2/addresses/addresses_test.go`
- Create: `internal/v2/api/addresses.go`

**Interfaces:**
- Consumes: `config.InboundSuffix()` (Task 3), `Sessions`/`Writers` (Tasks 6–7).
- Produces:
  - `func NewToken() (string, error)` — 26-char lowercase RFC 4648 base32 (no padding) of **16 bytes read from `crypto/rand`**.
  - `func NewTokenFrom(r io.Reader) (string, error)` — the injectable form the tests use.
  - `type Addresses struct { Pool *pgxpool.Pool; Suffix string; Now func() time.Time; Grace time.Duration }`
  - `func (a *Addresses) Issue(ctx, userID uuid.UUID) (localPart string, err error)`
  - `func (a *Addresses) Rotate(ctx, userID uuid.UUID) (newLocalPart string, oldExpiresAt time.Time, err error)` — the old address keeps accepting for `Grace` (7 days, spec §3.2).
  - `func (a *Addresses) Resolve(ctx, rcpt string) (userID uuid.UUID, isGrace bool, err error)` — `ErrUnknownRecipient` when no active or in-grace address matches. **Constant-time comparison is not required** (the token is looked up by primary key), but the error must be indistinguishable from every other RCPT failure at the SMTP layer.
  - `GET /api/v1/address` → `{address, created_at, rotates_from, grace_until}`; `POST /api/v1/address/rotate` → the new address plus the grace deadline. Rotation requires a fresh writer-key signature over a server challenge (§3.4 capability rules), not just a session.

Schema: `inbound_addresses(local_part text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL, expires_at timestamptz)` — `expires_at IS NULL` means active; a rotated address gets `expires_at = now + grace`. Partial unique index: at most one active address per user.

- [ ] **Step 1: Write the failing test**

```go
func TestTokenIsSixteenCryptoRandomBytesInBase32(t *testing.T) {
	// The point of §3.2:46 is >=128 bits of entropy. A test that only checks
	// len(tok)==26 and "no collisions in 1000 draws" passes for a generator with
	// a 20-character constant prefix and 6 random characters, so it tests the
	// SOURCE and the ENCODING instead.
	var known [16]byte
	for i := range known { known[i] = byte(i) }
	tok, err := NewTokenFrom(bytes.NewReader(known[:]))
	if err != nil { t.Fatal(err) }
	want := strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(known[:]))
	if tok != want { t.Fatalf("encoding drift: got %q want %q", tok, want) }
	if len(tok) != 26 { t.Fatalf("want 26 chars, got %d", len(tok)) }

	// exactly 16 bytes are consumed — not 8 padded, not 32 truncated
	r := &countingReader{R: rand.Reader}
	if _, err := NewTokenFrom(r); err != nil { t.Fatal(err) }
	if r.N != 16 { t.Fatalf("read %d bytes from the entropy source, want 16", r.N) }

	// a short read is an error, never a short token
	if _, err := NewTokenFrom(bytes.NewReader(known[:8])); err == nil {
		t.Fatal("a truncated entropy source must be an error")
	}

	// one flipped input bit changes the token (the encoding is injective)
	flipped := known; flipped[15] ^= 1
	other, _ := NewTokenFrom(bytes.NewReader(flipped[:]))
	if other == tok { t.Fatal("encoding is not injective") }
}

func TestRotationKeepsTheOldAddressForSevenDays(t *testing.T) {
	pool := pgtest.New(t); u := insertUser(t, pool)
	now := time.Now()
	a := &Addresses{Pool: pool, Suffix: "@in.example.test", Grace: 7 * 24 * time.Hour,
		Now: func() time.Time { return now }}
	old, _ := a.Issue(ctx, u)
	fresh, until, _ := a.Rotate(ctx, u)
	if fresh == old { t.Fatal("rotation must mint a new token") }
	if got, _, err := a.Resolve(ctx, old+"@in.example.test"); err != nil || got != u {
		t.Fatalf("old address must still resolve during grace: %v", err)
	}
	now = until.Add(time.Second)
	if _, _, err := a.Resolve(ctx, old+"@in.example.test"); err == nil {
		t.Fatal("old address must stop resolving after the grace window")
	}
}

func TestResolveRejectsAnAddressOutsideOurDomain(t *testing.T) { /* u-xxx@evil.test -> error */ }
func TestOnlyOneActiveAddressPerUser(t *testing.T)             { /* second Issue without Rotate -> error */ }
func TestRotationRequiresAWriterSignature(t *testing.T)        { /* session alone -> 403 */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/addresses/ -v`
Expected: FAIL — `undefined: NewToken`.

- [ ] **Step 3: Implement the package, the migration and the two handlers.**

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/addresses/ ./internal/v2/api/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/v2/addresses internal/v2/api/addresses.go internal/v2/pg/migrations/00005_inbound_addresses.sql
git commit -m "feat(v2): inbound address issuance, rotation and 7-day grace window"
```

---

### Task 23: Diagnostics — the bounded unencrypted ledger, and the §2 update

> Moved ahead of the SMTP receiver: Task 24's per-address-quota test asserts that a rejected message leaves a diagnostics row, which is impossible if `diag` does not exist yet.

**Files:**
- Create: `internal/v2/pg/migrations/00006_diagnostics.sql`
- Create: `internal/v2/diag/diag.go`, `internal/v2/diag/diag_test.go`
- Create: `internal/v2/diag/sig.go`, `internal/v2/diag/sig_test.go`
- **Modify: `docs/superpowers/specs/2026-07-31-multi-user-beta-design.md` §2 — unconditionally, see Step 5.**

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Record struct { … }` — **exactly these fields and no others:**

| column | type | why it is here |
|---|---|---|
| `id` | uuid | row identity |
| `user_id` | uuid NULL | scoping and purge; NULL only for protocol-layer events with no resolved recipient |
| `event` | text | closed enum: `arrival` \| `reprocess` — see below |
| `ingest_id` | bytea(32) | links a diagnostic to its op / quarantine row; hash of the raw body, never invertible |
| `received_at` | timestamptz | when |
| `sender_domain` | text | the **verified** signing domain, or the envelope domain prefixed `unverified:` |
| `dkim_result` | text | pass/fail/none/temperror |
| `arc_result` | text | pass/fail/none |
| `inner_origin_domain` | text NULL | only when attested (direct inner DKIM or ARC) |
| `template_id` | text NULL | which template was attempted |
| `template_version` | int NULL | |
| `normalizer_version` | int | which normalizer produced the matched text |
| `matched` | bool | did the template match |
| `empty_groups` | text[] | **names only** of named groups that captured nothing |
| `tier` | text | template / heuristic / none |
| `body_size_bucket` | int | the padding bucket, not the exact size |
| `structure_sig` | text | content-free structural fingerprint (below) |
| `outcome` | text | see the closed enum below |
| `reject_reason` | text NULL | closed enum: too_large, unknown_rcpt, over_quota, no_text_part, normalize_error |

  - **Explicitly never stored:** subject, From display name, any amount, any merchant, any capture-group *value*, any body text, any header value.
  - **`event` and the outcome enums.** The first draft had one flat `outcome` and then asserted `inbound_total == 23` in the exit test after 20 trusted + 3 quarantined-then-re-ingested messages — arithmetic that only works if re-ingest writes no diagnostics row, which would be a blind spot in the very instrument that exists to prove nothing is dropped. So the two kinds of event are separated:
    - `event='arrival'`: one row per inbound message. `outcome ∈ {appended, quarantined, rejected, over_quota, duplicate}`.
    - `event='reprocess'`: one row per reprocess attempt (confirm-and-re-ingest, template republish). `outcome ∈ {appended, superseded, unchanged}`.
    - `inbound_total` counts **arrivals only**. Reprocessing is reported alongside, never folded in.
  - `func (d *Diag) Record(ctx context.Context, r Record) error`
  - `func (d *Diag) CountRejection(ctx context.Context, reason string) error` — increments `smtp_rejections(day, reason, count)`. Protocol-layer rejections that never resolve a recipient (an unknown RCPT) have **no `user_id` to scope a row to**, and writing one row per attempt would let anyone flood the table from the open `:25`. An aggregated daily counter closes the "zero drops" hole without creating a storage-amplification one; `Accounting` reports it beside `inbound_total`.
  - `func StructureSig(normalized string) string` — content-free: replace every run of digits with `0`, every run of ASCII letters with `A`, every run of Arabic-script letters with `B`, keep punctuation and line structure, then `SHA256` the first 4 KB and hex the first 16 bytes. Two emails of the same layout with different amounts and merchants must produce the same signature; a different layout must not.
  - `func (d *Diag) Accounting(ctx, from, to time.Time) (Accounting, error)` — counts by `(event, outcome)`, used by Task 36's "zero drops without notice" report.

Schema adds `parse_diagnostics` (above) and `smtp_rejections(day date, reason text, count bigint, primary key (day, reason))`.

- [ ] **Step 1: Write the failing tests**

```go
func TestStructureSigIsContentFreeButLayoutSensitive(t *testing.T) {
	a := StructureSig("المبلغ\nAED 250.00\nالدفع الى\nCARREFOUR")
	b := StructureSig("المبلغ\nAED 9,912.45\nالدفع الى\nSPINNEYS ABU DHABI")
	c := StructureSig("Debit Amount:\nAED 250.00")
	if a != b { t.Fatal("same layout, different values must share a signature") }
	if a == c { t.Fatal("different layouts must differ") }
}

func TestDiagnosticsTableHasExactlyTheDisclosedColumns(t *testing.T) {
	pool := pgtest.New(t)
	rows, _ := pool.Query(ctx, `SELECT column_name FROM information_schema.columns
	                             WHERE table_name='parse_diagnostics' ORDER BY column_name`)
	// compare against the literal expected list; a new column fails this test,
	// which is the point: §2's breach inventory must be updated in the same commit.
}

func TestRecordStoresNoContent(t *testing.T) {
	// insert a Record built from a message containing "CARREFOUR" and "250.00";
	// then assert no text column in the row contains either substring.
}

func TestArrivalAndReprocessAreCountedSeparately(t *testing.T) {
	// 3 arrivals + 2 reprocess rows -> Accounting.InboundTotal == 3,
	// Accounting.Reprocess["appended"] == 2, Unaccounted == 0
}

func TestUnknownRcptIsCountedWithoutAUserScopedRow(t *testing.T) {
	// CountRejection("unknown_rcpt") twice -> smtp_rejections has count 2 and
	// parse_diagnostics is still empty
}
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/diag/ -v`
Expected: FAIL — `undefined: StructureSig`.

- [ ] **Step 3: Implement the migration, `diag.go` and `sig.go`.**

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/diag/ -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Update spec §2's breach inventory — this is required, not conditional**

The first draft made this step conditional ("only **if** the field list differs"). It does differ, definitively and in several places, and §2 is adopted **verbatim into the user-facing privacy page** — so a §2 that understates what a breach yields is a false claim to users, not an internal inconsistency. Update §2 to say, in its own voice:

1. **Size buckets** are `1 / 4 / 16 / 64 / 256 / 512 / 1024 KB`, not `1/4/16/64 KB` (Decision 7).
2. **The diagnostics inventory** currently reads "per-ingest sender domain, template ID, timestamps". It must also name: `structure_sig` (a content-free layout fingerprint), `inner_origin_domain` (which bank, behind a forwarder), `arc_result`/`dkim_result`, `empty_groups` (*which* template fields failed to extract), `normalizer_version`, `body_size_bucket`, `outcome`, `reject_reason` and `event`. Plainly: **a breach reveals which bank each user uses, when each transaction occurred, what shape their bank's mail has, and which parts of it we failed to read** — but no amount and no merchant.
3. **`smtp_rejections`** — an aggregated per-day count of protocol-level rejections, not user-linked.
4. **The merchant dictionary's `submitter_hmac`** (Task 33) — and the honest caveat that at closed-beta scale the operator can enumerate its own small user list against that HMAC, so it is a bounded but real per-pattern linkage until the row is purged at publication.
5. **`parse_rate_adjudications`** (Task 36) — the Phase-1-only operator classification of unparsed mail, and its deletion at the Phase 3 cutover.
6. **The inbound address is a bearer capability.** Anyone who learns a user's `u-<token>@in.<domain>` can inject *genuinely DKIM-signed* bank mail from their own bank account into that user's ledger. The signature proves the bank sent it; it does not prove the bank sent it *to this user*. The mitigations are address secrecy, in-app rotation, and the review queue — not cryptography. This is a property of any mail-slot design and belongs in an honest threat model rather than being discovered later.

Verify with `git diff --stat docs/superpowers/specs/2026-07-31-multi-user-beta-design.md` showing a non-empty change in the same commit as the migration.

- [ ] **Step 6: Commit**

```bash
git add internal/v2/diag internal/v2/pg/migrations/00006_diagnostics.sql \
        docs/superpowers/specs/2026-07-31-multi-user-beta-design.md
git commit -m "feat(v2): bounded parse diagnostics, aggregated SMTP rejections, and the spec §2 update"
```

---

### Task 24: SMTP receiver — RCPT gating, invalid-RCPT tarpit, DATA cap, per-address quota

**Files:**
- Create: `internal/v2/smtpd/smtpd.go`, `internal/v2/smtpd/smtpd_test.go`
- Create: `internal/v2/smtpd/limiter.go`, `internal/v2/smtpd/limiter_test.go`
- Modify: `cmd/ledgerd/main.go` (`runServe` starts the receiver)

**Interfaces:**
- Consumes: `Addresses.Resolve` (Task 22), `diag.Diag` (Task 23), `config.Mail` (Task 3).
- Produces:
  - `type Delivery struct { UserID uuid.UUID; Rcpt string; EnvelopeFrom string; RemoteIP netip.Addr; Raw []byte; ReceivedAt time.Time; IsGrace bool }`
  - `type Handler interface { Deliver(ctx context.Context, d Delivery) error }` — Task 29 implements it; Task 35 implements the relay's spooling version.
  - `func New(cfg config.MailConfig, res Resolver, h Handler, d *diag.Diag, now func() time.Time) *Server`
  - `func (s *Server) ListenAndServe() error`, `func (s *Server) Shutdown(ctx) error`
  - `type Limiter struct { … }` with `func (l *Limiter) InvalidRcpt(ip netip.Addr) (delay time.Duration, disconnect bool)` and `func (l *Limiter) AllowMessage(local string) bool`.

**Hardening rules (all of these are tested, not just configured):**
- `MaxMessageBytes = cfg.MaxMessageBytes` (1 MB) and `MaxRecipients = 1`, `MaxLineLength = 8192`, `ReadTimeout/WriteTimeout = 60s`.
- No `AUTH`, no `AllowInsecureAuth`, and `Rcpt` rejects **every** address that does not resolve — this server never relays.
- Invalid RCPT: reply `550 5.1.1 <no such recipient>` — the **same** text for "no such user", "malformed", and "wrong domain", so the response is not an enumeration oracle. Before replying, sleep `TarpitBase * 2^(n-Burst)` capped at 30s, where `n` is that IP's invalid-RCPT count in a rolling 1-hour window; after 20 invalid RCPTs in the window, drop the connection immediately with `421`. Each invalid RCPT calls `diag.CountRejection("unknown_rcpt")` — aggregated, never one row per attempt (Task 23).
- Per-address quota: `AllowMessage` permits `PerAddressDaily` (50) messages per local part per rolling 24 h; over quota → `452 4.2.2 mailbox full` (a *temporary* failure, so a legitimate burst retries rather than bounces) **and** a user-scoped diagnostics row with `event='arrival'`, `outcome='over_quota'` (the recipient resolved, so there is a user to scope it to).
- Over-size DATA → `552`, plus a diagnostics row with `outcome='rejected'`, `reject_reason='too_large'`. The recipient resolved at RCPT time, so this one is user-scoped too.
- The limiter is in-memory with a bounded map (LRU-capped at 10,000 IPs); a restart resets it. That is acceptable — it is a nuisance control, not a security boundary, and the real boundary is that unknown RCPTs are never accepted.

- [ ] **Step 1: Write the failing tests**

```go
func TestUnknownRecipientIsRejectedWithAnIndistinguishableMessage(t *testing.T) {
	srv, addr := start(t, resolverWith("u-known"))
	for _, rcpt := range []string{"u-unknown@in.example.test", "not-a-token@in.example.test", "x@elsewhere.test"} {
		code, msg := sendRCPT(t, addr, rcpt)
		if code != 550 || msg != "5.1.1 <no such recipient>" {
			t.Fatalf("rcpt %q leaked information: %d %q", rcpt, code, msg)
		}
	}
}

func TestInvalidRcptTarpitGrowsAndThenDisconnects(t *testing.T) {
	l := NewLimiter(LimiterConfig{Burst: 5, Base: 10 * time.Millisecond, Window: time.Hour})
	ip := netip.MustParseAddr("192.0.2.1")
	for i := 0; i < 5; i++ {
		if d, _ := l.InvalidRcpt(ip); d != 0 { t.Fatalf("burst %d should not delay, got %v", i, d) }
	}
	d6, _ := l.InvalidRcpt(ip)
	d7, _ := l.InvalidRcpt(ip)
	if !(d7 > d6 && d6 > 0) { t.Fatalf("tarpit must grow: %v then %v", d6, d7) }
	for i := 0; i < 20; i++ { l.InvalidRcpt(ip) }
	if _, disconnect := l.InvalidRcpt(ip); !disconnect { t.Fatal("expected disconnect after sustained abuse") }
}

func TestUnknownRcptIncrementsTheAggregateCounterOnly(t *testing.T) {
	// after 5 unknown RCPTs: smtp_rejections['unknown_rcpt'] == 5 and
	// parse_diagnostics is empty (no user to scope a row to)
}

func TestDataOverOneMegabyteIsRejected(t *testing.T) {
	// send 1 MB + 1 byte -> 552, Handler.Deliver never called, and one
	// diagnostics row with outcome='rejected', reject_reason='too_large'
}

func TestPerAddressDailyQuota(t *testing.T) {
	// 50 accepted, the 51st gets 452 and one diagnostics row with outcome='over_quota'
}

func TestServerNeverRelays(t *testing.T) { /* RCPT to a foreign domain -> 550, no delivery */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/smtpd/ -v`
Expected: FAIL — `undefined: NewLimiter`.

- [ ] **Step 3: Add the dependency and implement `limiter.go` then `smtpd.go`**

```bash
go get github.com/emersion/go-smtp@v0.24.0
```

Use `go-smtp`'s `BackendFunc` + a `session` struct implementing `Reset/Logout/Mail/Rcpt/Data`. `Data` reads with `io.LimitReader(r, max+1)` and returns `&smtp.SMTPError{Code: 552, EnhancedCode: smtp.EnhancedCode{5,3,4}, Message: "message too large"}` when the extra byte arrives.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/smtpd/ -race -v`
Expected: PASS (6 tests). Tests bind `127.0.0.1:0`, never `:25`.

- [ ] **Step 5: Wire the receiver into `runServe`** behind `cfg.Mail.SMTPListen`, logging the bound address once at startup.

- [ ] **Step 6: Commit**

```bash
git add internal/v2/smtpd cmd/ledgerd go.mod go.sum
git commit -m "feat(v2): hardened SMTP receiver with RCPT gating, tarpit, DATA cap and quota diagnostics"
```

---

### Task 25: Origin trust part 1 — DKIM verification and the verified signing domain

**Files:**
- Create: `internal/v2/origin/dkim.go`, `internal/v2/origin/dkim_test.go`
- Consumes: `internal/v2/origin/testdata/` (written by Task 2)

**Interfaces:**
- Consumes: `github.com/emersion/go-msgauth/dkim` (already added in Task 2).
- Produces:

```go
type SigResult string
const (SigPass SigResult = "pass"; SigFail SigResult = "fail"; SigNone SigResult = "none"; SigTempFail SigResult = "temperror")

type Verified struct {
	DKIM        SigResult
	DKIMDomains []string   // every d= whose signature verified, in header order
	Err         string
}
type LookupTXT func(ctx context.Context, name string) ([]string, error)
func VerifyDKIM(ctx context.Context, raw []byte, lookupTXT LookupTXT) Verified
```

`lookupTXT` is injected so tests are hermetic and offline; production passes a wrapper around `net.DefaultResolver.LookupTXT` with a 5-second timeout and a small positive/negative cache. The `--dns-fixtures` flag (Task 14) injects a recorded `dns.json` into a running server, which is what makes Task 38 step 4 deterministic.

**Rules:**
- A header field is never trusted unverified. `Authentication-Results` present in inbound mail is **ignored entirely** at this layer — it is attacker-writable (Task 26 uses only the ARC-sealed variant, and only after the seal verifies).
- Multiple `DKIM-Signature` headers: verify all; `DKIMDomains` holds only those that pass.
- A DNS failure is `SigTempFail`, distinct from `SigFail` — a temporary DNS problem must not permanently demote a bank to "unauthenticated".
- **A passing DKIM signature always covers `From:`.** `go-msgauth` returns `permFailError("From field not signed")` before anything else if `h=` omits it (`dkim/verify.go:239-251`), so any domain in `DKIMDomains` has signed the message's `From` header. Task 26 relies on this rather than re-deriving it.

**The `x=` expiry hazard, and the fixture discipline it forces.** DIB signs with a ~1-year `x=` tag and **4,702 of the corpus's 6,932 `x=`-bearing signatures have already expired.** `go-msgauth` enforces expiry at `dkim/verify.go:261-270` **before** the DNS key lookup, and its clock is a package-private `var now = time.Now` (`dkim/dkim.go:21`) that an external test cannot stub. There is therefore no way to freeze time around a verification; the only lever is *which fixture* the test uses. So:
- The **canonical permanently-stable pass case** is one of the **62 ENBD messages that carry no `x=` tag at all**. It can never expire.
- The DIB pass case is drawn from the ~2,229 messages whose signatures are still unexpired, and it is guarded by a canary.
- `manifest.json` (Task 2) records `has_x_tag` and `x_expires_at` per fixture, which is what makes the canary possible.

- [ ] **Step 1: Write the failing test**

```go
func TestVerifyDKIMOnAPermanentlyStableENBDMessage(t *testing.T) {
	// The 62 no-x= ENBD messages are the only fixtures that cannot rot.
	raw := mustRead(t, "testdata/enbd-alert-no-expiry.eml")
	got := VerifyDKIM(ctx, raw, staticTXT(loadDNS(t)))
	if got.DKIM != SigPass || !slices.Contains(got.DKIMDomains, "emiratesnbd.com") {
		t.Fatalf("%+v", got)
	}
}

func TestVerifyDKIMOnAnUnexpiredDIBMessage(t *testing.T) {
	raw := mustRead(t, "testdata/dib-unexpired.eml")
	got := VerifyDKIM(ctx, raw, staticTXT(loadDNS(t)))
	if got.DKIM != SigPass || !slices.Contains(got.DKIMDomains, "dib.ae") {
		t.Fatalf("%+v", got)
	}
}

func TestFixtureSignaturesHaveNotExpired(t *testing.T) {
	// THE CANARY. go-msgauth checks x= before the key lookup and its clock is
	// package-private, so a fixture that expires turns every DKIM test into a
	// mysterious "fail" with no hint why. This test says why, loudly.
	for _, f := range loadManifest(t).Fixtures {
		if !f.HasXTag { continue }
		if time.Now().After(f.XExpiresAt) {
			t.Fatalf("fixture %s expired on %s: re-run\n"+
				"  go run ./internal/v2/corpus/cmd/extract-fixtures --out internal/v2/origin/testdata\n"+
				"to draw a fresh unexpired message. See Task 25.", f.File, f.XExpiresAt)
		}
	}
}

func TestTamperedBodyFailsVerification(t *testing.T) {
	raw := mustRead(t, "testdata/enbd-alert-no-expiry.eml")
	tampered := bytes.Replace(raw, []byte("250.00"), []byte("950.00"), 1)
	if got := VerifyDKIM(ctx, tampered, staticTXT(loadDNS(t))); got.DKIM != SigFail {
		t.Fatalf("a modified amount must fail DKIM, got %v", got.DKIM)
	}
}

func TestDNSFailureIsTempFailNotFail(t *testing.T) { /* lookup returns error -> SigTempFail */ }
func TestNoSignatureIsNone(t *testing.T)           { /* -> SigNone, empty domains */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/origin/ -v`
Expected: FAIL — `undefined: VerifyDKIM`.

- [ ] **Step 3: Implement `dkim.go`** over `dkim.VerifyWithOptions(bytes.NewReader(raw), &dkim.VerifyOptions{LookupTXT: lookupTXT})`.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/origin/ -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/origin/dkim.go internal/v2/origin/dkim_test.go
git commit -m "feat(v2): cryptographic DKIM verification with injected DNS and expiry-aware fixtures"
```

---

### Task 26: Origin trust part 2 — inner-origin attestation, direct DKIM first

**Files:**
- Create: `internal/v2/origin/inner.go`, `internal/v2/origin/inner_test.go`
- Create: `internal/v2/origin/trust.go`, `internal/v2/origin/trust_test.go`

**Interfaces:**
- Consumes: Task 25's `VerifyDKIM`, Task 2's `arc.Verify` and fixtures, `go-msgauth/authres`.
- Produces:

```go
type Origin struct {
	Outer      string     // verified signing domain of the message as we received it
	Inner      string     // the bank's domain behind a forwarder, only when attested
	InnerFrom  string     // the original From address, only when attested
	Attested   bool       // true iff Inner rests on a cryptographic verification
	AttestedBy string     // "direct_dkim" | "arc" | ""
	DKIM, ARC  SigResult
}
func Resolve(ctx context.Context, raw []byte, lookupTXT LookupTXT) Origin
```

**Two paths to an attested inner origin, tried in this order.** The first draft made ARC the only path, which made the largest unknown in the plan also the load-bearing one. The corpus says it does not have to be:

1. **Direct inner DKIM (preferred).** A passing DKIM signature whose `d=` does **not** align with the envelope sender or the outer `From:` domain is, by itself, proof that that domain signed this exact message body — and `go-msgauth` guarantees the signature covers `From:` (Task 25), so the `From:` it covers is the attested original sender. For the 1,158 Gmail-delivered messages in the corpus, the original `d=dib.ae` signature **survives the forward intact and its body hash still matches**, so this path alone establishes bank identity for the common case with no ARC at all. Set `Inner = d=`, `InnerFrom = From:`, `Attested = true`, `AttestedBy = "direct_dkim"`.
2. **ARC (fallback).** On `arc.Verify(...).Status == "pass"`, parse instance 1's AAR with `authres`, take the `dkim=pass` result's `header.d`, and take the original `From` from the message's own `From:` header **only when** the highest-instance AMS covers `From` in its `h=` list. Set `AttestedBy = "arc"`.

`Outer` prefers a passing direct DKIM `d=` that *aligns* with the envelope/`From:` domain, falling back to the highest-instance ARC seal domain, falling back to `"unverified:" + envelope domain`.

**What this does to the ARC risk.** With path 1 in place, an ARC NO-GO (Task 2's scope guard) no longer means "the alpha phase cannot run". It means forwarders that *rewrite the body* — and therefore break the original signature — stay quarantined. That is a genuinely safe degraded mode, and it is safe because of a measured property of the corpus rather than an assumption.

**What it does not do.** Neither path proves the bank sent the mail *to this user*: a passing signature on a genuine DIB alert proves DIB sent it to *someone*. Anyone holding the user's inbound address can forward their own bank mail into it. That is a property of the mail-slot design, it is disclosed in §2 (Task 23 step 5), and the mitigations are address secrecy, rotation and the review queue.

- [ ] **Step 1: Write the failing tests**

```go
func TestGmailForwardIsAttestedByDirectInnerDKIMWithoutARC(t *testing.T) {
	raw := mustRead(t, "testdata/gmail-forward-inner-dkim.eml")
	got := Resolve(ctx, raw, staticTXT(loadDNS(t)))
	if !got.Attested || got.AttestedBy != "direct_dkim" || got.Inner != "dib.ae" {
		t.Fatalf("%+v", got)
	}
}

func TestARCIsUsedOnlyWhenDirectInnerDKIMIsAbsent(t *testing.T) {
	// a forward whose inner signature was broken by the forwarder but whose ARC
	// chain passes -> AttestedBy == "arc"
}

func TestResolveDoesNotAttestInnerOriginWithoutAnyVerification(t *testing.T) {
	// a plain (non-ARC, body-rewritten) forward with a Fwd: subject
	// -> Attested == false, Inner == "", AttestedBy == ""
}

func TestForgedForwardHeaderDoesNotBecomeAnInnerOrigin(t *testing.T) {
	// a body containing "Begin forwarded message:\nFrom: alerts@dib.ae" with no
	// signature at all -> Attested == false. The unwrap stage sees it; trust does not.
}

func TestAlignedSignatureIsOuterNotInner(t *testing.T) {
	// direct bank mail: d=dib.ae aligns with From: -> Outer == "dib.ae",
	// Inner == "", Attested == false (there is no forwarder to see behind)
}

func TestUnverifiedOuterIsPrefixed(t *testing.T) { /* Outer == "unverified:example.test" */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/origin/ -run Inner -v`
Expected: FAIL — `undefined: Resolve`.

- [ ] **Step 3: Implement `inner.go` and `trust.go`.** `trust.go` holds the allowlist reads (`sender_allowlist`, whose migration ships with Task 27) behind a small interface so the pipeline consumes one type.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/origin/ ./internal/v2/arc/ -v`
Expected: PASS (12 tests across both packages).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/origin/inner.go internal/v2/origin/inner_test.go internal/v2/origin/trust.go internal/v2/origin/trust_test.go
git commit -m "feat(v2): inner-origin attestation via direct DKIM with ARC as the fallback"
```
---

### Task 27: Quarantine — chain-free TTL store, its own sync channel, sender confirmation

> **Moved ahead of the pipeline (Task 29), which is a compile-order fix, not a preference.** In the first draft the pipeline task's `Pipeline` struct held a `*quarantine.Store`, quarantined untrusted mail in its step 3, and asserted a quarantine row in its very first test — while the `quarantine` package was created by the *following* task and was not even in the pipeline's Consumes list. It also used `TrustStore`/`sender_allowlist`, whose migration lived in that following task too. The pair was circular: neither could be implemented first. Quarantine and the allowlist migration now land here, before anything consumes them.

**Files:**
- Create: `internal/v2/pg/migrations/00007_quarantine.sql`
- Create: `internal/v2/quarantine/quarantine.go`, `internal/v2/quarantine/quarantine_test.go`
- Create: `internal/v2/api/quarantine.go`, `internal/v2/api/quarantine_test.go`

**Interfaces:**
- Consumes: Tasks 23 (`diag`), 25–26 (`origin.Origin`).
- Produces:

```go
type Item struct {
	ID           uuid.UUID
	UserID       uuid.UUID
	IngestID     []byte
	ReceivedAt   time.Time
	ExpiresAt    time.Time     // ReceivedAt + 30 days
	WarnedAt     *time.Time    // set 7 days before expiry
	OuterDomain  string
	InnerDomain  string
	Attested     bool
	AttestedBy   string
	DKIM, ARC    string
	SizeBucket   int
	Blob         []byte        // the raw message, padded, plaintext in Phase 1
}
type Store struct { Pool *pgxpool.Pool; TTL time.Duration; WarnBefore time.Duration; Now func() time.Time }
func (s *Store) Hold(ctx, it Item) error
func (s *Store) List(ctx, userID uuid.UUID, after time.Time, limit int) ([]Item, error)
func (s *Store) Confirm(ctx, userID uuid.UUID, domain, scope string) ([][]byte, error)
func (s *Store) ExpireDue(ctx) (warned int, deleted int, err error)
var ErrForwarderDomain = errors.New("refusing to allowlist a known forwarder as an outer origin")
```

**Rules (spec §3.2, §2 drop policy):**
- The quarantine table has **no chain columns and no `seq`** — it is deliberately outside the op log, so a quarantined message can never enter the integrity chains until it is confirmed.
- Its own sync channel: `GET /api/v1/quarantine?after=<rfc3339>&limit=<n>` returns items with the verified origin fields and an explicit `attested: bool` plus `attested_by`, so the client's "trust this sender" sheet can show the **verified signing domain — or a prominent unauthenticated state** rather than attacker-rendered content. The endpoint returns the raw blob only when `?include_blob=1`, so the default listing is cheap.
- **Never pushes.** There is no code path from `quarantine.Hold` to `pushv2`.
- Expiry is 30 days. `ExpireDue` runs hourly: it sets `warned_at` on items within `WarnBefore` (7 days) of expiry — which is what the client surfaces as "action needed" — and deletes only items past `expires_at` **that have been warned**. An unwarned item is never deleted, so a client that has not synced in a month cannot be silently pruned out from under.
- `POST /api/v1/quarantine/confirm {domain, scope:"outer"|"inner"}` inserts a `sender_allowlist` row for the **verified** domain and returns the ingest ids of every held message from that origin. Task 30's `Reprocess` re-runs ingest for them and appends the results as normal ops — they enter the chains at that point, exactly as spec §3.2 requires.
- **`scope:"outer"` refuses a known forwarder domain.** §3.2:51 exists to stop a user allowlisting `gmail.com` and thereby trusting anything that passes through their mailbox; an API that accepts `{domain:"gmail.com", scope:"outer"}` hands them exactly that. The closed refusal list is `gmail.com`, `googlemail.com`, `icloud.com`, `me.com`, `mac.com`, `outlook.com`, `hotmail.com`, `live.com`, `yahoo.com`, `proton.me`, `protonmail.com`, `zoho.com`, `fastmail.com`. The API returns `409` with `ErrForwarderDomain` and a message directing the user to confirm the **inner** origin instead, which requires the item to be `Attested`.
- **Gmail's forward-verification email lands here.** Spec §3.2:47 says the confirmation link is surfaced in-app during onboarding — but that mail arrives from `forwarding-noreply@google.com`, which is not the user's bank and is not allowlisted, so it quarantines like everything else. It is retrievable via `GET /api/v1/quarantine?include_blob=1` and that is the Phase 1 path: Task D6's onboarding step reads the link out of the admin console. Stating it here because "the onboarding flow silently depends on reading a quarantined message" is exactly the kind of thing that is discovered at 2 a.m. with an alpha on the phone.

Schema: `quarantine(id uuid pk, user_id uuid references users on delete cascade, ingest_id bytea, received_at, expires_at, warned_at, outer_domain, inner_domain, attested bool, attested_by text, dkim text, arc text, size_bucket int, blob bytea)`; `sender_allowlist(user_id, domain, scope, created_at, primary key (user_id, domain, scope))`.

- [ ] **Step 1: Write the failing tests**

```go
func TestQuarantineHasNoChainColumns(t *testing.T) {
	pool := pgtest.New(t)
	var n int
	pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
	  WHERE table_name='quarantine' AND column_name IN ('seq','blob_hash','prev_hash','writer_counter')`).Scan(&n)
	if n != 0 { t.Fatal("quarantine must stay outside the op log and its chains") }
}

func TestExpiryWarnsBeforeDeleting(t *testing.T)      { /* day 23: warned=1, deleted=0; day 31: deleted=1 */ }
func TestUnwarnedItemIsNeverDeleted(t *testing.T)     { /* expires_at in the past, warned_at NULL -> 0 deleted */ }
func TestConfirmReturnsEveryHeldIngestIDForThatOrigin(t *testing.T) { /* 3 held -> 3 ids */ }

func TestConfirmRefusesAForwarderDomainAsOuter(t *testing.T) {
	if _, err := s.Confirm(ctx, u, "gmail.com", "outer"); !errors.Is(err, ErrForwarderDomain) {
		t.Fatal("allowlisting a forwarder as an outer origin is exactly what §3.2:51 forbids")
	}
	// and the inner scope still works for an attested item
	if _, err := s.Confirm(ctx, u, "dib.ae", "inner"); err != nil { t.Fatal(err) }
}

func TestConfirmInnerRequiresAnAttestedItem(t *testing.T) { /* unattested -> error */ }

func TestListSurfacesAttestationStateRatherThanContent(t *testing.T) {
	// response JSON has attested/attested_by/dkim/arc/outer_domain and
	// no subject/body fields unless ?include_blob=1
}
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/quarantine/ -v`
Expected: FAIL — `undefined: Store`.

- [ ] **Step 3: Implement the migration, the store and the handlers.** Start `ExpireDue` on an hourly ticker in `runServe`.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/quarantine/ ./internal/v2/api/ -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/quarantine internal/v2/api/quarantine.go internal/v2/pg/migrations/00007_quarantine.sql
git commit -m "feat(v2): chain-free quarantine store with warned expiry and forwarder-safe confirmation"
```

---

### Task 28: Port the heuristic tier

> Split out of the old Task 26, which bundled the heuristic port, a ten-step pipeline, `Reprocess` and seven tests into one task consuming ten prior ones.

**Files:**
- Create: `internal/v2/heuristic/heuristic.go`, `internal/v2/heuristic/heuristic_test.go`

**Interfaces:**
- Consumes: `tmpl.Extraction` (Task 19).
- Produces: `func Parse(normalized string) (tmpl.Extraction, error)` — a direct port of v1's `internal/parse/heuristic.go`, with one behavioral change mandated by spec §3.2:54: **every heuristic result carries `NeedsReview = true`**, always, with no threshold and no override.

**The regex dialect does not apply here (Decision 16), and that is a deliberate call rather than an oversight.** v1's three heuristic patterns use `\b` and quantified alternation, which the dialect bans — but the bans exist to stop **Go/JS divergence** and **JS catastrophic backtracking**, and neither applies:
- The heuristic is never published, never distributed, and never executed by a client. There is no second executor to diverge from.
- Go's RE2 cannot backtrack, so an attacker-supplied body cannot make these patterns expensive in the only engine that runs them.

Converting them now would be a rewrite in service of an executor that does not exist, and worse, it would have to be validated against a corpus gate the plan does not have for the heuristic tier.

**The consequence is stated, not hidden.** Spec §3.5:103 requires the two executors to agree, and the conformance suite covers the **template** rung only. A Phase 2 client reprocessing a heuristic-parsed message therefore cannot reproduce the server's result. Two things follow, and both belong in the code as comments and in the Phase 2 plan:
1. Heuristic results are `needs_review` anyway, so the divergence surfaces to the user as a review item rather than as a silently different number.
2. Before client-side reprocessing ships, the heuristic must be converted to the dialect **and** entered into the conformance suite. Until then, a client must skip reprocessing any transaction whose `tier == "heuristic"`.

- [ ] **Step 1: Copy v1's tests and add the always-review case**

```go
func TestHeuristicResultsAreAlwaysNeedsReview(t *testing.T) {
	for _, body := range []string{
		"AED 250.00 debited", "USD 10.00 credited to your account", "Total: 1,234.56",
	} {
		e, err := Parse(body)
		if err != nil { t.Fatal(err) }
		if !e.NeedsReview {
			t.Fatalf("spec §3.2 requires every heuristic result to be needs_review: %q", body)
		}
	}
}

func TestHeuristicFindsAmountDirectionDateMerchant(t *testing.T) { /* ported from v1 */ }
func TestHeuristicErrorsWhenNoAmountIsPresent(t *testing.T)      { /* nothing to record */ }
func TestHeuristicIsUAEShapedAndSaysSo(t *testing.T) {
	// a EUR-denominated promotional email still parses as an amount — which is
	// exactly why §3.2 forces needs_review. Document the limitation with a test
	// rather than a comment nobody reads.
}
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/heuristic/ -v`
Expected: FAIL — `undefined: Parse`.

- [ ] **Step 3: Port `heuristic.go`** from `internal/parse/heuristic.go`, keeping its regexes byte-for-byte, returning a `tmpl.Extraction` with `Tier = "heuristic"` and `NeedsReview = true`. Add the package doc comment recording Decision 16 and its two consequences.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/heuristic/ -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/heuristic
git commit -m "feat(v2): port the bank-agnostic heuristic tier, always needs_review"
```

---

### Task 29: The ingest pipeline, and content-free push

> The push component was its own task in the first draft: three tests over a component that defaults to `Disabled` because no app exists yet, and whose `Pusher` interface the pipeline had to consume *before* the task that defined it. It is folded in here, where its single caller lives.

**Files:**
- Create: `internal/v2/ingest/pipeline.go`, `internal/v2/ingest/pipeline_test.go`
- Create: `internal/v2/pg/migrations/00008_push_tokens.sql`
- Create: `internal/v2/pushv2/push.go`, `internal/v2/pushv2/push_test.go`
- Create: `internal/v2/api/push.go`

**Interfaces:**
- Consumes: Tasks 4, 5, 8, 15, 19, 21, 22, 23, 24, 25, 26, 27, 28.
- Produces:
  - `type Pusher interface { Notify(ctx context.Context, userID uuid.UUID) error }` — **defined here**, with the pipeline that consumes it.
  - `type Pipeline struct { Store *tmpl.Store; Origin OriginResolver; Trust origin.TrustStore; Appender *oplog.Appender; Diag *diag.Diag; Quarantine *quarantine.Store; Push Pusher; Now func() time.Time }`
  - `func (p *Pipeline) Deliver(ctx context.Context, d smtpd.Delivery) error` — implements `smtpd.Handler`.
  - `func IngestID(raw []byte) []byte` — `SHA256(raw)`, the dedup key.
  - `pushv2.Expo` implementing `Pusher`; `pushv2.Disabled` as the Phase 1 default.
  - `POST /api/v1/push/tokens {token, platform}` and `DELETE /api/v1/push/tokens/{token}`.

**The pipeline, in order:**
1. `ingestID := IngestID(d.Raw)`. If an op with this ingest id already exists for this user → record `event='arrival'`, `outcome='duplicate'` and return (idempotent redelivery; SMTP retries are normal).
2. `origin.Resolve(...)` → DKIM/ARC results, outer and (when attested) inner origin.
3. **Trusted-lane gate.** The message is trusted only if a `sender_allowlist` row exists for this user matching the **verified** outer domain, or the **attested** inner domain (direct DKIM or ARC — Task 26). Anything else — including a message whose only claim to a bank identity is an unverified header or an unwrapped `From:` line — goes to quarantine with `outcome='quarantined'`, **no push**, and a diagnostics row. Grace-window deliveries (Task 22) inherit the old address's allowlist.
4. `norm.Normalize(norm.CurrentVersion, d.Raw, d.ReceivedAt)`. On error → quarantine with `reject_reason='normalize_error'`.
5. Template tier: for each published template whose `Match.SenderDomain` suffix-matches the **verified** domain, `tmpl.Execute(def, res.Subject, res.Text)` — the **effective** subject from the normalizer (inner when forwarded, Decision 14). First match with a passing `ValidateExtraction` wins; `Tier = "template"`, `NeedsReview = false`. When `DateFrom == "email"`, `PostedAt = res.EmailDate`.
6. Heuristic tier: `heuristic.Parse(res.Text)`. `Tier = "heuristic"`, `NeedsReview = true`, always.
7. Nothing matched → the op is still appended, with `Tier = "none"`, `NeedsReview = true` and `unparsed: true` in the payload. **Nothing is dropped.**
8. Append **two** ops in one `AppendIngest` call: a `hot` blob carrying the `txn_ingested` op, and a `cold` blob carrying an `oplog.RawBody` record (gzipped by the sealer). Both use the `ingest` writer; because chains are per `(writer_id, stream)` (Decision 13), the hot row gets the next **hot** ingest counter and the cold row the next **cold** ingest counter — they are not two consecutive numbers in one sequence. The cold blob carries a raw body and never an op (invariant I16), which is what lets a hot-only client materialize completely.
9. Record the diagnostics row: `event='arrival'`, `outcome='appended'`.
10. Fire a content-free push for **hot-stream appends only**.

**Push rules:** the request body sent to Expo is exactly `{"to": tok, "title": "New transaction", "body": ""}` — **no amount, no merchant, no count, no category, ever.** Push fires only from step 10; there is no other caller. Delivery failures are logged and never block the append. `cfg.Push.Enabled` defaults to false, so the Phase 1 wiring is `Disabled` — the point of building it now is that the *call site* and the content-free contract are pinned by tests before an app exists to make them convenient to bend.

- [ ] **Step 1: Write the failing tests**

```go
func TestUntrustedSenderIsQuarantinedNotAppended(t *testing.T) { /* op_log empty, quarantine has 1 */ }

func TestTrustedSenderAppendsHotAndColdOnIndependentChains(t *testing.T) {
	// two rows; streams hot+cold; both writer_id="ingest";
	// hot writer_counter == 1 AND cold writer_counter == 1 — NOT 1 and 2.
	// A second delivery makes them 2 and 2.
}

func TestColdBlobDecodesAsARawBodyNeverAsOps(t *testing.T) { /* invariant I16 at the source */ }
func TestUnparseableMailIsStillAppendedAsUnparsed(t *testing.T)  { /* never dropped */ }
func TestHeuristicResultsAreAlwaysNeedsReview(t *testing.T)      { /* payload needs_review == true */ }
func TestRedeliveryOfTheSameMessageIsIdempotent(t *testing.T)    { /* two Deliver calls -> 2 ops total */ }
func TestQuarantinedMailNeverPushes(t *testing.T)                { /* the fake Pusher records zero calls */ }

func TestForwardedMailUsesTheInnerSubjectForLast4(t *testing.T) {
	// an Apple-Mail-forwarded ENBD alert: last4 comes from the inner subject.
	// With the outer envelope subject this field is silently empty (Decision 14).
}

func TestATrustDecisionNeverReadsTheUnwrappedFrom(t *testing.T) {
	// a body carrying a forged "Begin forwarded message:\nFrom: alerts@dib.ae"
	// from an unsigned sender -> quarantined
}

func TestPushPayloadIsContentFree(t *testing.T) {
	var captured []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured, _ = io.ReadAll(r.Body); w.Write([]byte(`{"data":[{"status":"ok"}]}`))
	}))
	defer srv.Close()
	p := &pushv2.Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool}
	if err := p.Notify(ctx, user); err != nil { t.Fatal(err) }
	for _, forbidden := range []string{"250.00", "CARREFOUR", "AED", "debit"} {
		if bytes.Contains(captured, []byte(forbidden)) {
			t.Fatalf("push payload leaked %q: %s", forbidden, captured)
		}
	}
}

func TestPushFailureDoesNotPropagate(t *testing.T)            { /* 500 from Expo -> Notify returns nil, logs */ }
func TestTokenRegistrationIsScopedToTheSession(t *testing.T)  { /* user A cannot delete user B's token */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/ingest/ -v`
Expected: FAIL — package does not compile.

- [ ] **Step 3: Implement `pushv2` and the migration**, then `pipeline.go`.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/ingest/ ./internal/v2/pushv2/ -race -v`
Expected: PASS (12 tests).

- [ ] **Step 5: Run the whole gate**

Run: `bash scripts/v2-check.sh`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add internal/v2/ingest internal/v2/pushv2 internal/v2/api/push.go internal/v2/pg/migrations/00008_push_tokens.sql
git commit -m "feat(v2): ingest pipeline - trusted lane, cascade, hot+cold ops, content-free push"
```

---

### Task 30: Server-side reprocess (PHASE 1 ONLY)

> Split out of the old Task 26. It is separated not only for size but because it is the one part of the ingest path with a **known expiry date**, and bundling it with the pipeline made that invisible.

**Files:**
- Create: `internal/v2/ingest/reprocess.go`, `internal/v2/ingest/reprocess_test.go`
- Create: `docs/superpowers/specs/v2-phase1-only-inventory.md`

**Interfaces:**
- Consumes: Task 29's `Pipeline`, Task 27's `Confirm`, Tasks 19/21.
- Produces:
  - `func (p *Pipeline) Reprocess(ctx, userID uuid.UUID, ingestIDs [][]byte) (Report, error)` — re-reads the raw body from the **cold stream**, re-runs pipeline steps 4–7, and appends a `txn_superseded` op **keyed by the same ingest id** when any of the eight compared fields differ. Identical results append nothing and record `event='reprocess'`, `outcome='unchanged'`.
  - `type Report struct { Examined, Superseded, Unchanged, Failed int }`

**⚠ PHASE 1 ONLY — this code is deleted at the Phase 3 cutover.** Put that banner at the top of the file, and put the reasoning in `v2-phase1-only-inventory.md`:

> Cold blobs are HPKE-sealed to the user's public key from Phase 3 onward. The server holds no private key, so a server-side read path over cold bodies is not "hard" in Phase 3 — it is **structurally impossible**. Everything in this document is scaffolding for the unencrypted alpha phase and must be deleted, not migrated.
>
> The Phase-1-only inventory:
> 1. `ingest.Pipeline.Reprocess` (this task) — server-side re-parse over cold bodies.
> 2. `quarantine.Confirm` → `Reprocess` (Task 27) — re-ingest of held mail after a sender is trusted.
> 3. `samples.Donate` pulling the raw body from the user's cold stream (Task 31).
> 4. `ledgerd parse-rate` adjudication over unparsed cold bodies (Task 36).
>
> **What replaces them.** Spec §3.5:109 puts reprocessing on the client, over its own decrypted, chain-verified cold bodies. Phase 1 builds the *verification* half of that (Task 10's `verifyHashList`/`verifyFetchedRange`, Task 14's `pull-cold-hashes`, invariant `I3b_cold_hash_list`) precisely so Phase 2 has a safe foundation; it does not build the *reprocessing* half. Quarantine confirmation in Phase 3 becomes: the server returns the held ciphertext to the client, the client re-parses locally and uploads the resulting ops under its own writer.
>
> The plan explicitly rejected the throwaway PWA materialized view on the grounds that "a server-side materialized view is exactly the plaintext read path Phase 3 must delete." These four paths are the same category of thing. The difference is that they are **enumerated, banner-marked and dated** rather than assumed to be temporary.

- [ ] **Step 1: Write the failing tests**

```go
func TestReprocessEmitsASupersedeKeyedByIngestID(t *testing.T) {
	// publish a corrected template, Reprocess, assert one txn_superseded with the
	// same ingest_id and that replay leaves exactly one live transaction
}

func TestReprocessAppendsNothingWhenTheResultIsIdentical(t *testing.T) {
	// Report.Unchanged == 1, op_log length unchanged, one event='reprocess'
	// diagnostics row with outcome='unchanged'
}

func TestReprocessReadsTheColdStreamNotTheOriginalDelivery(t *testing.T) {
	// the only source of the raw body is the cold blob, which is what makes the
	// Phase 3 impossibility concrete rather than theoretical
}

func TestConfirmThenReprocessMovesQuarantinedMailIntoTheChains(t *testing.T) {
	// 3 quarantined -> Confirm -> Reprocess -> 3 hot + 3 cold ops, and 3
	// event='reprocess' diagnostics rows with outcome='appended'
}

func TestReprocessSupersedeRecomputesFXAtItsOwnPosition(t *testing.T) {
	// end-to-end with the client's replay: the superseding txn's
	// amount_home_minor is computed fresh, never inherited (spec §3.7:128)
}
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/ingest/ -run Reprocess -v`
Expected: FAIL — `undefined: Reprocess`.

- [ ] **Step 3: Implement `reprocess.go`** and write `docs/superpowers/specs/v2-phase1-only-inventory.md`.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/ingest/ -race -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/v2/ingest/reprocess.go internal/v2/ingest/reprocess_test.go \
        docs/superpowers/specs/v2-phase1-only-inventory.md
git commit -m "feat(v2): server-side reprocess with ingest-id supersede, marked Phase-1-only"
```
---

## Part F — Admin, intake, data rights, relay, verification

### Task 31: Donated samples intake

> Moved ahead of the admin console, which consumes `samples.ForSender` for its template-validation endpoint. The first draft had the admin task listing a later task in its Consumes line.

**Files:**
- Create: `internal/v2/pg/migrations/00009_donated_samples.sql`
- Create: `internal/v2/samples/samples.go`, `internal/v2/samples/samples_test.go`
- Create: `internal/v2/api/samples.go`

**Interfaces:**
- Consumes: Task 23 (`StructureSig`), Task 30 (the cold-stream read).
- Produces:
  - `type Sample struct { ID uuid.UUID; UserID uuid.UUID; SenderDomain string; StructureSig string; Raw []byte; Consent string; CreatedAt time.Time }`
  - `func (s *Samples) Donate(ctx, sample Sample) error` — requires a non-empty `Consent` string recording *what* the user agreed to and when; a sample without it is rejected.
  - `func (s *Samples) Clusters(ctx) ([]Cluster, error)` — `{sender_domain, structure_sig, user_count, sample_count, first_seen}`, ordered by `user_count DESC`. This is §3.5's "14 users hitting an untemplated FAB credit-card format" view.
  - `func (s *Samples) ForSender(ctx, domain string) ([]Sample, error)` — the corpus Task 32's `validate` replays over.
  - `POST /api/v1/samples/report {sender_domain, structure_sig}` — the **default**, content-free path.
  - `POST /api/v1/samples/donate {ingest_id, consent}` — the opt-in, content-bearing path; the server pulls the raw body from the user's own cold stream rather than accepting an upload, so a donation can never introduce content the user did not actually receive. **PHASE 1 ONLY** — item 3 in Task 30's inventory; from Phase 3 the client uploads the decrypted sample itself after showing the redaction preview.

- [ ] **Step 1: Write the failing tests**

```go
func TestDonateRequiresRecordedConsent(t *testing.T)  { /* empty consent -> error, nothing stored */ }
func TestReportPathStoresNoRawBody(t *testing.T)      { /* raw IS NULL for a structure-only report */ }
func TestClustersCountDistinctUsersNotSamples(t *testing.T) {
	// user A donates 5 samples of one sig, user B donates 1 -> user_count 2, sample_count 6
}
func TestDonateOnlyAcceptsAnIngestIDTheUserActuallyReceived(t *testing.T) {
	// user A donating user B's ingest_id -> error, nothing stored
}
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/samples/ -v`
Expected: FAIL — `undefined: Samples`.

- [ ] **Step 3: Implement the package, migration and handlers**, with the Phase-1-only banner on the cold-stream read.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/samples/ -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/samples internal/v2/api/samples.go internal/v2/pg/migrations/00009_donated_samples.sql
git commit -m "feat(v2): donated-sample intake with content-free structural reports and consent records"
```

---

### Task 32: Admin console API (Tailscale-bound)

**Files:**
- Create: `internal/v2/admin/admin.go`, `internal/v2/admin/admin_test.go`
- Create: `internal/v2/pg/migrations/00010_waitlist.sql`
- Modify: `cmd/ledgerd/main.go` (second listener on `cfg.Server.AdminListen`)

**Interfaces:**
- Consumes: Tasks 19, 21, 23, 30, 31.
- Produces:

```
GET  /admin/templates                          -> all versions, all statuses
POST /admin/templates            {definition}  -> 201; runs ValidateDefinition + ValidatePattern
POST /admin/templates/{id}/{ver}/validate      -> replays the definition over every donated
                                                  sample for its sender and returns per-sample results
POST /admin/templates/{id}/{ver}/publish       -> published; refuses if any sample regresses
POST /admin/templates/{id}/{ver}/reprocess     -> runs Task 30's Reprocess for affected ingest ids
GET  /admin/diagnostics?from&to&user&outcome   -> paged diagnostics rows
GET  /admin/accounting?from&to                 -> the "every email accounted for" report (Task 36)
GET  /admin/quarantine?user&include_blob=1     -> the operator's view, incl. Gmail's verification mail
GET  /admin/waitlist                           -> {bank, count, first_seen}
POST /admin/waitlist                {bank}     -> record demand (called by onboarding)
```

**Binding rule, enforced in code and tested:** the admin listener defaults to `127.0.0.1:8079` and `runServe` **refuses to start** if `AdminListen` resolves to a non-loopback, non-Tailscale (`100.64.0.0/10`) address. Spec §3.1: admin stays tailnet-only. Auth is a static bearer token from `LEDGER_ADMIN_TOKEN`, compared with `subtle.ConstantTimeCompare`; the binding restriction, not the token, is the real control.

- [ ] **Step 1: Write the failing tests**

```go
func TestAdminListenerRefusesAPublicBind(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:8079", ":8079", "178.104.132.41:8079"} {
		if err := checkAdminBind(addr); err == nil {
			t.Fatalf("admin must refuse %q (spec §3.1: tailnet-only)", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1:8079", "100.100.215.38:8079"} {
		if err := checkAdminBind(addr); err != nil { t.Fatalf("%q: %v", addr, err) }
	}
}

func TestPublishRefusesWhenAValidationSampleRegresses(t *testing.T) {
	// two donated samples pass under v1; author a v2 that breaks one -> publish 409
}

func TestAdminRequiresTheBearerToken(t *testing.T) { /* 401 without, 200 with */ }
func TestRepublishCanTriggerReprocess(t *testing.T) { /* the endpoint returns a Task 30 Report */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/admin/ -v`
Expected: FAIL — `undefined: checkAdminBind`.

- [ ] **Step 3: Implement `admin.go`,** the waitlist migration, and the second listener.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/admin/ -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/admin internal/v2/pg/migrations/00010_waitlist.sql cmd/ledgerd
git commit -m "feat(v2): tailnet-bound admin API for template authoring, publishing and diagnostics"
```

---

### Task 33: Merchant dictionary — k=3 threshold, moderation, no user linkage

**Files:**
- Create: `internal/v2/pg/migrations/00011_merchant_dictionary.sql`
- Create: `internal/v2/dict/dict.go`, `internal/v2/dict/dict_test.go`
- Create: `internal/v2/api/dict.go`, `internal/v2/admin/dict.go`
- Modify: `cmd/ledgerd/main.go` (`runSeedDictionary`)

**Interfaces:**
- Consumes: `internal/v2/corpus` (Task 2) for the operator seed; `LEDGER_DICT_HMAC_KEY` (Task 3).
- Produces:
  - `const K = 3` — the suppression threshold (Decision 8).
  - `type Dict struct { Pool *pgxpool.Pool; HMACKey []byte }`
  - `func (d *Dict) Submit(ctx, userID uuid.UUID, pattern, category string) error`
  - `func (d *Dict) Moderate(ctx, pattern, category string, approved bool, note string) error` — admin only.
  - `func (d *Dict) Published(ctx) ([]Entry, error)` — only entries that are **both** moderator-approved **and** have `distinct_submitter_count >= K`.
  - `func (d *Dict) SeedFromV1(ctx, rules []Entry) error` — one-shot import of the operator's existing rules, marked `source='operator_seed'`, which bypasses the k-gate because it is one identified operator's own data contributed deliberately, not a crowd signal.
  - `func (d *Dict) ForgetSubmitter(ctx, userID uuid.UUID) (int, error)` — used by Task 34's purge.
  - `GET /api/v1/dictionary?since=<version>` → `{version, entries:[{pattern, match, category}]}`.

**The submissions table stores no `user_id`.** Spec §3.6:115 says the dictionary is "a bare merchant pattern, **never user-linked**", and §2's breach inventory promises "no amounts or merchants". Storing `(pattern, category, user_id)` and keeping it is precisely a **per-user merchant ledger** — a worse disclosure than `parse_diagnostics`, undisclosed in §2, and the exact thing §3.6 forbids. Instead:

```sql
CREATE TABLE dict_submissions (
  pattern        text NOT NULL,
  category       text NOT NULL,
  submitter_hmac bytea NOT NULL,   -- HMAC-SHA256(key, user_id || 0x00 || pattern)
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pattern, category, submitter_hmac)
);
```

- The HMAC is keyed by `LEDGER_DICT_HMAC_KEY` (env-only) and **salted per pattern**, so it counts distinct submitters for one pattern and gives no cross-pattern linkage: two rows for the same user under different patterns are unrelatable.
- **Rows are deleted the moment an entry publishes**, leaving only `dict_entries(pattern, category, distinct_count, approved, source, published_at)`. The submitter identifiers exist exactly as long as the counting requires.
- **The honest caveat, which §2 must carry (Task 23 step 5).** With 3–5 alpha users the operator can brute-force its own user list against the HMAC and recover who submitted a pattern, for as long as the row exists. The HMAC is not a privacy guarantee at this scale; it removes the *stored* linkage and bounds its lifetime, and §2 says so rather than implying more.
- `Purge` (Task 34) cannot find these rows by `user_id` because there is none. `ForgetSubmitter` recomputes the HMAC for the purged user against every distinct `pattern` in the table — a few thousand HMACs, microseconds — and deletes the matches. There is a test for exactly this, because a purge that silently misses a table is the failure mode Task 34's schema discovery exists to prevent.

**Client-side matching is Phase 2.** Phase 1 ships the store, the gates and the distribution endpoint only.

- [ ] **Step 1: Write the failing tests**

```go
func TestDictionaryStoresNoUserID(t *testing.T) {
	pool := pgtest.New(t)
	var n int
	pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
	  WHERE table_name IN ('dict_submissions','dict_entries') AND column_name='user_id'`).Scan(&n)
	if n != 0 {
		t.Fatal("spec §3.6: a merchant pattern is never user-linked; storing user_id here " +
			"builds a per-user merchant ledger the privacy page does not disclose")
	}
}

func TestEntryIsSuppressedBelowK(t *testing.T) {
	d := &Dict{Pool: pgtest.New(t), HMACKey: testKey}
	for i := 0; i < 2; i++ { d.Submit(ctx, users[i], "CARREFOUR", "groceries") }
	d.Moderate(ctx, "CARREFOUR", "groceries", true, "")
	if got, _ := d.Published(ctx); len(got) != 0 {
		t.Fatalf("k=%d not reached; entry must stay suppressed, got %v", K, got)
	}
	d.Submit(ctx, users[2], "CARREFOUR", "groceries")
	if got, _ := d.Published(ctx); len(got) != 1 {
		t.Fatalf("k reached; entry must publish, got %v", got)
	}
}

func TestRepeatedSubmissionsFromOneUserDoNotReachK(t *testing.T) {
	// same user submits 5 times -> the primary key collapses them, count stays 1
}

func TestSubmitterHMACsAreNotLinkableAcrossPatterns(t *testing.T) {
	// the same user's HMAC for "CARREFOUR" != their HMAC for "SPINNEYS"
}

func TestPublicationDeletesTheSubmitterRows(t *testing.T) {
	// after Published() promotes an entry, dict_submissions holds 0 rows for it
}

func TestForgetSubmitterRemovesAPurgedUsersSubmissions(t *testing.T) { /* ... */ }
func TestUnmoderatedEntryNeverPublishesEvenAboveK(t *testing.T)      { /* poisoning gate */ }
func TestOperatorSeedBypassesKButNotModeration(t *testing.T)         { /* ... */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/dict/ -v`
Expected: FAIL — `undefined: Dict`.

- [ ] **Step 3: Implement the package, migration, handlers and `runSeedDictionary`.**

- [ ] **Step 4: Seed from v1's rules**

```bash
S=/tmp/claude-0/-root-Coding-ledger/bcc8cb5e-1dd4-451e-94e9-031572dd88c7/scratchpad
LEDGER_CORPUS_DB=$S/corpus.db LEDGER_PG_DSN="$TEST_DSN" LEDGER_DICT_HMAC_KEY=$(openssl rand -hex 32) \
  go run ./cmd/ledgerd seed-dictionary
```
Expected: prints `seeded N operator rules` where N matches `sqlite3 $S/corpus.db "select count(*) from rules"`.

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/v2/dict/ -v`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add internal/v2/dict internal/v2/api/dict.go internal/v2/admin/dict.go \
        internal/v2/pg/migrations/00011_merchant_dictionary.sql cmd/ledgerd
git commit -m "feat(v2): moderated merchant dictionary with k=3 suppression and no stored user linkage"
```

---

### Task 34: Account purge and retention enforcement

**Files:**
- Create: `internal/v2/purge/purge.go`, `internal/v2/purge/purge_test.go`
- Create: `internal/v2/api/account.go`
- Modify: `cmd/ledgerd/main.go` (`runPurgeUser`)

**Interfaces:**
- Consumes: every table created so far.
- Produces:
  - `func Purge(ctx context.Context, pool *pgxpool.Pool, d *dict.Dict, userID uuid.UUID) (Report, error)` — deletes the user's rows from **every** user-scoped table and returns per-table counts.
  - `func UserScopedTables(ctx context.Context, pool *pgxpool.Pool) ([]string, error)` — discovers them by querying `information_schema.columns` for a `user_id` column. The purge iterates this list, so a table added in a later task cannot be silently forgotten.
  - `func EnforceRetention(ctx context.Context, pool *pgxpool.Pool, cutoff time.Time) (Report, error)` — Phase 1's plaintext-retention commitment: purges any user whose consent record's retention deadline has passed.
  - `DELETE /api/v1/account` — requires a **fresh** IdP re-authentication (an `id_token` whose `iat` is within the last 5 minutes) **plus** a writer-key signature over a server challenge (spec §3.4). A session token alone is refused.
  - `ledgerd purge-user --user <uuid>` for operator use.

**Two tables have no `user_id` and must be handled explicitly, with a test that fails if either is forgotten:** `dict_submissions` (Task 33 — via `dict.ForgetSubmitter`) and `smtp_rejections` (Task 23 — aggregated and never user-linked, so nothing to delete; assert that deliberately rather than by omission).

- [ ] **Step 1: Write the failing tests**

```go
func TestPurgeLeavesNoRowInAnyUserScopedTable(t *testing.T) {
	pool := pgtest.New(t)
	u := seedAFullyPopulatedUser(t, pool)  // ops, quarantine, diagnostics, sessions,
	                                       // writers, key history, addresses, push tokens,
	                                       // samples, dictionary submissions
	if _, err := Purge(ctx, pool, dict, u); err != nil { t.Fatal(err) }
	tables, _ := UserScopedTables(ctx, pool)
	if len(tables) < 9 { t.Fatalf("expected to discover the user-scoped tables, found %v", tables) }
	for _, tb := range tables {
		var n int
		pool.QueryRow(ctx, "SELECT count(*) FROM "+tb+" WHERE user_id=$1", u).Scan(&n)
		if n != 0 { t.Fatalf("table %s still holds %d rows for the purged user", tb, n) }
	}
	var users int
	pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id=$1`, u).Scan(&users)
	if users != 0 { t.Fatal("the users row itself must be gone") }
}

func TestPurgeAlsoClearsTablesWithNoUserIDColumn(t *testing.T) {
	// dict_submissions is keyed by an HMAC, so schema discovery cannot see it.
	// A purge that only iterates user_id columns silently leaves it behind.
	var n int
	pool.QueryRow(ctx, `SELECT count(*) FROM dict_submissions`).Scan(&n)
	if n != 0 { t.Fatalf("dict_submissions still holds %d rows for the purged user", n) }
}

func TestPurgeDoesNotTouchOtherUsers(t *testing.T)            { /* ... */ }
func TestDeleteAccountRefusesASessionTokenAlone(t *testing.T) { /* 403 without fresh re-auth + signature */ }
func TestDeleteAccountRefusesAStaleIDToken(t *testing.T)      { /* iat older than 5 minutes -> 403 */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/purge/ -v`
Expected: FAIL — `undefined: Purge`.

- [ ] **Step 3: Implement the package, handler and `runPurgeUser`.**

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/purge/ ./internal/v2/api/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/v2/purge internal/v2/api/account.go cmd/ledgerd
git commit -m "feat(v2): schema-discovering account purge and plaintext retention enforcement"
```

---

### Task 35: Relay mode

**Files:**
- Create: `internal/v2/relay/relay.go`, `internal/v2/relay/relay_test.go`
- Create: `internal/v2/api/relay.go` (the primary's side)
- Modify: `cmd/ledgerd/main.go` (`runRelay`)

**Interfaces:**
- Consumes: `smtpd` (Task 24), `Addresses` (Task 22), `ingest.Pipeline` (Task 29).
- Produces:
  - On the **primary**: `GET /api/v1/relay/addresses?since=<rfc3339>` → `{addresses:[{local_part, user_pubkey, expires_at}], as_of}` and `POST /api/v1/relay/deliver` accepting `{local_part, envelope_from, remote_ip, received_at, raw:<base64>}` — authenticated by `Authorization: Bearer $LEDGER_RELAY_TOKEN`, rate-limited, and 1 MB-capped like SMTP. `deliver` runs the ordinary `ingest.Pipeline.Deliver`, so relayed mail is **idempotent by ingest id** and indistinguishable downstream.
  - In **relay mode**: `type Relay struct { SpoolDir string; PrimaryURL string; Token string; HTTP *http.Client; Now func() time.Time }`
    - `func (r *Relay) SyncAddresses(ctx) (int, error)` — pulls the replica into `SpoolDir/addresses.json`; the relay holds **only** `inbound_address → user public key`, never op-log data.
    - `func (r *Relay) Deliver(ctx, d smtpd.Delivery) error` — implements `smtpd.Handler`; writes `SpoolDir/<ulid>.eml` and `<ulid>.json`, `fsync`s both **and the containing directory**, and returns success only after the fsync (an SMTP 250 must mean "durably spooled"; without the directory fsync the file name can be lost on power failure even though its contents are safe).
    - `func (r *Relay) Drain(ctx) (sent int, failed int, err error)` — POSTs each spooled message to the primary, deleting it **only** on a 2xx; a 4xx other than 429 moves it to `SpoolDir/rejected/` with the response body, never deletes it.
  - `runRelay` starts the SMTP receiver with the relay's handler, an address-sync ticker (5 min) and a drain ticker (1 min).

**Phase 1 is plaintext:** the relay spools the raw message unencrypted and forwards it. The `user_pubkey` column is carried in the replica **now, unused**, so Phase 3 seals at arrival without a schema or protocol change.

- [ ] **Step 1: Write the failing tests**

```go
func TestSpoolIsDurableBeforeAccepting(t *testing.T) {
	// Deliver returns only after both files exist on disk and the directory is
	// fsynced; kill-and-restart still finds them
}
func TestDrainDeletesOnlyOnSuccess(t *testing.T) {
	// primary returns 500 -> file remains; 200 -> file gone; 400 -> moved to rejected/
}
func TestDrainIsIdempotentAgainstThePrimary(t *testing.T) {
	// deliver the same spooled message twice -> primary appends one op (ingest-id dedup)
}
func TestRelayHoldsNoOpLogData(t *testing.T) {
	// the replica JSON has exactly {local_part, user_pubkey, expires_at} keys
}
func TestDeliverEndpointRejectsAWrongToken(t *testing.T) { /* 401 */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/relay/ -v`
Expected: FAIL — `undefined: Relay`.

- [ ] **Step 3: Implement both sides and `runRelay`.**

- [ ] **Step 4: Run the tests, then an end-to-end loop locally**

Run one `ledgerd serve` and one `ledgerd relay` (relay pointed at the primary, both on loopback ports), send a message to the relay's SMTP port with a small Go client, and assert the op appears in the primary's `op_log`.

Run: `go test ./internal/v2/relay/ -race -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/relay internal/v2/api/relay.go cmd/ledgerd
git commit -m "feat(v2): relay mode - address replica, durable spool, idempotent forward"
```

---

### Task 36: Server-side structural verifier, the mail-accounting report, and the parse-rate instrument

**Files:**
- Create: `internal/v2/verify/verify.go`, `internal/v2/verify/verify_test.go`
- Create: `internal/v2/verify/parserate.go`, `internal/v2/verify/parserate_test.go`
- Create: `internal/v2/pg/migrations/00012_parse_rate.sql`
- Create: `internal/v2/admin/accounting.go`
- Modify: `cmd/ledgerd/main.go` (`runVerify`, `runParseRate`)

**Interfaces:**
- Consumes: Tasks 5, 8, 23, 27, 30.
- Produces:
  - `type Finding struct { ID string; UserID uuid.UUID; Detail string }`
  - `func Structural(ctx context.Context, pool *pgxpool.Pool) ([]Finding, error)` — the four server-side invariants:
    - `S1_seq_dense`: per user, `count(*) == max(seq)` and `min(seq) == 1` — no gaps, ever.
    - `S2_ingest_chain`: per user **and per stream**, the `ingest` writer's counters are `1..N` and `blob_hash[n] == SHA256(blob_hash[n-1] ‖ blob[n])` recomputed from stored bytes. Chains are per `(writer_id, stream)` (Decision 13), so a single combined check would report a false break on every user.
    - `S3_aad_matches_row`: every blob's embedded AAD equals its row's `(user_id, stream, writer_id, writer_counter)`.
    - `S4_bucket_valid`: `octet_length(blob) == size_bucket` and `size_bucket` is one of the **seven** buckets.
  - `func Accounting(ctx context.Context, pool *pgxpool.Pool, from, to time.Time) (Report, error)` — **the exit-criterion instrument for "zero drops without notice"**. For the window it returns:
    - `inbound_total` — `event='arrival'` rows only,
    - the arrival split into `appended`, `quarantined`, `rejected`, `over_quota`, `duplicate`,
    - the reprocess split into `appended`, `superseded`, `unchanged`,
    - `protocol_rejections` from `smtp_rejections` (unknown RCPT — no user to scope a row to, Task 23),
    - and asserts `inbound_total == sum(arrival parts)`. A non-zero `unaccounted` is a hard failure.
  - `ledgerd verify [--user <uuid>] [--json]` — exits 1 on any finding.

**The parse-rate instrument (spec §5's ≥95% exit criterion).** This is the one exit criterion the first draft asserted without an instrument: it said "excluding non-transactional mail, counted from `parse_diagnostics`" — but diagnostics deliberately store no content, so **the denominator is not derivable from any recorded field.** Nothing in the schema knows whether an unparsed message was a bank alert or a newsletter. Define it properly:

- **Numerator:** `event='arrival'` rows in the window with `tier ∈ {template, heuristic}`.
- **Denominator:** numerator + the count of arrivals with `tier='none'` that an **operator has adjudicated as genuine transaction mail**.
- **The adjudication** is `ledgerd parse-rate --from --to [--user] [--sample N]`, which for each `tier='none'` arrival reads the cold body, prints the normalized text, and records a verdict in a new table:

```sql
CREATE TABLE parse_rate_adjudications (
  ingest_id  bytea NOT NULL,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verdict    text NOT NULL CHECK (verdict IN ('transaction','non_transactional','unreadable')),
  adjudicated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ingest_id, user_id)
);
```

- **Sampling protocol.** At alpha scale (3–5 users × single-digit bank alerts/day, plus whatever else lands) two weeks of `tier='none'` arrivals is low hundreds at most, so the default is to adjudicate **every** one and the reported rate has no sampling error. `--sample N` draws a uniform random sample when the population exceeds N (default 200) and the tool then reports the **Wilson 95% lower bound**; the exit gate is met only if that **lower bound** is ≥95%. A point estimate from a sample is not a gate.
- **What this measures and what it does not.** It measures parse **coverage** — did we extract a transaction from mail that carried one. It does **not** measure correctness: a template that matches and extracts the wrong amount counts as a success here. Correctness is Task 21's corpus gate plus alpha reports. Say so in the exit record rather than letting "95% parses" be read as "95% correct".
- **PHASE 1 ONLY** — item 4 in Task 30's inventory. It reads plaintext cold bodies, which Phase 3 makes impossible; the table is dropped at the cutover and §2 discloses it until then (Task 23 step 5).

- [ ] **Step 1: Write the failing tests**

```go
func TestS1DetectsAnInjectedGap(t *testing.T)  { /* append 5, DELETE seq=3 -> S1_seq_dense */ }
func TestS2DetectsATamperedIngestBlob(t *testing.T) { /* UPDATE op_log SET blob -> S2_ingest_chain */ }
func TestS2ChecksHotAndColdSeparately(t *testing.T) {
	// a healthy log with interleaved hot/cold ingest rows yields ZERO findings;
	// a combined-chain check would report a break on every one of them
}
func TestS3DetectsARowMovedToAnotherStream(t *testing.T) { /* UPDATE stream='cold' -> S3 */ }
func TestCleanDatabaseYieldsNoFindings(t *testing.T)     { /* ... */ }

func TestAccountingSeparatesArrivalsFromReprocessing(t *testing.T) {
	// 20 arrivals appended + 3 arrivals quarantined + 3 reprocess appended
	// -> inbound_total == 23, reprocess.appended == 3, unaccounted == 0
}
func TestAccountingFailsWhenAnOutcomeIsUnknown(t *testing.T) { /* outcome='' -> unaccounted == 1 */ }
func TestAccountingReportsProtocolRejections(t *testing.T)   { /* smtp_rejections surfaces */ }

func TestParseRateDenominatorRequiresAdjudication(t *testing.T) {
	// 10 parsed + 2 tier='none' with no adjudication -> the tool refuses to
	// report a rate and names the 2 unadjudicated ingest ids
}
func TestParseRateExcludesNonTransactionalMail(t *testing.T) {
	// 19 parsed, 1 tier='none' adjudicated 'transaction'   -> 95.0%
	// 19 parsed, 1 tier='none' adjudicated 'non_transactional' -> 100%
}
func TestParseRateUsesTheWilsonLowerBoundWhenSampled(t *testing.T) { /* ... */ }
```

- [ ] **Step 2: Run and watch fail**

Run: `go test ./internal/v2/verify/ -v`
Expected: FAIL — `undefined: Structural`.

- [ ] **Step 3: Implement `verify.go`, `parserate.go`, `accounting.go`, `runVerify` and `runParseRate`,** with the Phase-1-only banner on the adjudication path.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/v2/verify/ -v`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/v2/verify internal/v2/admin/accounting.go \
        internal/v2/pg/migrations/00012_parse_rate.sql cmd/ledgerd
git commit -m "feat(v2): structural verifier, inbound-mail accounting, and the parse-rate instrument"
```
---

## Part G — The exit test

> The first draft made this one task: a harness, an SMTP client, two client instances, a template republish and ten assertion groups. Its own self-review flagged that it might not fit one session and said "split the SMTP-driving half into its own task rather than trimming assertions." Taking that advice preemptively, because the failure mode it warns about — trimming assertions to fit — is exactly how an exit test stops being one.

### Task 37: The end-to-end harness

**Files:**
- Create: `client/test/e2e/harness.ts`
- Create: `client/test/e2e/smtp.ts`
- Create: `client/test/e2e/harness.test.ts`

**Interfaces:**
- Consumes: `cmd/ledgerd` (`serve --dev-auth --dns-fixtures`), `internal/v2/pgtest`, `client/src/*`.
- Produces:
  - `export async function startStack(): Promise<Stack>` — creates a scratch database, starts `ledgerd serve` on **scratch loopback ports** (never `:8080`, never `:25`, never `:443`), waits for `/api/v1/healthz`, and returns handles. Ports are taken from `LEDGER_E2E_HTTP_PORT`/`LEDGER_E2E_SMTP_PORT` with loopback-only defaults in the 18000–18999 range.
  - `export async function stopStack(s: Stack): Promise<void>` — SIGTERM, drop the database, assert no child process survives.
  - `export function clientFor(s: Stack, writerId: string): Client` — a `client/src/net/client.ts` instance with its own state directory under a temp dir.
  - `export async function sendMail(s: Stack, rcpt: string, raw: Uint8Array): Promise<{code: number; message: string}>` — a minimal SMTP client over `Bun.connect`: `EHLO`, `MAIL FROM`, `RCPT TO`, `DATA`, dot-stuffing, `QUIT`. It must dot-stuff correctly, because the corpus contains bodies with lines beginning `.` and a naive sender silently truncates them — which would then fail DKIM verification for a reason that looks like a crypto bug.
  - `export function corpusFixtures(kind: "enbd-stable" | "dib-unexpired" | "unknown-origin", n: number): Uint8Array[]` — reads `.eml` files written by Task 2.

**Fixture selection is a correctness requirement, not a convenience.** The 20 trusted-lane messages the exit scenario delivers must all still verify under DKIM **at the moment the test runs**, and `go-msgauth` enforces `x=` expiry with a clock no test can stub (Task 25). So `corpusFixtures("enbd-stable", 20)` draws from the **62 ENBD messages that carry no `x=` tag at all**, which can never expire. The DIB template path is covered by Task 21's full-corpus gate and by Task 25's canary-guarded DKIM test; it is deliberately not on the exit test's critical path, because a test that starts failing on an arbitrary future date is worse than one with narrower coverage.

- [ ] **Step 1: Write the harness self-test**

```ts
test("the stack starts, answers healthz, and binds only loopback scratch ports", async () => {
  const s = await startStack();
  expect((await fetch(`${s.httpURL}/api/v1/healthz`)).status).toBe(200);
  expect(s.httpURL).toMatch(/^http:\/\/127\.0\.0\.1:18\d\d\d$/);
  expect(s.smtpPort).toBeGreaterThan(18000);
  await stopStack(s);
});

test("the SMTP client dot-stuffs a body containing a leading-dot line", async () => {
  const s = await startStack();
  const raw = new TextEncoder().encode("Subject: t\r\n\r\nline1\r\n.hidden\r\nline3\r\n");
  const res = await sendMail(s, `u-unknown@in.example.test`, raw);
  expect(res.code).toBe(550);                 // unknown rcpt, but the transaction completed
  await stopStack(s);
});

test("two clients get independent state directories", async () => { /* ... */ });
test("stopStack leaves no ledgerd process and no scratch database", async () => { /* ... */ });
```

- [ ] **Step 2: Run and watch fail**

Run: `cd client && bun test test/e2e/harness.test.ts`
Expected: FAIL — cannot resolve `./harness`.

- [ ] **Step 3: Implement `harness.ts` and `smtp.ts`.**

- [ ] **Step 4: Run the tests**

Run: `cd client && bun test test/e2e/harness.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/test/e2e/harness.ts client/test/e2e/smtp.ts client/test/e2e/harness.test.ts
git commit -m "test(v2): end-to-end harness - scratch stack, SMTP client, multi-client fixtures"
```

---

### Task 38: The exit test — two concurrent writers and a supersede-after-template-fix round-trip

**Files:**
- Create: `client/test/e2e/exit.test.ts`
- Create: `docs/superpowers/specs/v2-phase1-exit-record.md` (the result record)

**Interfaces:**
- Consumes: everything.
- Produces: the executable form of spec §5's Phase 1 exit criterion.

**The scenario, exactly:**
1. Boot the stack (Task 37) against a fresh migrated database, with `--dns-fixtures internal/v2/origin/testdata/dns.json` so DKIM verification is deterministic and offline.
2. Create a user; enroll writer `dev-a`; enroll `dev-b` **signed by `dev-a`'s key** over `RegistrationMessage(nonce, "dev-b", pubB)`.
3. `dev-a` emits `home_currency_set(AED)` and `rate_set(USD, 3672500)`; push; pull on `dev-b`.
4. **Emit a writer checkpoint.** `dev-a` runs `cli checkpoint` and pushes; `dev-b` pulls. Assert the checkpoint op names a head for **every `(roster writer × stream)` pair — not merely every pair a writer has produced** — and that `checkAll` on `dev-b` no longer reports the `I11_roster_checkpoint` notice. Without this step I11 passes vacuously and spec §5's "both chains + checkpoints" is green with the feature entirely absent — which is what the first draft did.

   **`dev-b` has authored nothing at this point, and that is exactly why the pair set is the roster and not the observed chains.** A checkpoint built from observed heads cannot name `dev-b` — it has no head — so `I11` would hard-stop here and at step 6 forever, and no checkpoint any device could emit would clear it. `dev-b` is named at `counter: "0"` with the 64-zero genesis hash (see `CHECKPOINT_NAMES_THE_ROSTER` in `client/src/invariants/check.ts`). The earlier wording of this step made the exit criterion unreachable in its own configuration.
5. Deliver **20** real corpus messages over SMTP from an allowlisted, DKIM-verifiable origin — `corpusFixtures("enbd-stable", 20)`, the no-`x=` set that cannot expire. Assert 20 hot ops and 20 cold ops appended, 0 quarantined, and that the **hot ingest counters are 1..20 and the cold ingest counters are also 1..20** (per-stream chains, Decision 13).
6. **Hot-only pull.** `dev-b` runs `pull` with **no `--stream`**, i.e. hot only. Assert:
   - it receives exactly the 20 hot rows (plus the earlier client ops) and **zero cold bytes**;
   - the pulled `seq` values are strictly increasing but **not** globally contiguous — cold rows occupy the gaps;
   - `checkAll` reports **zero hard stops**, and specifically no `I1` and no `I2` violation;
   - the materialized state contains all 20 transactions.
   This is the property spec §3.3:70 actually requires and the one the first draft never exercised: it pulled both streams fully, so a design where hot-only sync was impossible would have passed.
7. Deliver 3 messages from an unknown origin. Assert 3 quarantine rows, **0 pushes**, 0 op-log rows. Confirm the sender via the API (`scope:"inner"`, since the origin is attested); assert the 3 messages are re-ingested and appear as ops, and that 3 `event='reprocess'` diagnostics rows exist with `outcome='appended'`.
8. **Forwarder refusal.** Attempt `POST /api/v1/quarantine/confirm {domain:"gmail.com", scope:"outer"}`. Assert `409` — §3.2:51's rule is enforced by the API, not by the user's judgment.
9. **Concurrent writers:** with both clients holding the same synced prefix, `dev-a` categorizes txn `T` as `groceries` and `dev-b` categorizes the same `T` as `dining`, both naming the same parent version, both offline. Push `dev-b` first, then `dev-a`. Both clients pull to the head.
   - Assert both clients materialize the **same** category (the later `authored_at`).
   - Assert both clients report exactly **one** `ForkNotice` — surfaced, not silent.
10. **Supersede after template fix:** publish a corrected template version for one of the 20 messages that changes its parsed amount and its currency (`USD` → `AED`). Run `Reprocess` (Task 30). Both clients pull.
    - Assert exactly one live transaction for that ingest id on both clients.
    - Assert the superseding transaction's `amount_home_minor` was computed **fresh at its own log position**, not inherited (the AED identity value, not the old USD conversion).
11. **Cold verification.** `dev-b` runs `pull-cold-hashes`, then fetches a single cold range. Assert the pinned head advances, `verifyFetchedRange` accepts the honest range, and a deliberately corrupted body in a re-fetch is rejected with `I3b_cold_hash_list`.
12. Run `checkAll` on both clients: **zero `hard_stop` violations**, and the notice list is printed in full.
13. Run `ledgerd verify`: **zero findings.**
14. Run the accounting report over the window and assert exactly:
    - `inbound_total == 23` (20 trusted + 3 quarantined; **arrivals only**),
    - `arrival.appended == 20`, `arrival.quarantined == 3`,
    - `reprocess.appended == 3` (step 7's re-ingest), `reprocess.superseded == 1` (step 10),
    - `unaccounted == 0`.
    The arrival/reprocess split is what makes this arithmetic well-defined; with one flat counter, 23 and 26 are both defensible and the instrument has a blind spot either way (Task 23).

- [ ] **Step 1: Write the failing test** implementing steps 2–14 above as one `test()` per numbered step, sharing a stack via `beforeAll`. Every assertion above is a spec requirement; **do not relax one to pass.** If a step cannot pass, the defect is upstream.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd client && bun test test/e2e/exit.test.ts`
Expected: FAIL on the first unimplemented seam — fix forward until green.

- [ ] **Step 3: Run the whole gate**

Run: `bash scripts/v2-check.sh && cd client && bun test test/e2e/exit.test.ts`
Expected: exit 0 for both.

- [ ] **Step 4: Record the run** in `docs/superpowers/specs/v2-phase1-exit-record.md`: date, commit, the fourteen step outcomes, the checkpoint contents, the fork notice contents, the two snapshot values from step 10, and the accounting numbers from step 14.

- [ ] **Step 5: Commit**

```bash
git add client/test/e2e/exit.test.ts docs/superpowers/specs/v2-phase1-exit-record.md
git commit -m "test(v2): Phase 1 exit test - hot-only pull, checkpoints, fork notice, supersede round-trip"
```

---

## Part H — Deployment tasks (blocked on the domain and the relay VPS)

These are separated because they cannot be completed from the keyboard alone: D1 needs the domain decision, D2–D3 need a purchased VPS, D4 needs D1, D6 needs real people. **Everything in Parts A–G proceeds without any of them.**

### Task D1: Choose the domain and publish DNS

- [ ] Decide the domain (spec §6 open question). Record it in `docs/superpowers/specs/2026-07-31-multi-user-beta-design.md` §6, replacing the open question.
- [ ] Publish DNS: `A`/`AAAA` for `<domain>` and `in.<domain>` → the Hetzner host; `MX 10 in.<domain>` → the primary; `TXT` SPF (`v=spf1 -all` — this domain never *sends*), `TXT _dmarc` (`v=DMARC1; p=reject; rua=...`); set the host's reverse DNS (rDNS/PTR) in the Hetzner console to `in.<domain>`.
- [ ] Verify: `dig +short MX in.<domain>` returns the primary, and `dig +short -x <ip>` returns `in.<domain>`.
- [ ] Set `LEDGER_MAIL_DOMAIN` in `/etc/ledger-v2/ledgerd.env`.

### Task D2: Probe inbound port 25 on the backup-relay provider (Phase 0 leftover)

Spec §3.2's precondition and §5's Phase 0 require confirming port 25 with **both** providers; `spike/phase0/RESULTS.md` covers the primary (Hetzner) only and names this as outstanding.

- [ ] Provision the cheapest IPv4-capable Vultr instance (research doc's primary recommendation; **not** the $2.50 IPv6-only tier).
- [ ] Run the identical probe from `spike/phase0/RESULTS.md` "Port 25": open the local firewall, bind a throwaway listener on `:25` and a `:2525` control, probe both from check-host.net with `max_nodes=5`, then clean up exactly as that document's Cleanup section does.
- [ ] Record the verdict in `spike/phase0/RESULTS.md` under a new "Port 25 — backup relay provider" section, with the raw JSON inlined the same way.
- [ ] **GO/NO-GO:** a NO-GO means falling back to Netcup and re-probing (the research doc flags Netcup's inbound status as community-sourced only), or re-opening spec §3.2's "disclose a plaintext spool window" branch. Do not deploy the relay before this is a GO.

### Task D3: Provision and deploy the relay

- [ ] Deploy `ledgerd relay` to the D2 host with a systemd unit modeled on `deploy/ledger.service` (same hardening: `ProtectSystem=strict`, `NoNewPrivileges`, a dedicated user, `AmbientCapabilities=CAP_NET_BIND_SERVICE` for `:25`).
- [ ] Add `MX 20 relay.<domain>` (lower priority than the primary's 10).
- [ ] Set `LEDGER_RELAY_TOKEN` on both hosts; confirm `SyncAddresses` pulls a non-empty replica.
- [ ] Verify end to end: stop `ledgerd serve` on the primary, send a message, confirm it spools on the relay, restart the primary, confirm `Drain` delivers it and the op appears — **and** that a second drain of the same message appends nothing.

### Task D4: TLS, firewall and the primary's systemd unit

- [ ] `ufw allow 25/tcp` and `ufw allow 443/tcp` (v4 and v6) on the primary; check the **Hetzner Cloud Firewall** panel separately — `spike/phase0/RESULTS.md` flags it as a second layer not inspected by the spike.
- [ ] Add autocert (`golang.org/x/crypto/acme/autocert`) to `runServe` for `<domain>`, with the cache directory in `/var/lib/ledger-v2/autocert` (0700). This is the one code change in Part H; it is here because issuance cannot be tested without the real domain.
- [ ] Create `/etc/ledger-v2/config.toml` and `/etc/ledger-v2/ledgerd.env` (0600, secrets env-only — including `LEDGER_ADMIN_TOKEN`, `LEDGER_RELAY_TOKEN` and `LEDGER_DICT_HMAC_KEY`), `deploy/ledgerd.service`, and `/var/lib/ledger-v2` (0700).
- [ ] Verify the running process is the new binary (inode/PID check, per the deploy runbook's convention), that `:8080` and `/var/lib/ledger` are untouched, and that `curl https://<domain>/api/v1/healthz` returns 200 over a real certificate.

### Task D5: PostgreSQL on the primary

- [ ] Install PostgreSQL 16, `listen_addresses = 'localhost'` only, a dedicated database, `scram-sha-256` auth, passwords in `/etc/ledger-v2/ledgerd.env`.
- [ ] **Two roles, not one — `ledger_migrate` (owns the schema) and `ledger_runtime` (the app, never the owner).** This is a security requirement, not tidiness: `key_history` is append-only by trigger (Task 7), and `ALTER TABLE … DISABLE TRIGGER` needs only **ownership**. A single role that migrates and serves can switch the guard off and rewrite the key-history log that peer devices audit for key substitution (spec §3.4). The full recipe — including the two steps that are easy to miss — is in the header comment of `internal/v2/pg/migrations/00003_writers.sql`, and `auth.TestDocumentedRuntimeRoleGrantsWork` pins it:
  - `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public` — `key_history.id` is a `bigserial`, so table grants alone make **every** registration and revocation fail with `permission denied for sequence`.
  - `ALTER DEFAULT PRIVILEGES FOR ROLE ledger_migrate IN SCHEMA public GRANT … ON TABLES/SEQUENCES` — `GRANT … ON ALL TABLES` is a snapshot, not a policy, so any table added by a later migration is unreachable to the runtime role without it.
- [ ] Consequence for the deploy script: **apply migrations out-of-band as `ledger_migrate` before starting the new binary.** `ledgerd`'s own `pg.Migrate` call stays in place and is a clean no-op for a non-owner against an up-to-date database; a deploy that ships a new migration and starts `ledgerd` first fails loudly at startup rather than running on a half-applied schema.
- [ ] **Create the database with `LC_COLLATE='C.UTF-8' LC_CTYPE='C.UTF-8' ENCODING='UTF8'`**, matching `pgtest`'s cluster locale exactly (Decision 2). A production cluster whose collation differs from the test cluster's is a class of bug — ordering, `LIKE` behavior, index usability — that only appears after deploy.
- [ ] Nightly `pg_dump` to `/var/backups/ledger-v2/` with 14-day rotation, plus a pre-deploy dump in the deploy script.
- [ ] Verify: `ledgerd verify` exits 0 against the production database, and a restore of last night's dump into a scratch database also passes `ledgerd verify`.

### Task D6: Alpha onboarding and the two-week measurement

- [ ] Write the plain-language alpha consent document: **plaintext handling** during Phase 1, the retention limit, and migrate-or-delete at the Phase 3 cutover (spec §5). It must name, in plain words, the four Phase-1-only server-side read paths from Task 30's inventory — reprocessing, quarantine re-ingest, sample donation, and parse-rate adjudication — because "we can read your mail during the alpha" is the actual thing being consented to. Collect a signature from each of the 3–5 alphas before issuing an address.
- [ ] Onboard each alpha: issue the inbound address, walk them through the Gmail forward rule, then **read Gmail's verification link out of the quarantine lane** (`GET /admin/quarantine?user=<id>&include_blob=1` — it arrives from `forwarding-noreply@google.com`, which is not allowlisted and therefore quarantines like any other unknown origin; Task 27). Confirm their first real bank email from the quarantine lane using `scope:"inner"`.
- [ ] Run for **two consecutive weeks**, checking `GET /admin/accounting` daily and asserting `unaccounted == 0` every day.
- [ ] **Measure the exit criterion with the Task 36 instrument, not by eye:**
  ```bash
  ledgerd parse-rate --from <start> --to <end>
  ```
  Adjudicate every `tier='none'` arrival as `transaction` / `non_transactional` / `unreadable`. The gate is **≥95%**, and when the tool sampled rather than adjudicating the whole population, it is the **Wilson 95% lower bound** that must clear 95%.
- [ ] Record the two-week result in `docs/superpowers/specs/v2-phase1-exit-record.md`, **including the adjudication counts and the explicit note that this measures parse coverage and not extraction correctness** (Task 36). Below 95% means stop and fix templates, not push on.

---

## Exit criteria checklist (spec §5, Phase 1)

> *Exit: headless client replays cleanly with invariants green across two concurrent writers, including a supersede-after-template-fix round-trip; ≥95% of alphas' genuine transaction mail parses over two consecutive weeks; zero drops without notice (every inbound email accounted for in diagnostics or quarantine).*

- [ ] **Headless client replays cleanly** — Task 14's `cli check` exits 0 against a real server (Tasks 9–14).
- [ ] **Invariants green** — all 17 invariants implemented (Task 13), zero `hard_stop` in the exit test (Task 38 step 12).
- [ ] **Across two concurrent writers** — Task 38 steps 2 and 9: two enrolled writers, same-parent fork, identical materialization on both, exactly one surfaced `ForkNotice`.
- [ ] **Including a supersede-after-template-fix round-trip** — Task 38 step 10: one live transaction per ingest id, snapshot recomputed fresh at its own position.
- [ ] **≥95% of alphas' genuine transaction mail parses over two consecutive weeks** — Task D6, measured with Task 36's `ledgerd parse-rate` instrument and its adjudicated denominator. (The first draft had no instrument for this criterion at all: the denominator is not derivable from `parse_diagnostics`, which stores no content by design.)
- [ ] **Zero drops without notice** — Task 36's accounting report shows `unaccounted == 0` every day (Task D6), protocol-layer rejections are counted in `smtp_rejections` (Task 23), quarantine expiry is always warned first (Task 27), and fingerprint collisions become review items rather than discards — **in the client's replay (Task 11 rule 4)**, which is where decrypted history lives; a server-side fingerprint index would be another plaintext read path Phase 3 must delete.
- [ ] **Additional gates this plan adds because the spec makes them prerequisites:**
  - [ ] Seed templates reproduce v1 over the full 3-year corpus, 0 mismatches, 0 misses (Task 21).
  - [ ] Normalizer v1 matches v1's `BodyText` + `Unwrap` over the same corpus, with only the two declared divergences (Task 16).
  - [ ] Go and TypeScript executors agree on every conformance fixture (`scripts/v2-check.sh`, Tasks 17 and 20).
  - [ ] A **hot-only** pull is complete, verifiable and invariant-clean (Task 38 step 6) — the property spec §3.3:70 requires and the one a both-streams-always test cannot see.
  - [ ] A writer checkpoint is actually emitted and verified (Task 38 step 4) — spec §5 lists "both chains + checkpoints", and an unemitted checkpoint makes `I11` pass vacuously.
  - [ ] Port 25 confirmed on the **backup-relay provider** as well as the primary (Task D2 — Phase 0 left this open).
  - [ ] `ledgerd verify` reports zero structural findings against production (Task D5).
  - [ ] Spec §2's breach inventory matches the code (Task 23 step 5) — buckets, diagnostics fields, `smtp_rejections`, the dictionary HMAC, `parse_rate_adjudications`, and the inbound-address bearer-capability caveat.

---

## Self-review notes

- **Spec coverage.** §3.1 → Tasks 3, 9, 24, 32 (surfaces and their bindings). §3.2 → Tasks 22–30, 35. §3.3 → Tasks 4–14, 36. §3.4 → Task 7 only, deliberately: everything else in §3.4 is Phase 3, and Global Constraints says so. §3.5 → Tasks 15–21, 23, 31, 32. §3.6 → Task 33 (server side only; client matching is Phase 2, stated in the non-goals). §3.7 → Task 12, with the determinism rules copied into Global Constraints. §3.8 → Tasks 6, 7, 29. §3.9 → out of scope (Phase 2), stated. §3.10 → Task 34 (export is on-device, therefore Phase 2). §5's Phase 0 leftover → Task D2.

- **The three structural decisions a reviewer should push on first.**
  1. **Chains per `(writer_id, stream)` plus the hash list (Decision 13).** Both halves are built rather than one, because the split alone does not solve lazy cold verification and the hash list alone does not make a hot-only pull self-contained. If this is wrong, Tasks 5, 8, 9, 10, 13, 14, 29 and 38 all move together.
  2. **The regex dialect bans unbounded group quantifiers, not all of them (Decision 5, Task 18).** The alternative — banning `?` and `{n,m}` on groups — is what the first draft did, and it made its own acceptance test unsatisfiable and Task 21's hard gate unreachable, because four v1 patterns use the optional-currency-prefix shape.
  3. **Forwarded mail is parsed against its inner subject and inner date (Decision 14, Task 15).** The alternative (outer envelope) silently drops `last4` on every forwarded ENBD alert and mis-dates late forwards. The safety property that makes it acceptable is that unwrapped fields are *content* and never *trust*, which Tasks 26 and 29 each pin with a test.

- **Known thin spots a reviewer should push on.**
  (a) **ARC (Task 2) is still the largest unknown**, but it is no longer load-bearing: Task 26 attests the inner origin from the surviving direct DKIM signature first, which the corpus shows works for all 1,158 Gmail-delivered messages. A NO-GO now costs body-rewriting forwarders, not the alpha phase. That reframing is the single biggest risk reduction in this revision.
  (b) **Task 21's gate compares v2 against *v1's own parsers***, which is the right reference for "reproduce the existing parsers" but says nothing about whether v1 was right — that is what alpha traffic is for.
  (c) **Task 17 (TypeScript normalizer) is the largest single-file task** and inherits three non-obvious behaviors from Go's stdlib and `go-message` (charset resolution order, lenient quoted-printable, whitespace-tolerant base64). Budget two sessions; it is sized honestly rather than optimistically.
  (d) **No TypeScript heuristic exists** (Decision 16), so the conformance suite covers the template rung only and a Phase 2 client cannot reproduce a heuristic-parsed result. Stated in the non-goals, in Task 28's package doc, and as a precondition on Phase 2's client-side reprocessing.
  (e) **Four server-side plaintext read paths are Phase-1-only** and enumerated in Task 30's inventory. They are the same category of thing this plan refused to build as a PWA materialized view; the difference is that they are banner-marked, dated, and named in the alpha consent document.
  (f) **The parse-rate denominator requires operator adjudication** (Task 36). There is no way around this: diagnostics store no content by design, so nothing recorded can distinguish a bank alert from a newsletter. The instrument is honest about being a coverage measure rather than a correctness one.
