-- +goose Up

-- Phase 3 Task 1: the account's published ingest public key, and the blob that
-- wraps its private key material under the user's recovery phrase.
--
-- # What the server holds, and what it does not
--
-- `ingest_pubkey` is an X25519 public key. It is not a secret — it is the thing
-- incoming bank mail will be sealed TO (Task 2), and a copy of it leaks nothing.
--
-- `wrapped_keys` is opaque here. Its format is `client/src/crypto/keys.ts`'s
-- envelope: an Argon2id salt and cost, an AES-256-GCM nonce, and the account's
-- X25519 private key and data key sealed under a key derived from a twelve-word
-- recovery phrase this server has never seen and cannot derive. The column is
-- bytea because the server's only relationship with these bytes is storing and
-- returning them.
--
-- The honest statement of what that buys, in the terms spec §2 requires: a
-- stolen disk, a stolen backup or a subpoena of this table yields a public key
-- and a blob nothing here can open. It is NOT "we cannot see your data" — bank
-- mail arrives over SMTP in plaintext and is read in memory before it is sealed,
-- and a live, actively compromised server could log that. This table narrows the
-- at-rest exposure; it does not remove the ingest window.
--
-- # One row per account, and it is written ONCE
--
-- `user_id` is the primary key, so an account has one key set. The API refuses
-- to replace an existing row with different bytes (see internal/v2/api/keys.go),
-- and the reason is not tidiness: every blob ever sealed to this public key
-- becomes unreadable the moment a different key set replaces it. There is no
-- "rotate my keys" story in Phase 3 and there must not be an accidental one.
--
-- The refusal lives in the API rather than in a trigger because it needs to
-- compare the SUBMITTED bytes with the stored ones to tell a retry apart from a
-- replacement — a device that lost its response and re-PUT identical bytes has
-- done nothing wrong, and a row-level "no UPDATE ever" would refuse it.
--
-- # Why there is no key_history entry for this
--
-- key_history (00003) is the WRITER roster's audit log: it is what a peer device
-- reads to detect key substitution, and every entry names a writer id. An ingest
-- key names no writer and authors nothing. Publishing it here does not weaken
-- that log; a later phase that wants substitution detection for THIS key needs
-- its own cross-device comparison, and quietly appending to key_history would
-- make one look like it already existed.
CREATE TABLE user_keys (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- X25519, raw, 32 bytes. The length is a CHECK rather than a convention: a
  -- short key here is mail sealed to something that is not the user's key, and
  -- it would not be discovered until the user could not read their own history.
  ingest_pubkey bytea NOT NULL
    CONSTRAINT user_keys_pubkey_is_256_bits CHECK (octet_length(ingest_pubkey) = 32),

  -- The wrapped blob. 117 bytes at the shipped envelope; the bound is generous
  -- so a later key set fits, and finite so a malformed upload is refused at the
  -- edge rather than stored. It mirrors MAX_WRAPPED_BYTES in
  -- client/src/crypto/keys.ts, and api/keys_test.go pins the two together.
  wrapped_keys bytea NOT NULL
    CONSTRAINT user_keys_wrapped_is_bounded CHECK (octet_length(wrapped_keys) BETWEEN 32 AND 4096),

  -- The envelope version the blob declares, copied out by the client so an
  -- operator can answer "which accounts are on the old envelope?" without
  -- parsing a blob the server is not supposed to interpret. Advisory: nothing
  -- branches on it server-side, and the authority is the blob's own first byte.
  key_version integer NOT NULL
    CONSTRAINT user_keys_version_is_positive CHECK (key_version > 0),

  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- DEPLOYMENT: the two-role split (see 00003_writers.sql's header for the full
-- recipe). ledger_migrate owns the schema; ledger_runtime gets DML only. A
-- deployment that ran the documented ALTER DEFAULT PRIVILEGES steps already
-- covers this table and this block is then a no-op — but the failure mode of
-- having missed them is "permission denied for table user_keys" in PRODUCTION
-- ONLY, on the onboarding path, discovered by the first user, so it is granted
-- explicitly here as well.
--
-- Conditional on the role existing: pgtest clusters and single-role deployments
-- have no ledger_runtime, and an unconditional GRANT would fail the migration
-- for every one of them. No sequence grant is needed — this table has no serial
-- column — which is the one line of 00003's recipe that does not apply here.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON user_keys TO ledger_runtime';
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE user_keys;
