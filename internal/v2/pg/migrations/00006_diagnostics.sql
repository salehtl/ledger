-- +goose Up

-- The bounded, deliberately UNENCRYPTED diagnostics ledger (spec §3.5), and the
-- aggregated protocol-rejection counter beside it.
--
-- # What this table is for
--
-- v1's promise was "nothing is ever silently dropped". v2 cannot keep that
-- promise by retaining raw bodies — they are sealed to the user's key the
-- moment they arrive and the server cannot read them again. So the only way an
-- operator can turn "this user's mail stopped parsing" into a fixable bug
-- report is a record of NON-CONTENT facts about each ingest: which template was
-- tried, whether it matched, which of its named groups came back empty, roughly
-- how big the body was, who signed it, and what happened to it.
--
-- # What this table is, honestly
--
-- It is a per-user bank-and-timing ledger. A breach of this server reveals
-- which bank each user banks with, when each of their transactions happened,
-- what shape their bank's mail has, and which parts of it we failed to read.
-- It does NOT reveal an amount, a merchant, a subject, a display name, a
-- header value, or any fragment of a body. Spec §2 states exactly this, and §2
-- is adopted verbatim into the user-facing privacy page.
--
-- That makes the column list a PUBLISHED CLAIM. Adding a column here is a
-- change to what users have been told a breach yields, and
-- diag.TestDiagnosticsTableHasExactlyTheDisclosedColumns plus
-- diag.TestEveryDisclosedColumnIsNamedInSpecSection2 exist to make that
-- impossible to do silently: the first fails on any new column, and the second
-- keeps failing until §2 names it too.
--
-- # Why the CHECK constraints are not decoration
--
-- diag.Record validates every field in Go before it gets here. These
-- constraints are the backstop for everything that is not diag.Record: a repair
-- script, a psql session, a future caller, or a bug. The guarantee this table
-- makes is "free text cannot be stored", and a guarantee that only holds when
-- callers are well-behaved is not a guarantee. Each constraint below is
-- exercised from Go with a deliberately content-bearing value in
-- TestTheDatabaseRefusesFreeTextWhenGoIsBypassed.
--
-- The shared shape of the argument, per field: every text column is either a
-- CLOSED ENUM (event, dkim_result, arc_result, tier, outcome, reject_reason),
-- a HOSTNAME (sender_domain, inner_origin_domain), an IDENTIFIER
-- (template_id, the elements of empty_groups), or a FIXED-WIDTH HEX DIGEST
-- (structure_sig). None of those grammars admits a sentence, an amount, or a
-- body fragment.
CREATE TABLE parse_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL only for protocol-layer events that never resolved a recipient. Every
  -- other row must be scoped, because an unscoped row is a row that survives
  -- account deletion — see parse_diagnostics_unscoped_rows_are_refusals below.
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,

  -- Arrivals and reprocessing are separate events and are NEVER folded
  -- together. An earlier draft had one flat outcome, which made the exit
  -- test's inbound arithmetic work only if re-ingest wrote no row at all —
  -- a blind spot in the very instrument that exists to prove nothing is
  -- dropped.
  event text NOT NULL
    CONSTRAINT parse_diagnostics_event_is_closed CHECK (event IN ('arrival','reprocess')),

  -- SHA-256 of the raw body: the join key to the op / quarantine row. It is a
  -- one-way function of content, so it cannot be read back into a message —
  -- but an operator holding a CANDIDATE message can confirm that message was
  -- ingested. That is a real disclosed property, not a hidden one.
  ingest_id bytea NOT NULL
    CONSTRAINT parse_diagnostics_ingest_id_is_256_bits CHECK (octet_length(ingest_id) = 32),

  received_at timestamptz NOT NULL,

  -- The VERIFIED signing domain, or the envelope domain prefixed 'unverified:'.
  -- The prefix is load bearing: "DKIM says dib.ae signed this" and "the
  -- envelope claimed dib.ae" are evidence and an attacker's assertion
  -- respectively, and a column that rendered them identically would launder the
  -- second into the first. '' means no domain at all (a null sender).
  --
  -- Content safety: bounded to hostname grammar, so no space, no punctuation
  -- beyond '.' and '-', and no character outside [a-z0-9.-]. A subject line, an
  -- amount or a merchant phrase cannot be spelled in it.
  sender_domain text NOT NULL
    CONSTRAINT parse_diagnostics_sender_domain_is_a_hostname CHECK (
      sender_domain = '' OR (
        length(sender_domain) <= 264 AND
        sender_domain ~ '^(unverified:)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
      )
    ),

  dkim_result text NOT NULL
    CONSTRAINT parse_diagnostics_dkim_result_is_closed
    CHECK (dkim_result IN ('pass','fail','none','temperror')),
  arc_result text NOT NULL
    CONSTRAINT parse_diagnostics_arc_result_is_closed
    CHECK (arc_result IN ('pass','fail','none')),

  -- Which bank is behind a forwarder. This is the single most content-adjacent
  -- column in the table, because the tempting place to read it from is the
  -- forwarded body's own From line — which norm.Result documents in capitals as
  -- "CONTENT ONLY, never trust". A message with no passing attestation has no
  -- legitimate source for an inner origin at all, so that combination is made
  -- UNSTORABLE rather than merely discouraged (see the constraint below). That
  -- does not prove a caller used the attested value, but it removes every row
  -- in which a body-derived value could be the only possible source.
  inner_origin_domain text
    CONSTRAINT parse_diagnostics_inner_origin_is_a_hostname CHECK (
      inner_origin_domain IS NULL OR (
        length(inner_origin_domain) <= 253 AND
        inner_origin_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
      )
    ),

  -- Operator-published identifiers, not attacker-controlled, but still pinned
  -- to an identifier grammar so a caller cannot pass a message fragment.
  template_id text
    CONSTRAINT parse_diagnostics_template_id_is_an_identifier
    CHECK (template_id IS NULL OR template_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  template_version int
    CONSTRAINT parse_diagnostics_template_version_is_positive
    CHECK (template_version IS NULL OR (template_version >= 1 AND template_version <= 1000000)),

  -- Which normalizer produced the matched text. 0 means none ran (the message
  -- was refused before normalization).
  normalizer_version int NOT NULL
    CONSTRAINT parse_diagnostics_normalizer_version_is_bounded
    CHECK (normalizer_version >= 0 AND normalizer_version <= 1000),

  matched boolean NOT NULL,

  -- NAMES ONLY of the named capture groups that captured nothing. This is what
  -- turns "unparsed" into "the amount group stopped matching on 3 March", and
  -- it is the weakest field in the table on content safety: a group NAME is an
  -- identifier, and so is a single-token merchant like CARREFOUR, so grammar
  -- alone cannot tell a name from that particular kind of value.
  --
  -- Three things bound it. (1) The grammar below admits no space, no '.', no
  -- ',', no '/' and nothing over 32 characters, which excludes every amount,
  -- date, card fragment and multi-word merchant. (2) At most 32 elements.
  -- (3) The semantic invariant that makes the field safe at all: a group listed
  -- here captured NOTHING, so it has no value to leak.
  --
  -- The array is joined with ',' for the grammar check because CHECK cannot
  -- contain a subquery. An element that itself contains ',' would pass as two
  -- elements — bounded, since each piece must still be an identifier, and
  -- diag.Record checks elements individually and does not have that gap.
  empty_groups text[] NOT NULL DEFAULT '{}'
    CONSTRAINT parse_diagnostics_empty_groups_are_identifiers
    CHECK (array_to_string(empty_groups, ',') ~ '^([A-Za-z_][A-Za-z0-9_]{0,31})?(,[A-Za-z_][A-Za-z0-9_]{0,31})*$'),

  tier text NOT NULL
    CONSTRAINT parse_diagnostics_tier_is_closed CHECK (tier IN ('template','heuristic','none')),

  -- The padding bucket, never the exact size. An exact byte count tracks the
  -- merchant name's length and the amount's digit count, which is precisely the
  -- content this table promises not to hold. 0 means no bucket applies (the
  -- message exceeded the largest rung, or was refused before it was measured).
  -- The ladder is blob.Buckets; TestTheSQLBucketLadderMatchesBlobBuckets pins
  -- the two together.
  body_size_bucket int NOT NULL
    CONSTRAINT parse_diagnostics_body_size_is_a_bucket
    CHECK (body_size_bucket IN (0, 1024, 4096, 16384, 65536, 262144, 524288, 1048576)),

  -- A content-free layout fingerprint: every digit run becomes 0, every ASCII
  -- letter run A, every Arabic letter run B, every other letter run C,
  -- punctuation and line structure survive, and the result is SHA-256'd and
  -- truncated to 128 bits. Two emails of the same layout with different amounts
  -- and merchants share a signature. The stored value is a digest, so even the
  -- layout string it commits to is not recoverable from it — only equality is.
  -- '' means no normalized text existed.
  structure_sig text NOT NULL
    CONSTRAINT parse_diagnostics_structure_sig_is_a_digest
    CHECK (structure_sig = '' OR structure_sig ~ '^[0-9a-f]{32}$'),

  outcome text NOT NULL,

  -- Closed enum, NOT an error string. This is the exact place the mistake would
  -- be permanent: a prior task's error text was found capable of carrying a
  -- token fragment into the operator log, and an error string stored here would
  -- carry a subject line into a table that promises never to hold one.
  reject_reason text
    CONSTRAINT parse_diagnostics_reject_reason_is_closed CHECK (
      reject_reason IS NULL OR
      reject_reason IN ('too_large','unknown_rcpt','over_quota','no_text_part','normalize_error')
    ),

  -- Each event kind has its own outcome vocabulary. verify.Accounting counts
  -- arrivals only as inbound_total and reports reprocessing beside it.
  --
  -- Note what 'duplicate' is and is not: it is an ASSERTION that these bytes
  -- are already stored somewhere, not a fact about the row itself. A duplicate
  -- whose referent is in no store is a DISCARDED message, and no constraint
  -- here can see that because the evidence lives in three other places. That is
  -- verify's A3_duplicate_of_nothing check.
  CONSTRAINT parse_diagnostics_outcome_matches_event CHECK (
    (event = 'arrival'   AND outcome IN ('appended','quarantined','rejected','over_quota','duplicate')) OR
    (event = 'reprocess' AND outcome IN ('appended','superseded','unchanged'))
  ),

  -- An inner origin claim needs an attestation to have come from. See the
  -- column comment: without one, the only available source is body text.
  CONSTRAINT parse_diagnostics_inner_origin_needs_an_attestation CHECK (
    inner_origin_domain IS NULL OR dkim_result = 'pass' OR arc_result = 'pass'
  ),

  -- And the same rule for the column the TRUST DECISION keys on, which is the
  -- one that needed it most. The unprefixed spelling of sender_domain means
  -- "a signature we verified names this domain"; with neither dkim_result nor
  -- arc_result passing there is no such signature and the only available
  -- source is the envelope, which is exactly the assertion the 'unverified:'
  -- prefix exists to keep distinguishable from evidence.
  --
  -- It has a live consumer: admin.reprocessTemplate reads these values back
  -- through tmpl.MatchesSenderDomain to decide whose mail a template republish
  -- re-parses. An unattested domain laundered into the verified form widens
  -- that set. diag.Record enforces the rule in Go; this is the guarantee.
  CONSTRAINT parse_diagnostics_verified_sender_needs_an_attestation CHECK (
    sender_domain = '' OR sender_domain LIKE 'unverified:%'
    OR dkim_result = 'pass' OR arc_result = 'pass'
  ),

  -- Only a refusal has a reason, and every refusal has one. Otherwise
  -- reject_reason drifts into a general-purpose note field, which is how free
  -- text gets into tables that promised not to have any.
  CONSTRAINT parse_diagnostics_reject_reason_pairs_with_a_refusal CHECK (
    (reject_reason IS NOT NULL) = (outcome IN ('rejected','over_quota'))
  ),

  -- A version of nothing, or an id that cannot be traced to the template that
  -- produced the diagnostic. Both halves or neither.
  CONSTRAINT parse_diagnostics_template_id_and_version_are_paired CHECK (
    (template_id IS NULL) = (template_version IS NULL)
  ),
  -- You cannot match a template you never attempted, and the template tier
  -- cannot be the tier that produced a result if nothing matched.
  CONSTRAINT parse_diagnostics_match_needs_a_template CHECK (
    NOT matched OR template_id IS NOT NULL
  ),
  CONSTRAINT parse_diagnostics_template_tier_needs_a_match CHECK (
    tier <> 'template' OR matched
  ),

  -- The only rows allowed to be unscoped are the protocol-layer refusals that
  -- genuinely have no recipient to scope to (an unknown RCPT). Anything else
  -- without a user_id would survive that user's account deletion.
  CONSTRAINT parse_diagnostics_unscoped_rows_are_refusals CHECK (
    user_id IS NOT NULL OR (event = 'arrival' AND outcome = 'rejected')
  )
);

