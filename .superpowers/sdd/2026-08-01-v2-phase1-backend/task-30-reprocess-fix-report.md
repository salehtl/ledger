# Fix round — server-side reprocess (`internal/v2/ingest/reprocess.go`)

**Responds to:** `task-30-31-35-critic.md`, the Task 30 half only (C4, C5, II1–II5 and
the Task 30 Minors). Tasks 31 and 35 are other people's files.

**Date:** 2026-08-01. **Branch:** `v2`. **Files touched:**
`internal/v2/ingest/reprocess.go`, `internal/v2/ingest/reprocess_test.go` and this
report. No other file in the tree, deliberately — see the note under C4.

---

## 0. The critic's own drift warning applies to the critic

`task-30-31-35-critic.md` states every number is against `bf565c6`. For C5 that
cannot be true:

```
$ git show bf565c6:internal/v2/ingest/reprocess_test.go | grep -c Concurrent
0
```

`TestConcurrentConfirmationsAppendTheMessageOnce` **did not exist at `bf565c6`**.
It arrived with `b5a4724`, six commits later, and the line the critic quotes
(`reprocess_test.go:907`) is that test's diagnostics assertion at `fd34c6e`. So
C5 was measured against a tree at or after `b5a4724` — which matters, because
`b5a4724` is also the commit that introduced the defect being reported.

Everything below was re-established against HEAD before being fixed.

---

## C4 — one client blob this build cannot read bricked reprocess. **Fixed.**

### Reproduced first, at HEAD

`TestReprocessSkipsAClientBlobThisBuildCannotRead` stores one device blob whose
plaintext is `{"v":2,"kind":"ops","ops":[]}` — framing v1 (frozen, and what the
upload path enforces), op schema v2 inside — and then asks for a reprocess of a
message whose template has just been corrected:

```
reprocess_test.go:1153: one client blob from a newer build failed the whole reprocess:
  ingest: reprocess: hot blob at seq 3: op schema version newer than supported:
  blob is v2, this build supports v1
```

`Report{Examined:1}`, all other fields zero, and no supersede. Permanently, for
that account: nothing in the upload path decodes ops
(`api.decodeUploadBlob` checks framing, hashes, bucket and AAD and stops), so
the blob stays and every later reprocess hits it again.

### The split, and why it is by writer as well as by error

`oplog.DecodeBlob`'s doc requires callers to split its errors two ways.
`currentPayloads` now splits them, and adds the dimension the doc cannot know
about — who wrote the blob:

| blob | error | now |
|---|---|---|
| device writer | `ErrUnknownNewerVersion` | **skipped**, named in the log with its seq and writer, run continues |
| ingest writer | `ErrUnknownNewerVersion` | **stop** — this binary is older than its own log |
| either | anything else | **stop** — corruption at a version this build owns |

The middle row is why the gate is on the writer and not on the error alone. The
old comment's fear was real — a hot blob this build cannot read *might* hold the
supersede that already corrected one of these messages, and comparing against a
stale payload appends a redundant correction, which retires a transaction the
user may have categorized. But a **device** blob cannot hold that supersede:
`oplog.AppendClient` refuses the ingest writer id outright and stamps every
device row `type_flag = "edit"`, so the creates in a user's log are the server's
own. The server's own unreadable blob is a genuine hole in the comparison base
and still stops the run.

Three tests, one per row of that table:

- `TestReprocessSkipsAClientBlobThisBuildCannotRead` — the v2 device blob; the
  template fix still lands, `Report{Examined:1, Superseded:1}`.
- `TestReprocessFailsOnAServerBlobThisBuildCannotRead` — the same v2 plaintext
  written into the *ingest* writer's own blob; still an error, still nothing
  appended.
- `TestReprocessFailsOnACorruptHotBlob` — a device blob at v1 carrying an op
  type that does not exist; still an error naming the seq.

### What I could not close: the count is in the log, not in `Report`

