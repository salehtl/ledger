# v2 Phase 1 — exit record

The recorded result of `client/test/e2e/exit.test.ts`, which is spec §5's Phase 1
exit criterion in executable form.

> *Exit: headless client replays cleanly with invariants green across two
> concurrent writers, including a supersede-after-template-fix round-trip; ≥95%
> of alphas' genuine transaction mail parses over two consecutive weeks; zero
> drops without notice (every inbound email accounted for in diagnostics or
> quarantine).*

**Run date:** 2026-08-01
**Branch:** `v2` (worktree `/root/Coding/ledger/.claude/worktrees/v2`)
**Tested against:** `3dba711` plus this task's own changes. Three fixes from a
parallel session landed while this ran — `ababae1` (discarded-duplicate
detection, the `A3_duplicate_of_nothing` finding and the `S5_counter_matches_head`
structural check), `da817f5`, `3dba711` — and the run below **includes** them.
That matters for step 13: `ledgerd verify` before `ababae1` could certify "zero
drops" over a live drop class, so a green step 13 on an older commit would have
meant less.
**Command:** `cd client && bun test test/e2e/exit.test.ts`
**Result:** 16 tests, 0 fail, 201 `expect()` calls, against a real `ledgerd`, a
real Postgres, real SMTP over a socket and offline DKIM (`--dns-fixtures`).
**Gate:** `go clean -testcache && bash scripts/v2-check.sh` → `v2-check: OK
(go + client + conformance)`; 1904 client tests across 17 files, 0 fail.

---

## The fourteen steps

| # | What it asserts | Outcome |
| --- | --- | --- |
| 1 | Fresh migrated database, `ledgerd serve --dev-auth --dns-fixtures`, `GET /api/v1/healthz` → `{"status":"ok","db":"ok"}` | **pass** |
| 2 | One account, two writers; `dev-b` enrolled by an Ed25519 signature from `dev-a`'s key over `RegistrationMessage(nonce, "dev-b", pubB)`, not by a session token | **pass** |
| 3 | `dev-a` emits `home_currency_set(AED)` + `rate_set(USD, 3672500)`, pushes; `dev-b` pulls both | **pass** |
| 4 | An explicit `cli checkpoint`; the checkpoint names one head per **(roster writer × stream)** pair, `dev-b` at counter 0 / genesis; no `I11` hard stop and no "no checkpoint yet" notice on `dev-b` | **pass** |
| 5 | 20 corpus messages over SMTP → 20 hot + 20 cold ops, 0 held, hot counters 1–20 and cold counters 1–20 on independent chains | **pass** |
| 6 | **Hot-only** pull: 20 rows, **zero cold bytes**, strictly increasing but non-contiguous `seq`, no `I1`/`I2` hard stop, all 20 transactions materialized | **pass** |
| 7 | 3 unknown-origin messages held (0 ops appended), confirmed `scope:"inner"`, re-ingested, 3 `event='reprocess'` `outcome='appended'` rows, 3 new transactions | **pass** |
| 8 | `POST /api/v1/quarantine/confirm {domain:"gmail.com", scope:"outer"}` → **409 `forwarder_domain`**, and the refusal names the inner scope | **pass** |
| 9 | Same-parent fork from two offline writers, pushed `dev-b` then `dev-a`: both devices materialize the later `authored_at`'s category, both report **exactly one** `ForkNotice` with the same winner/loser op ids | **pass** |
| 10 | Corrected template version supersedes exactly one transaction; one live transaction per ingest id on both devices; the FX snapshot recomputed **fresh at its own position** | **pass** |
| 11 | `pull-cold-hashes` advances the pinned head from genesis to 23; an honest cold range verifies; a body with one flipped byte is refused **`I3b_cold_hash_list`** and persists nothing | **pass** |
| 12 | `checkAll` on both devices, both streams: **zero `hard_stop`**; the full notice list printed | **pass** |
| 13 | `ledgerd verify --json` → exit 0, `findings: []` | **pass** |
| 14 | The accounting equation over the window | **pass** |
| 15 | `ledgerd parse-rate` runs against the real database and prints the §5 number (the *instrument*, not the criterion) | **pass** |

