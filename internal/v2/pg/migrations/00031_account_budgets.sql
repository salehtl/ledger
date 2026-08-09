-- +goose Up

-- P1 and P2 of docs/superpowers/specs/2026-08-09-account-isolation-design.md:
-- the per-account usage ledger, the policy table admission reads, and the
-- content-free record of what was refused.
--
-- The principle these three serve, in the design's words: "every durable byte
-- must be attributable to exactly one account at the moment it is admitted, and
-- admission must fail closed against that account's budget — in one place, not
-- per endpoint."
--
-- All three carry a plain `user_id` foreign key with ON DELETE CASCADE, so
-- internal/v2/purge discovers them from pg_class and account deletion takes them
-- with it. That is not incidental: a usage row naming a deleted account is a
-- record of how much a forgotten person stored.

-- ---------------------------------------------------------------------------
-- account_usage — what each account currently holds
-- ---------------------------------------------------------------------------
--
-- One row per (account, resource). It is maintained INSIDE the same transaction
-- as the write that changes it — the oplog appender and quarantine.Hold — which
-- is what makes it survive a rolled-back append: the bytes and the number that
-- counts them commit together or not at all.
--
-- # amount is bigint and may never go negative
--
-- bigint because 256 MB fits in an int, but a resource that later counts
-- something denser must not have to migrate its type mid-flight; and because
-- every arithmetic path here is `amount + delta` where delta is caller-supplied.
--
-- The CHECK is the part that matters. Three paths DECREMENT (the expiry sweep,
-- confirm-and-reingest, and any future compaction), and a decrement that is
-- larger than what is stored means the ledger has already lost track of
-- reality. Without the constraint that produces a NEGATIVE balance, which reads
-- as free quota — an accounting bug silently converted into a hole in the
-- budget. With it, the transaction aborts and the caller finds out. Callers
-- must therefore compute honest deltas rather than clamping at zero and hoping;
-- internal/v2/verify's reconciliation check (recompute sum(octet_length(blob))
-- per account, compare) is the standing audit that the two have not drifted.
CREATE TABLE account_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Closed, and deliberately small. Each value names a place attacker-scale
  -- durable bytes can accumulate, and there are exactly two such seams (the op
  -- log append and quarantine.Hold). The small sinks — sessions, challenges,
  -- push tokens, key wraps, dictionary submissions, diagnostics — are NOT
  -- ledgered on purpose: every one of them is bounded twice already, by the
  -- 64 KB maxSmallBodyBytes cap and by its own limiter. Adding a value here is
  -- a migration, which is the correct amount of friction for a claim that a new
  -- write path can fill the disk.
  resource text NOT NULL
    CONSTRAINT account_usage_resource_is_closed
    CHECK (resource IN ('oplog_hot_bytes','oplog_cold_bytes',
                        'quarantine_bytes','quarantine_count')),

  amount bigint NOT NULL DEFAULT 0
    CONSTRAINT account_usage_amount_is_non_negative CHECK (amount >= 0),

  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, resource)
);

-- ---------------------------------------------------------------------------
-- Backfill — the ledger is correct from its FIRST read, not from deployment
-- ---------------------------------------------------------------------------
--
-- A ledger that starts at zero on a box that already holds data is wrong the
-- moment it is read: every existing account would be handed its whole budget a
-- second time, and the reconciliation check in internal/v2/verify would report
-- drift on day one with no way to tell a backfill omission from a real bug.
--
-- Two steps rather than one INSERT ... SELECT, so that EVERY account ends up
-- with all four rows even when it has no op log and no quarantine at all. An
-- absent row and a zero row then mean the same thing to a reader, and admission
-- never has to decide what a missing row implies.
--
-- octet_length(), not length(): on bytea the two agree in Postgres, but
-- length() is the one that means "characters" on text, and this column is the
-- byte count of a blob. Saying which is meant costs nothing.
INSERT INTO account_usage (user_id, resource, amount)
SELECT u.id, r.resource, 0
  FROM users u
  CROSS JOIN (VALUES ('oplog_hot_bytes'), ('oplog_cold_bytes'),
                     ('quarantine_bytes'), ('quarantine_count')) AS r(resource);

