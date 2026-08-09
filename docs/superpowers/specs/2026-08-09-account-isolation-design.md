# Per-account isolation — design

**Date:** 2026-08-09
**Status:** approved by the operator, ready for a plan
**Depends on:** nothing
**Depended on by:** `2026-08-09-mail-ingest-redesign-design.md` (its lanes 2 and 3 are gated on this)

---

## 1. Why this exists

The beta is about to grow from one user to several invited strangers. The
operator's requirement, in his words:

> "My main concern is that an insider wants to deny service for everyone. I want
> user impacts to be isolated. We can go deep into security later, but I want the
> architecture set on a healthy foundation."

So the threat is **not** an outsider who learned an inbound address. It is a
holder of a valid invite, with a valid passkey and a valid session, who wants to
degrade or stop the service for everyone else.

### What is actually missing, verified in the code

| Finding | Evidence |
|---|---|
| `POST /api/v1/sync` is guarded by `requireSession` and nothing else | route at `internal/v2/api/api.go:752`; `handleUpload` in `internal/v2/api/sync.go` does shape, writer-liveness and chain checks, and calls no limiter |
| Upload caps are per request only | `maxUploadBlobs = 8`, `maxUploadBytes = 12 << 20` (`api.go:189-202`) |
| No cumulative per-account cap exists anywhere | nothing in `internal/v2/oplog` or `internal/v2/api` |
| Quarantine has no storage cap | `Store.Hold` inserts unconditionally (`internal/v2/quarantine/quarantine.go:399-415`). `QuarantinePerUser` (`api.go:463-466`) rate-limits `POST /quarantine/confirm`; it is not a storage cap |
| There is no way to suspend an account | the only account lever is `internal/v2/purge` |
| The pool is 16 connections | `cfg.MaxConns = 16` (`internal/v2/pg/pg.go:39`) |

A stored blob is capped at 1 MB (`internal/v2/oplog/chain.go:456`), so one upload
durably stores at most 8 MiB. With 33 GB free on the single 75 GB filesystem,
roughly **4,200 unthrottled uploads fill the box** — a few hours. A full disk
stops Postgres writing, which stops ingest and sync **for every user**. That is
the attack, and today nothing between a valid session and the disk prevents it.

### What is already sound — do not rebuild these

- **Server-side parsing is not a CPU denial-of-service.** Go uses RE2, which does
  not backtrack, so match cost is linear. `MaxBodyBytes` refuses oversized input
  rather than truncating it, `MaxCaptureRunes` bounds captures
  (`internal/v2/tmpl/exec.go:8-22,57-60`), the dialect carries rune-counted cost
  bounds (`dialect.go:84-107`), and the heuristic tier makes the same argument
  with a hostile-body test. The 125-second ReDoS in this project's history was a
  JavaScript backtracking property, not a Go one.
- **Reads are already bounded** per page (`pullByteBudget`,
  `internal/v2/oplog/read.go:81-97`). Read amplification is a bandwidth nuisance,
  not a storage hazard. **Writes are the problem.**
- Cross-account writes are unavailable: the session resolves the account and
  there is no user field on the wire.
- The SMTP limiter keys on the **user**, not the address, and rotation demands
  fresh identity proof — so rotation is not a quota reset.
- Dictionary poisoning needs three distinct submitters **and** moderator approval
  (`internal/v2/dict/dict.go:523`). Template publishing is operator-only.

---

## 2. The principle

> **Every durable byte must be attributable to exactly one account at the moment
> it is admitted, and admission must fail closed against that account's budget —
> in one place, not per endpoint.**

The codebase is already half way there and does not know it. Every write path
resolves the account before doing work: `requireSession` hands a `userID` to every
handler, and SMTP resolves address→user at `RCPT` before `DATA`. What is missing
is not attribution. It is **accounting and admission**.

The design point that matters most: the budget check belongs **at the storage
seam, inside the same transaction as the write** — not at the endpoint. An
endpoint check is the thing the next feature forgets. A check inside the appender
cannot be forgotten, because there is no second way to append.

---

## 3. The four primitives

### P1 — the account usage ledger

A table `account_usage(user_id, resource, amount)` with one row per
(account, resource). Resources at launch:

