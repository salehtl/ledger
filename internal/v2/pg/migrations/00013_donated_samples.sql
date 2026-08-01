-- +goose Up

-- The donated-sample queue (spec §3.5): the corpus a template is authored from
-- and, more importantly, the corpus every publish is REGRESSION-TESTED against.
--
-- # What this table is, honestly
--
-- It is the one table in v2 that holds a user's real mail in the clear on
-- purpose. Everything else either never sees content (parse_diagnostics, the
-- merchant dictionary, the waitlist) or holds it because the message has not
-- been trusted yet and is on a countdown (quarantine). A row here exists
-- because a person read a description of what would be sent and pressed a
-- button.
--
-- That makes the column list a PUBLISHED CLAIM, exactly like parse_diagnostics.
-- Adding a column is a change to what users have been told a breach yields, and
-- samples.TestDonatedSamplesTableHasExactlyTheDisclosedColumns plus
-- samples.TestEveryDisclosedColumnIsNamedInSpecSection2 make it impossible to
-- do silently: the first fails on any new column, and the second keeps failing
-- until spec §2 names it too.
--
-- # Two kinds of row, and the default is the empty one
--
-- §3.5:114 is explicit that the DEFAULT client behaviour is a content-free
-- structural report and that a full sample is a separate, explicit act. The
-- table encodes that as two shapes of row:
--
--   * A REPORT has sender_domain and structure_sig and NOTHING else. No body,
--     no ingest id, no arrival time, no consent — there is nothing to consent
--     to, because there is no content. It answers "14 users are hitting an
--     untemplated FAB credit-card format" without anybody reading a message.
--   * A DONATION carries raw, and therefore carries all of its provenance: the
--     ingest id it came from, when it arrived, the identifier of the consent
--     text the donor was shown, and when they agreed.
--
-- donated_samples_a_body_travels_with_consent_and_provenance below makes the
-- two shapes the ONLY two. There is no third state in which a body sits here
-- with no record of why.
--
-- # Retention is a promise, not a preference
--
-- expires_at is NOT NULL and must be ahead of created_at, so every row has a
-- deletion date from the instant it is written; samples.ExpireDue deletes past
-- it on the server's sweep ticker. The default window is samples.DefaultRetention
-- (180 days), chosen against the gate's actual job: a template rewritten a
-- quarter after it was published must still regress against real mail, and a
-- corpus that empties faster than templates are rewritten is a gate that
-- silently stops being one. It is not open-ended: a donation made today is gone
-- inside six months, the whole table is dropped at the Phase 3 cutover, and
-- account deletion takes every row with it (ON DELETE CASCADE, pinned by
-- samples.TestDeletingAUserDeletesTheirDonatedSamples).
--
-- Re-reporting a format refreshes only a REPORT's expiry — a format somebody is
-- still hitting is still live demand, and a report holds no content to age out.
-- A donation's expiry is fixed when it is stored and never extended.
--
-- # Who can read one
--
-- No HTTP route in this system returns these bytes. The console replays
-- templates over them and returns MATCH RESULTS (matched / not, and the names
-- of capture groups that came back empty); the queue view returns counts. The
-- operator with a shell on the box can read the table, and that is the honest
-- limit of the promise — it is stated in spec §2 rather than implied by the
-- absence of a route. admin.TestNoConsoleRouteReturnsADonatedBody pins the
-- route half.
CREATE TABLE donated_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Never NULL, unlike parse_diagnostics.user_id: every row here exists because
  -- a specific person acted, and an unscoped row would be one that survives
  -- their account deletion.
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The CRYPTOGRAPHICALLY VERIFIED signing domain the message came from — for
  -- a forwarded message, the attested inner origin. It is taken from this
  -- server's own arrival record and NEVER from the request (samples.Donate
  -- refuses a caller-supplied domain), because a caller who could name the
  -- domain could plant a sample under any bank and block that bank's template
  -- publishes for ever.
  --
  -- The 'unverified:' prefix parse_diagnostics uses is deliberately NOT
  -- admitted here. Templates match verified domains; a sample stored under a
  -- bare hostname that was only ever an envelope claim would launder an
  -- assertion into evidence.
  sender_domain text NOT NULL
    CONSTRAINT donated_samples_sender_domain_is_a_verified_hostname CHECK (
      length(sender_domain) <= 253 AND
      sender_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    ),

  -- diag.StructureSig: the content-free 128-bit layout fingerprint. Same
  -- grammar and same meaning as parse_diagnostics.structure_sig, so the two
  -- cluster against each other. '' is legal ONLY on a row that carries a body
  -- (a donated message that does not normalize has no layout to fingerprint);
  -- see donated_samples_a_report_is_its_signature.
  structure_sig text NOT NULL
    CONSTRAINT donated_samples_structure_sig_is_a_digest
    CHECK (structure_sig = '' OR structure_sig ~ '^[0-9a-f]{32}$'),

  -- SHA-256 of the raw body: the same join key parse_diagnostics and the op log
  -- use, and the dedup key that makes donating one message twice one row.
  ingest_id bytea
    CONSTRAINT donated_samples_ingest_id_is_256_bits
    CHECK (ingest_id IS NULL OR octet_length(ingest_id) = 32),

  -- The message as it arrived. PLAINTEXT, in Phase 1, on purpose.
  --
  -- Bounded by blob.MaxColdMail, the same ceiling the cold stream applies, so a
  -- donation can never be larger than the message it came from.
  raw bytea
    CONSTRAINT donated_samples_raw_is_bounded_mail
    CHECK (raw IS NULL OR (octet_length(raw) > 0 AND octet_length(raw) <= 1000000)),

  -- When the message arrived, from the cold record itself. The replay needs it:
  -- norm.Normalize takes the arrival instant, so a sample replayed without it
  -- would normalize differently from the way it did in production.
  received_at timestamptz,

  -- The IDENTIFIER of the consent text the donor was shown ('donate-sample-v1'),
  -- not their words and not ours. Same grammar as template_id for the same
  -- reason parse_diagnostics.reject_reason is a closed enum: the alternative is
  -- a free-text note field, and a note field beside a table of real mail is
  -- where a subject line ends up.
  consent text
    CONSTRAINT donated_samples_consent_is_an_identifier
    CHECK (consent IS NULL OR consent ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),

  -- When they agreed, from the SERVER's clock at the moment the donation
  -- arrived. A client-supplied instant would be a claim about consent made by
  -- the party the consent protects us from.
  consented_at timestamptz,

  created_at timestamptz NOT NULL,

  -- The deletion date. See the header: every row has one from the instant it is
  -- written.
  expires_at timestamptz NOT NULL,

  -- The two shapes, and only the two. A body travels with its provenance and
  -- its consent, or none of them are present.
  CONSTRAINT donated_samples_a_body_travels_with_consent_and_provenance CHECK (
    (raw IS NULL) = (ingest_id IS NULL) AND
    (raw IS NULL) = (received_at IS NULL) AND
    (raw IS NULL) = (consent IS NULL) AND
    (raw IS NULL) = (consented_at IS NULL)
  ),

  -- A row with no body and no signature holds nothing at all; it would be a
  -- record that a user uses a bank, and nothing else.
  CONSTRAINT donated_samples_a_report_is_its_signature CHECK (
    raw IS NOT NULL OR structure_sig <> ''
  ),

  CONSTRAINT donated_samples_expires_after_it_was_created CHECK (
    expires_at > created_at
  )
);

-- One row per donated MESSAGE. Donating the same mail twice is idempotent
-- rather than a second copy of it on disk.
CREATE UNIQUE INDEX donated_samples_one_row_per_message
  ON donated_samples (user_id, ingest_id) WHERE ingest_id IS NOT NULL;

-- One row per (user, format) for the content-free path. A row per unparsed
-- EMAIL would turn the default, privacy-preserving path into a per-user
-- transaction-timing ledger — the exact surface parse_diagnostics already
-- discloses and that nothing else should duplicate — for the sake of a count
-- the console does not ask for.
CREATE UNIQUE INDEX donated_samples_one_report_per_user_and_format
  ON donated_samples (user_id, sender_domain, structure_sig) WHERE raw IS NULL;

-- Serves ForSender: the publish gate's corpus read, bodies only.
CREATE INDEX donated_samples_by_sender ON donated_samples (sender_domain)
  WHERE raw IS NOT NULL;
-- Serves the retention sweep.
CREATE INDEX donated_samples_by_expiry ON donated_samples (expires_at);

-- +goose Down
DROP TABLE donated_samples;