UPDATE account_usage a
   SET amount = s.bytes
  FROM (SELECT user_id,
               'oplog_' || stream || '_bytes' AS resource,
               sum(octet_length(blob))::bigint AS bytes
          FROM op_log
         GROUP BY user_id, stream) s
 WHERE a.user_id = s.user_id AND a.resource = s.resource;

UPDATE account_usage a
   SET amount = s.bytes
  FROM (SELECT user_id, sum(octet_length(blob))::bigint AS bytes
          FROM quarantine GROUP BY user_id) s
 WHERE a.user_id = s.user_id AND a.resource = 'quarantine_bytes';

UPDATE account_usage a
   SET amount = s.held
  FROM (SELECT user_id, count(*)::bigint AS held
          FROM quarantine GROUP BY user_id) s
 WHERE a.user_id = s.user_id AND a.resource = 'quarantine_count';

-- A WINDOW EXISTS AND THE RUNBOOK MUST CLOSE IT. Migrations are applied out of
-- band as ledger_migrate BEFORE the new binary starts (00003_writers.sql), so
-- the OLD binary — which does not maintain this ledger — can keep appending
-- between the sums above and the restart. Either run this with the service
-- stopped, or treat the first internal/v2/verify reconciliation after deploy as
-- MANDATORY, expected to find drift, and expected to repair it.