The brief asks that "a reprocess that skipped 40 blobs it didn't understand must
not look identical to one that had nothing to do". I implemented that as a
`Report.SkippedBlobs` field first, and it fails the gate:

```
cmd/ledgerd/main_test.go:532: ingest.Report has 6 fields and admin.Report has 5:
  a field was added to one without a line in toAdminReport, and it is being
  dropped silently
```

That test is right, and carrying the field properly means editing
`internal/v2/admin/admin.go`, `internal/v2/api/quarantine.go` and
`cmd/ledgerd/main.go`'s two adapters — `admin/` and `cmd/ledgerd/` are files
this round was told not to touch, and `api/quarantine.go` was rewritten by the
concurrent quarantine session tonight. Committing the field without them leaves
the gate red at my own commit, which is the one thing a fix round must not do.
So the field is out and the distinction is in the
log instead: every set-aside blob is named with its seq and its writer, and a
run that set any aside says how many at the end. Both lines are asserted
(`rig.captureLog`), so they cannot silently stop being emitted.

**Recommendation for whoever owns the adapters:** add `SkippedBlobs int` to
`ingest.Report`, `admin.Report` and `api.Report`, and a line to each of
`toAdminReport`/`toAPIReport`. Four lines; the log is a weaker surface than the
console for an operator condition.

---

## C5 — the flaky test. **Reproduced, and already fixed by another session.**

### It is real, and it is not the rate the critic reported

At `fd34c6e` — the HEAD this round started from — the assertion was
`len(r.reprocessDiags()) != 1`. Extracted to its own tree with `git archive` so
that no concurrent session could touch it, compiled once, and run sixty times
under eight CPU hogs on a 2-core box:

```
RUN 6 FAILED:
    reprocess_test.go:907: 2 reprocess diagnostics rows for one promotion
OLD ASSERTION (fd34c6e): 1 failures in 60 runs under load
```

Unloaded it did not reproduce in 25 consecutive runs. The rate is therefore
load-dependent, which reconciles the critic's 1-in-8 (measured while it was
running mutation batteries in parallel) with the `b5a4724` author's 1-in-20 and
with a clean machine's zero — the same defect at three loads, not three defects.

### The root cause is the TEST, not the implementation

For N concurrent confirmations the number of `event='reprocess'` rows is in
`[1, N]`, and every value in that range is correct:

- a racer whose `Quarantine.Held` lands **before** the winner's `Promote`
  commits finds the message held, blocks on `promotionClaims`, sees
  `appendedBefore`, clears the row and writes nothing;
- a racer whose `Held` lands **after** it finds nothing held, takes the stored
  lane, re-parses a message that is now legitimately in the log, compares equal
  and records an `unchanged`.

The implementation has no race: one append, one cold body, one live entity,
quarantine empty, in every run. The test was asserting a scheduling order.

`warmPool` (added by `b5a4724` with the test) is a real mitigation of a
*different* stagger — pgxpool dials lazily, so unwarmed racers never overlap —
but it cannot make the count deterministic, and the load run above shows it does
not.

### Already fixed at `1301b0e`

Another session landed the same conclusion while this round was running: the
test now counts `outcome='appended'` (exactly one) and `superseded` (none). I
verified it rather than re-fixing it, and added the half it still cannot reach —
`TestAConfirmationArrivingAfterThePromotionRecordsAnUnchangedReprocess` runs the
two confirmations in sequence, so the losing interleaving is pinned by something
that cannot fail for a scheduling reason.

### The 60-run

The two concurrency tests, compiled from the tree being committed, run sixty
times consecutively under the same load that made the old assertion fail:

```
FINAL TREE: 0 failures in 60 consecutive runs (load average 8.66)
```

---

## The Importants

### II1 — the forwarded, attested path was entirely uncovered. **Closed.**

