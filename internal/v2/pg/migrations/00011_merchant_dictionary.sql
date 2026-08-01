-- +goose Up

-- The global anonymous merchant -> category dictionary (spec §3.6).
--
-- # What this is
--
-- v2 has no LLM. Categorization is a lookup: a merchant pattern maps to a
-- category, the mapping is distributed to every client like a template, and
-- rule matching runs on-device. The dictionary is seeded from the operator's
-- own v1 rules and grown from users' opt-in confirmations.
--
-- # The two gates, and what each one is for
--
-- Spec §3.6 puts two independent gates in front of publication, and they block
-- different attacks:
--
--   * MODERATION blocks poisoning. Without it, enough coordinated submissions
--     of `AMAZON -> Charity` ship a wrong mapping to every device. An operator
--     approval is required, and `approved` is TRI-STATE (NULL = not yet looked
--     at, true, false) so "nobody has reviewed this" is never confused with
--     "someone reviewed it and said no".
--
--   * THE k THRESHOLD blocks identification. A merchant only one person in the
--     beta has ever transacted with is a name for that person: publishing
--     `DR ALIA FERTILITY CLINIC -> Healthcare` would say something about one
--     identifiable user. k = 3 distinct submitters (plan Decision 8) is the
--     smallest threshold at which a rare merchant stops being a single-user
--     identifier.
--
-- Both are required, and both are enforced by dict.Submit and dict.Moderate,
-- which are the only writers.
--
-- What the SQL adds is NARROWER than "the gates are enforced in the database",
-- and the difference matters. dict_entries_publishable_rows_are_published
-- below embeds the same predicate dict.Published selects on, and it guarantees
-- exactly one thing: a row that is BEING SERVED to clients also carries a
-- published_at, so the retraction feed can never lose an entry it already
-- shipped. It does NOT make the gates unforgeable. A direct INSERT can still
-- set distinct_submitter_count to 99 with no submission rows behind it, or
-- supply its own published_at alongside an unmoderated or below-k row, and the
-- constraint will accept it — the first of those is then served by
-- dict.Published like any other entry.
--
-- That is not a hole to be plugged here: anything with INSERT on this table is
-- the operator, who can approve an entry through the front door anyway. It is
-- written down because a comment claiming the database enforces the gates
-- would be relied on by the next person to skip a check in Go.
--
-- # Why dict_submissions has no user_id
--
-- Spec §3.6 says the dictionary is "a bare merchant pattern, never user-linked"
-- and §2's breach inventory promises the server holds no merchants. A table of
-- (user_id, merchant_pattern) is a per-user merchant ledger — a WORSE
-- disclosure than parse_diagnostics, which holds no merchant at all.
--
-- So what is stored is HMAC-SHA256(server key, user_id || pattern || category),
-- which supports exactly one operation — counting DISTINCT submitters for one
-- entry — and no other. Two rows for one user under different patterns are not
-- relatable to each other, because the pattern is inside the HMAC input.
--
-- # What that is NOT, stated plainly
--
-- With three to five alpha users the operator can enumerate its own user list
-- against the HMAC and recover who submitted a pattern, for as long as the row
-- exists. The HMAC is not a privacy guarantee at this scale. What it does is
-- remove the STORED linkage (a stolen disk without the key yields nothing) and
-- BOUND the lifetime of the identifier. Spec §2 says exactly this rather than
-- implying more.
--
-- The lifetime bound is the part that carries real weight, and it is stricter
-- than "deleted at publication": a submitter row exists only while the count
-- can still change the outcome. dict.Submit stores nothing at all once an entry
-- has reached k, has been seeded by the operator, or has published, and the
-- rows for an entry are deleted the moment its count reaches k — whether or not
-- a moderator has looked at it yet. See dict.Submit.
--
-- # The column list is a published claim
--
-- Same rule as parse_diagnostics (00006): §2 is adopted verbatim into the
-- user-facing privacy page, so a column here that §2 does not name is a false
-- statement to users about what a breach yields.
-- dict.TestDictionaryTablesHaveExactlyTheDisclosedColumns fails on any new
-- column and dict.TestEveryDisclosedDictionaryColumnIsNamedInSpecSection2 keeps
-- failing until §2 names it, in the same commit.

-- The delta cursor clients page the dictionary by. A sequence rather than a
-- timestamp: two entries updated inside the same clock tick must still have a
-- total order, or a client resuming from a cursor silently skips one.
CREATE SEQUENCE dict_entry_version_seq;

