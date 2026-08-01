# Task 6 — server changes the beta blocks on

Plan: `docs/superpowers/plans/2026-08-02-v2-phase2-client.md`, Task 6 (line ~830).
Branch `v2`, worktree `/root/Coding/ledger/.claude/worktrees/v2`, parent `34e7a43`.

Four Phase 1 carry-forwards, one review. All four landed. Two of them turned out
to be wrong as specified and are implemented differently, both documented below
with the evidence that the specified version could not work.

---

## Step 1 — a real nonce on address rotation, and the exchange path

`api/addresses.go` passed an empty `auth.VerifyOpts{}`, so spec §3.4's "fresh
IdP re-authentication" checked nothing at all: any currently-valid Apple or
Google ID token satisfied factor 2. It now passes

```go
auth.VerifyOpts{
    Nonce:  base64.StdEncoding.EncodeToString(nonce),
    MaxAge: reauthMaxAge,   // 5 minutes, the same constant account.go uses
}
```

where `nonce` is the challenge `POST /api/v1/address/challenge` issued —
server-side state created before the token existed, spent exactly once by
`RotateAuthorized`, which is the only shape that makes a nonce binding real
rather than decorative (the argument is on `auth.VerifyOpts.Nonce` and I did not
have to invent it).

Two changes beyond the letter of the step, both required for the step to mean
anything:

1. **The freshness is re-checked in the handler against the returned
   `Identity`**, exactly as `account.go` does, so a `Verifier` implementation
   that ignores `MaxAge` cannot silently turn rotation back into a
   session-plus-key endpoint. `TestRotationRechecksFreshnessAgainstTheIdentity`
   drives a verifier that ignores opts entirely and hands back a month-old
   token.
2. **`auth.UpsertUser` is gone from the rotation path.** It resolved the
   re-authenticating identity by *creating* it, so one valid session plus any
   valid Apple token minted a `users` row on every rejected rotation — a
   row-creation primitive on the path that answers 403, and (once Step 2 landed)
   a way straight past the closed beta's only gate. `account.go` had already
   found and fixed the identical defect on the deletion path; that fix is now
   extracted as `auth.IdentityMatchesUser` and both call sites can no longer
   drift. `TestARefusedRotationCreatesNoAccount` measures the users count across
   a refused rotation.

**The exchange path stays unbound, deliberately.** `sync.go:193` carried the
byte-identical empty `VerifyOpts{}` and still does. The task text says to leave
it; the reason it is *right* to leave it is not the same as the reason Phase 1
gave, so it is restated at the call site: rotation's store always existed
(`address_rotation_challenges`, in the same commit), while sign-in has none and
cannot cheaply have one — the challenge would have to be issued to an anonymous
caller before any identity is known, which is a new unauthenticated,
rate-limited, swept table and a two-round-trip sign-in. What *did* change is the
residual's blast radius: a replayed ID token can no longer create an account,
because creation needs an invite code. It can still take over a sign-in for an
identity that already exists. That is named Phase-4-blocking in the package doc
and at both call sites, so the asymmetry between two adjacent lines is written
down rather than silent.

## Step 2 — the closed beta's gate

Migration **`00020_invite_codes.sql`**, as Decision 8 specifies:
`code_hash` (SHA-256, primary key, 32-byte CHECK), `note`, `created_at`,
`redeemed_at`, `redeemed_by uuid REFERENCES users(id) ON DELETE SET NULL`, plus
a CHECK that `redeemed_by` implies `redeemed_at` and a partial index on the
unredeemed rows.

**How the number was verified free:** `ls internal/v2/pg/migrations/` immediately
before writing the file — highest present `00019`, `00004` and `00015` vacant and
not claimed, nothing at `0002*`. Re-checked immediately before the commit.
`00021` was claimed by the same procedure at the same moment (see Step 3).