| Resource | Meaning |
|---|---|
| `oplog_hot_bytes` | durable bytes in the hot stream |
| `oplog_cold_bytes` | durable bytes in the cold stream |
| `quarantine_bytes` | held raw message bytes |
| `quarantine_count` | number of held messages |

**Maintained inside the same transaction as the write that changes it.** Two
seams only:

- `oplog` append (the one path to the log; see `AppendClient` / `appendRows`)
- `quarantine.Hold`, and the expiry sweep which decrements

Transactional co-location is the property that makes this durable against future
features: those are the only paths to **attacker-scale** durable bytes, so
instrumenting them covers every current and future caller — including both new mail
lanes, and Phase 3's sealed blobs, because sealing changes the bytes and not the
seam.

**Two implementation facts the plan must not miss.** `oplog`'s append already runs
in a transaction, but `quarantine.Hold` today is a bare `Exec`
(`internal/v2/quarantine/quarantine.go:407-410`) — "same transaction as the write"
therefore *requires converting Hold to a transaction*. And the decrement paths are
three, not one:

1. the expiry sweep,
2. **confirm-and-reingest** (`handleConfirmSender` → `Confirm` → `reingest`), which
   moves bytes out of quarantine and into the op log, so it decrements one resource
   and increments the other,
3. purge — the new tables (`account_usage`, `account_limits`, the refusal
   aggregate, the persisted SMTP counters) **must be added to the table list in
   `internal/v2/purge/purge.go:126`**, or deleting an account leaks rows.

### The small sinks, named so nobody concludes this is naive

Other tables an account can cause to grow: sessions, passkey credentials and
challenges, `address_rotation_challenges`, push tokens, key wraps, dictionary
submissions, `deleted_account_sessions`, diagnostic notices, and the refusal
aggregate itself. **None is attacker-scale**, and each is bounded twice: every
non-sync body is capped at 64 KB (`maxSmallBodyBytes`, `api.go:203-205`), and each
path has its own limiter (`api.go:428-466`). Sample reports carry no content by
construction, and push tokens are capped with newest-wins eviction. They are not
ledgered, deliberately.

Write churn on the per-account usage row is bounded by the same limiters, and
autovacuum handles the bloat. No action at beta scale.

Drift is the known failure mode of application-level accounting. So the ledger
ships **with** a reconciliation check in `internal/v2/verify`, the self-audit the binary
already runs on itself: recompute `sum(length(blob))` per account, compare against
the ledger, and report any difference as a finding. The check is the guard against
the ledger quietly becoming fiction.

### P2 — the admission gate

One function, called from those same two seams:

```
Admit(ctx, tx, userID, resource, delta) error
```

Policy lives in one table, `account_limits`: a single default row plus optional
per-account overrides. Refusals map to:

- API: `413` or `429` with a distinct machine-readable code
- SMTP: `452`, temporary and content-free, consistent with
  `internal/v2/smtpd/smtpd.go:202-208`

**Every denial increments a per-account refusal aggregate**
`(user_id, day, resource, count)` — counts only, no sender and no content, so it
leaks nothing and is unaffected by sealing. This is what keeps the promise that
nothing is silently dropped: the user's own app can say "N writes were declined
today", and the operator console can show who is hitting walls.

### Lock ordering — not optional

The append path pins **READ COMMITTED** deliberately: a `repeatable read` default
produced 41 serialization failures out of 60 (`internal/v2/oplog/append.go:317-326`).
It also has a hard ordering rule — `allocSeq` takes the per-account counter lock
**first**, before anything else reads or writes (`append.go:321-336`).

Therefore:

> **`Admit` runs AFTER `allocSeq`**, as part of `prepare` or immediately after it.

With that placement every same-account append is already serialized on the counter
row before the usage row is touched, so same-account concurrency contends on one
lock in one order, and different accounts touch disjoint rows. No deadlock is
possible between two appends. Under normal two-device sync the worst case is a
brief row-lock wait, not a user-visible error.

The quarantine-hold transaction touches only `quarantine_*` usage rows and the
append transaction only `oplog_*` rows, so the two paths are disjoint. **If any
future transaction ever updates more than one usage row, it must update them in
fixed resource-name order.**

Beta ceilings, as policy rather than code:

