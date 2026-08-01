-- +goose Up

-- Tie a push token to the device that registered it, so that revoking the
-- device stops the notifications.
--
-- # The hole this closes
--
-- 00010 gave push_tokens four columns — user_id, token, platform, created_at —
-- and no link to anything revocable. The consequence was not theoretical:
--
--   * auth.Writers.Revoke retires a device key and did not touch this table.
--   * auth.Sessions.Revoke / RevokeAllForUser sign a device out and did not
--     touch this table.
--   * the only user-facing removal was DELETE /push/tokens/{token}, which
--     needs the EXACT token string, and there was no route that would tell a
--     user what their tokens were.
--
-- So a phone that was stolen, revoked, signed out or handed to somebody else
-- kept receiving a real-time "New transaction" on its lock screen for the life
-- of the account, and the legitimate owner had no way to stop it. The content
-- of that notification is nothing; its TIMING is a live feed of when the victim
-- spends. The only thing that ever cleared a row was Expo reporting
-- DeviceNotRegistered, which requires the app to be UNINSTALLED — the one thing
-- the person holding the phone will not do.
--
-- 00010's own comment justified the composite primary key by saying the
-- hand-on case "is recoverable by the user who still has the device". That was
-- false as implemented, and this migration is what makes it true. The comment
-- in 00010 has been corrected in place rather than left to mislead.
--
-- # Why the table is CLEARED rather than backfilled
--
-- writer_id and session_hash are NOT NULL, because a nullable link is a link
-- that the one client who forgets to send it silently opts out of, and the
-- whole point is that the guarantee is total. Existing rows cannot be
-- backfilled — nothing recorded which device or session registered them.
--
-- Clearing costs nothing, and that is checkable rather than hopeful:
-- cfg.Push.Enabled has defaulted to false since 00010 landed, no client exists
-- that registers a token, and registration is an upsert a client performs on
-- every launch (see api.handleRegisterPushToken). Any row this deletes would be
-- re-created, correctly linked, the next time its app opened. A backfill with
-- an invented writer_id would instead produce exactly the unrevocable row this
-- migration exists to make impossible.
DELETE FROM push_tokens;

ALTER TABLE push_tokens
  -- The handle a user deletes a device BY. The token itself is the natural key
  -- and the client's own client deletes by it, but GET /push/tokens shows a
  -- human only a short prefix — a listing that returned whole tokens would put
  -- every one of a user's device tokens into a response, and a token is
  -- exactly the string Expo's public send endpoint accepts as a target. So the
  -- listing hands back an id and the delete route accepts either.
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),

  -- The device this token belongs to, and the reason this migration exists.
  -- auth.Writers.Revoke deletes the matching rows in the same transaction that
  -- retires the key, so "revoke this device" and "stop notifying this device"
  -- are one atomic act rather than two things an operator has to remember.
  ADD COLUMN writer_id text NOT NULL,

  -- The session that registered it. Sign-out is the OTHER disowning gesture,
  -- and it is not the same as revoking a key: a user who signs out of a shared
  -- phone has not retired their device key, they have ended that phone's
  -- access. auth.Sessions.Revoke and RevokeAllForUser delete by this column.
  --
  -- ON DELETE CASCADE is the belt to that braces: sessions rows are marked
  -- revoked rather than deleted today, so the cascade is dormant, but a future
  -- session-pruning job must not be able to leave an orphan behind.
  ADD COLUMN session_hash bytea NOT NULL;

ALTER TABLE push_tokens
  ADD CONSTRAINT push_tokens_id_uniq UNIQUE (id),
  -- Composite, against writers' own primary key: a writer_id is only unique
  -- WITHIN a user, so referencing writer_id alone would be a different (and
  -- wrong) statement about who owns the device. It also means the API cannot
  -- register a token against another account's writer even if its own
  -- ownership check were removed.
  ADD CONSTRAINT push_tokens_writer_fk
    FOREIGN KEY (user_id, writer_id) REFERENCES writers (user_id, writer_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT push_tokens_session_fk
    FOREIGN KEY (session_hash) REFERENCES sessions (token_hash)
    ON DELETE CASCADE;

-- Revocation sweeps. Both are DELETE ... WHERE on the hot path of a security
-- action, so neither may be a sequential scan of every user's devices.
CREATE INDEX push_tokens_writer_idx ON push_tokens (user_id, writer_id);
CREATE INDEX push_tokens_session_idx ON push_tokens (session_hash);

-- The fan-out order, DESCENDING, and it is a correctness fix rather than a
-- performance one. pushv2 caps one Notify at 20 devices; the original
-- `ORDER BY created_at` ascending kept the twenty OLDEST registrations, so the
-- 21st device — the phone the user is actually holding — was the one silently
-- excluded. Newest-first means the casualty of the cap is always a device the
-- user stopped using, never the one in their hand. api enforces the same cap at
-- INSERT with the same ordering, so the two cannot disagree about who is kept.
CREATE INDEX push_tokens_fanout_idx ON push_tokens (user_id, created_at DESC, token DESC);

-- +goose Down
DROP INDEX IF EXISTS push_tokens_fanout_idx;
DROP INDEX IF EXISTS push_tokens_session_idx;
DROP INDEX IF EXISTS push_tokens_writer_idx;
ALTER TABLE push_tokens
  DROP COLUMN session_hash,
  DROP COLUMN writer_id,
  DROP COLUMN id;
