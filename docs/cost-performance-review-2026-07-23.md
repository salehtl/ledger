# Cost & Performance Review — 2026-07-23

Scope: full app review (Go backend, SQLite, IMAP ingest, AI paths, frontend PWA) plus the live
production instance on `dinosaur`. Focus: where money or resources are spent today, and what would
spend them tomorrow.

## Live snapshot (measured on prod)

| Metric | Value | Note |
|---|---|---|
| DB size | 165 MB | **164 MB of it is raw email bodies** in `ingest_log` (6,965 emails, ~24 KB avg) |
| Process RSS | ~245 MB (peak 256 MB) | no `MemoryMax` in the systemd unit |
| CPU | 21 min over ~45 h uptime (~0.8%) | idle load is polling, not requests |
| IMAP mode | poll every 60 s, `use_idle = false` | ~1,440 Gmail logins/day for ~4 real emails/day |
| Transactions / rules | 3,647 / 249 | |
| `unparsed` ingest rows | 842 | re-parsed **every poll cycle, forever** (see F1) |
| AI spend | **$0** — runtime `ai_enabled=0`, $10/mo cap set | 21,778 *failed* extract calls logged on 2026-07-11 |

The July 11 incident is the review's best evidence: during a deploy-day window (~3 h), the parse
loop swept all 842 unparsed emails through the AI tier roughly 26 times — 21,778 attempted API
calls. Every call errored (0 tokens, $0), but with a working key and Haiku pricing that day would
have cost real money (~26 re-extractions of every unparsed email, each sending the full body).

---

## Findings, ranked by leverage

### F1. Unparsed emails retry through the full cascade — including the AI tier — every 60 s, forever
**The one compounding, unbounded cost pattern in the app.**

- Every sync (even with zero new mail) runs `ProcessPending(OnlyUnparsed: true)`
  (`internal/ingest/ingest.go:203-209`, wired in `cmd/ledger/main.go:327-329`).
- Selection is by status only: `SELECT … raw_body FROM ingest_log WHERE parse_status IN ('unparsed')`
  (`internal/store/transactions.go:116-127`) — loads the full raw body of all 842 rows into memory
  each cycle.
- Failures are re-marked `unparsed` (`internal/parse/processor.go:64,72,103`); there is no attempt
  counter or terminal `failed` state, so un-parseable mail retries 1,440×/day indefinitely.
- When AI extraction is enabled, tier 3 (`internal/parse/cascade.go:66-81`) re-invokes the API on
  every such row every cycle. This is exactly what produced the July 11 storm.

**Fix:** add an attempt counter / `last_attempt_at` (or a terminal `failed` status) so the periodic
hook only processes never-attempted rows; leave exhausted rows to the manual `/api/reprocess`.
Cheap additive migration via the existing `addColumn` helper.

### F2. AI cost leaks that will bite when `ai_enabled` is turned on

Model choice is already optimal (Haiku, the cheapest tier — `internal/config/config.go:101`);
savings must come from call *count* and *size*:

1. **No rule write-back when auto-accept is off → repeat billing.** `buildCategorizer` sets
   `threshold = math.MaxFloat64` unless `AIAutoAccept` is on (`cmd/ledger/main.go:63`), and
   `ProposedRule` is only generated at/above threshold (`internal/categorize/categorize.go:169-180`).
   So with auto-accept off (your current setting), a bulk categorize run pays for every unknown
   merchant, remembers nothing, and a second run pays again. **Fix:** persist AI suggestions
   (e.g. a `merchant → suggested category` memo or low-priority `source='ai_suggested'` rule) even
   below threshold, so re-runs are cache hits.
2. **Extraction sends the whole email body, uncapped** (`internal/parse/ai.go:106`). Bank emails run
   300–2,000+ tokens; this is the dominant input-token driver. **Fix:** truncate/normalize the
   plaintext to a bounded budget before sending.
3. **Reprocess re-bills AI-extracted rows.** `Reprocess` selects `low_confidence` rows too
   (`internal/parse/reprocess.go:12-14`), and AI results are always `low_confidence` — so every
   reprocess re-extracts every previously AI-extracted email. **Fix:** skip the AI tier for rows a
   prior AI pass already produced, unless explicitly requested.
4. **Bulk categorize is a perfect Batch API fit.** `runCategorize` (`internal/server/categorize_job.go:64-112`)
   is already async and throttled; the Batch API would halve its cost.
5. Smaller items: the bulk-job dedup cache keys on raw merchant, not lowercased/trimmed
   (`categorize_job.go:85,89` vs `processor.go:140`) so casing variants double-call; no
   idempotency key on retried POSTs (`internal/anthropic/retry.go:73-75`) so a post-generation 5xx
   can double-bill; `max_tokens` of 200/400 could be ~60/~200 as a runaway guard. Prompt caching is
   **not** worth adding — both system prompts are far below the cacheable minimum.

### F3. `ingest_log` raw bodies: 164 MB uncompressed, growing forever
`raw_body TEXT` is stored verbatim, no compression, no retention (`internal/store/schema.sql:45`).
Growth is roughly ~100 MB/year at current volume, and every backup copies all of it. Bank HTML
compresses ~10×; gzip-on-write (transparent gunzip on read) would take the DB from 165 MB to
~20 MB without violating the "nothing is ever dropped" principle. Low urgency, high satisfaction.

### F4. SQLite tuning + missing indexes
- **`synchronous` is left at FULL** — in WAL mode, `NORMAL` is crash-safe and roughly halves commit
  fsync cost. Set it via DSN.
