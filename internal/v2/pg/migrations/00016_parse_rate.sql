-- +goose Up

-- ⚠ PHASE 1 ONLY. THIS TABLE IS DROPPED AT THE PHASE 3 CUTOVER.
--
-- Item 4 of docs/superpowers/specs/v2-phase1-only-inventory.md, and the only
-- one of the four that exists purely to measure something.
--
-- # Why an operator has to be in the loop at all
--
-- Spec §5's exit criterion is "≥95% of transaction emails parse". The first
-- draft said that was "counted from parse_diagnostics, excluding
-- non-transactional mail" — and that is not derivable. Diagnostics deliberately
-- store no content (00006_diagnostics.sql), so NOTHING in this schema knows
-- whether a message that reached tier='none' was a bank alert whose template
-- broke or a newsletter that was never going to parse. The numerator is a
-- query; the denominator is a judgement, and a judgement needs a judge.
--
-- So the denominator is: everything that parsed, plus the unparsed arrivals an
-- operator has LOOKED AT and called genuine transaction mail. This table is
-- where those judgements are written down, one per (message, user), so the
-- measurement is reproducible and so a second run does not silently re-ask.
--
-- # Why it does not survive Phase 3
--
-- Making the judgement means reading the body. In Phase 1 the operator can:
-- cold blobs are plaintext. From Phase 3 they are sealed to the user's key and
-- the server holds no private key, so this is not "harder later" — it is
-- structurally impossible, and the metric becomes whatever the content-free
-- diagnostics ledger can support. The table goes with the capability.
--
-- # What it holds, and what it does not
--
-- An ingest id (a SHA-256 of a body — one-way, the same identifier
-- parse_diagnostics and quarantine_removals already carry), a user, a
-- three-valued verdict and a timestamp. No text, no excerpt, no reason field. A
-- free-text note here would be an operator's paraphrase of somebody's bank mail
-- in an unencrypted table, which is precisely what §3.5's concession is bounded
-- to exclude.
--
-- 'unreadable' is the third verdict rather than an absent row because "I could
-- not read this body" is a fact that has to be recorded: verify.ParseRate counts
-- it AGAINST the rate (it might have been a transaction), and without the
-- verdict it would be indistinguishable from work not yet done, so the tool
-- would ask for it again forever.
--
-- user_id is a plain user-scoped FK, so schema discovery in internal/v2/purge
-- picks this table up automatically and account deletion takes the
-- adjudications with it. That is deliberate: an adjudication is a record about
-- a specific person's mail.
CREATE TABLE parse_rate_adjudications (
  ingest_id bytea NOT NULL
    CONSTRAINT parse_rate_adjudications_ingest_id_is_256_bits CHECK (octet_length(ingest_id) = 32),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verdict text NOT NULL
    CONSTRAINT parse_rate_adjudications_verdict_is_closed
    CHECK (verdict IN ('transaction','non_transactional','unreadable')),
  adjudicated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ingest_id, user_id)
);

-- +goose Down
DROP TABLE parse_rate_adjudications;
