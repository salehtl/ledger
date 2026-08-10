-- +goose Up

-- P3 of docs/superpowers/specs/2026-08-09-account-isolation-design.md: the one
-- lever between "this account is fine" and "purge it".
--
-- # Why a column and not a role system
--
-- The design is explicit that no role system is required (§3 P3). The admin
-- console is operator-only by NETWORK POSITION — permanently tailnet-bound,
-- enforced at bind by config.CheckAdminBind — so "who may suspend" is already
-- answered, and suspend/resume are two endpoints writing this one column.
--
-- # What suspended MEANS, restated here because the schema cannot enforce it
--
-- The column is a fact; the policy lives in the code that reads it, and the
-- policy is asymmetric on purpose:
--
--   * requireSession denies NON-GET methods with `403 account_suspended`, a
--     distinct code so the client renders "account paused" rather than
--     something that looks like data loss.
--   * GET stays ALLOWED. Pull, hashes and listings keep working, deliberately,
--     so a suspended user's devices keep reading their own data. A suspension
--     that also blanked the app would be indistinguishable, to the user, from
--     the operator having deleted them.
--   * Sign-in is the one write outside requireSession, and a suspended account
--     MAY still sign in — read-only devices are the whole point of allowing
--     pull, and a device needs a session to do it.
--   * SMTP recipient resolution answers 452 (temporary), so mail RETRIES across
--     a short suspension instead of bouncing. A 550 here would destroy mail the
--     user is entitled to once they are resumed.
--
-- # Why there is no suspended_at, no reason, no actor
--
-- The design specifies "one column". A reason string is an operator's free text
-- about a named person in an unencrypted table, which is the same thing
-- 00016_parse_rate.sql refused for the same reason; and an `at` timestamp
-- without an actor answers half a question. If an audit trail is wanted later it
-- should be a proper append-only operator-action log, not two columns bolted
-- here that nobody is obliged to write.
--
-- DEFAULT 'active' with NOT NULL means every existing row is backfilled by the
-- ALTER itself and every future INSERT — including auth.UpsertUser's, which does
-- not name this column — lands active. There is no window in which an account
-- has no status.
ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CONSTRAINT users_status_is_closed CHECK (status IN ('active','suspended'));

-- No GRANT block: this migration creates no relation and no sequence. The
-- runtime role's DML privileges are held on the TABLE, and adding a column does
-- not narrow them (column-level grants would, and none are used here). The
-- two-role recipe in 00003_writers.sql applies to the tables in 00031/00032,
-- which do carry one.

-- +goose Down
ALTER TABLE users DROP COLUMN status;
