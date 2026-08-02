-- +goose Up

-- The closed beta's gate: a single-use invite code (Phase 2 plan, Decision 8).
--
-- # Why this is not an identity allowlist
--
-- The obvious design — `ledgerd allow-signup --subject <sub>` — cannot be
-- built, and the reason is worth writing down so it is not proposed a third
-- time. An IdP `subject` is not knowable until that person's FIRST SIGN-IN,
-- which is exactly the event being gated: there is no moment at which the
-- operator could run that command in time. Keying on the verified `email`
-- claim was the other candidate and is rejected because Apple's
-- `@privaterelay.appleid.com` relay addresses make it a per-provider special
-- case on the security-critical path.
--
-- `waitlist` (00012) cannot be the key either: it is
-- `(bank, demand, first_seen, last_seen)` — a bank-demand counter that contains
-- no users at all.
--
-- So the key is a secret the OPERATOR mints and hands over out of band, which
-- is knowable before the sign-in because the operator made it up.
--
-- # What is stored, and what is not
--
-- The code itself is never written down here. `code_hash` is SHA-256 of the
-- normalized code (see auth.NormalizeInviteCode) and the primary key, on the
-- same terms as `sessions.token_hash`: a database backup, a log line or a
-- replica leaks a set of digests rather than a set of live credentials.
--
-- The code is preimage-resistant AND high-entropy (15 bytes from crypto/rand,
-- 120 bits), so an unsalted digest is not a dictionary-attack target the way a
-- password digest would be. That is the same argument sessions.token_hash
-- makes and it holds for the same reason: there is nothing to guess.
CREATE TABLE invite_codes (
  code_hash bytea PRIMARY KEY
    CONSTRAINT invite_codes_hash_is_256_bits CHECK (octet_length(code_hash) = 32),

  -- The operator's own words: "saleh's brother", "the beta tester from the
  -- bank thread". Free text, and deliberately NOT constrained to an identifier
  -- the way parse_diagnostics.template_id is — nothing machine-reads it, and a
  -- gate whose audit trail is a slug is a gate nobody can audit six weeks
  -- later. It may be NULL: a code minted in a hurry with no note is better
  -- than a code not minted.
  --
  -- It is CLEARED when the account that spent the code is deleted — see
  -- 00023_invite_note_dies_with_the_account.sql. Note that as written this
  -- column is the reason the paragraph on redeemed_by below was, for two
  -- migrations, not true of the row as a whole: "saleh's brother" beside a
  -- redeemed_at IS a record of somebody, and the operator is exactly who can
  -- read it. An OUTSTANDING code keeps its note.
  note text,

  created_at timestamptz NOT NULL,

  -- Set exactly once, by the transaction that also creates the account. NULL
  -- means unredeemed and therefore spendable; the redemption is
  -- `UPDATE ... WHERE code_hash = $1 AND redeemed_at IS NULL`, which is what
  -- makes "single use" a row-level fact rather than an application promise.
  -- Two concurrent sign-ins presenting the same code serialize on this row and
  -- the loser's UPDATE matches zero rows under READ COMMITTED.
  redeemed_at timestamptz,

  -- Who spent it. ON DELETE SET NULL rather than CASCADE, and the difference is
  -- the point: deleting an account must not resurrect its invite code. The row
  -- survives as "this code was spent" with the link to the person removed,
  -- which is the same shape dict_entries takes after purge.ForgetSubmitter —
  -- an unattributable residue, not a record of anybody.
  --
  -- The column is deliberately NOT called `user_id`: purge's schema discovery
  -- treats a `user_id` column as "this table holds one user's data and must
  -- CASCADE", and this table does not and must not. See purge.notUserLinked,
  -- where it is classified with this reasoning.
  redeemed_by uuid REFERENCES users(id) ON DELETE SET NULL,

  -- redeemed_by may be NULL while redeemed_at is set (the account was deleted
  -- afterwards), but never the other way round: a code attributed to somebody
  -- and not marked spent would be spendable again by anyone.
  CONSTRAINT invite_codes_redeemer_implies_redemption
    CHECK (redeemed_by IS NULL OR redeemed_at IS NOT NULL)
);

-- The operator's "what is still outstanding" question, which is the only
-- listing this table has. Partial, because the answer is always about the
-- unredeemed ones and the redeemed rows accumulate for the life of the beta.
CREATE INDEX invite_codes_unredeemed_idx ON invite_codes (created_at)
  WHERE redeemed_at IS NULL;

-- +goose Down
DROP TABLE invite_codes;