-- ---------------------------------------------------------------------------
-- account_limits — the policy, as rows rather than constants
-- ---------------------------------------------------------------------------
--
-- One default row plus optional per-account overrides. Policy lives in rows so
-- that raising a ceiling for one account, or for everyone, is an UPDATE rather
-- than a deploy — the design says outright that these numbers are first
-- estimates to be revisited once a real account's year of data is measured.
--
-- # user_id IS NULL is the default row
--
-- The alternative — a separate singleton table — costs a second relation, a
-- second GRANT, and a hand-written classification in internal/v2/purge for a
-- table with no user_id. A nullable user_id keeps one shape, one lookup, and
-- automatic purge discovery. webauthn_ceremonies already carries a nullable
-- user_id for the same structural reason. The lookup is:
--
--   SELECT ... FROM account_limits WHERE user_id = $1 OR user_id IS NULL
--    ORDER BY user_id NULLS LAST LIMIT 1
--
-- # Ceilings are per RESOURCE FAMILY, not per ledger resource
--
-- The design's ceiling table reads "op log: 256 MB per account" — one number
-- over the whole log, not one per stream. So oplog_bytes bounds
-- oplog_hot_bytes + oplog_cold_bytes TOGETHER, and admission for either stream
-- compares the pair's sum plus the delta against it. Splitting it into a hot
-- and a cold ceiling would have invented policy the design did not state, and
-- would refuse an account that is entirely within its stated 256 MB merely
-- because the split fell the wrong way.
--
-- Quarantine has two independent ceilings — bytes OR holds — because a held
-- bank email is tens of KB and 500 tiny ones are as much of a nuisance as
-- 100 MB of large ones. Either one refuses.
--
-- The numbers are binary megabytes: 256 MiB and 100 MiB.
CREATE TABLE account_limits (
  -- NULL = the default that applies to every account without a row of its own.
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,

  oplog_bytes bigint NOT NULL
    CONSTRAINT account_limits_oplog_bytes_is_non_negative CHECK (oplog_bytes >= 0),
  quarantine_bytes bigint NOT NULL
    CONSTRAINT account_limits_quarantine_bytes_is_non_negative CHECK (quarantine_bytes >= 0),
  quarantine_count bigint NOT NULL
    CONSTRAINT account_limits_quarantine_count_is_non_negative CHECK (quarantine_count >= 0),

  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One override per account, and exactly one default. Two partial unique indexes
-- rather than a primary key, because a primary key cannot be NULL and the
-- default row is the NULL one. Without the second index a duplicated default
-- makes the lookup above non-deterministic — two policies, and which one
-- applies depends on the physical row order.
CREATE UNIQUE INDEX account_limits_one_row_per_account
  ON account_limits (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX account_limits_one_default_row
  ON account_limits ((true)) WHERE user_id IS NULL;

INSERT INTO account_limits (user_id, oplog_bytes, quarantine_bytes, quarantine_count)
VALUES (NULL, 256 * 1024 * 1024, 100 * 1024 * 1024, 500);

-- +goose StatementBegin
-- The default row is the only policy an account without an override has. If it
-- is gone, Admit has nothing to compare against, and the two ways to handle
-- that are "refuse every write on the box" and "allow every write on the box" —
-- one is an outage, the other is the exact failure this whole design exists to
-- prevent. Neither is a thing to discover at 3am, so the row is made
-- undeletable instead.
--
-- DELETE only. An operator raising or lowering the default is an UPDATE and is
-- entirely expected. DROP TABLE is not bound by a row trigger, which is correct:
-- the goose Down below has to work.
CREATE FUNCTION account_limits_keep_the_default_row() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'account_limits: the default policy row cannot be deleted — every account without an override depends on it; UPDATE it instead'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER account_limits_default_row_is_permanent
  BEFORE DELETE ON account_limits
  FOR EACH ROW WHEN (OLD.user_id IS NULL)
  EXECUTE FUNCTION account_limits_keep_the_default_row();

-- ---------------------------------------------------------------------------
-- account_refusals — what was declined, counted and nothing more
-- ---------------------------------------------------------------------------
--
-- Every denial increments a count here. This is what keeps the promise that
-- nothing is silently dropped: the user's own app can say "N writes were
-- declined today", and the operator console can show who is hitting walls.
--
-- COUNTS ONLY. No sender, no address, no body, no size, no message id — the
-- same discipline smtp_rejections (00006) keeps, and for the same reason: a
-- per-refusal record would be a log of who mailed whom, growing under an
-- attacker's control, in exactly the table that exists to bound growth. It is
-- also therefore unaffected by Phase 3 sealing, because there is nothing here to
-- seal.
--
-- `day` is a date in UTC, matching smtp_rejections. A local-time boundary would
-- make "today" mean different things to the sweep and to the app.
CREATE TABLE account_refusals (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,

  -- Wider than account_usage.resource, because a refusal has more sources than
  -- the ledger has resources: the four cumulative ceilings, the byte-weighted
  -- upload limiter, the SMTP daily allowance, the box-level headroom fuse, and
  -- suspension. A refusal with no place to be counted is a silent drop, which
  -- is the one thing this table exists to prevent — so the set is stated in
  -- full rather than left to whichever track lands first.
  resource text NOT NULL
    CONSTRAINT account_refusals_resource_is_closed
    CHECK (resource IN ('oplog_hot_bytes','oplog_cold_bytes',
                        'quarantine_bytes','quarantine_count',
                        'upload_bytes','smtp_daily','headroom','suspended')),

  count bigint NOT NULL DEFAULT 0
    CONSTRAINT account_refusals_count_is_non_negative CHECK (count >= 0),

  PRIMARY KEY (user_id, day, resource)
);

-- Serves "what was declined for this account lately", which is the app's own
-- question and the console's. The primary key already leads with user_id, so
-- this exists for the day-ordered scan a retention sweep or a rolling window
-- wants across all accounts.
CREATE INDEX account_refusals_day_idx ON account_refusals (day);

-- DEPLOYMENT: the two-role split (00003_writers.sql's header carries the full
-- recipe). ledger_migrate owns the schema; ledger_runtime gets DML only. A
-- deployment that ran the documented ALTER DEFAULT PRIVILEGES steps is already
-- covered and this block is a no-op — but the failure mode of having missed
-- them is "permission denied for table account_usage" in PRODUCTION ONLY, on
-- the first sync after deploy, which is every write path at once. It never
-- fires in tests, so it is granted explicitly here as well.
--
-- Conditional on the role existing: pgtest clusters and single-role deployments
-- have no ledger_runtime and an unconditional GRANT would fail the migration
-- for every one of them.
--
-- No sequence grant is needed and that is checked rather than assumed: none of
-- these three tables has a serial or identity column, so no INSERT here calls
-- nextval(). That is the one line of 00003's recipe that does not apply — the
-- line whose absence made every registration fail with "permission denied for
-- sequence" the first time.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON account_usage TO ledger_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON account_limits TO ledger_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON account_refusals TO ledger_runtime';
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE account_refusals;
DROP TRIGGER IF EXISTS account_limits_default_row_is_permanent ON account_limits;
DROP TABLE account_limits;
DROP FUNCTION IF EXISTS account_limits_keep_the_default_row();
DROP TABLE account_usage;