- `POST /api/v1/auth/exchange` accepts an optional `invite_code`.
- `auth.UpsertUserInvited` redeems it **inside the same transaction as
  `UpsertUser`**. The gate is keyed on `created`, a value that comes back from
  the `INSERT ... ON CONFLICT DO NOTHING RETURNING id` itself, never from a
  pre-flight "does this user exist?" — that check-then-act has a window in it and
  the window is exactly a concurrent first sign-in.
- Single use is the row predicate `WHERE code_hash = $1 AND redeemed_at IS NULL`,
  not anything in Go. Concurrent redeemers serialize on the row and the loser
  re-evaluates under READ COMMITTED (which `UpsertUser` already pins, for the
  neighbouring reason) and matches zero rows.
- Refusal is `403 {"error":"not_invited"}` and creates nothing — the transaction
  rolls back, so there is no half-provisioned identity, no `oplog_seq` row and no
  ingest writer left for a later sign-in to inherit.
- Every other authentication failure is still the byte-identical
  `401 {"error":"unauthorized"}`.

**Issuing and redeeming:** the operator runs `ledgerd mint-invite --note "who"`,
which prints the code once on stdout (alone on its line, so piping it into a
message gets the code and not a sentence) and stores only its SHA-256.
`ledgerd mint-invite --show` lists what is outstanding by hash prefix. There is
no command that recovers a code: one that could would make every database backup
a bag of live invitations. The code is 15 bytes of `crypto/rand` in unpadded
base32 — 24 characters, no case to lose, nothing a messaging app will linkify —
and `auth.NormalizeInviteCode` (upper-case, drop spaces/dashes/underscores) is
applied identically at mint and at redemption so the two cannot drift.

The mode is registered in `config.modeOrder`, `config.modeImplemented` and
`cmd/ledgerd`'s `modeHandlers`, so `checkModeHandlers()` panics on drift at every
invocation, and `TestModesIsTheExactSetInOrder` was updated with the reason.

## Step 3 — a distinguishable answer for a deleted account

**The step as written can never fire, and this is the finding of the task.**

