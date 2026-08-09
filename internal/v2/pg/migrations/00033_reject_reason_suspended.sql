-- +goose Up

-- Follow-up to 00030_account_status.sql. That migration gave the operator a
-- suspend lever and smtpd a 452 to answer with; it did not give the diagnostics
-- ledger a word for what had happened.
--
-- # What was wrong
--
-- parse_diagnostics.reject_reason is a closed enum (00006_diagnostics.sql) and
-- had no 'suspended' value, so the suspension path filed its user-scoped notice
-- under 'over_quota' — the nearest available value, and a false one. An
-- operator reading diagnostics saw "this user hit their quota" for an account
-- the operator had themselves paused. The accurate record existed in
-- account_refusals under resource 'suspended', but the two disagreed, and the
-- one an operator reaches for first was the one that lied.
--
-- The enum stays closed; it gains exactly one value. The reason it is closed at
-- all is 00006's: this column must never become a note field that free text —
-- a subject line, a recipient address — can ride into an unencrypted table on.
--
-- # Why smtp_rejections is NOT widened alongside it
--
-- That table aggregates refusals with no recipient to scope a row to. A
-- suspension always has one: the only way to know an account is suspended is to
-- have resolved the recipient first. A 'suspended' row there would be an
-- unscoped fact about a KNOWN user, which is what
-- parse_diagnostics_unscoped_rows_are_refusals refuses next door, and which
-- would then survive that user's account deletion. diag.aggregatedReasons keeps
-- the Go guard in step with the narrower set so a caller gets ErrInvalidRecord
-- rather than a database error.
--
-- # Mechanics
--
-- Postgres cannot widen a CHECK in place; the constraint is dropped and
-- recreated. Not NOT VALID: every existing row already satisfies the wider set
-- by construction — it satisfied the narrower one — so there is nothing to
-- validate later and an unvalidated constraint would be a guarantee in name
-- only. The re-add takes ACCESS EXCLUSIVE for the scan, which on a table
-- holding one bounded row per ingest is brief.
--
-- No GRANT block. The two-role recipe in 00003_writers.sql covers migrations
-- that CREATE a relation or sequence; this one creates neither. ledger_runtime
-- holds its DML privileges on the TABLE, and replacing a table constraint does
-- not touch them (column-level grants would be affected by column changes, and
-- none are used anywhere in this schema). Same conclusion, and same reason, as
-- 00030's no-GRANT note.
ALTER TABLE parse_diagnostics
  DROP CONSTRAINT parse_diagnostics_reject_reason_is_closed;

ALTER TABLE parse_diagnostics
  ADD CONSTRAINT parse_diagnostics_reject_reason_is_closed CHECK (
    reject_reason IS NULL OR
    reject_reason IN ('too_large','unknown_rcpt','over_quota','no_text_part',
                      'normalize_error','suspended')
  );

-- +goose Down

-- The rollback has to answer a question the Up side did not: what happens to
-- rows already carrying 'suspended' when the constraint that permits it goes
-- away. Re-adding the narrow CHECK over them fails outright, so a Down that
-- only swapped the constraint back would be a rollback that does not run —
-- which is worse than none, because it fails in the middle of an emergency.
--
-- Three options, and why this one:
--
--   * DELETE the rows. Destroys diagnostics to make a schema change fit, in a
--     system whose first promise is that nothing is silently dropped. No.
--   * SET NULL. Immediately violates
--     parse_diagnostics_reject_reason_pairs_with_a_refusal, which requires
--     every refusal outcome to carry a reason. It trades one failure for
--     another.
--   * Fold back to 'over_quota'. Chosen. It is exactly the value the code
--     before this migration wrote for these rows, so the rolled-back database
--     is byte-for-byte the database that code would have produced — no rows
--     lost, no count changed, and the imprecision restored is the imprecision
--     that version of the system already had.
--
-- The fold is lossy in the same way the original bug was, and that is the
-- point: a rollback restores the old behaviour, including its flaws. The
-- accurate record of these refusals is unaffected either way — it lives in
-- account_refusals under resource 'suspended', which this migration never
-- touched.
UPDATE parse_diagnostics SET reject_reason = 'over_quota'
  WHERE reject_reason = 'suspended';

ALTER TABLE parse_diagnostics
  DROP CONSTRAINT parse_diagnostics_reject_reason_is_closed;

ALTER TABLE parse_diagnostics
  ADD CONSTRAINT parse_diagnostics_reject_reason_is_closed CHECK (
    reject_reason IS NULL OR
    reject_reason IN ('too_large','unknown_rcpt','over_quota','no_text_part','normalize_error')
  );
