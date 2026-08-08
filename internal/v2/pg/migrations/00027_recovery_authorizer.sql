-- +goose Up

-- The recovery authorizer: an Ed25519 public key, published with the account's
-- key set, whose signature auth.Writers.Register accepts as an alternative to a
-- signature by an already-enrolled device.
--
-- # The dead end this removes
--
-- 00026 gave an account keys and a recovery phrase, and a browser with cleared
-- site data could recover them and READ again. It could not WRITE. The device
-- writer's Ed25519 identity key lived in the local database that was cleared,
-- the account's one TOFU self-approval was spent by the original device, and
-- Register accepts only a signature by an already-enrolled device. So a
-- one-device user who cleared their browser was permanently read-only, holding
-- their recovery phrase, with nothing on the server able to help — which is
-- precisely the outcome the phrase exists to prevent.
--
-- # What it does NOT weaken, stated because it is the whole question
--
--   * It is a CRYPTOGRAPHIC PROOF OF POSSESSION, not a session token. The
--     server holds the public half only and cannot produce a signature under
--     it. A stolen session is exactly as useless as it was before 00026.
--   * It does NOT reopen the TOFU bootstrap. auth's `hadDevice` rule — one
--     self-signature ever per account, keyed on whether a device writer has
--     EVER existed — is untouched. This is an ADDITIONAL authorised signer.
--   * Its use is VISIBLE. An enrolment it authorises is written to key_history
--     as 'recovery_registered' rather than 'registered' (see the CHECK below),
--     so a peer device auditing the log sees that a recovery happened — and the
--     cross-device comparison code hashes the event string, so a server that
--     lied about it would produce a different code on the two devices.
--
-- The key is derived from the recovery phrase and lives inside the wrapped blob
-- 00026 already stores; the client never persists it. See
-- client/src/crypto/keys.ts.
--
-- # Why NOT NULL, and why this migration exists at all rather than an edit to 00026
--
-- Deployment here is FORWARD-ONLY (deploy/README.md): the fix for a shipped
-- migration is another migration. 00026 is committed, so it is not edited.
--
-- NOT NULL with no default is only possible on an EMPTY table, and that is a
-- deliberate precondition rather than an oversight. Publication is write-once
-- (409, no DELETE, no rotation path), so an account that published a key set
-- WITHOUT a recovery authorizer could never gain one; every published key set
-- must therefore carry one, with no nullable branch for Register to reason
-- about. This migration was written while no account anywhere had published —
-- and if that ever stops being true, this ALTER fails loudly at migrate time
-- instead of quietly admitting an account that can never be recovered.
ALTER TABLE user_keys
  ADD COLUMN recovery_pubkey bytea NOT NULL
    CONSTRAINT user_keys_recovery_pubkey_is_256_bits CHECK (octet_length(recovery_pubkey) = 32);

-- The new key_history event. It is a value in the existing vocabulary rather
-- than a new column on purpose: the cross-device comparison code
-- (web/src/v2/deviceEnrolment.ts) hashes id, writer_id, pubkey and event, so a
-- distinct event string is covered by the audit peers already perform. A
-- separate "authorizer" column would be invisible to that digest unless the
-- digest changed too, which is a worse place to put a fact whose whole purpose
-- is that a peer can see it.
ALTER TABLE key_history DROP CONSTRAINT key_history_event_check;
ALTER TABLE key_history ADD CONSTRAINT key_history_event_check
  CHECK (event IN ('registered', 'revoked', 'recovery_registered'));

-- No grant block: this migration adds no relation. 00026's DO block already
-- granted ledger_runtime DML on user_keys, and column-level privileges are not
-- separately granted when the table grant is unqualified.

-- +goose Down
--
-- READ 00025's warning before reaching for this. Restoring the narrower CHECK
-- cannot succeed once any account has recovered — Postgres validates a new
-- CHECK against every existing row and the ALTER aborts on the first
-- 'recovery_registered' entry. That is correct: key_history is append-only and
-- the alternative would be a rollback that deleted evidence of a recovery.
ALTER TABLE key_history DROP CONSTRAINT key_history_event_check;
ALTER TABLE key_history ADD CONSTRAINT key_history_event_check
  CHECK (event IN ('registered', 'revoked'));
ALTER TABLE user_keys DROP COLUMN recovery_pubkey;