-- Serves the per-user views and the purge path.
CREATE INDEX parse_diagnostics_user_received_idx ON parse_diagnostics (user_id, received_at);
-- Serves diag.Accounting's window scan.
CREATE INDEX parse_diagnostics_event_received_idx ON parse_diagnostics (event, received_at);
-- Serves "what happened to this ingest", the actual bug-report lookup.
CREATE INDEX parse_diagnostics_ingest_idx ON parse_diagnostics (ingest_id);

-- Protocol-level rejections that never resolve a recipient.
--
-- These have no user_id to scope a row to, and one row per attempt would let
-- anyone flood this table from the open :25 — turning the instrument that
-- proves nothing is dropped into a storage-amplification bug. A per-day
-- aggregate closes the "zero drops" hole without opening that one. It is not
-- user-linked and cannot be: it is a count.
CREATE TABLE smtp_rejections (
  day date NOT NULL,
  reason text NOT NULL
    CONSTRAINT smtp_rejections_reason_is_closed
    CHECK (reason IN ('too_large','unknown_rcpt','over_quota','no_text_part','normalize_error')),
  count bigint NOT NULL DEFAULT 0
    CONSTRAINT smtp_rejections_count_is_non_negative CHECK (count >= 0),
  PRIMARY KEY (day, reason)
);

-- +goose Down
DROP TABLE smtp_rejections;
DROP TABLE parse_diagnostics;
