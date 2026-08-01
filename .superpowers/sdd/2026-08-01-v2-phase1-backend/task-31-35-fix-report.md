# Fix report — Tasks 31 (donated samples) and 35 (relay mode)

**Against:** `task-30-31-35-critic.md` (2026-08-01, HEAD `bf565c6`).
**Scope:** C6, C2, C1, C3 and the Importants filed under Tasks 31 and 35 only.
Task 30's C4/C5 and its Importants belong to `internal/v2/ingest`, which is
another session's file and is untouched here.

**Mutation work on a copy** under `.../scratchpad/mut` (the tree, with
`internal/v2/ingest` restored from HEAD because a concurrent session had it
mid-edit and red). The worktree itself was modified only by the changes below.

---

## 1. What changed

| # | Defect | Fix |
|---|---|---|
| C6 | `Samples.Report` took `sender_domain` from the request, contradicting spec §2:25 and the migration's own column comment | The report path now names one of the caller's OWN messages by ingest id; the domain **and** the layout fingerprint come from this server's `parse_diagnostics` arrival record. A caller-supplied domain or signature is refused. |
| C2 | §2 claimed the relay seals before spooling; it spools plaintext, and §2's unencrypted-surface list omitted the spool, the rejection lane and `addresses.json` | §2's first bullet corrected; the "three further unencrypted surfaces" bullet is now **six**, with the three relay-disk surfaces and the "no database purge reaches them" consequence; §3.2's relay bullet corrected. |
| C1 | A 404 from a primary that does not *mount* the relay routes filed the whole spool under `rejected/` in one tick | A rejection must now be **stated** by the primary in `X-Ledger-Relay-Verdict: reject`, never inferred from a status. 404/405/501 are recognised as "this primary is not serving the relay" — keep everything, stop the pass, alarm. |
| C3 | The entire durability protocol was unasserted (R1/R2/R3 all survived) | The two writes and the directory fsync go through a seam the tests observe; the write ORDER, each step's failure, both crash lanes and `writeSynced`'s own fsync are now pinned. |

