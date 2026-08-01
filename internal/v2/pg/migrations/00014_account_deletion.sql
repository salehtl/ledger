-- +goose Up

-- Spec §3.10, the deletion half of "users own their data".
--
-- Two tables, both small, both existing because deletion has to be
-- SELF-SERVICE and it has to be AUTHORIZED harder than a session token.
--
-- # Why account deletion gets its own challenge table
--
-- Same argument 00005 makes for address_rotation_challenges, applied one step
-- further. Spec §3.4 puts writer registration, address rotation and account
-- deletion in one class: a session token alone authorizes none of them. Each
-- proves key possession with an Ed25519 signature over a single-use nonce.
--
-- Sharing writer_challenges across all three would be less code and a real
-- weakening: a nonce minted for one purpose would be spendable on another, and
-- the domain-separation prefix in the signed message would be the only thing
-- standing between "enroll my new phone" and "destroy my account". Separate
-- tables mean the nonce ITSELF is scoped, so the prefix is defence in depth
-- rather than the whole defence.
--
-- The rows are worthless once used or expired; purge.Challenges sweeps them
-- opportunistically on the same terms as the other two challenge tables (a
-- full retention period past expiry, so a sweep can only ever remove a row
-- that could no longer authorize anything).
CREATE TABLE account_deletion_challenges (
  nonce      bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at  timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  CONSTRAINT account_deletion_challenges_nonce_is_256_bits CHECK (octet_length(nonce) = 32)
);
-- Serves the opportunistic sweep in purge.Challenges.Issue.
CREATE INDEX account_deletion_challenges_expiry_idx ON account_deletion_challenges (expires_at);

-- The Phase 1 plaintext-retention commitment, as a row.
--
-- Spec §5 admits alphas to Phase 1 "unencrypted, under signed plain-language
-- consent (plaintext handling, retention limit, migrate-or-delete at Phase 3
-- cutover)". A retention LIMIT that lives only in a PDF is not a limit; this is
-- where the deadline the operator agreed to is written down, per user, so
-- purge.EnforceRetention can act on it without anyone remembering to.
--
-- One row per user, on purpose. Re-consenting (a new document version, an
-- extended window) UPDATEs the row rather than appending a second one: what the
-- sweep needs is "when does this account's plaintext have to be gone", and two
-- rows disagreeing about that is a question with no answer. The history of
-- which document a user signed and when is the operator's own record — a signed
-- consent form — not something this table pretends to be.
--
-- A user with NO row here is deliberately NOT purged by EnforceRetention. They
-- are reported instead (Report.WithoutConsentRecord): an automatic sweep that
-- treated "no deadline recorded" as "deadline passed" would turn a bug in the
-- onboarding path into the destruction of every account it touched.
CREATE TABLE user_consent (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- WHICH document was signed. An identifier, not prose: this column exists so
  -- an operator can answer "which version of the terms is this user under",
  -- and the same grammar parse_diagnostics.template_id uses keeps it from
  -- becoming a free-text field that a body fragment could end up in.
  document text NOT NULL
    CONSTRAINT user_consent_document_is_an_identifier
    CHECK (document ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),

  signed_at timestamptz NOT NULL,

  -- The deadline. After this instant the account's PLAINTEXT may no longer
  -- exist, and in Phase 1 every byte of it is plaintext — so the enforcement is
  -- a full purge, not a partial one.
  retention_until timestamptz NOT NULL,

  CONSTRAINT user_consent_retention_follows_signature
    CHECK (retention_until > signed_at)
);
-- Serves EnforceRetention's due scan.
CREATE INDEX user_consent_retention_idx ON user_consent (retention_until);

-- +goose Down
DROP TABLE user_consent;
DROP TABLE account_deletion_challenges;