It says to answer 410 "when the session's user row is absent but the session
token parsed". `sessions.user_id` is `REFERENCES users(id) ON DELETE CASCADE`
(`00001`), and `purge.Purge` is one `DELETE FROM users` with everything else
cascading from it — so the session row is destroyed along with the account and
the state the check looks for does not exist. A middleware check for it would
compile, pass a test that inserted the halfway state by hand, and fire exactly
never in production. That is Phase 1's second defect shape (`written, tested
green, never wired`) reproduced from the plan text.

What landed instead — migration **`00021_deleted_account_sessions.sql`**:

- a table holding `token_hash`, `deleted_at`, `expires_at` and **nothing else** —
  no user id, no subject, no address, nothing derived from any of them. The key
  is the digest of a 32-byte `crypto/rand` value, linkable to a person only by
  someone already holding the token, i.e. by the device the row exists to answer.
  `TestTheTombstoneCarriesNoIdentity` reads `information_schema` and fails on any
  fourth column, so a later task cannot quietly add one.
- a **`BEFORE DELETE ON users`** trigger that copies the account's session hashes
  into it. `BEFORE` is load-bearing: RI cascades run as after-row actions on the
  referenced table, so an `AFTER` trigger finds nothing (mutation M11).
- the trigger is on `users`, not on `sessions`: a trigger on `sessions` would fire
  for any future session-pruning job and tell every returning device its account
  was deleted.
- putting it in the trigger rather than in `purge.Purge` means it covers *every*
  path to a deleted account — `purge.Purge`, the retention sweep,
  `ledgerd purge-user`, and whatever a later task adds — rather than the one path
  someone remembered.

`auth.Sessions.Resolve` consults it only on the `pgx.ErrNoRows` path, so the
common request pays nothing, and a row past its own `expires_at` answers
"unknown" — at that point "expired" is true and sufficient. `requireSession`
turns `auth.ErrSessionAccountDeleted` into `410 {"error":"account_deleted"}`,
checked *before* the `ErrSessionInvalid` collapse it wraps.

**One clock decides.** The first draft filtered `expires_at > now()` in the
trigger, which is Postgres's clock, while `Sessions` judges expiry against its
own injected clock. That is two clocks deciding one fact and it failed
immediately under the package's pinned test clock — a session issued at the fake
"now" is already expired by wall time, so no row was written and every 410
silently became a 401. The filter is gone; the trigger writes every row and
`Sessions` alone judges. `TestTombstoneExpiryIsDecidedByTheSessionsClock` pins
it, and mutation M13 restores the filter to prove the test sees it.

`internal/v2/purge` classifies both new tables in `notUserLinked` with their
reasoning. Its own completeness guard caught them unclassified before I did,
which is the guard working.

## Step 4 — rate-limit and bound the quarantine confirmation

`POST /api/v1/quarantine/confirm` re-ingests every released message through the
whole parse cascade, synchronously, inside a user-facing request (cap 500). It
was the only write path in the API with no budget at all. It now takes
`Server.QuarantinePerUser` at **1/minute sustained, burst 10** — identical to the
address and account budgets, with `TestQuarantineBudgetMatchesTheAddressAndAccountBudgets`
asserting the equality rather than trusting three copied literals. `Handler()`
fills it in like every other limiter, and
`TestQuarantineLimiterIsFilledInByHandler` fails if that line is dropped
(mutation M20), because a limiter only a test sets is a production route with no
limit.

`Incomplete` and `Remaining` round-trip: `TestConfirmReportsIncompleteAndRemainingToTheClient`
reads them off the **wire**, not off our own struct, so a renamed or dropped JSON
tag is visible. `TestACompleteConfirmSaysSo` pins the other direction — a client
that paged on a false flag would loop.

The `reingest` doc comment claimed "the absence of a rate limit on this route is
therefore safe because the PROMOTION is exclusive". That argument answered the
wrong question (it is about correctness under repetition, not about cost) and is
corrected in place.

---

## TDD evidence

Written test-first, in this order, with the failing run observed before each
implementation:

| Tests written | Observed failing as | Then implemented |
|---|---|---|
| `auth/invite_test.go` (11) | `MintInvite` undefined | `auth/invite.go`, `00020` |
| `auth/deleted_account_test.go` (5) | `err = ... no such session, want ErrSessionAccountDeleted` | `00021`, `Sessions.deletedOrUnknown` |
| `api/invite_test.go` (9) | `status 403, want 200` / gate absent | `handleExchange` |
| `api/deleted_account_test.go` (3) | `status 401, want 410` | `requireSession` + `writeAccountDeleted` |
| `api/rotation_reauth_test.go` (6) | `rotate: 403` (fake verifier had no `iat`) | `VerifyOpts{Nonce,MaxAge}`, `IdentityMatchesUser` |
| `api/quarantine_limit_test.go` (5) | `request 0 answered 200` | `QuarantinePerUser` |

Two failures during the run were *findings rather than red-to-green theatre*:
the two-clock tombstone bug (Step 3) and `purge`'s completeness guard rejecting
the new tables.

## Mutation score

**22 of 23 caught (95.7%).** Runner:
`/tmp/claude-0/-root-Coding-ledger/bcc8cb5e-1dd4-451e-94e9-031572dd88c7/scratchpad/task6-mutate.py`,
log alongside it as `task6-mut.log`. Each mutation is a textual patch applied to
the real source; a mutation counts as caught only when the whole affected
package's suite (`go test -count=1 ./internal/v2/auth/` or `./internal/v2/api/`)
exits non-zero — not a hand-picked test, so a mutation nothing catches cannot be
hidden by choosing the wrong `-run`. 24 were designed; M8 (move the redemption
out of the account transaction) does not compile — `go func` closing over a
`pgx.Tx` after the caller commits is not a mutation the type system permits — so
it is excluded from the denominator rather than counted as caught.

| # | mutation | caught by |
|---|---|---|
| M1 | spent codes redeem again (drop `AND redeemed_at IS NULL`) | `TestASpentCodeCreatesNoSecondAccount`, `TestConcurrentRedemption…` |
| M2 | redemption ignores `RowsAffected` | `TestAWrongCodeCreatesNoAccount`, +2 |
| M3 | gate fires for returning users instead of new ones | `TestValidCodeCreates…`, +2 |
| M4 | gate removed entirely | (compile: `invite` unused) |
| M5 | codes are case sensitive | `TestInviteCodeNormalizationIsForgiving` |
| **M6** | **empty-code guard removed** | **SURVIVED — see below** |
| M7 | the code itself is stored, not its hash | `TestMintedInviteIsNeverStoredInTheClear` |
| M9 | tombstone never consulted | `TestASessionOfADeletedAccount…`, +2 |
| M10 | tombstone ignores the session's own expiry | `TestTheTombstoneStopsAnswering…` |
| M11 | trigger fires `AFTER DELETE` instead of `BEFORE` | `TestASessionOfADeletedAccount…`, +2 |
| M12 | 410 branch removed from the middleware | `TestADeletedAccountAnswers410…`, `TestDeleteAccountWithAllThreeFactors…` |
| M13 | tombstone filters on Postgres's clock | `TestTombstoneExpiryIsDecidedByTheSessionsClock`, +2 |
| M14 | rotation binds no nonce | `TestRotationBindsTheServerIssuedNonce…`, +2 |
| M15 | rotation asks for no `MaxAge` | `TestRotationBindsTheServerIssuedNonce…` |
| M16 | handler-side freshness recheck removed | `TestRotationRechecksFreshnessAgainstTheIdentity` |
| M17 | rotation resolves re-auth by upserting again | `TestARefusedRotationCreatesNoAccount` |
| M18 | rotation binds a nonce of its own invention | `TestRotationBindsTheServerIssuedNonce…`, +1 |
| M19 | confirm is unlimited | `TestQuarantineConfirmIsRateLimitedPerUser` |
| M20 | limiter not filled in by `Handler()` | `TestQuarantineLimiterIsFilledInByHandler` |
| M21 | `Incomplete` never reported | `TestConfirmReportsIncompleteAndRemaining…`, +1 |
| M22 | `Remaining` never reported | `TestConfirmReportsIncompleteAndRemaining…`, +1 |
| M23 | `not_invited` answered as a 401 | `TestSignUpNeedsAnInviteCode`, +2 |
| M24 | exchange creates accounts ungated | `TestSignUpNeedsAnInviteCode`, +2 |

**M6 survived and it is an equivalent mutant, stated rather than excused.**
`redeemInviteTx` refuses an empty code before hashing it. Removing that guard
changes nothing observable: the empty string hashes to `SHA-256("")`, which
matches no row, so the `UPDATE` affects zero rows and the function returns
`ErrNotInvited` by the other path. It is defence against a future
`invite_codes` row whose hash happened to be that constant — i.e. against
somebody inserting one deliberately — and no test can distinguish it without
planting that row. I left the guard and did not write a test that plants the
row, because such a test would assert a scenario production cannot produce.
Score reported as 22/23 rather than rounded to 23/23.

## Verification

```
go clean -testcache && bash scripts/v2-check.sh      # exit 0, captured directly
v2-check: OK (go + client + conformance)
27 Go packages ok; client 1985 pass / 0 fail / 0 skip
```

**The e2e actually ran, asserted rather than assumed.** The plan warns that
"`exit.test.ts` green" is satisfiable by skipping, so: the bare `bun test` run
(no `LEDGER_TEST_POSTGRES_URL`) reports **37 skip**, and the gate run reports
**0 skip** with the pass count higher by exactly that many. Confirmed
independently by running the e2e files alone against a booted cluster —
`roundtrip.test.ts` 8 pass / 0 skip, `exit.test.ts` + `harness.test.ts` 32 pass
/ 0 skip, with real `ledgerd` output in the log (the step-16
`I11_roster_checkpoint/chain_withheld` detection and the `parse-rate` exit
report). Every one of those accounts is created through the new gate: they mint
a real code by running `ledgerd mint-invite`, so a broken CLI or a broken
redemption fails them.

`client/src/replay/fx.test.ts`'s known load-sensitive 5 s timeout did not fire
in the gate run; its limit was not touched.

## Files changed

26 files, +2458/−55, committed as `f0e5979` through a temporary `GIT_INDEX_FILE`
seeded from HEAD, moved with a compare-and-swap `update-ref`, and read back with
`git show --stat` before reporting.

- **new**: `internal/v2/pg/migrations/00020_invite_codes.sql`,
  `internal/v2/pg/migrations/00021_deleted_account_sessions.sql`,
  `internal/v2/auth/invite.go`, and five test files
  (`auth/invite_test.go`, `auth/deleted_account_test.go`, `api/invite_test.go`,
  `api/deleted_account_test.go`, `api/rotation_reauth_test.go`,
  `api/quarantine_limit_test.go`).
- **changed**: `internal/v2/auth/session.go`, `internal/v2/purge/purge.go`,
  `internal/v2/api/{api,sync,addresses,quarantine}.go`,
  `internal/v2/api/{sync,account}_test.go`,
  `internal/v2/config/config.go` + `config_test.go`, `cmd/ledgerd/main.go`,
  `client/src/net/client.ts`, `client/test/e2e/{harness.ts,harness.test.ts,exit.test.ts,roundtrip.test.ts}`.

**`client/src/net/client.ts` was staged as a reconstructed blob**, not as the
working-tree file: it was `MM` in the shared index with another session's
in-flight doc edit on top of their committed platform-seam work. The committed
blob is HEAD's content with only my `login` hunk applied, so their unstaged edit
is neither swept nor reverted. The same temp-index discipline is why this commit
does not carry the `D client/src/platform{,.test}.ts` deletions another session
had staged.

## Concerns

1. **The exchange remains a replayable-bearer path.** Bounded now (no account
   creation) but not closed. Phase-4-blocking, named at three sites.
2. **`internal/v2/ingest/reprocess_test.go:841` carries a now-false comment**
   ("POST /api/v1/quarantine/confirm deliberately has no rate limit"). The file
   is `MM` in the shared index — another session owns it right now — so I left
   it rather than risk clobbering their work. Whoever lands that file next
   should fix the sentence.
3. **`auth.UpsertUser` survives as an ungated creation primitive** for tests and
   seeding. No production request path calls it any more, and its doc says so in
   capitals, but nothing mechanically prevents a future caller. A stronger
   version would unexport it; that renames a symbol in twelve concurrently-edited
   test files, which is the wrong trade today.
4. **`Resolve` does one extra PK lookup per unrecognized bearer token.** Only on
   the failure path, on a tiny table, but authenticated routes have no global
   limiter, so a caller with a socket can drive it. It is one indexed SELECT
   against a table bounded by the sessions of deleted accounts.
5. **e2e files were edited**, which the plan's file list does not enumerate
   (`client/src/**` is listed, `client/test/**` is not). Required: making
   account creation need a code breaks every e2e sign-in otherwise. They mint a
   real code by running `ledgerd mint-invite`, not by INSERTing a row, so the
   e2e proves the mint → hand over → redeem loop end to end rather than
   performing setup production does not perform. `Client.login` gained an
   optional third parameter — additive, no behaviour change when omitted.
6. **`deploy/README.md` documents no v2 commands at all**, so `mint-invite` is
   documented only in its own `--help`, this report, and the code. The operator
   cannot open the beta without knowing it exists.
7. **The `not_invited` 403 is a code oracle in principle.** 120 bits of entropy
   behind a 12/minute per-IP sign-in budget makes it uninteresting in practice.
8. **The mutation battery edits shared source in a shared worktree.** Another
   session's `go test ./internal/v2/... ./cmd/ledgerd` was seen running while
   `addresses.go` was mutated, so that session may have read spurious `api`
   failures. Nothing was left corrupted — every mutation is restored from a
   `.mutbak` in a `finally`, and the tree was verified clean (`gofmt -l` empty,
   `go build ./...` ok, no `.mutbak` remaining) before the final gate — but a
   future battery here should announce itself or run against a scratch clone.