**Importants closed:** IR1 (empty replica → permanent 550), IR2 (head-of-line
block), IR3 (transient body-read error read as permanent), IR4 (redirect
refusal unreachable), IR5 (R15/R5/R6), IS1 (consent registry), IS3 (`coldBody`
unscoped), IS4 (`verifiedOrigin`'s two decisions). Minors closed:
`Stats().Rejected` under-counting; report/donation idempotency semantics
(S14/S18/S19/S22); `ingest_id` case handling on both HTTP routes.

---

## 2. C6 — the report path's provenance

`Report` and `Donate` are now symmetric about provenance and asymmetric only
about content:

```
POST /api/v1/samples/report {ingest_id}           -> 204
POST /api/v1/samples/donate {ingest_id, consent}  -> 204
```

`arrivalRecordSQL` returns `(COALESCE(NULLIF(inner_origin_domain,''),
sender_domain), structure_sig)` for `(user_id, ingest_id, event='arrival')`, and
both paths go through it. A report stores the domain and the fingerprint that
query returned; the ingest id is a lookup key and is **not** stored on the row,
so the disclosed column set is unchanged and §2:25's row description still holds
byte for byte.

New refusals: `ErrOriginNotCallerSupplied` (400) for a caller-named domain or
signature, `ErrNotIngested` (404) for a message this account did not receive,
`ErrUnverifiedOrigin` (409), `ErrNoRecordedStructure` (409, new — a message no
normalizer could read has no layout to cluster, and the answer names donation as
the path that does work).

**The donation path was left alone.** Its checks, its errors and its wire shape
are unchanged; the only edit inside `Donate` is that it reads its domain through
the shared `recordedArrival` instead of the old `verifiedOrigin`, plus the
consent-registry check (IS1). The critic's judgement that the donation path
"gets this exactly right" is preserved rather than re-litigated.

Two side effects worth naming:

- **IS2 is largely dissolved on the default path.** `structure_sig` is no longer
  a cross-executor contract for a report: there is nothing for TypeScript to
  compute, so the Go/TS agreement that does not exist cannot be violated. The
  client sends the lower-case hex `ingest_id` it is already holding in the cold
  record it decoded. `diag.StructureSig`'s Go/TS parity is still owed for
  anything else that wants it, but §3.5:115's default path is now implementable
  end to end with no new TypeScript at all.
- The package-doc claim that "a donation lands in the SAME cluster the user's
  earlier reports did" is now checkable and checked
  (`TestAReportAndADonationOfTheSameFormatShareOneCluster`), because both
  signatures come from one Go function over one normalizer.

## 3. C2 — the exact §2 wording

First bullet, replacing "*The backup relay does the same before spooling
(§3.2).*":

> **The backup relay (§3.2) does not do this yet, and saying it did would be the
> one kind of error this page exists to avoid.** In Phase 1 the relay writes
> every message it accepts to its own disk **in the clear**, exactly as the bank
> sent it, and holds it there until the primary is reachable again — each
> spooled message carries a `"sealed": false` record beside it, so the phase is a
> fact on disk rather than a claim in a document. Sealing at the relay is Phase 3
> work (the address replica already carries the account public key it will need,
> and the relay cannot use the primary's op-log envelope for it — see §3.2), so
> until then the plaintext spool window is **disclosed** in the
> unencrypted-surfaces bullet below rather than claimed away here.

The surfaces bullet is now "**Six further unencrypted surfaces**": the three
database ones unchanged, then

> **The other three are files on the backup relay's disk (§3.2)** — a second host
> that has no database at all and holds nothing else about you: (a) **the
> spool**, every message the relay accepted while the primary was unreachable,
> held in the clear until the primary takes it (Phase 1; see the first bullet);
> (b) **the rejection lane**, messages the relay accepted and the primary then
> refused, which are *never deleted* — the sending mail server was already told
> the message was delivered, so nothing else will ever retry it, and a queue
> nobody looks at is a silent drop with extra steps; and (c) `addresses.json`,
> the relay's replica of the live inbound addresses, which it needs in order to
> refuse mail for addresses this system does not serve, and which is therefore a
> list of bearer capabilities (see the inbound-address bullet below). **No
> database purge reaches any of the three.** Deleting your account (§3.10) clears
> the primary's tables; it cannot clear another host's disk, so mail of yours
> sitting in that spool or that lane outlives it until an operator removes it by
> hand. That is an open operator decision rather than a solved problem (tracked
> in the project's NEEDS-SALEH log, §4). As of 2026-08-01 no relay host is
> provisioned, so all three are empty — this is disclosed now because it must be
> true *before* the relay carries real mail, not after.

§3.2's relay bullet now records that relay mode is built, that Phase 1 spools
plaintext, **why** the original "seals mail at arrival exactly like the primary"
sentence was impossible as written (`blob.Envelope` binds a writer counter the
relay cannot know), and that the §3.2:62 gate is therefore satisfied by the
disclosure branch. The shipping gate is met by disclosure, not by weakening it;
sealing the spool remains Phase 3 work and was not attempted.

## 4. C1 — before and after on the 404 tick

Reproduced first, on a copy, exactly as the critic described:

```
Drain against an unmounted route = (0 sent, 3 failed, <nil>)
live spool: []
rejected/:  3 × {.eml,.json,.why.txt}
```

After (`TestAPrimaryThatDoesNotServeTheRelayRoutesNeverRejectsAnything`):

```
Drain against an unmounted route = (0 sent, 0 failed, "the primary does not serve
    /api/v1/relay/deliver (404)")
live spool: 3
rejected/:  []
log: relay: THE PRIMARY DOES NOT SERVE THE RELAY ENDPOINTS (404 from …/relay/deliver).
     Nothing is being forwarded and NOTHING HAS BEEN DISCARDED — every message stays
     spooled. Check LEDGER_RELAY_TOKEN and relay.enabled on the primary.
```

The mechanism is a two-sided marker: `internal/v2/api`'s `relayReject` sets
`X-Ledger-Relay-Verdict: reject` on the four answers that really are about the
message (bad base64, oversize, malformed local part, unknown recipient) and on
nothing else; `relay.drainOne` sets a message aside only for an answer carrying
it, on a non-retryable 4xx. The status-only inference is gone. Drain's outcomes
gained `outcomeSkip` (keep this message, continue with the rest) so that a local
per-message failure neither discards nor blocks. The catch-all's 404 is asserted
to carry no verdict, and the two spellings are pinned against each other in
`TestTheRelayRoutesAreTheOnesTheRelayCalls`.

Cost, stated: against a primary that is up but misconfigured, or one older than
this change, the spool stalls loudly instead of draining. That is the direction
that cannot destroy mail.

## 5. C3 — the durability protocol

Reproduced first: R1 (drop `syncDir`), R2 (drop `f.Sync()`) and R3 (write the
commit record first) all left the suite green.

`writeSpoolFile` / `syncSpoolDir` are package variables that production never
reassigns; `durability_test.go` substitutes them to record the sequence and to
simulate a crash between the two writes. Four assertions:

1. the sequence is exactly `[write .eml, write .json, fsync dir]`;
2. each of the three failing makes `Deliver` fail (so smtpd defers and the
   sender keeps the message);
3. a crash after the body leaves an **uncommitted orphan** that the drain
   neither forwards, deletes nor rejects — and a commit record with no body,
   which is what the reversed order would produce, can only be set aside;
4. `writeSynced("/dev/null", …)` must fail — `fsync(2)` on a character device is
   EINVAL on Linux, which exercises the real fsync error path without a fault
   injector.

**All three critic mutations now die** (R1, R2, R3), as does a fourth
("a missing body is retried for ever instead of set aside").

## 6. Mutation scores

Runner: one literal substitution, `go test -count=1 <pkg>`, revert. Baseline
green before and after.

### `internal/v2/relay` — the critic's 10 survivors, plus 6 new mutants for the fixes

| mutant | before | now |
|---|---|---|
| R1 directory fsync dropped | SURVIVED | caught |
| R2 file fsync dropped | SURVIVED | caught |
| R3 commit record written first | SURVIVED | caught |
| R4 redirect refusal dropped | SURVIVED | caught |
| R5 non-atomic replica write | SURVIVED | caught |
| R6 `maxReplicaBytes` removed | SURVIVED | caught |
| R15 `outcomeRetry` no longer the zero value | SURVIVED | caught |
| R19 body-read error made a rejection | SURVIVED | caught |
| R20 `Deliver` accepts a foreign recipient | SURVIVED | caught |
| R24 sync status check removed | SURVIVED | caught |
| N1 any non-retryable 4xx is a rejection (the C1 defect itself) | — | caught |
| N2 404/405/501 not recognised as an unmounted route | — | caught |
| N3 an empty address map replaces a working replica | — | caught |
| N4 a local per-message failure stops the whole pass | — | caught |
| N5 the rejection lane counted by `.eml` again | — | caught |
| N6 a missing body retried for ever instead of set aside | — | caught |

Six of the critic's *caught* mutants were re-run as a regression check
(401/403 permanent, delete on any 2xx-or-above, digest check, rejected files
deleted, alarm never fires, stale replica refuses permanently): all six still
die. One of them — "401/403 made permanent" — briefly survived the C1 fix,
because the verdict rule made the bulk drop structurally impossible and nothing
then pinned *stopping the pass*. `TestOurOwnFailuresNeverRejectAMessage` now
spools three messages and asserts the drain makes exactly one attempt and names
`LEDGER_RELAY_TOKEN`. Caught again.

**Relay: 24/24 on the critic's denominator (was 14/24), and 30/30 counting the
six new mutants.**

The critic's report for this task claimed "7 attempted, 7 caught, 1 known
survivor". That was 7 mutants against a suite the critic then measured at 14/24;
the overclaim is corrected here, and the numbers above are stated with the
mutant list so the next reviewer can re-run them rather than take them.

### `internal/v2/samples` — 20 mutants, 18 caught

| mutant | before | now |
|---|---|---|
| S9 the attested inner origin is ignored | SURVIVED | caught |
| S10 the last arrival row wins | SURVIVED | caught |
| S14 report's content-free guard removed | SURVIVED | caught |
| S18 a repeat report bumps `created_at` | SURVIVED | caught |
| S19 a repeat donation overwrites consent | SURVIVED | caught |
| S22 32-byte ingest-id check removed (report) | SURVIVED | caught |
| S21 cold-body size bound removed | SURVIVED | **SURVIVED** (see §7) |
| S10b the empty-domain preference dropped (new) | — | caught |
| S22b the 32-byte check, donation path (new) | — | caught |
| T1 `Report` stores the caller's domain (the C6 defect itself) | — | **SURVIVED — equivalent** |
| T2 `Report` accepts a caller-supplied origin silently | — | caught |
| T3 `Report` skips the unverified-origin gate | — | caught |
| T4 `Report` stores an empty fingerprint | — | caught |
| T5 the consent registry is not consulted | — | caught |
| T6 the cold-stream read is unscoped | — | caught |
| T7 the arrival lookup is not scoped to the user | — | caught |

Plus four of the critic's *caught* mutants re-run as a regression check
(`Clusters` counts rows not people; retention ×10; a caller-supplied body
accepted; the donation's caller-supplied-domain refusal): all four still die.

**T1 is an equivalent mutant and is reported as one rather than as a hole.** It
appends `if sample.SenderDomain != "" { domain = sample.SenderDomain }` before
the INSERT — but the refusal seven lines above makes `SenderDomain` provably
empty at that point, so the statement is unreachable. The reachable form of the
same defect is T2 (delete the refusal), which dies, as does the direct assertion
`TestReportTakesItsProvenanceFromTheServersOwnRecord`.

**Samples: 20/21 on the critic's denominator (was 14/21). Counting the nine new
mutants: 28/30, both survivors unreachable by construction.**

*Method note.* The first samples battery was run while a second mutation runner
and an `rsync` were touching the same scratch tree, and it left `samples.go`
missing one line — so its verdicts were measured against a mutated baseline and
were discarded. Every number above is from a serial re-run on a freshly synced
tree, with the tree verified byte-identical to the worktree afterwards.

## 7. What is NOT closed

- **S21, the cold body's size floor and ceiling.** Reaching either would need a
  cold record the op log itself refuses to store (an empty body, or one over
  `blob.MaxColdMail`), so the check is unreachable through this package's own
  writer and the mutant survives. It stays as defence in depth against a future
  writer; a test would have to fabricate an op-log row behind `oplog`'s back,
  which is a worse trade than the survivor.
- **T1 is an equivalent mutant**, not a gap — see §6.
- **`diag.StructureSig` still has no TypeScript implementation or conformance
  suite** (IS2's second half). The *default* path no longer needs one — see §2 —
  but any future client-side use of the fingerprint does, and §3.5:111's
  "conformance fixtures against both executors" is unmet for `shape()`.
- **The consent registry is Go-side only.** `ConsentTexts` is a closed set that
  §2 must name (enforced by a test), which makes "what did they agree to"
  answerable. It does not join to `user_consent`, and the actual consent *text*
  lives in the client's onboarding copy rather than in a versioned document in
  this repo. Whoever writes that copy should land it under a path the registry
  can name.
- **The relay's spool is still plaintext** and account deletion still cannot
  reach it. Phase 3 work; disclosed now, and cross-referenced from §2, the relay
  package doc and NEEDS-SALEH §4 rather than duplicated.
- **`runRelay` is unchanged.** `Drain`'s signature is the same, so no edit to
  `cmd/ledgerd` was needed; its coverage is still only its refusal paths.
- **Task 30's C4 and C5** (the undecodable client blob, and the flaky
  `TestConcurrentConfirmationsAppendTheMessageOnce`) are `internal/v2/ingest`,
  owned by another session. C5 in particular still inflates any mutation score
  measured against that package's suite.

## 8. Verification

```
go clean -testcache && bash scripts/v2-check.sh
```

Run in a clean worktree at this commit, because the shared tree was red from
concurrent sessions (`internal/v2/ingest/reprocess.go` mid-edit). See the commit
message for the sha.
