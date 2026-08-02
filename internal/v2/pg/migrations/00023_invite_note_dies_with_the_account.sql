-- +goose Up

-- An invite code's note does not outlive the account that spent it.
--
-- # The claim this makes true
--
-- Three places said the same thing about this table and all three were wrong:
--
--   * 00020: "The row survives as 'this code was spent' with the link to the
--     person removed … an unattributable residue, not a record of anybody."
--   * internal/v2/purge/purge.go, classifying invite_codes as notUserLinked:
--     "The link is the only user-attributable thing here and it is removed by
--     the schema itself."
--   * deploy/README-v2.md's "what survives on purpose" table: "what survives is
--     'some code was spent, and nobody knows by whom'".
--
-- All three describe `redeemed_by uuid REFERENCES users(id) ON DELETE SET NULL`
-- and stop there. `note` is the column they forget, and it is OPERATOR FREE
-- TEXT — 00020's own documented example is `'saleh''s brother'`. It survived
-- deletion alongside `redeemed_at`, the timestamp of that person's sign-up. In
-- a closed beta of a dozen people, `(note, redeemed_at)` names a deleted
-- account outright, and the operator — the one party the row is retained for —
-- is exactly who can read it.
--
-- So one of the two had to move: the claim, or the data. This moves the data,
-- because the alternative is a runbook that promises less than it could about
-- the most sensitive question a beta user can ask, and because "the operator's
-- audit trail" survives intact in the shape that actually matters: the row is
-- still there, still flagged redeemed, still carrying `created_at` and
-- `redeemed_at` and the code hash, and still not spendable again. What is lost
-- is only the sentence naming a person who asked to be forgotten.
--
-- # Why a trigger on invite_codes, not one on users
--
-- Because the thing being enforced is not "account deletion clears the note",
-- it is the narrower invariant that the note never outlives the LINK it
-- describes. Keying on the FK's own SET NULL makes that a row-level fact rather
-- than an application promise, the way single-use redemption is: any path that
-- detaches a redeemer — the cascade from `DELETE FROM users`, purge.Purge, a
-- future admin unlink, an operator at psql — clears the note with it, and no
-- future caller has to remember.
--
-- The WHEN clause is the whole tightening: it fires only on the
-- non-NULL → NULL transition of `redeemed_by`. An UNREDEEMED code is
-- untouched (its `redeemed_by` was already NULL, so the trigger never fires),
-- which is the case the operator's note is FOR — "who is this outstanding code
-- for" is the question `mint-invite --show` exists to answer.
--
-- BEFORE, not AFTER, so it is a field assignment on the row already being
-- written rather than a second UPDATE recursing into this same trigger.
--
-- # One description is still short, and it is not mine to edit
--
-- 00020's column comment and deploy/README-v2.md now both name this trigger.
-- internal/v2/purge/purge.go still reads "The link is the only user-attributable
-- thing here and it is removed by the schema itself", which was the false half
-- of the claim and is now merely incomplete: `note` is removed by the schema
-- too, by this trigger rather than by the FK. That file belongs to another
-- session, so this is the coordination note — one sentence is owed there.
-- Nothing in purge's BEHAVIOUR changes: this fires on the FK's SET NULL, which
-- purge.Purge's `DELETE FROM users` already triggers, and invite_codes stays
-- classified notUserLinked for the reason 00020 gives.
--
-- What holds the claim up is not any of the three comments. It is
-- auth.TestNoTextTheOperatorWroteAboutADeletedAccountSurvivesInTheInviteRow,
-- which enumerates the row's text columns from the catalog and scans each one,
-- so a column added later that carries an email or a support-ticket id fails
-- without anybody having to remember this file exists.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION forget_invite_note() RETURNS trigger AS $$
BEGIN
  NEW.note := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER invite_note_dies_with_the_account
  BEFORE UPDATE ON invite_codes
  FOR EACH ROW
  WHEN (OLD.redeemed_by IS NOT NULL AND NEW.redeemed_by IS NULL)
  EXECUTE FUNCTION forget_invite_note();

-- +goose Down
DROP TRIGGER invite_note_dies_with_the_account ON invite_codes;
DROP FUNCTION forget_invite_note();