CREATE TABLE dict_entries (
  -- The merchant pattern, canonicalized by dict.Canonicalize: lower-cased,
  -- trimmed, internal whitespace collapsed. Canonicalization is a k-gate
  -- concern, not tidiness — without it "CARREFOUR", "Carrefour" and
  -- " carrefour " are three entries with one submitter each instead of one
  -- entry with three, and the threshold is trivially split.
  --
  -- Bounded and single-line. This column exists to hold a merchant string, so
  -- unlike parse_diagnostics it cannot be pinned to a closed grammar — the
  -- bound is on SHAPE: 2..64 characters, at least one alphanumeric, no control
  -- characters (so no newline, and nothing that reflows an operator's log), and
  -- no leading or trailing space. A paragraph, a note or a pasted statement
  -- line does not fit.
  pattern text NOT NULL
    CONSTRAINT dict_entries_pattern_is_a_bounded_merchant_string CHECK (
      length(pattern) BETWEEN 2 AND 64
      AND pattern = btrim(pattern)
      AND pattern ~ '[[:alnum:]]'
      AND pattern !~ '[[:cntrl:]]'
    ),

  -- How a client matches the pattern. 'regex' is DELIBERATELY not a value: this
  -- table is published to every device, so a regex here is a fleet-wide ReDoS
  -- surface accepted from a crowd submission, and all 270 of v1's own rules are
  -- `contains` anyway. Adding it later means adding a bounded regex dialect
  -- (see internal/v2/tmpl) and a client-side execution budget first.
  match_type text NOT NULL DEFAULT 'contains'
    CONSTRAINT dict_entries_match_type_is_closed CHECK (match_type IN ('contains','exact')),

  -- The category the pattern maps to, lower-cased. A bounded identifier
  -- grammar, not free text: a category is a short label from a small vocabulary
  -- ("groceries", "debt repayment"), and the failure mode of a free-text column
  -- here is a user's note travelling into a table that ships to every client.
  category text NOT NULL
    CONSTRAINT dict_entries_category_is_a_bounded_label
    CHECK (category ~ '^[a-z0-9][a-z0-9 _/&-]{0,31}$'),

  -- 'operator_seed' is the operator's own v1 rules, imported once by
  -- `ledgerd seed-dictionary`. It bypasses the k gate — and ONLY the k gate —
  -- because it is one identified party's own data contributed deliberately,
  -- not a crowd signal that could be a single user's fingerprint.
  source text NOT NULL DEFAULT 'crowd'
    CONSTRAINT dict_entries_source_is_closed CHECK (source IN ('crowd','operator_seed')),

  -- How many DISTINCT users have submitted this exact (pattern, category).
  -- Maintained by dict.Submit from the row count in dict_submissions while the
  -- count can still change the outcome, then frozen when it reaches k — at
  -- which point the rows it was counting are deleted.
  distinct_submitter_count int NOT NULL DEFAULT 0
    CONSTRAINT dict_entries_submitter_count_is_non_negative CHECK (distinct_submitter_count >= 0),

  -- TRI-STATE. NULL means no moderator has looked at this yet, and it is the
  -- default precisely so that a new entry cannot publish through inaction.
  approved boolean,

  -- The moderator's own note. Operator-authored, NEVER user-supplied and never
  -- served to a client — the only free-text column in either table, bounded so
  -- it cannot become a general-purpose store.
  moderator_note text
    CONSTRAINT dict_entries_moderator_note_is_bounded
    CHECK (moderator_note IS NULL OR length(moderator_note) <= 500),

  -- The delta cursor. Bumped on every change a client could observe.
  version bigint NOT NULL DEFAULT nextval('dict_entry_version_seq')
    CONSTRAINT dict_entries_version_is_positive CHECK (version > 0),

  -- When this entry FIRST published. It is never cleared, because it is what
  -- lets a retraction be reported to clients without leaking anything: only an
  -- entry that was actually published may appear in a delta feed's `removed`
  -- list, so a suppressed or rejected pattern that never shipped can never be
  -- named by one. See dict.Since.
  published_at timestamptz,

  PRIMARY KEY (pattern, category),

  -- THE PUBLICATION INVARIANT, as a database guarantee rather than a
  -- convention. dict.Published selects exactly this predicate, so a row that
  -- satisfies it IS being served to clients; requiring published_at on such a
  -- row means the retraction feed can never lose an entry it already shipped.
  --
  -- The literal 3 is dict.K. SQL cannot reference a Go constant, so
  -- dict.TestTheKThresholdMatchesTheSQLLiteralAndTheSpec reads this
  -- constraint's definition back and fails if the two ever disagree.
  CONSTRAINT dict_entries_publishable_rows_are_published CHECK (
    published_at IS NOT NULL
    OR NOT (approved IS TRUE AND (source = 'operator_seed' OR distinct_submitter_count >= 3))
  )
);

-- Serves the delta feed (dict.Since) and the publication scan.
CREATE INDEX dict_entries_version_idx ON dict_entries (version);

-- The submitter identifiers. This table's whole reason to exist is counting to
-- k, and every property of it follows from wanting that count and nothing else.
CREATE TABLE dict_submissions (
  pattern text NOT NULL,
  category text NOT NULL,

  -- HMAC-SHA256(LEDGER_DICT_HMAC_KEY, pattern || category || user_id), with
  -- every field length-prefixed so no two different inputs can be spelled the
  -- same way. Keyed, so a stolen disk without the key yields nothing; salted by
  -- the entry, so one user's rows under two different entries are unrelatable.
  --
  -- It is a bytea rather than text so it cannot be mistaken for something
  -- printable and rendered into a log.
  submitter_hmac bytea NOT NULL
    CONSTRAINT dict_submissions_hmac_is_256_bits CHECK (octet_length(submitter_hmac) = 32),

  -- The RETENTION key, and its only purpose. An identifier for an entry that
  -- never reaches k would otherwise live forever; dict.ExpireStaleSubmissions
  -- drops it. Without this column that sweep cannot exist, which is the whole
  -- argument for storing a timestamp beside a pseudonym at all.
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (pattern, category, submitter_hmac),

  -- A submission is always ABOUT an entry, and dies with it. Without this,
  -- deleting an entry would leave orphaned identifiers behind with nothing left
  -- pointing at them — the exact shape of the row that survives a purge.
  CONSTRAINT dict_submissions_belong_to_an_entry
    FOREIGN KEY (pattern, category) REFERENCES dict_entries (pattern, category) ON DELETE CASCADE
);

-- Serves ExpireStaleSubmissions' age scan.
CREATE INDEX dict_submissions_created_idx ON dict_submissions (created_at);

-- +goose Down
DROP TABLE dict_submissions;
DROP TABLE dict_entries;
DROP SEQUENCE dict_entry_version_seq;