- **`foreign_keys=ON` is applied with `db.Exec`** (`internal/store/store.go:47`), which only sets it
  on one pooled connection — the file's own comment (:34-36) explains this hazard for
  `busy_timeout`, but FK still goes through `Exec`. Move it to the DSN (correctness, not just perf).
  Consider `SetMaxOpenConns(1)` given WAL's single-writer model.
- **Missing indexes:** `ingest_log(created_at)` — the drift monitor full-scans `ingest_log` every
  5 minutes (`internal/store/monitor.go:23-31`, ticker in `internal/monitor/monitor.go:72`);
  `transactions(ingest_id)` — reprocess does a full `transactions` scan per email
  (`internal/store/transactions.go:80-90`).

### F5. `/api/transactions` returns every row, with a per-row correlated subquery
`SelectTransactions` (`internal/store/categories.go:247-279`) has no LIMIT and runs a scalar
`accounts` subquery per returned row (`categories.go:60`). The frontend then renders every row with
a gesture-wrapped `SwipeableRow` (`frontend/src/screens/Transactions.tsx:191-217`), and
`AppShell` fetches the full needs-review set just to show a badge count
(`frontend/src/app/AppShell.tsx:57-65`). Fine at this month's volume; it's the first thing that
will feel slow as history accumulates. **Fix when felt:** keyset pagination + `LEFT JOIN accounts`,
and a cheap count endpoint for the badge.

### F6. SSE events invalidate all six query keys — refetch storms during bulk operations
`useLiveEvents` (`frontend/src/hooks/useLiveEvents.ts:14-21`) invalidates `summary`,
`transactions`, `review`, both insights keys, and `categorize-status` on *every* event, and
`staleTime` is 5 s — so a bulk import emitting one event per transaction triggers N × 6 refetches
on the phone. **Fix:** debounce/coalesce invalidations (~300 ms trailing) and/or scope keys by the
event's `type` field (already in the payload, currently only used to skip drift alerts). Best
battery/data win on the frontend.

### F7. Ingest polling is heavier than it needs to be (all negligible today, listed for completeness)
- Every poll: fresh TLS dial + LOGIN (`internal/ingest/imap.go:49-55`), `UID SEARCH ALL`
  (`imap.go:131-143`), and a full `SELECT message_uid FROM ingest_log` into a map
  (`internal/store/ingest.go:57-72`). All O(mailbox)/O(table) every 60 s.
- `use_idle = true` would make new mail instant *and* let you raise `poll_interval` to 10–15 min,
  cutting Gmail logins ~15×. IDLE still runs the same full sync on wake, so the SEARCH ALL /
  KnownUIDs pattern stays — a high-water UID mark would fix that if it ever matters.

### F8. Small backend cleanups (do opportunistically)
- `recatFn` rebuilds the categorizer — settings read + all rules + regex compiles — once **per
  merchant** during bulk runs (`cmd/ledger/main.go:234-266`); build once per run.
- Budget `?all=1` loops 3 queries per month, up to 1,800 queries per request
  (`internal/server/budget.go:93-122`); one `GROUP BY strftime('%Y-%m',…)` query replaces the loop.
- `NetTransferPairs` is O(n²) in memory (`internal/store/transactions.go:329-411`); bucket by
  `(amount, currency)` first.
- Add `MemoryMax=256M` to `deploy/ledger.service` — this box is also the dev box, and the service
  currently peaks at 256 MB with no ceiling.

---

## What's already in good shape (verified, no action)

- **Model choice:** Haiku everywhere; nothing cheaper exists.
- **Ingest-path categorization dedup:** per-batch merchant cache + rule write-back
  (`internal/parse/processor.go:140,158-166`); CSV importer never calls AI at all.
- **SSE hub:** bounded 16-slot buffers, non-blocking broadcast, clean unsubscribe on disconnect
  (`internal/server/events.go`) — no leaks.
- **No hot query touches `raw_body`** — the 164 MB rides in overflow pages that list/health/drift
  queries never read.
- **Frontend bundle:** single ~102 KB gzip chunk, hand-rolled SVG charts (no recharts/table libs),
  no sourcemaps or dead deps shipped, tight service-worker precache (~190 KB), no `/api` SW-cache
  duplication with the react-query persister.
- **Retry client:** honors `Retry-After`, jittered backoff, monthly spend cap latch.

## Suggested order of work

| # | Change | Why first | Effort |
|---|---|---|---|
| 1 | Attempt counter / terminal state for unparsed rows (F1) | Kills the only unbounded cost loop; prerequisite for ever enabling AI extraction | S |
| 2 | Persist AI category suggestions below threshold (F2.1) | Biggest recurring API-spend leak once AI is on | S–M |
| 3 | Cap extraction body tokens (F2.2) + skip re-AI on reprocess (F2.3) | Bounds the largest per-call cost | S |
| 4 | DSN pragmas (`synchronous=NORMAL`, `foreign_keys`) + 2 indexes (F4) | One-line-ish, correctness + write cost | S |
| 5 | Debounce SSE invalidations (F6) | Best phone battery/data win | S |
| 6 | Enable IMAP IDLE + raise poll to 10–15 min (F7) | Config-only; 15× fewer Gmail round-trips | XS |
| 7 | gzip `raw_body` (F3) | 165 MB → ~20 MB DB and backups | M |
| 8 | Batch API for bulk categorize (F2.4) | 50% off the one bursty AI workload | M |
| 9 | Pagination for `/api/transactions` (F5), F8 items | Defer until felt | M |