## Step 4 — the checkpoint, verbatim

```
dev-a|cold=0/00000000  dev-a|hot=1/a0a8801b  dev-b|cold=0/00000000  dev-b|hot=0/00000000
```

`dev-b` has authored nothing and is named anyway, at counter 0 with the 64-zero
genesis hash — `CHECKPOINT_NAMES_THE_ROSTER`. A checkpoint built from *observed*
heads could not name it, and `I11_roster_checkpoint` would then hard-stop every
sync forever with no checkpoint any device could emit able to clear it.

**The plan predicted "0 hard stops, 1 notice" here and the count is unreachable:**
`I11` emits one notice per checkpoint head on the stream a pull did *not* cover,
so a hot check carries one per writer. What is asserted instead is the property
the step is about — no `I11` hard stop, and the "no checkpoint yet" notice gone.

## Step 9 — the fork notice, verbatim

```json
[{"entity":{"kind":"txn","id":"01KYZDVVP1N3K6PMG9QBM2D9YV"},
  "winner_op":"01KYZDVVYP8P65ZW8WZ8K97BNN",
  "loser_op":"01KYZDVVYGRWK3K8XNRYAHCV7B",
  "at_seq":"50"}]
```

Identical on both devices. `dev-b` categorized `dining` and pushed first;
`dev-a` categorized `groceries` with a later `authored_at` and pushed second;
both devices materialize `groceries` at version 3. The two `emit`s are separated
by a deliberate 5 ms sleep — `authored_at` has millisecond resolution and a tie
falls through to a `writer_id` comparison, which would make the winner depend on
how fast the machine is.

## Step 10 — the two snapshot values

```
step 10 snapshot: USD 10000 home 36725  ->  AED 410000 home 410000
```

* **Before**: template `e2e.enbd.transfer` v1 read `100.00` out of
  `Debit Amount:\nAED 4,100.00` and declared `default_currency: "USD"`, so the
  transaction was `USD 100.00` and its frozen home-currency snapshot was
  `100.00 × 3.6725 = AED 367.25` (36 725 fils).
* **After**: v2 restores the currency capture group and the whole number, so the
  superseding transaction is `AED 4,100.00` and its snapshot is the **identity**
  value, 410 000 — computed at the supersede's own log position from the rate
  head there, not inherited. Inheriting would have left 36 725.

Both devices agree, and each has exactly one live transaction for that ingest id
(`liveByIngestID`), with the predecessor retired via `superseded_by`.

## Step 14 — the accounting, verbatim

```json
{
  "inbound_total": 23,
  "inbound_identities": 23,
  "arrival":   {"appended": 19, "quarantined": 4, "rejected": 0, "duplicate": 0, "over_quota": 0},
  "arrival_sum": 23,
  "reprocess": {"appended": 4, "superseded": 1, "unchanged": 0},
  "unaccounted": 0,
  "discarded": 0,
  "balanced": true,
  "ok": true,
  "findings": null,
  "protocol_rejections_total": 0,
  "quarantine": {"expected": 4, "held": 0, "expired": 0, "promoted": 4, "accounted": 4, "untraced": 0, "extra": 0}
}
```

**Two of the plan's numbers were wrong and the reason is a real property of the
system, not a test artefact.**

1. The plan expected `arrival.appended == 20` and `arrival.quarantined == 3`.
   **An origin cannot be allowlisted before a message from it has been held** —
   `quarantine.Confirm` answers `origin_unproven` for a domain no held message
   carries a verified signature from, deliberately, so that naming a domain is
   not a way to pre-trust it. So the *first* message of every origin is
   quarantined and then promoted, and the split is 19 + 4 with
   `reprocess.appended == 4` (3 forwarded + 1 ENBD bootstrap).
   `inbound_total == 23`, `reprocess.superseded == 1` and `unaccounted == 0` are
   exactly as the plan says, and those are the criterion.