`TestReprocessOfForwardedMailRunsTheInnerBanksTemplate` delivers a Gmail-shaped
inline forward against an account whose only allowlist row is
`bank.example|inner` — §3.2's primary onboarding shape — and reprocesses it
through a template correction. It asserts the supersede came from
`bank.card.v1 v2` with the corrected money, and that the reprocess diagnostics
row records `inner_origin_domain = bank.example` under
`sender_domain = google.com`.

`TestTheRecordedOriginIsRebuiltExactlyFromTheArrivalRow` reads
`recordedOrigin` directly in both directions — direct mail must come back
unattested with no `AttestedBy`, the forward must come back attested by **ARC**,
which is the only verdict that passed — plus the `nil` for an id with no
arrival. Both ends fail silently end to end because `origin.Decide`'s own gates
absorb them, which is why the value handed to those gates is asserted.

### II2 — the missing-arrival refusal was dead in tests. **Closed.**

`TestReprocessRefusesAMessageWithNoRecordedArrival` deletes the arrival
diagnostics row and asserts `Report{Examined:1, Failed:1}`, no new op, no
reprocess row. Without the branch the mutant does not merely change an outcome —
`origin.Decide(ctx, p.Trust, userID, *o)` dereferences nil.

### II3 — `prev == nil`. **Closed.**

`TestReprocessRefusesAColdBodyWithNoTransactionOp` rewrites the ingest writer's
hot blob to an empty op blob, keeping its position and re-linking its hash, so
the cold body is intact and the hot stream simply holds no transaction. Emitting
a supersede there is replay's `supersede_without_origin`.

### II4 — the promotion arrival instant. **Closed.**

`TestPromotedMailIsDatedItsArrivalAndNotItsConfirmation` holds two messages —
one parseable, one not — advances the clock six weeks, confirms, and asserts
three timestamps: each op's `authored_at` and each cold record's `received_at`
against the held row's own `ReceivedAt`, and the unparsed message's `posted_at`
against the arrival DATE, which is the one the normalizer's instant decides.
`TestReprocessDoesNotRedateAMessageItLeavesAlone` is the same property on the
stored lane, where getting it wrong turns an unchanged into an **append**.

### II5 — `storedOrigin`'s attestation gate. **Closed, as a unit.**

`TestStoredOriginNeverCarriesAnUnattestedInnerDomain` asserts the pure function
in both directions. It is asserted there because `Pipeline.hold` only ever
writes `InnerDomain` when the origin was attested, so nothing end to end can
tell the two apart and the guard was free to disappear.

### Minors

`TestTheReprocessDiagnosticsRowIsStampedWithTheRerun` pins both timestamps the
critic listed: the reprocess row's `received_at` is the re-run instant (not the
six-week-old arrival), and the supersede's `authored_at` is the instant the
correction was made, within a millisecond in both directions rather than merely
"after".

`TestTrustHeldPrefersTheFreshVerificationOverTheStoredOne` holds a really-signed
`bank.example` message under a row recording a different, also-allowlisted
domain, so the preference is visible in both the diagnostics row and which
bank's templates ran.

---

## Mutations

Runner: one literal substitution in `reprocess.go`, `go test -count=1
./internal/v2/ingest/`, revert. Run in a tree extracted with `git archive` and
overlaid with only the two files being committed, because the shared scratchpad
is shared with other sessions — a first battery was discarded after another
session re-extracted a tree over it mid-run and three verdicts were measured
against the wrong test file.

### The review's 15 survivors: 13 now die

