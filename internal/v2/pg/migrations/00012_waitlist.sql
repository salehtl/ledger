-- +goose Up

-- The bank waitlist (spec §3.1: the admin console's fourth surface).
--
-- # What it is for
--
-- v2 parses a bank only if a template exists for it, and a template is written
-- by hand from real donated mail. So the operator's scheduling question is
-- "which bank do the most waiting people use", and this table is the answer.
-- It is the demand signal that decides which parser gets written next.
--
-- # Why it is a COUNTER and not a list of requests
--
-- One row per bank, with a count, rather than one row per submission. Two
-- reasons, and the second is the load-bearing one:
--
--   * The operator's question is aggregate. Nobody ever reads an individual
--     waitlist entry.
--   * A per-submission table would be a per-user record of which bank someone
--     said they use — a financial-institution association, tied to whoever
--     submitted it, retained indefinitely, for a feature whose entire output is
--     a bar chart. Storing the aggregate means there is nothing here to leak,
--     nothing to hand over, and nothing to delete when an account is purged.
--     The account-deletion path (Task 34) does not have to know this table
--     exists, because it holds nothing about anybody.
--
-- The cost is honest and worth stating: a counter cannot be corrected. A double
-- submission inflates it and nothing can tell. That is acceptable for a
-- prioritisation signal reachable only from the tailnet, and it would not be
-- acceptable for anything a decision about a specific person rested on.
--
-- # Why the bank name is a bounded grammar
--
-- This is the ONE column in v2 that stores free user-authored text outside the
-- op log and quarantine, so it gets the same treatment every text column in
-- parse_diagnostics got: a grammar, enforced in Go AND here, so a row Go would
-- refuse is also a row the database refuses.
--
-- The grammar is deliberately narrow enough that this cannot become a general
-- suggestion box or a place a transaction description ends up: printable ASCII
-- letters, digits, spaces and the four punctuation marks that appear in real
-- bank names (& . - '), 1..64 characters, already lower-cased and
-- whitespace-collapsed by admin.Waitlist.Record.
--
-- The consequence, stated rather than discovered: a bank name written in Arabic
-- is REFUSED, not stored. Onboarding is expected to send a value from a picker
-- rather than a free-text field, and "other" is a legitimate entry.
CREATE TABLE waitlist (
  bank text PRIMARY KEY
    CONSTRAINT waitlist_bank_is_bounded
    CHECK (bank ~ '^[a-z0-9]([a-z0-9 &.''-]{0,62}[a-z0-9])?$'),

  -- bigint, not int. Nothing here is expected to exceed a few thousand, and an
  -- unauthenticated-adjacent counter that can wrap is not worth the two bytes.
  demand bigint NOT NULL
    CONSTRAINT waitlist_demand_is_positive CHECK (demand >= 1),

  first_seen timestamptz NOT NULL,
  last_seen  timestamptz NOT NULL,

  CONSTRAINT waitlist_last_seen_follows_first
    CHECK (last_seen >= first_seen)
);

-- The console's only ordering: most-wanted first.
CREATE INDEX waitlist_by_demand ON waitlist (demand DESC, bank);

-- +goose Down
DROP TABLE waitlist;