| Resource | Ceiling | Reasoning |
|---|---|---|
| op log | 256 MB per account | a real user's year is a few thousand sub-kilobyte ops; this is ~1000× normal use and ~0.7% of the disk |
| quarantine | 100 MB **or** 500 holds per account | a held bank email is tens of KB |

### P3 — account status

One column, `accounts.status ∈ {active, suspended}`, and two checks:

- `requireSession` denies **non-GET methods** for a suspended account, with one
  distinct code — `403 account_suspended` — so the client can render "account
  paused" rather than something that looks like data loss. **GET stays allowed**:
  pull, hashes and listings all keep working, deliberately, so a suspended user's
  devices keep reading their own data.
- **Sign-in is the one case outside `requireSession`**, and it writes a session
  row. A suspended account **may still sign in**. Read-only devices are the whole
  point of allowing pull, and they need a session to do it.
- SMTP recipient resolution answers `452` for a suspended account, so mail retries
  across a short suspension instead of bouncing.

**No role system is required.** The admin console is already the operator-only
surface by network position — permanently tailnet-bound, enforced at bind, with
`config.CheckAdminBind` and
`TestTheAdminConsoleIsNotMountedOnThePublicListener` guarding it. Suspend and
resume are two admin endpoints and two buttons. Deletion stays the separate,
existing path (`internal/v2/purge`).

### P4 — the headroom fuse

Per-account budgets multiplied by account count can still exceed the disk, and
Postgres has no native per-role storage quota. So there is a box-level backstop:
one goroutine calls `statfs` every 30 seconds and sets an atomic flag. Below a
reserved floor (**8 GB**), **all** durable writes are refused with temporary
errors (`503` on the API, `452` on SMTP) while reads keep serving. The state is
shown loudly on the admin console.

The floor is sized so Postgres, its WAL, and the operator's shell all keep
working. The box never reaches 100%.

**Stated so it is not later reported as a bug:** "all durable writes" includes
creating a session, so **nobody can sign in while the fuse is tripped**. That is
correct for an emergency state — the box is protecting its ability to recover —
but it must be deliberate and it must be in the copy.

> **Ops note, not architecture:** backups currently share the data filesystem
> (`/var/backups` on the same 75 GB root). They should move off it. That is
> operations work and is not part of this design.

---

## 4. Fair sharing

At beta scale — dozens of accounts at most — weighted fair queuing is
over-engineering. What must hold now is narrower: **one account saturating a
shared resource degrades only itself.** Three cheap mechanisms get there.

**Flow. The limiter must be weighted in BYTES, not in requests.** A request-counted
limit cannot serve both goals at once, and the arithmetic is worth stating because
an earlier draft of this spec got it wrong by three orders of magnitude:

- One upload durably stores up to 8 MiB (8 blobs × 1 MB,
  `internal/v2/oplog/chain.go:456`).
- At a sustained 1 request per second that is 86,400 requests per day ≈ **675 GB
  per day**, not the 0.7 GB the earlier draft claimed.
- Meanwhile bulk import genuinely needs hundreds of requests in minutes: one blob
  is one op, so a 5,000-op year is about 625 requests.

There is **no request rate that both permits an import and stops an abuser**,
because the two differ by blob size, not by request count.

So: a per-account token bucket **in upload bytes** — about 64 MiB burst and
256 MiB per day sustained — plus a modest request rate of about 2 per second,
purely for pool fairness. Import ops are sub-kilobyte, so a full year costs
roughly 3 MB of budget and finishes in minutes. An abuser sending maximum-size
blobs exhausts the byte bucket in eight requests.

**State the limiter's job honestly.** It shapes flow and slows an attack. **Only
the cumulative ceiling stops one.** Do not claim a rate limit turns an hours-long
disk fill into a weeks-long one; it does not.

This is why no behavioural filtering is needed even though bulk import makes
bursts legitimate: **the budget is the control, not the shape of the traffic.**

**Concurrency.** A small per-account in-flight cap (a semaphore keyed by account,
about 4) on the expensive endpoints, so one account cannot occupy the
16-connection pool. A Postgres statement timeout is the backstop.

