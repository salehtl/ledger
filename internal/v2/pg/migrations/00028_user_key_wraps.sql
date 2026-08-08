-- +goose Up

-- A SECOND wrap of the account's key material, sealed under a WebAuthn PRF
-- output instead of under the recovery phrase — what makes Face ID, Touch ID or
-- a security key an alternative to typing twelve words.
--
-- # Why a table and not another column
--
-- 00026's `wrapped_keys` is written ONCE. internal/v2/api/keys.go compares all
-- three published fields byte for byte and answers 409 on any difference; there
-- is no UPDATE and no DELETE. So appending a second wrap to that column is
-- unreachable for any account that has already published, and relaxing the
-- comparison would reopen the accidental-rekey hazard the 409 exists to
-- prevent: every blob ever sealed to a published ingest key becomes unreadable
-- the moment different key material replaces it.
--
-- Keeping the multi-wrap here is additive in the way that matters — 00026 is
-- untouched, keys.go is untouched, and an account that published months ago
-- gains PRF unlock without rewriting a byte of what it published.
--
-- # What the server holds, and what it does not
--
-- `wrapped` is opaque here, exactly as `user_keys.wrapped_keys` is. Its format
-- is client/src/crypto/prf.ts's envelope: an HKDF salt, an AES-256-GCM nonce,
-- and the same 97-byte key body 00026's blob carries, sealed under a key derived
-- from a 32-byte secret that lives inside the user's authenticator. The server
-- never sees that secret and cannot ask for it.
--
-- The honest statement, in spec §2's terms and no stronger: a stolen disk, a
-- stolen backup or a subpoena of this table yields blobs nothing here can open.
-- It is NOT "we cannot see your data" — bank mail arrives over SMTP in plaintext
-- and is read in memory before it is sealed.
--
-- # DELETE is correct here, and it is not correct for user_keys
--
-- Losing a PRF wrap loses NOTHING. The recovery phrase still opens the account,
-- because both wraps carry the same key set, so a row here is disposable by
-- design: a user who removes a passkey, or a device that finds an orphaned wrap
-- whose credential no longer exists, may delete it freely. The same operation on
-- user_keys would destroy a financial history from a stolen phone, which is why
-- that table has no DELETE at all.
--
-- The recovery phrase therefore stays MANDATORY. Every row here derives from a
-- secret inside one authenticator that can be lost, reset or silently rotated by
-- an operating system update, and this server holds nothing that would help.
CREATE TABLE user_key_wraps (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The credential whose PRF output opens this wrap. The cascade is the whole
  -- lifecycle: a passkey removed from the account takes its wrap with it, so a
  -- row can never outlive the only thing that could open it.
  credential_id bytea NOT NULL REFERENCES webauthn_credentials(credential_id) ON DELETE CASCADE,

  -- 159 bytes at the shipped envelope. The bound matches
  -- user_keys_wrapped_is_bounded and MAX_WRAPPED_BYTES in
  -- client/src/crypto/keys.ts: generous so a later key set fits, finite so a
  -- malformed upload is refused at the edge rather than stored.
  wrapped bytea NOT NULL
    CONSTRAINT user_key_wraps_wrapped_is_bounded CHECK (octet_length(wrapped) BETWEEN 32 AND 4096),

  -- The envelope version the blob declares, copied out by the client. Advisory,
  -- exactly as user_keys.key_version is: nothing branches on it server-side and
  -- the authority is the blob's own first byte.
  wrap_version integer NOT NULL
    CONSTRAINT user_key_wraps_version_is_positive CHECK (wrap_version > 0),

  created_at timestamptz NOT NULL,

  -- One wrap per credential per account. A second row for the same credential
  -- would be two answers to one question at unlock time.
  PRIMARY KEY (user_id, credential_id)
);

-- DEPLOYMENT: the two-role split (see 00003_writers.sql's header for the full
-- recipe). ledger_migrate owns the schema; ledger_runtime gets DML only. A
-- deployment that ran the documented ALTER DEFAULT PRIVILEGES steps already
-- covers this table and this block is then a no-op — but the failure mode of
-- having missed them is "permission denied for table user_key_wraps" in
-- PRODUCTION ONLY, discovered by the first user who tries to unlock with Face
-- ID, so it is granted explicitly here as well.
--
-- Conditional on the role existing: pgtest clusters and single-role deployments
-- have no ledger_runtime, and an unconditional GRANT would fail the migration
-- for every one of them. No sequence grant is needed — this table has no serial
-- column — which is the one line of 00003's recipe that does not apply here.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON user_key_wraps TO ledger_runtime';
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE user_key_wraps;
