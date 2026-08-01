-- +goose Up

-- A writer is one of the (writer_id, writer_counter) identities that appears in
-- every op_log row and inside every blob's AAD (§3.3). Two kinds exist and they
-- are not symmetric:
--
--   'device' — a client writer. It holds an Ed25519 identity key whose private
--              half never leaves the device Keychain. Its chain is authored
--              under a key the server does not have, so a server that drops or
--              reorders its ops is detectable by the user's own devices.
--   'ingest' — the server's own writer, one per user, no key at all. Its chain
--              is computed by the server over material the server itself seals,
--              so it proves storage integrity and NOTHING about operator
--              honesty (spec §3.3(b)). Giving it a key would imply otherwise.
--
-- Rows are never deleted. A retired device is marked revoked_at, because the
-- absence of a writer and the revocation of a writer are different facts to a
-- peer device auditing the roster — and because "has this user ever enrolled a
-- device?" is what closes the TOFU bootstrap window permanently (see
-- auth.Writers.Register).
CREATE TABLE writers (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  writer_id     text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('device','ingest')),
  pubkey        bytea,
  registered_at timestamptz NOT NULL,
  revoked_at    timestamptz,
  PRIMARY KEY (user_id, writer_id),
  -- writer_id travels in op_log.writer_id, in blob AAD and in JSON checkpoint
  -- ops. Keeping it to an unambiguous ASCII subset means no encoding question
  -- can ever arise about what was signed or what was bound into an AAD.
  CONSTRAINT writers_writer_id_charset CHECK (writer_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  -- A device writer without a well-formed key could never have proved
  -- possession of anything; an ingest writer with one would claim a property
  -- the server cannot have.
  CONSTRAINT writers_key_matches_kind CHECK (
    (kind = 'device' AND octet_length(pubkey) = 32) OR
    (kind = 'ingest' AND pubkey IS NULL))
);

-- One identity key, one writer. Two writer ids sharing a key would make
-- (writer_id, writer_counter) ambiguous about which device authored an op while
-- both would verify under the same signature.
CREATE UNIQUE INDEX writers_pubkey_uniq ON writers (user_id, pubkey) WHERE pubkey IS NOT NULL;

-- The append-only key-history log: what a peer device audits for key
-- substitution, and what the cross-device comparison code (§3.4) hashes.
--
-- It is server-attested, not self-authenticating: a compromised server can
-- append a fabricated entry. Spec §3.4 states that limit ("cannot make key
-- substitution impossible, only detectable") and detection is by comparing this
-- log's head across devices. What the guard below buys is that a rewrite of an
-- already-published entry — the silent version of the same attack — cannot
-- happen through the application's own database role.
CREATE TABLE key_history (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  writer_id text NOT NULL,
  pubkey    bytea,   -- NULL for the keyless ingest writer
  event     text NOT NULL CHECK (event IN ('registered','revoked')),
  at        timestamptz NOT NULL
);
CREATE INDEX key_history_user_idx ON key_history (user_id, id);

-- +goose StatementBegin
CREATE FUNCTION key_history_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'key_history is append-only: TRUNCATE is refused'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'key_history is append-only: UPDATE of entry % (writer %) is refused', OLD.id, OLD.writer_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- DELETE is refused for a live account. The one legitimate deletion is
  -- erasing the account itself (spec §3.10), which arrives here as the RI
  -- cascade from users and therefore runs AFTER the users row is gone — that
  -- is the whole distinction between "this account no longer exists" and
  -- "this account's history was quietly edited".
  IF EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
    RAISE EXCEPTION 'key_history is append-only: DELETE of entry % is refused while user % exists', OLD.id, OLD.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER key_history_no_rewrite
  BEFORE UPDATE OR DELETE ON key_history
  FOR EACH ROW EXECUTE FUNCTION key_history_append_only();

-- Row triggers do not fire for TRUNCATE, so the wholesale version of the same
-- attack needs its own statement-level trigger.
CREATE TRIGGER key_history_no_truncate
  BEFORE TRUNCATE ON key_history
  FOR EACH STATEMENT EXECUTE FUNCTION key_history_append_only();

-- Registration challenges. The nonce is the primary key, so consuming one is a
-- single-row UPDATE and cannot be raced (see auth.Writers.consumeChallenge).
-- user_id is here because a challenge issued to one account must be worthless
-- against another; it is checked in the WHERE clause, never after the lookup.
CREATE TABLE writer_challenges (
  nonce      bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at  timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  CONSTRAINT writer_challenges_nonce_is_256_bits CHECK (octet_length(nonce) = 32)
);
-- Serves the opportunistic sweep in auth.Writers.Challenge.
CREATE INDEX writer_challenges_expiry_idx ON writer_challenges (expires_at);

-- +goose Down
DROP TABLE writer_challenges;
DROP TABLE key_history;
DROP FUNCTION key_history_append_only();
DROP TABLE writers;