| mutant | verdict | killed by |
|---|---|---|
| `recordedOrigin` drops the attestation | **caught** | `TestReprocessOfForwardedMailRunsTheInnerBanksTemplate`, `TestTheRecordedOriginIsRebuiltExactlyFromTheArrivalRow` |
| `recordedOrigin` marks every origin attested | **caught** | `TestTheRecordedOriginIsRebuiltExactlyFromTheArrivalRow` |
| missing-arrival refusal removed | **caught** | `TestReprocessRefusesAMessageWithNoRecordedArrival` |
| `trustHeld` prefers stored over fresh | **caught** | `TestTrustHeldPrefersTheFreshVerificationOverTheStoredOne` |
| `storedOrigin` honours an unattested inner domain | **caught** | `TestStoredOriginNeverCarriesAnUnattestedInnerDomain` |
| diagnostics `received_at` moved 1000 h | **caught** | `TestTheReprocessDiagnosticsRowIsStampedWithTheRerun` |
| supersede backdated 1000 h | **caught** | `TestTheReprocessDiagnosticsRowIsStampedWithTheRerun` |
| `prev == nil` superseded anyway | **caught** | `TestReprocessRefusesAColdBodyWithNoTransactionOp` |
| `parse` uses `o.Outer` | **caught** | `TestReprocessOfForwardedMailRunsTheInnerBanksTemplate` |
| stored lane normalizes against `now` | **caught** | `TestReprocessDoesNotRedateAMessageItLeavesAlone` |
| held lane normalizes against `now` (added) | **caught** | `TestPromotedMailIsDatedItsArrivalAndNotItsConfirmation` |
| promoted op authored at `now` | **caught** | `TestPromotedMailIsDatedItsArrivalAndNotItsConfirmation` |
| `AttestedBy` always DKIM | **caught** | the two origin tests above |
| `AttestedBy` never set | **caught** | the two origin tests above |
| claim keyed by user only | survived | benign — see below |
| claim keyed by message only | survived | benign — see below |

The two the review re-classified as "caught only by the flaky test"
(`recordedOrigin` attests everything, normalize against `now`) now die to
deterministic tests, so the score no longer depends on a scheduling outcome.

### The new split: 4 of 4 die

| mutant | verdict | killed by |
|---|---|---|
| skip every undecodable blob, whatever its writer | **caught** | `TestReprocessFailsOnAServerBlobThisBuildCannotRead` |
| skip every device blob, whatever the error | **caught** | `TestReprocessFailsOnACorruptHotBlob` |
| the skip is not counted or logged | **caught** | `TestReprocessSkipsAClientBlobThisBuildCannotRead` |
| revert to failing the whole reprocess (the C4 defect) | **caught** | `TestReprocessSkipsAClientBlobThisBuildCannotRead` |

The last one is the regression guard for this whole round, and it fails with the
original symptom verbatim:

```
--- FAIL: TestReprocessSkipsAClientBlobThisBuildCannotRead
    one client blob from a newer build failed the whole reprocess:
    ingest: reprocess: hot blob at seq 3: op schema version newer than supported
```

(The runner reported it as "did not compile" — a false positive in its own crude
detector; it was re-run by hand and the tree builds.)

Three of the review's already-caught 18 were re-run as a control (stored-lane
trust re-check removed, always-supersede, leftover ids not counted) and all
three are still caught.

### Score

**31 / 33 (94%)**, against the review's own 33-mutant frame and its 18/33 (55%).
Both survivors are `promotionClaims`' key, which the review itself lists as
benign: with one user and one message in the test, either half of the key
serializes the racers identically. Killing them needs two users confirming two
different messages and an assertion about lock *contention*, which is not a
property a test can observe without instrumenting the lock.

---

## Not addressed, deliberately

- **`reprocessOne` does not check `sha256(raw) == ingestID`** (critic's Minor).
  Still true. It is one line, but the invariant it would pin belongs with
  whoever owns the cold-record writer, and adding a hash of every raw body to a
  reprocess is a real cost on the admin republish path this exists to serve.
- **`Examined == Appended+Superseded+Unchanged+Failed` is true by construction.**
  Agreed, and left as is — the critic itself calls this the benign instance.
- **I33/I34 (the claim key)** survive and are benign for the reason the critic
  gives: with one message and one user in the test, either half of the key
  serializes the racers. Pinning them needs two users confirming two messages
  concurrently and asserting a *negative* about lock contention, which is not a
  property a test can observe without instrumenting the lock.
