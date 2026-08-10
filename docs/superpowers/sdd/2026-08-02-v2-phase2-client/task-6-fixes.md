# Task 6 fixes — the two clocks, the unmeasured invite code, and the note that outlived the account

**Commit:** `7adaa6b` on `v2`, parented on `de67c08`.
**Gate:** `go clean -testcache && bash scripts/v2-check.sh` in a `git archive 7adaa6b`
export at `/tmp/verify7ada` with `client/node_modules` copied in — **exit 0**, script's
own final line `v2-check: OK (go + client + conformance)`. 27 Go packages `ok`, zero
`FAIL`; client `2246 pass / 0 fail / 15781 expect() calls` in 23.49s at load average 0.8.
The exit code captured is the script's, not a pipeline's (`bash scripts/v2-check.sh >
log 2>&1; echo $?`).

**Mutation score: 21/21.** Battery and log below.

I picked this up mid-task: a previous agent had already landed most of finding 1 as
uncommitted work in the tree (`00022`, `ReapDeletedAccountTombstones`, the `cmd/ledgerd`
wiring, `00021`'s corrected comment, and two skew tests). Its last words were "now update
00021's comment and wire the sweep in cmd/ledgerd" — both of which it had in fact done.
I read that work, kept it, and added what it did not have: tests for the reap itself, a
wiring instrument that measures `runServe` rather than the starter, and findings 2 and 3.
Everything below is verified at `7adaa6b`, not inherited on trust.

---

## 1. One clock now decides — and the calendar decides nothing

### What was wrong

`00021`'s `tombstone_account_sessions()` argued, correctly and at length, that filtering
the tombstone INSERT on `expires_at > now()` would make the table depend on a *second*
clock. It then ended the same function with

```sql
DELETE FROM deleted_account_sessions WHERE expires_at < now() - interval '30 days';
```

which is that same second clock thirty days downstream: `now()` is Postgres's, and
`expires_at` was copied from a `sessions` row whose expiry `auth.Sessions.Now` computed.
The sweep ran *after* the INSERT in the same invocation and over the whole table, so one
`DELETE FROM users` destroyed the tombstone it had just written **and every other
account's**. The device then got a bare 401, which Task 13's `mayWipeLocalData` refuses
to wipe on precisely because it is indistinguishable from an expiry — so the deleted
account silently became an expired session.

### The fix

**`00022_tombstone_sweep_leaves_the_trigger.sql`** `CREATE OR REPLACE`s the
function with the INSERT alone (a new migration, not an edit to `00021`, because goose
never re-runs an applied one). The reaping is now
`auth.Sessions.ReapDeletedAccountTombstones`, bounded by `s.now().Add(-tombstoneGrace)`
— the same clock, the same object and the same file as `deletedOrUnknown`, two functions
apart. `cmd/ledgerd` runs it on the hourly sweep loop beside quarantine, samples and the
dictionary.

That placement also preserves `00021`'s real objection to sweeping on the lookup path,
which still stands: `deletedOrUnknown` runs on every unrecognized bearer token, so
reaping there would let anyone holding a socket make this server write. A ticker in the
serving process is neither attacker-triggerable nor dependent on an account ever being
deleted again.

`00021`'s comment now says `SUPERSEDED BY 00022` at the deleted statement and explains
why the body is left intact; its index comment names the sweep's new home.

### How this is tested without a date-dependent test

Three instruments, none of which reads a calendar:

**(a) Skew is a duration, not a pinned instant.** `newSkewedClock(d)` returns
`time.Now().UTC().Add(d)`. `TestATombstoneOutlivesADisagreementBetweenTheGoAndPostgresClocks`
runs at −31d, −90d and +90d. The same disagreement exists on every day this suite will
ever run. (The critic's fuse was real: `newClock()` is pinned to `2026-08-01T12:00:00Z`
with a 1h TTL, so the trigger's sweep would have started eating those rows on
`2026-08-31T13:00:00Z`. With the sweep gone the fuse is gone, and no test I added
substitutes a new one.)

**(b) The premise is measured, and the outcome is unreachable by the wrong clock.**
`TestReapingTombstonesUsesTheSessionsClockAndSparesRowsInsideTheGrace` builds three
tombstones under a clock 90 days *ahead* of wall time —

| row | state | must |
|---|---|---|
| A | expired long before `now() − tombstoneGrace` | be reaped |
| B | expired an hour ago, inside the grace | survive |
| C | still live | survive, and still answer 410 |

— and then, **before** reaping, asserts

```sql
SELECT count(*) FROM deleted_account_sessions WHERE expires_at < now() - interval '30 days'
```

is **0**. Every row's `expires_at` is in Postgres's future, so a Postgres-clock
implementation could only score 0 reaps. `n == 1` is therefore not consistent with the
wrong clock; the test cannot pass for the reason the old code would have made it pass.
That assertion is the difference between measuring the clock and measuring the
arithmetic.

**(c) Three rows, not one.** A single-tombstone fixture cannot distinguish "spared the
row inside its grace" from "the sweep did not run this time", and it cannot see the
cross-account destruction at all — which is why
`TestDeletingOneAccountDoesNotReapAnotherAccountsTombstone` deletes **two** accounts and
checks the first device still gets `ErrSessionAccountDeleted`.

**(d) A date-dependent test that already existed was removed.**
`TestTombstoneExpiryIsDecidedByTheSessionsClock` used the pinned `newClock()` and
`t.Skip`ped itself when wall time had not yet passed it — silently vacuous on any box
whose date disagreed, and green for a reason no one chose. It now takes
`newSkewedClock(-2 * time.Hour)` and **asserts** its premise (`Postgres considers this
session expired`) instead of skipping on it.

**(e) The wiring is measured against `runServe`'s syntax tree, not by calling the
starter.** `TestEverySweepIsStartedAndAwaitedByRunServe` parses `main.go`, *discovers*
every `start*Sweep` declaration (a hand-maintained list would be one more thing to forget
— which is the bug), and requires each to be called in `runServe` **and** its channel
received from on shutdown. This is the AGENT-RULES defect shape that has landed six
times here; the pre-existing `TestDictSweepIsWiredAndToleratesNoStore` calls
`startDictSweep(nil)` directly and says nothing whatever about whether `runServe` reaches
it, so `M8`/`M9` would have survived it.

### Judgement call worth recording

`tombstoneGrace` is a Go constant (30 days) rather than a config key. It is not a
correctness window — a row past its own `expires_at` already answers nothing, because
`deletedOrUnknown` refuses it — so it only bounds the table, and
`TestTheTombstoneGraceIsAFiniteWindowPastExpiry` pins that it is finite and non-zero
rather than pinning the number.

---

## 2. The invite code's entropy is now measured, twice, in two different ways

`403 not_invited` is a perfect oracle: a guesser learns on every attempt whether the code
they tried exists. Entropy is the only thing between this beta and open sign-up, and it
was asserted **in a comment, on the same line that would have to change to break it** —
the exact "true by construction" shape. A 16-bit code and a counter both passed the whole
package.

### Properties pinned (`TestMintedInviteCodesAreUnguessable`, 256 codes minted through `MintInvite`)

| property | assertion | what it kills |
|---|---|---|
| length | exactly 24 characters | `inviteCodeBytes = 2` fails on the first code, before any statistic |
| alphabet | every rune in `A–Z2–7`; no padding | a base64/hex/lower-case switch |
| bit budget | decodes under `inviteAlphabet` to exactly 15 bytes = **120 bits** | a silently shortened code |
| normal form | `NormalizeInviteCode(code) == code` | mint/redeem drift |
| per-**byte**-position variation | ≥64 distinct values at each of the 15 byte positions | a counter, a partially-zeroed buffer, a narrowed byte range |
| per-**character**-position variation | ≥16 distinct symbols at each of the 24 positions | a low-entropy alphabet |
| pairwise independence | no two of the 256 codes share more than 6 of 15 byte positions | sequential minting; consecutive counter values share 13–14 |
| distinctness | all 256 differ | (a corollary, not the headline) |

**I did not implement the critic's suggested test, because it does not work.** The
suggestion was "1,000 codes with no repeated 4-character prefix — a counter fails this
immediately". A 4-character base32 prefix is 20 bits, and the proposed counter mutant is
**little-endian** (`raw[i] = byte(c >> 8i)`), so byte 0 varies fastest and 1,000 counter
codes have 1,000 distinct prefixes. That test passes on a counter. Per-*position*
variation is the version that works, because what a counter cannot do is vary byte 14.
This is precisely the "would this test still pass if the property it names were false?"
question, and the answer for the suggested test was yes.

False-failure arithmetic, so the thresholds are bounds and not flake sources: at 256
draws a byte position sees ~162 distinct values on average (floor 64) and a character
position ~32 of 32 (floor 16); the chance a given pair agrees in ≥7 of 15 bytes is
C(15,7)·256⁻⁷ ≈ 9·10⁻¹⁴, ≈3·10⁻⁹ across all 32,640 pairs.

### The half a statistic cannot see

`TestTheInviteCodeSourceIsCryptoRand` reads `invite.go`'s syntax tree: `crypto/rand`
imported, `math/rand` and `math/rand/v2` **not**, and `MintInvite` actually calling
`rand.Read`. This exists because `mrand.New(mrand.NewSource(1))` passes every statistic
in the table above — uniform, independent, all distinct within a process — while shipping
the *same 256 codes to every deployment that ever runs the binary*. The property that
fails there is the seed, and the only place the seed is visible is the import. Mutant M13
confirms it: statistics green, this test red.

Every code in both tests is minted through `MintInvite`, the production entry point, so
there is no untested seam between what is measured and what an operator runs.

---

## 3. `invite_codes.note` — reaped, and three descriptions reconciled

### The decision

**Reap it**, per the dispatch's preference, and I agree with the preference. The
counter-argument (it is the operator's own audit trail, not the user's data) is real but
it loses: the note is *free text about a person* whose own documented example in `00020`
is `saleh''s brother`, it sat beside `redeemed_at` — the timestamp of that person's
sign-up — and in a beta of a dozen people that pair names a deleted account outright, to
exactly the party the row is retained for. What the operator actually needs from the row
survives untouched: it is still there, still flagged spent, still carrying `code_hash`,
`created_at` and `redeemed_at`, and still not spendable again.

### How

`00023_invite_note_dies_with_the_account.sql` — a `BEFORE UPDATE` trigger on
`invite_codes` with `WHEN (OLD.redeemed_by IS NOT NULL AND NEW.redeemed_by IS NULL)`,
setting `NEW.note := NULL`.

Keyed on the FK's own `SET NULL` transition rather than on `DELETE FROM users`, because
the invariant being enforced is the narrower one — *the note never outlives the link it
describes* — and that makes it a row-level fact the way single-use redemption is: the
cascade from `DELETE FROM users`, `purge.Purge`, a future admin unlink and an operator at
`psql` all clear it, and no future caller has to remember. `BEFORE`, not `AFTER`, so it
is a field assignment on the row already being written rather than a second `UPDATE`
recursing into the same trigger. An **outstanding** code keeps its note — its
`redeemed_by` was already NULL so the trigger never fires — which is the case
`mint-invite --show` exists for.

Nothing in `purge`'s behaviour changes: this fires on an `UPDATE` that `purge.Purge`'s
`DELETE FROM users` already causes, and `invite_codes` stays classified `notUserLinked`
for the reason `00020` gives (a `user_id` column here would make `checkCascades`
correctly refuse the whole purge, while the `CASCADE` it would then demand would put a
spent code back into circulation).

### The three descriptions

| where | before | now |
|---|---|---|
| `00020_invite_codes.sql`, the `note` column comment | described free text, said nothing about deletion, while the `redeemed_by` paragraph below claimed "an unattributable residue, not a record of anybody" | names `00023`, and states plainly that this column was the reason that paragraph was not true of the row as a whole |
| `deploy/README-v2.md` — the `notUserLinked` table (§`parse-rate`) and the `mint-invite` section | "`redeemed_by` is nulled by the schema; what survives is 'some code was spent, and nobody knows by whom'" | both columns named, `--show` documents the empty note after a purge and the retained note on an outstanding code, plus "if you need a permanent record of who you invited, keep it somewhere that is not this database" |
| `internal/v2/purge/purge.go`, `notUserLinked` | "The link is the only user-attributable thing here and it is removed by the schema itself" | **not edited — the dispatch forbids touching `internal/v2/purge/`.** The claim is no longer false (the note no longer survives), but it is now incomplete: `note` is removed by the schema too, by a trigger rather than by the FK. `00023` carries the coordination note naming the file and the sentence owed. **One sentence is owed in `purge.go` and I did not write it.** |

The thing actually holding the claim up is neither of the three comments. It is
`TestNoTextTheOperatorWroteAboutADeletedAccountSurvivesInTheInviteRow`, which enumerates
`invite_codes`' text columns **from the catalog** and scans each one for the operator's
words — so a column added later carrying an email, a referrer or a ticket id fails
without anybody having to remember this file exists. (It also refuses to pass vacuously:
it fails if the table has no text columns at all.)
`TestDeletingAnAccountForgetsTheOperatorsNoteAboutThemAndNobodyElses` uses **three**
codes — deleted, live, outstanding — because a single-deletion fixture cannot tell
"cleared the right note" from "cleared every note", and it asserts the note is present
*before* the deletion so a reaping with nothing to reap cannot pass.

---

## Mutation battery — 21 deliberate defects, 21 caught

Runner: `/tmp/mut/run.py`. It **copies the tree per mutant** into `/tmp/mut/work` and
never patches in place, so a SIGKILL cannot leave a mutated file behind to corrupt later
results — the failure mode the critic hit with Task 6's original runner, whose `ROOT`
pointed at the shared worktree. Baseline at the same tree: `./internal/v2/auth/` and
`./cmd/ledgerd` both `ok` before any mutation.

| # | mutation | result | caught by |
|---|---|---|---|
| M1 | the sweep goes back into `00021`'s trigger | caught | `…OutlivesADisagreement…`, `DeletingOneAccountDoesNotReapAnother…` |
| M2 | the reap judges on Postgres's `now()` | caught | `ReapingTombstonesUsesTheSessionsClock…` |
| M3 | the reap drops the grace | caught | same |
| M4 | the reap deletes nothing | caught | same |
| M5 | the reap deletes everything | caught | same |
| M6 | `tombstoneGrace = 0` | caught | same + `…GraceIsAFiniteWindow…` |
| M7 | `deletedOrUnknown` judges on Postgres's clock | caught | four tests |
| M8 | `runServe` never starts the tombstone sweep | caught | `EverySweepIsStartedAndAwaitedByRunServe` |
| M9 | it starts it but never awaits it | caught | same |
| M10 | the sweep loop is a no-op | caught | `TombstoneSweepSurvivesAFailureAndStopsOnShutdown` |
| M11 | a 16-bit invite code | caught | `MintedInviteCodesAreUnguessable` |
| M12 | codes minted from a counter | caught | same |
| M13 | codes from `math/rand` with a fixed seed | caught | `TheInviteCodeSourceIsCryptoRand` |
| M14 | only the first four bytes are random | caught | `MintedInviteCodesAreUnguessable` |
| M15 | every byte narrowed to two bits | caught | same |
| M16 | hex, not base32 (30 chars over 16 symbols) | caught | same |
| M17 | the note is not reaped (`NEW.note := NEW.note`) | caught | both note tests |
| M18 | the trigger is never created | caught | both note tests |
| M19 | the `WHEN` clause dropped: every note dies on any update | caught | `…NoteAboutThemAndNobodyElses` |
| M20 | the `WHEN` clause reversed: the note dies at redemption | caught | same |
| M21 | deletion wipes *every* note, not the deleted account's | caught | same |

**Two of my own first drafts were bad mutants and are reported as such rather than
counted as either result.** M12 v1 did not compile (no `mintCounter` declaration) — fixed
by declaring it, then caught. M18 v1 *renamed* the trigger instead of removing it, which
changes nothing, and it "SURVIVED" for that reason; rewritten to delete the
`CREATE TRIGGER` statement outright, it is caught. The lesson is the one AGENT-RULES
states: when a mutant survives, check the mutant and the test before believing the
result. In M18's case the fault was in neither the test nor the code, it was in me.

---

## What is not exercised

- **Nothing on a device.** No Apple account, no Mac, no floor device. This change is
  server-side only, so the only device-facing surface is the 410/`account_deleted` pair,
  and that is exercised at the `auth` layer and (pre-existing) at the API layer, never on
  a phone.
- **Real clock skew between two hosts.** Skew is simulated inside Go by moving
  `Sessions.now()`. `ledgerd` and Postgres share `dinosaur` today, so the production
  disagreement is currently zero; the point of the fix is that correctness no longer
  depends on that remaining true.
- **The hourly ticker over an hour of wall time.** The tests prove the sweep is started,
  awaited, survives a failing database, stops on cancel, and does the right thing when
  called. The interval itself is the shared `quarantineSweepInterval`. **No test asserts
  a wall-clock duration**, by rule.
- **`mint-invite --show` rendering after a reap.** `ListInvites` coalesces `NULL → ""`
  and the printf path takes it unconditionally, so the line renders with an empty note
  and cannot panic — read, not executed. No test drives the CLI's stdout.
- **The OS entropy source.** The tests measure a 256-code sample from one process plus
  the import graph. They cannot see a compromised `getrandom(2)`.
- **`purge.go`'s comment**, as above — one sentence owed, deliberately not written.
- **The critic's own Task 6/7 batteries were not re-run.** I ran the full gate, which
  covers both packages, and my own 21.
- **Client-side.** `client/` and `app/` are untouched by this commit; the gate's
  `bun test` ran green (2246/0) but that is a regression net, not evidence about these
  three fixes.

## Files

- `internal/v2/auth/session.go` — `tombstoneGrace`, `ReapDeletedAccountTombstones`
- `internal/v2/auth/deleted_account_test.go` — skew clock, three-row reap test, two-account test, de-dated existing test
- `internal/v2/auth/invite_test.go` — entropy suite, `crypto/rand` source test, note tests
- `internal/v2/pg/migrations/00022_tombstone_sweep_leaves_the_trigger.sql` — new
- `internal/v2/pg/migrations/00023_invite_note_dies_with_the_account.sql` — new
- `internal/v2/pg/migrations/00021_deleted_account_sessions.sql`, `00020_invite_codes.sql` — comments only
- `cmd/ledgerd/main.go` — `startTombstoneSweep`, wired into `runServe`
- `cmd/ledgerd/main_test.go` — the AST wiring instrument, the sweep-failure test
- `deploy/README-v2.md` — four sweeps, the clock rationale, entropy, the note
