-- +goose Up

-- How a device finds out its account is gone, rather than merely expired.
--
-- # The problem, and why the obvious fix is not one
--
-- A device whose account has been deleted (spec §3.10) needs to learn that
-- fact, because the correct response is to wipe its local copy of the ledger.
-- Today it learns nothing: every rejected session is the same 401, and 401 is
-- overwhelmingly "your session expired, sign in again". A client that wiped its
-- local data on a 401 would destroy an offline user's outbox on every routine
-- token expiry, so the distinction has to come from the server.
--
-- The Phase 2 plan's Step 3 says to answer 410 "when the session's user row is
-- absent but the session token parsed". That condition IS NEVER TRUE, and the
-- reason is one FK away: `sessions.user_id` is `REFERENCES users(id) ON DELETE
-- CASCADE` (00001), so `purge.Purge`'s single `DELETE FROM users` takes every
-- session row with it. A middleware check for "session resolves, user missing"
-- would compile, pass a test that inserted the halfway state by hand, and fire
-- exactly never in production.
--
-- # What is kept, and why keeping it is compatible with "purge means purge"
--
-- One row per session that was live at the moment of deletion, holding
-- SHA-256(session token) and when that session would have expired anyway.
--
-- It carries no user id, no subject, no address, no email, and nothing derived
-- from any of them. The key is the digest of a 32-byte value drawn from
-- crypto/rand, which is linkable to a person only by someone who already holds
-- the token — i.e. by the device the row exists to answer. It is the same
-- shape, and the same argument, as dict_entries after ForgetSubmitter: a
-- residue attributable to nobody.
--
-- Deliberately NOT named `user_id`, and deliberately carrying no foreign key
-- into users or sessions: a row whose entire purpose is to outlive both of
-- those cannot reference either. purge classifies it in notUserLinked with this
-- reasoning.
CREATE TABLE deleted_account_sessions (
  token_hash bytea PRIMARY KEY
    CONSTRAINT deleted_account_sessions_hash_is_256_bits CHECK (octet_length(token_hash) = 32),

  -- Operator-facing only. Nothing reads it to make a decision; it is here so
  -- that a table of opaque digests can be reasoned about at all when someone
  -- asks in six months why it has rows in it.
  deleted_at timestamptz NOT NULL,

  -- The session's ORIGINAL expiry, copied verbatim. Past it, this row answers
  -- nothing: a token that would have expired anyway gets the ordinary 401,
  -- because "expired" is then a true and sufficient answer and a 410 would be
  -- claiming to know something about a credential that is dead either way.
  expires_at timestamptz NOT NULL
);

-- Serves the retention sweep. NOTE: the sweep this originally served lived in
-- the trigger below and was wrong — it ran on Postgres's clock over rows
-- written from ledgerd's, and destroyed the row it had just inserted. It moved
-- to auth.Sessions.ReapDeletedAccountTombstones in
-- 00022_tombstone_sweep_leaves_the_trigger.sql, which is where the clock that
-- decides already lives. The index still serves it.
CREATE INDEX deleted_account_sessions_expiry_idx ON deleted_account_sessions (expires_at);

-- +goose StatementBegin
CREATE FUNCTION tombstone_account_sessions() RETURNS trigger AS $$
BEGIN
  -- BEFORE DELETE on users, so the sessions rows are still here: referential
  -- cascades run as AFTER-row actions on the referenced table, strictly later
  -- than this. An AFTER trigger would find nothing and would be the same
  -- never-fires bug in a different disguise.
  INSERT INTO deleted_account_sessions (token_hash, deleted_at, expires_at)
  SELECT s.token_hash, now(), s.expires_at
    FROM sessions s
   WHERE s.user_id = OLD.id
  ON CONFLICT (token_hash) DO NOTHING;

  -- EVERY session, with no `expires_at > now()` filter, and that omission is
  -- deliberate. auth.Sessions evaluates expiry against ITS OWN injected clock
  -- and never against Postgres's, precisely so that one clock decides when a
  -- session is alive; a filter here would make this table's contents depend on
  -- a SECOND clock, and the two disagreeing is not hypothetical — it is the
  -- ordinary case under a test that pins time. So the row is always written and
  -- auth.Sessions.deletedOrUnknown is the one place that judges it.
  --
  -- REVOKED sessions are tombstoned too, on purpose. A phone that was signed
  -- out and then had its account deleted under it should still wipe: 410 is a
  -- true statement about that account, and the device acting on it is the
  -- outcome we want. Filtering them out would trade a correct wipe for
  -- nothing.

  -- SUPERSEDED BY 00022. The sweep below reintroduced, thirty days downstream,
  -- exactly the second clock the paragraph above rejects: `now()` is Postgres's
  -- and `expires_at` is auth.Sessions'. Running after the INSERT in the same
  -- invocation, it deleted the row it had just written whenever ledgerd's clock
  -- was more than 30 days behind Postgres's, and every other account's row too.
  -- 00022 replaces this function with the INSERT alone and moves the reaping to
  -- auth.Sessions.ReapDeletedAccountTombstones, which judges on the clock that
  -- already decides. This body is left intact as history — goose never re-runs
  -- an applied migration, so editing it would fix nothing anywhere.
  DELETE FROM deleted_account_sessions WHERE expires_at < now() - interval '30 days';

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- On users, not on sessions. A trigger on sessions would fire for any future
-- session-pruning job and tombstone ordinary expired sessions as deleted
-- accounts — a lie told to every device that came back after a month away.
-- Deleting a users row is the one event that means what this table records, and
-- putting the trigger there covers EVERY path to it: purge.Purge, the
-- retention sweep, `ledgerd purge-user`, and whatever a later task adds.
CREATE TRIGGER users_tombstone_sessions
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION tombstone_account_sessions();

-- +goose Down
DROP TRIGGER users_tombstone_sessions ON users;
DROP FUNCTION tombstone_account_sessions();
DROP TABLE deleted_account_sessions;