**CPU.** Nothing new. Parse cost is bounded per message (§1), and message rate is
bounded per account by the mail quota, so CPU is already attributable and capped.
Do not build CPU accounting now.

What makes real scheduling additive later is exactly that every unit of work is
account-attributed before it starts. A future scheduler only needs to key on what
the request already carries.

---

## 5. Phasing

### P0 — before another invite is sent

Each of these is days, not weeks, and each stands alone.

1. **Suspend and resume** (P3). Without it, the only response to an active abuser
   is purge, which destroys both their data and the evidence.
2. **The headroom fuse** (P4). It converts "everyone loses writes until an
   operator intervenes at 3am" into "writes pause, with headroom intact".
3. **A per-account, byte-weighted rate limit on `POST /api/v1/sync`.** The
   `Limiter` type already exists and there are **14** limiter fields today
   (`api.go:428-466`); this is the fifteenth. It shapes flow and slows an attack.
   It does not stop one — item 4 does.
4. **A crude cumulative ceiling — placed INSIDE the append path, not at the
   endpoint.** A `SELECT sum(...)` is acceptable arithmetic at beta scale, but its
   **placement is not negotiable**: it goes in `appendTx`, so it covers
   `AppendClient` *and* `AppendIngest`. A ceiling written "per upload" would miss
   the ingest writer entirely — trusted mail appends one hot op and one cold raw
   body through the server's own writer, which never passes through
   `handleUpload`. It would also contradict this document's own principle that an
   endpoint check is the thing the next feature forgets.

   Ship it behind the same `Admit` name that P1 later replaces, so P1 is a change
   of implementation at one call site and not a change of shape. It is stateless,
   so there is no migration hazard in replacing it.

### P1 — with the mail lanes

The transactional ledger and `Admit` in both seams, refusal visibility, and the
per-account quarantine budget. Only then do mail lanes 2 and 3 ship.

### P2 — later, all additive, none blocking

the per-account concurrency semaphore and statement
timeouts; backups off the data filesystem; replacing the crude P0 ceiling with the
ledger everywhere; any move toward weighted scheduling.

---

## 6. Testing

- **Every test must be proven to bite.** Mutate the implementation, watch the test
  fail, revert. A check that cannot fail is this codebase's most repeated defect —
  `CLAUDE.md` records three separate NUL-byte instances alone, where a `grep`
  returned nothing and git diffed the file as binary, so sweeps and reviews both
  skipped it silently.
- `Admit` denies at the boundary: at the ceiling, one byte over, and far over.
- The ledger stays correct across a rolled-back transaction — the case that makes
  transactional co-location worth the trouble. Assert the amount is unchanged
  after a failed append.
- The expiry sweep decrements. A quarantine budget that only ever grows is a slow
  lockout of an honest user.
- Suspension denies writes and **permits pulls**, on both the API and SMTP paths.
- The fuse refuses writes below the floor and permits reads, with the floor
  injected rather than measured from the real disk.
- `CheckAdminBind` and `TestTheAdminConsoleIsNotMountedOnThePublicListener` must
  still pass **unmodified** after the suspend endpoints are added.

## 7. Migration

New tables and one column, applied as goose migrations. Per the runbook they are
applied **out of band as `ledger_migrate`, before the new binary starts** — the
service connects as `ledger_runtime` and cannot own the schema. New tables need
the two-role `GRANT` recipe from `00003_writers.sql`; that block never fires in
tests and only fails in production.

The ledger is **backfilled at migration time** from existing rows
(`sum(length(blob))` per account, and the equivalent for quarantine), so it is
correct from its first read rather than counting only from deployment onward.

**A window exists and must be closed deliberately.** Migrations run out of band
*before* the new binary starts, so the **old** binary — which does not maintain the
ledger — can keep writing between the backfill `sum()` and the restart. Either run
the backfill with the service stopped, or treat the first `verify` reconciliation
after deploy as **mandatory**, expected to find drift, and expected to repair it.

## 8. Open questions

- Ceilings are first estimates. They are policy rows, changeable without a
  deploy, and should be revisited once a real account's year of data is measured.
- Whether `requireSession` is the sole chokepoint for **every** mutating route was
  checked for the routes at `api.go:745-770` but not exhaustively enumerated. The
  plan should begin by enumerating the mux and confirming it.
