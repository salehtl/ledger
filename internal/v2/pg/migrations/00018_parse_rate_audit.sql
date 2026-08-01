-- +goose Up

-- ⚠ PHASE 1 ONLY, inherited from 00016_parse_rate.sql. Dropped at the cutover.
--
-- Makes parse-rate adjudication APPEND-ONLY.
--
-- # Why a verdict table needs an audit trail at all
--
-- 00016 made (ingest_id, user_id) the primary key and verify.RecordVerdict
-- upserted onto it, so re-adjudicating overwrote the previous verdict and its
-- timestamp and left no trace. That was defended as "the first pass over an
-- unfamiliar bank's mail is exactly where a mistake is made", which is true and
-- is still why re-adjudication is allowed.
--
-- What it missed is who is holding the pen. This verdict is the DENOMINATOR of
-- spec §5's ship gate, the operator adjudicating is the person who wants the
-- beta to ship, and a mutation of six verdicts out of ten was measured to move
-- the reported rate from 0.9000 (fail) to 0.9574 (pass) while leaving ten rows
-- and no evidence that anything had changed. A number that can be edited into
-- passing, by an interested party, without a trace, is not evidence.
--
-- This does not remove the conflict of interest — nothing in a schema can. It
-- makes the edits VISIBLE, so the exit record can state how many verdicts were
-- revised, by whom, and in which direction, and a reader can weigh it.
--
-- # Shape
--
-- Every adjudication is an INSERT. The live verdict for a message is the row
-- with the highest id, and superseded rows stay. UPDATE and DELETE are refused
-- by a trigger for the same reason and on the same terms as key_history: a
-- guarantee that only holds when callers behave is not a guarantee, and the
-- caller most likely to want an edit here is the one this table exists to
-- constrain.
--
-- The account-deletion carve-out is identical to key_history's: the RI cascade
-- from users runs after the users row is gone, which is what distinguishes
-- "this account no longer exists" from "this verdict was quietly rewritten".

-- Altered in place rather than dropped and recreated. A DROP would have made
-- 00016's own Down fail (it drops a table that no longer exists), and a
-- migration whose Down is not reversible is one nobody can safely run backwards
-- on the box it matters on.

-- id becomes the primary key; (ingest_id, user_id) stops being unique, which is
-- exactly the change: a message may now carry several verdicts over time.
ALTER TABLE parse_rate_adjudications
  DROP CONSTRAINT parse_rate_adjudications_pkey;
ALTER TABLE parse_rate_adjudications
  ADD COLUMN id bigserial PRIMARY KEY;

-- WHO. An identifier, not prose, on the same grammar as user_consent.document
-- and for the same reason: this table must not become somewhere a sentence
-- about a user's mail can be written. '' means the operator did not identify
-- themselves, which is itself worth being able to count.
ALTER TABLE parse_rate_adjudications
  ADD COLUMN operator text NOT NULL DEFAULT ''
    CONSTRAINT parse_rate_adjudications_operator_is_an_identifier
    CHECK (operator = '' OR operator ~ '^[a-z0-9][a-z0-9._@-]{0,63}$');

-- The live verdict lookup: highest id per message.
CREATE INDEX parse_rate_adjudications_message_idx
  ON parse_rate_adjudications (user_id, ingest_id, id DESC);

-- +goose StatementBegin
CREATE FUNCTION parse_rate_adjudications_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'parse_rate_adjudications is append-only: TRUNCATE is refused'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'parse_rate_adjudications is append-only: UPDATE of verdict % is refused; insert a superseding row instead', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
    RAISE EXCEPTION 'parse_rate_adjudications is append-only: DELETE of verdict % is refused while user % exists', OLD.id, OLD.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER parse_rate_adjudications_no_rewrite
  BEFORE UPDATE OR DELETE ON parse_rate_adjudications
  FOR EACH ROW EXECUTE FUNCTION parse_rate_adjudications_append_only();

CREATE TRIGGER parse_rate_adjudications_no_truncate
  BEFORE TRUNCATE ON parse_rate_adjudications
  FOR EACH STATEMENT EXECUTE FUNCTION parse_rate_adjudications_append_only();

-- +goose Down
DROP TRIGGER parse_rate_adjudications_no_truncate ON parse_rate_adjudications;
DROP TRIGGER parse_rate_adjudications_no_rewrite ON parse_rate_adjudications;
DROP FUNCTION parse_rate_adjudications_append_only();
DROP INDEX parse_rate_adjudications_message_idx;
ALTER TABLE parse_rate_adjudications DROP COLUMN operator;
ALTER TABLE parse_rate_adjudications DROP COLUMN id;
ALTER TABLE parse_rate_adjudications ADD PRIMARY KEY (ingest_id, user_id);