2. `reprocess.superseded == 1` is reachable only because step 10 reprocesses a
   **one-message window** (`?from=&to=` on the admin route). The committed corpus
   holds two distinct ENBD messages, so 20 deliveries are 10 byte-distinct copies
   of each and a template fix would otherwise change ten transactions at once.

## The notices, in full (step 12)

Zero `hard_stop` on both devices, on both streams. Printed rather than
summarised, because a notice list nobody reads is the same as no invariants:

```
dev-a hot:  I11 the server served blobs from writer "ingest", which its own roster does not list
            I11 checkpoint head (dev-a|cold) claims counter 0 and was not cross-checked: hot only
            I11 checkpoint head (dev-b|cold) claims counter 0 and was not cross-checked: hot only
            I14 1 fork, 18 anomalies (possible_duplicate 18)
dev-a cold: I11 checkpoint head (dev-a|hot) claims counter 2 and was not cross-checked: cold only
            I11 checkpoint head (dev-b|hot) claims counter 1 and was not cross-checked: cold only
            I14 1 fork, 18 anomalies (possible_duplicate 18)
dev-b hot:  (as dev-a hot)
dev-b cold: I11 the server served blobs from writer "ingest", which its own roster does not list
            I11 checkpoint head (dev-a|hot) claims counter 2 and was not cross-checked: cold only
            I11 checkpoint head (dev-b|hot) claims counter 1 and was not cross-checked: cold only
            I14 1 fork, 18 anomalies (possible_duplicate 18)
```

Two of these are findings rather than noise, and the test pins both so they
cannot quietly change:

* **`GET /api/v1/writers` does not list the server's own `ingest` writer.**
  A `writer_checkpoint` therefore names no head for the chain the user's *mail*
  lives on, and a truncation of the ingest chain would verify against every
  checkpoint in the log. `I11` reports it as a notice because the roster is the
  server's own answer and a hard stop would let a server disable sync by
  omitting a writer. Worth closing before the beta: either the roster lists
  `ingest`, or `attestableHeads` names it unconditionally.
* **18 `possible_duplicate` anomalies.** The corpus is 10 byte-distinct copies
  of each of 2 real messages (Task 37 §8.1), so the fingerprint heuristic fires
  9 times per group. Both rows stay live, which is the specified behaviour
  (§3.3:67) — the test asserts every anomaly is of that kind and that
  `liveByIngestID` still holds 23 entries.

## The criterion that is NOT met here, and why

**"≥95% of alphas' genuine transaction mail parses over two consecutive weeks"
cannot be met by a test.** It needs live alpha traffic and an operator
adjudicating every `tier='none'` arrival as `transaction` /
`non_transactional` / `unreadable`, because `parse_diagnostics` stores no
content by design and nothing in the schema can tell a bank alert from a
newsletter. Step 15 asserts the *instrument* instead: `ledgerd parse-rate` runs
against the real database, computes the numerator from diagnostics, and prints
the gate. On this scenario:

```
parse rate 2026-08-01T19:45:59Z .. 2026-08-01T19:47:59Z
  parsed (numerator)       23  (template 22, heuristic 1)
  unparsed population      0
  adjudicated              0  (transaction 0, non-transactional 0, unreadable 0)
  rate                     100.00%  (whole population adjudicated, no sampling error)
  exit gate (>= 95%)       true
  NOTE: this is parse COVERAGE, not correctness…
```

The Wilson lower bound is not exercised because nothing was sampled — every
arrival is in the population. **The criterion itself is Task D6's**, and it is
recorded here when it is measured, together with the adjudication counts and the
explicit note that this measures parse *coverage* and not extraction
*correctness*.

## The two-week measurement (Task D6)

*Not yet run.* Fill in below after two consecutive weeks of alpha traffic:

| field | value |
| --- | --- |
| window | |
| `ledgerd parse-rate --from … --to …` output | |
| adjudicated `transaction` / `non_transactional` / `unreadable` | |
| sampled? Wilson 95% lower bound | |
| daily `unaccounted == 0` confirmed for all 14 days | |
