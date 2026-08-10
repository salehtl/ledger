# Fix report — quarantine confirm / re-ingest (Tasks 27 + 38)

Round: adversarial review of the confirm → re-ingest path. Three proved defects,
two design gaps, seven unpinned store properties, plus minors.

Files: `internal/v2/quarantine/quarantine.go`, `internal/v2/api/quarantine.go`,
`internal/v2/ingest/reprocess.go`, and one call site in
`internal/v2/ingest/pipeline.go`, one route block + one doc block in
`internal/v2/api/api.go`. No migration: revocation is a `DELETE` from a table
that already exists. (00018 and 00019 were taken by other sessions while this
round ran; nothing here claims a number.)

## What was deliberately left alone

The critic ruled these out by inspection plus mutation and re-ran the
implementer's battery finding no inflated counts: the trust gate (one
`INSERT INTO sender_allowlist` in the tree, reachable only from an
authenticated confirm on a held message with a verified signature), the entire
expiry contract, store errors returned rather than swallowed, the listing
carrying no content and no envelope sender, and the pool-warming in the
concurrency test. None of it was touched. The one change adjacent to the trust
gate is the `already` branch below, which writes nothing.

---

## Defect 1 — two concurrent confirmations double-appended the same message

`POST /api/v1/quarantine/confirm` has no rate limit deliberately. Two
simultaneous confirmations of one origin both read the same held ids, both
`appendOps`, and one loses the `FOR UPDATE` race in `Promote`: **two
`txn_ingested` ops for one ingest id** (replay's `duplicate_ingest`) plus a
second copy of a body that can be a megabyte. Both responses said
`{"appended":1}`, because `promoteHeld` discarded `Promote`'s row count.

**Reproduction, written before the fix** —
`ingest.TestConcurrentConfirmationsAppendTheMessageOnce`. Four racers, pool
warmed first (pgxpool connects lazily and staggers new connections, so
un-warmed racers dial instead of overlapping and the race never happens).

- BEFORE: `4 concurrent confirmations reported 4 appends of ONE message`,
  **5 runs out of 5**.
- AFTER: green, `-count=5 -race`.
- Re-verified as a mutation on the committed tree: removing the claim
  reproduces **5/5** again.

**Fix.** `promoteHeld` takes a claim on `(user, ingest id)` from before the
"already appended?" check to after the append. The loser then finds the message
in the log and clears the row instead of appending a second copy, and the
reports are honest (`{Appended:1}` and `{Unchanged:1}`).

The claim is a **process-level Go lock**, not a database one, and that is a
measured trade rather than a shortcut. A row lock or advisory lock spanning the
append holds a pool connection while `appendOps` acquires a second one — so
`MaxConns` concurrent confirmations would each hold one and wait for one, on a
route with no rate limit. Turning a duplicate op into a self-inflicted deadlock
is not an improvement. What is left open — two `ledgerd` processes on one
database — is the residue `alreadyHandled` already documents for the arrival
path: a bounded, visible mess that replay folds to one live transaction.

`Promote`'s row count is no longer discarded; zero after a successful append is
logged, because it is the visible symptom of exactly this race.

## Defect 2 — the post-append `Promote` guard was inert

`appendedBefore` reads `parse_diagnostics`. That row was written **after**
`Promote`, so in the real crash state (append committed, promote failed, no
diagnostics row) the guard returned false and the retry appended again:
`op_log` 2 → 4 rows, two `txn_ingested`. The test pinning it ran a *successful*
reprocess first, leaving the diagnostics row behind — a state the failure it
names cannot produce.

**Reproduction.** `rig.blockPromotion` plants the removal record `Promote`
itself must insert; `quarantine_removals.quarantine_id` is UNIQUE, so
`Promote`'s own INSERT collides and its transaction rolls back. A real failure
of the real statement, at the real point in the sequence.

- BEFORE (diagnostics written after the promote):
  `report = {Examined:1 Appended:1 ...}, want one unchanged` — i.e. the retry
  appended a second copy.
- AFTER: `{Examined:1 Unchanged:1}`, `op_log` unchanged at 2 rows, quarantine
  row cleared, `replayLiveEntities` sees one live create.

**Fix.** The diagnostics row is written immediately after the append and
**before** the promote, on the detached context `recordAfterStore` already
uses — so a client that hangs up mid-request still leaves the evidence. The
promote that follows a successful append also runs detached (10s), which
removes the stated trigger entirely: a cancelled request no longer leaves mail
showing as quarantined when it is already in the ledger. `rep.Appended++` moved
to just after the append, because a partial report that omits an append that
*happened* is the one kind of wrong this accounting exists to prevent.

## Defect 3 — re-confirming a fully-promoted origin answered 409

`Confirm` refused when nothing was still *held*, before reaching the allowlist
insert, and the API mapped that to `409 origin_unproven`: *"no message held for
this account carries a verified signature from that origin… Mail that cannot be
verified stays quarantined."* About an origin already on the allowlist — the
state a **successful** confirmation leaves. Reachable by a double-tap, a retry
after a lost response, or one more pass of the documented `remaining > 0` loop,
on the single step spec §3.2 calls out as onboarding.

**Fix.** When nothing is held, `Confirm` asks whether the row already exists. If
it does: 200 with an empty id list, nothing written. If it does not: the refusal
stands, unchanged, so an origin this account has never proven is still refused.

- BEFORE (mutation `already && false`): both
  `quarantine.TestConfirmingAnAlreadyTrustedOriginIsNotARefusal` and
  `api.TestConfirmingATrustedOriginAgainIsNotAConflict` fail.
- AFTER: 200, `ingest_ids: []`, `reingest` all-zero, the reprocessor is not
  called a second time, and `never-seen.example` still gets its 409.

## Defect 4 — the `?include_blob=1` budget did not do what its comment claimed

`quarantine.List` materialised **every** row of the `limit`-sized page with its
blob and the handler truncated afterwards, so `?include_blob=1&limit=200`
allocated ~200 MB server-side per request, concurrently, for any authenticated
caller. The comment claimed "the same argument, and the same number, as
`pullByteBudget`"; it was the same number and the opposite implementation.

**Fix.** `Store.ListPage` applies the budget **in SQL**, in `oplog.readPageSQL`'s
shape: a window `sum(size_bucket)` over a plain int column, so a row the outer
`WHERE` discards is never detoasted; `rn = 1` for forward progress past an
oversized message; `count(*) OVER ()` so the page can report that the budget cut
it. `List` remains as a thin wrapper on the default budget, so `admin` and the
existing tests are untouched. The handler no longer truncates and `Complete` is
`!truncated && …` — a page cut at three of fifty must not read as "the lane is
empty".

## Defect 5 — there was no revocation

Nothing in the tree deleted a `sender_allowlist` row except
`users ON DELETE CASCADE`. A user who confirmed a lookalike (`dib-alerts.ae`, or
a punycode A-label — `reHostname` admits `xn--…`) could only fix it by deleting
their account.

**Added:** `Store.Revoke`, `Store.AllowlistedOrigins`, and
`GET`/`DELETE /api/v1/quarantine/allowlist`. The listing is not a convenience —
it is the same argument written above the push-token list route: a delete that
needs a `(domain, scope)` pair the user has no way to recover is unreachable to
the person who needs it.

Revocation closes the lane going forward (the allowlist is re-read on every
arrival and every reprocess —
`TestReprocessOfStoredMailReChecksTheAllowlist` already proved that half; the
row simply could not be removed). It does not retract ops already in the log,
and it says so. Revoking something that was not trusted is `200
{"revoked":false}`, not 404: the caller's goal is met either way, and a 404
would make the route an oracle for what an account trusts.

## Defect 6 — seven unpinned store properties

Each now has a test that **dies to the named mutation**. Verified by running
each mutation on the committed tree and confirming the paired test fails
(16 mutations, 16 killed, 0 survivors), plus the two race mutations above.

| Property | Mutation | Test |
| --- | --- | --- |
| `Allowlisted` whole-domain match | `domain = $2` → `$2 LIKE domain \|\| '%'` | `TestAllowlistedMatchesTheWholeDomain` |
| `Allowlisted` scope | drop `scope = $3` | `TestAllowlistedIsScopedToTheScope` |
| `Held` user scope | drop `user_id = $1` | `TestHeldIsScopedToTheUser` |
| `IsHeld` user scope | drop `user_id = $1` | `TestIsHeldIsScopedToTheUser` |
| `Promote` user scope | drop `user_id = $1` | `TestPromoteIsScopedToTheUser` |
| `Counts` user scope | drop `user_id = $1` | `TestCountsAreScopedToTheUser` |
| `Removals` user scope | drop `user_id = $1` | `TestRemovalsAreScopedToTheUser` |
| `Confirm` lower-casing | drop `NormalizeDomain` | `TestConfirmLowerCasesTheDomain` |

`Held`'s was the worst: two accounts can hold the same bytes (one bank, two
customers, one alert template), so an unscoped `ingest_id = ANY($2)` matched
both rows — and `alreadyHandled` treats a hit as "this user has already seen
this", which would discard the victim's own mail while returning another
account's plaintext to the reprocessor. The existing
`TestReprocessOfAnotherUsersMessageFindsNothing` looks like it covers this but
uses `r.allow(...)`, so its message is *appended*, never held: the held lane was
never crossed.

