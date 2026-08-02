-- +goose Up

-- One clock decides whether a tombstone still answers. It is not Postgres's.
--
-- # The defect this closes
--
-- 00021 argued, correctly and at length, that filtering the tombstone INSERT on
-- `expires_at > now()` would make the table's contents depend on a SECOND clock
-- — and then ended the same function with
--
--     DELETE FROM deleted_account_sessions WHERE expires_at < now() - interval '30 days';
--
-- which is that same second clock, thirty days downstream. `expires_at` is
-- copied from a sessions row whose expiry was computed by auth.Sessions.Now;
-- `now()` here is Postgres's. Worse, the sweep runs AFTER the INSERT in the
-- same trigger invocation, over the whole table, so a single deletion destroyed
-- the row it had just written and every other account's row with it.
--
-- Measured, not theorised: with ledgerd's clock 31 days behind Postgres the
-- tombstone count after `DELETE FROM users` was 0, and a session LIVE by the
-- clock that decides resolved to ErrSessionUnknown — a 401. Task 13's
-- mayWipeLocalData requires 410 AND `account_deleted` before it will wipe,
-- precisely so that a bare 401 (which is also what an ordinary expiry looks
-- like) never destroys an offline user's outbox. So the defect did not merely
-- lose a diagnostic: it turned a deleted account into an indistinguishable
-- expired session and the device never wiped.
--
-- It was benign in production only because ledgerd and Postgres share a box.
-- That is an accident of the current deployment, not a property of the system,
-- and it stops being true the moment the relay or a second host exists.
--
-- # The fix
--
-- The trigger no longer decides anything about time: it INSERTs and returns.
-- The reaping moved to auth.Sessions.ReapDeletedAccountTombstones, which is the
-- same object, the same clock and the same file as deletedOrUnknown — the one
-- place that judges whether a tombstone still answers. cmd/ledgerd runs it on
-- the hourly sweep loop beside the quarantine, sample and dictionary sweeps.
--
-- Moving it there also answers 00021's original objection to sweeping on the
-- lookup path, which stands: the lookup runs on every unrecognized bearer
-- token, so sweeping there would let anyone with a socket make this server
-- write. A ticker in the serving process is neither attacker-triggerable nor
-- dependent on an account ever being deleted again.
--
-- CREATE OR REPLACE rather than an edit to 00021: goose does not re-run an
-- applied migration, so a fix written into the original file would be a fix
-- that reaches no deployment which already started.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION tombstone_account_sessions() RETURNS trigger AS $$
BEGIN
  -- BEFORE DELETE on users, so the sessions rows are still here: referential
  -- cascades run as AFTER-row actions on the referenced table, strictly later
  -- than this. An AFTER trigger would find nothing and would be the same
  -- never-fires bug in a different disguise.
  --
  -- EVERY session, with no `expires_at > now()` filter, and that omission is
  -- deliberate — see 00021. REVOKED sessions are tombstoned too, on purpose: a
  -- phone that was signed out and then had its account deleted under it should
  -- still wipe.
  INSERT INTO deleted_account_sessions (token_hash, deleted_at, expires_at)
  SELECT s.token_hash, now(), s.expires_at
    FROM sessions s
   WHERE s.user_id = OLD.id
  ON CONFLICT (token_hash) DO NOTHING;

  -- Nothing else. `deleted_at` above is Postgres's clock and is allowed to be:
  -- it is operator-facing only and no decision reads it. Every value this
  -- function writes that a DECISION reads (expires_at) is copied verbatim from
  -- a row auth.Sessions wrote, and no statement here removes a row.
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION tombstone_account_sessions() RETURNS trigger AS $$
BEGIN
  INSERT INTO deleted_account_sessions (token_hash, deleted_at, expires_at)
  SELECT s.token_hash, now(), s.expires_at
    FROM sessions s
   WHERE s.user_id = OLD.id
  ON CONFLICT (token_hash) DO NOTHING;

  DELETE FROM deleted_account_sessions WHERE expires_at < now() - interval '30 days';

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd
