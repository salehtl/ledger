-- +goose Up

-- Three corrections to the merchant dictionary (00011), all of them closing
-- ways the k gate and the erasure path could be defeated without anything
-- looking wrong.

-- ===========================================================================
-- 1. The key epoch: HMAC-keyed pseudonyms are only anonymous per key
-- ===========================================================================
--
-- dict_submissions counts DISTINCT submitter_hmac values, and an HMAC is a
-- function of the key. Nothing recorded WHICH key produced a row, and nothing
-- said the key was unrotatable — so rotating LEDGER_DICT_HMAC_KEY silently
-- broke both halves of the design:
--
--   * THE k GATE. One user submitting the same merchant once per key
--     generation produces three different HMACs and therefore
--     distinct_submitter_count = 3, which publishes after one approval. Worse,
--     because 00011 deletes the rows the moment the count reaches k, the
--     evidence deletes itself: the table is left empty and the entry looks
--     like an ordinary three-person consensus.
--
--   * ERASURE. dict.ForgetSubmitter finds rows by recomputing the pseudonym.
--     Under a rotated key it recomputes a DIFFERENT pseudonym, matches
--     nothing, deletes nothing, and returns no error — and purge.forgetSubmitter
--     reads a non-error as complete erasure, so an account is reported deleted
--     while the identifier survives. Rotation is what an operator does AFTER a
--     breach, which is exactly when stale identifiers matter most.
--
-- The fix is to stamp each row with an 8-byte fingerprint of the key that
-- wrote it, so the system can tell its own rows from an earlier generation's:
--
--   * dict.recount counts only CURRENT-epoch rows, so a rotated key can never
--     inflate the count — a rotation makes suppression stricter, never looser.
--   * dict.VerifyKeyEpoch refuses at startup while foreign-epoch rows exist.
--   * dict.ForgetSubmitter refuses rather than reporting a false erasure.
--
-- Rotation is not forbidden, it is SEQUENCED: expire or publish the outstanding
-- identifiers first (they are short-lived by design), then rotate.
--
-- The default backfills any row written before this migration with eight zero
-- bytes, which matches no real key, so pre-existing rows are treated as foreign
-- and trip the refusal rather than being silently trusted. The default is then
-- dropped so every future insert must name its epoch explicitly.
ALTER TABLE dict_submissions
  ADD COLUMN key_epoch bytea NOT NULL DEFAULT '\x0000000000000000'::bytea;
ALTER TABLE dict_submissions ALTER COLUMN key_epoch DROP DEFAULT;
ALTER TABLE dict_submissions
  ADD CONSTRAINT dict_submissions_key_epoch_is_64_bits CHECK (octet_length(key_epoch) = 8);

-- ===========================================================================
-- 2. created_at is coarsened to a whole UTC day
-- ===========================================================================
--
-- Spec §2 tells users, as a statement of fact, that "one user's rows under two
-- different merchants cannot be matched to each other". A full-precision
-- timestamptz defeated that WITHOUT THE KEY AT ALL: an opt-in confirmation
-- batch writes one user's rows within a couple of milliseconds of each other
-- (measured: 1.78 ms, 534 us, 467 us, 449 us across one user's five merchants)
-- and tens of milliseconds away from anyone else's (measured: 60.8 ms, 61.4
-- ms). A keyless breach could therefore partition the pending patterns by
-- submitter on arrival time alone, which is precisely the cross-merchant
-- profile the per-entry salt exists to prevent.
--
-- The column's ONLY consumer is dict.ExpireStaleSubmissions, which compares
-- against a cutoff. Day precision costs it nothing.
--
-- Both the default and the constraint pin the truncation to UTC explicitly.
-- Plain date_trunc('day', now()) would truncate in the SESSION time zone, so
-- two connections configured differently would land on different boundaries
-- and the constraint would reject rows the default had just produced.
UPDATE dict_submissions
   SET created_at = date_trunc('day', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
ALTER TABLE dict_submissions
  ALTER COLUMN created_at SET DEFAULT (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
-- The Go side never sets created_at, so without this the guarantee would hold
-- only for callers that happen to go through the dict package. Same argument as
-- 00006's CHECK constraints: the Go path is the guard, the constraint is the
-- guarantee.
ALTER TABLE dict_submissions
  ADD CONSTRAINT dict_submissions_created_at_is_a_whole_day CHECK (
    created_at = date_trunc('day', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  );

-- ===========================================================================
-- 3. A `contains` pattern needs a floor
-- ===========================================================================
--
-- A short `contains` pattern is a wildcard wearing a merchant's clothes.
-- `on -> charity` passes every gate this design has — three real users can
-- genuinely submit it — and then contains-matches AMAZON, NOON and TALABAT
-- ONLINE on every device in the beta. The k threshold cannot catch it, because
-- it is not a rare merchant; only breadth makes it dangerous.
--
-- Four characters is measured, not guessed: the operator's own 212 seeded v1
-- rules bottom out at exactly four characters, so the floor rejects nothing
-- real. `exact` keeps the shorter floor, because an exact match is not a
-- wildcard.
--
-- dict.TestTheContainsFloorMatchesTheSQLLiteral pins this literal to
-- dict.minContainsRunes, the same way the k literal is pinned to dict.K.
ALTER TABLE dict_entries
  ADD CONSTRAINT dict_entries_contains_patterns_have_a_floor CHECK (
    match_type <> 'contains' OR length(pattern) >= 4
  );

-- +goose Down
ALTER TABLE dict_entries DROP CONSTRAINT dict_entries_contains_patterns_have_a_floor;
ALTER TABLE dict_submissions DROP CONSTRAINT dict_submissions_created_at_is_a_whole_day;
ALTER TABLE dict_submissions ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE dict_submissions DROP CONSTRAINT dict_submissions_key_epoch_is_64_bits;
ALTER TABLE dict_submissions DROP COLUMN key_epoch;