## Minors

- **`alreadyHandled` no longer SELECTs a megabyte to test existence.** New
  `Store.IsHeld` is an `EXISTS` on the `(user_id, ingest_id)` unique index;
  `pipeline.go`'s one call site uses it.
- **`handleConfirmSender` echoes the domain it stored**, not the caller's
  spelling. A response that says `DIB.AE` while the row says `dib.ae` invites a
  client to build its next request from a string the server will not match.
  `quarantine.NormalizeDomain` is now the single spelling rule, used by
  `validate`, `Confirm`, `Allowlisted`, `Revoke` and the handler.
- **`validate` really does mirror the CHECK constraints now**: the 264/253
  length caps were missing, so an over-long domain reached the caller as a 500
  instead of an `ErrInvalidItem`. A regex anchored on *label* length accepts a
  name of any number of labels.
- **`AttestedByDirectDKIM`/`AttestedByARC` are pinned equal to `origin`'s** by
  `TestTheAttestationMethodsMatchOrigin`, from the quarantine side only
  (`origin/inner.go` was being rewritten concurrently). Same silent-drift shape
  as the forwarder-list bug that actually bit this package.
- **The stale safety comment at `api/quarantine.go`** ("a promoted message is no
  longer held", offered as the reason repeating a confirmation is cheap) now
  says what is actually true: that holds *serially*, and what makes the missing
  rate limit safe is that the **promotion** is exclusive.
- **The Task 27 report's claim that `Confirm` writes "without touching
  `op_log` (TestHoldNeverWritesToTheOpLog)" was wrong** — that test covers
  `Hold`. `TestConfirmNeverWritesToTheOpLog` now makes the claim true.

## Not closed, deliberately

**No per-user cap on quarantine rows or bytes.** The worst case named in the
review (50/day × 1 MB × 30 days ≈ 1.5 GB per known address) is real, but a cap
here is a *refusal to hold*, and mail that was never held has no notice channel
at all — it would be the first silent drop in a subsystem built entirely around
§2's promise that there is never one. The volume bound belongs where it already
is: the SMTP layer's per-address ~50/day limit (spec §3.2), which is what makes
that arithmetic's worst case require an attacker who is already rate-limited.
Both numbers in it are ceilings (the DATA cap and the daily cap) and no
observed message is near either. Revisit with a real distribution from the
alpha, and if a cap is added it must arrive with a user-visible notice, not
instead of one.

## Verification

The shared tree carried four other sessions' in-flight work throughout this
round, so nothing here was verified against it. `reprocess.go`, `api.go` and
`pipeline.go` were reconstructed as HEAD plus this round's hunks only — the
other sessions' uncommitted edits to the first two are left in the working tree
for them to commit — and the whole set was staged as explicit blobs through a
temporary index, so no foreign staged entry could be swept in.

Gate, in a **clean worktree checked out at this commit** (parent `d08daef`),
with an empty `git status`:

```
go clean -testcache && bash scripts/v2-check.sh
→ v2-check: OK (go + client + conformance)   exit 0
   go vet + go test ./internal/v2/... ./cmd/ledgerd, then 1910 client tests, 0 fail
```

One earlier run of the same gate at the same tree failed on
`client/src/replay/fx.test.ts` — a 5s test timing out at 7.5s while four other
sessions' suites were running on the box. It passes in isolation (51/51, 5.19s)
and passed on the clean re-run above; it is load, not this change.

Mutation battery, run against the committed tree: **16/16 killed, 0 survivors**,
plus the two race mutations — remove the promotion claim and defect 1
reproduces 5/5; move the diagnostics row back after the promote and defect 2's
retry appends a second copy.

### One flake in this round's own test, found and fixed

`TestConcurrentConfirmationsAppendTheMessageOnce` asserted *one* reprocess
diagnostics row and failed about once in twenty runs under load
(`2 reprocess diagnostics rows for one promotion`). The code was right and the
assertion was wrong: a racer that arrives after the winner has already promoted
finds nothing held, falls through to the STORED lane, re-parses the message it
now finds in the cold stream and correctly records an `unchanged`. Nothing is
appended and no supersede is written — it is wasted work and nothing else. The
assertion now counts rows with `outcome='appended'` (exactly one) and
`outcome='superseded'` (none), which is the property; the old one was pinning a
scheduling order. Re-verified with seven concurrent full-package runs green,
`-count=5 -race` green, and the no-claim mutation still reproducing 5/5.
