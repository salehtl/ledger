-- +goose Up

-- +goose StatementBegin

-- Quarantine: where mail from an origin this account has not vouched for waits
-- (spec §3.2:55-56), plus the allowlist that lets it out and the record of
-- everything that has ever left.
--
-- # This table is deliberately OUTSIDE the op log
--
-- There is no `seq`, no `blob_hash`, no `prev_hash` and no `writer_counter`
-- here, and there must never be. A quarantined message has not been trusted
-- yet: the whole point of holding it is that nothing about it has entered the
-- account's integrity chains. Confirming its sender re-runs ingest (Task 30)
-- and appends the RESULT to op_log as ordinary ops; that append — not the
-- arrival — is the moment the message joins the chains.
--
-- quarantine.TestQuarantineHasNoChainColumns fails on any of those four column
-- names appearing here, because a chain column on this table would mean a
-- message the user never vouched for is being hashed into the same structure
-- their own writes are verified against.
--
-- # Phase 1 stores the blob in the clear
--
-- `blob` is the raw RFC822 message. In Phase 1 that is PLAINTEXT — the server
-- parses this mail in the clear anyway — so it is stored unpadded and
-- size_bucket is recorded beside it rather than baked into the byte count.
-- Padding hides a length only from someone who cannot read the content, which
-- describes nobody in Phase 1 and describes the server itself from Phase 3, and
-- Phase 3 is when this column starts holding a sealed, padded blob. Keeping
-- size_bucket now means the diagnostics ledger and the client both already
-- speak in rungs and neither changes at the cutover.
CREATE TABLE quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- SHA-256 of the raw body: the same join key parse_diagnostics.ingest_id and
  -- the ops use, which is what lets "what happened to this message" be
  -- answerable across all three.
  ingest_id bytea NOT NULL
    CONSTRAINT quarantine_ingest_id_is_256_bits CHECK (octet_length(ingest_id) = 32),

  received_at timestamptz NOT NULL,
  -- received_at + TTL (30 days). Computed in Go against the injected clock, so
  -- one clock decides both when the window opens and when it closes.
  expires_at timestamptz NOT NULL,
  -- When the client was TOLD this item is about to expire. NULL means it has
  -- not been told, and an item that has not been told is one that cannot be
  -- deleted (see quarantine_removals below and quarantine.Store.ExpireDue).
  warned_at timestamptz,

  -- The verified signing domain of the message as we received it, or the
  -- envelope domain prefixed 'unverified:'. The prefix is what stops an
  -- attacker's assertion being laundered into evidence — and it is also what
  -- makes Confirm's job trivial: a plain hostname never matches a row whose
  -- only claim was unverified, so an origin that was never verified cannot be
  -- allowlisted (§3.2:54).
  outer_domain text NOT NULL
    CONSTRAINT quarantine_outer_domain_is_a_hostname CHECK (
      outer_domain = '' OR (
        length(outer_domain) <= 264 AND
        outer_domain ~ '^(unverified:)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
      )
    ),
  -- The bank behind a forwarder. Recorded ONLY when an attestation proved it —
  -- the tempting alternative source is the forwarded body's own From line,
  -- which is attacker-rendered content. Same rule, same reason, as
  -- parse_diagnostics.inner_origin_domain.
  inner_domain text
    CONSTRAINT quarantine_inner_domain_is_a_hostname CHECK (
      inner_domain IS NULL OR (
        length(inner_domain) <= 253 AND
        inner_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
      )
    ),

  attested boolean NOT NULL DEFAULT false,
  -- How the inner origin was proven. Closed enum: origin.Origin.AttestedBy.
  attested_by text NOT NULL DEFAULT ''
    CONSTRAINT quarantine_attested_by_is_closed CHECK (attested_by IN ('', 'direct_dkim', 'arc')),

  dkim text NOT NULL
    CONSTRAINT quarantine_dkim_is_closed CHECK (dkim IN ('pass','fail','none','temperror')),
  arc text NOT NULL
    CONSTRAINT quarantine_arc_is_closed CHECK (arc IN ('pass','fail','none')),

  size_bucket int NOT NULL
    CONSTRAINT quarantine_size_bucket_is_a_bucket
    CHECK (size_bucket IN (1024, 4096, 16384, 65536, 262144, 524288, 1048576)),
  blob bytea NOT NULL
    CONSTRAINT quarantine_blob_fits_its_bucket CHECK (octet_length(blob) <= size_bucket),

  -- A redelivery is the same message, not a second one. SMTP retries are
  -- routine, and without this a sender that retries for three days fills the
  -- user's quarantine lane with copies of one email.
  CONSTRAINT quarantine_one_row_per_message UNIQUE (user_id, ingest_id),

  CONSTRAINT quarantine_ttl_runs_forward CHECK (expires_at > received_at),
  -- Either it was attested and we can say by what, or neither.
  CONSTRAINT quarantine_attestation_names_its_method CHECK ((attested_by <> '') = attested),
  -- An attestation is a cryptographic verification or it is not an attestation.
  CONSTRAINT quarantine_attestation_needs_a_passing_signature CHECK (
    NOT attested OR dkim = 'pass' OR arc = 'pass'
  ),
  -- See the inner_domain comment: without an attestation the only available
  -- source for this value is body text, so that row is made unstorable rather
  -- than merely discouraged.
  CONSTRAINT quarantine_inner_origin_needs_an_attestation CHECK (inner_domain IS NULL OR attested)
);

-- Serves the sync channel's keyset page. The cursor is (received_at, id) rather
-- than received_at alone because a batch of mail that arrives in the same
-- microsecond would otherwise straddle a page boundary and be silently skipped
-- — a drop in the very channel that exists so nothing is dropped.
CREATE INDEX quarantine_user_received_idx ON quarantine (user_id, received_at, id);
-- Serves ExpireDue's candidate scan.
CREATE INDEX quarantine_expiry_idx ON quarantine (expires_at);
-- Serve Confirm's "everything held from this origin" lookups.
CREATE INDEX quarantine_user_outer_idx ON quarantine (user_id, outer_domain);
CREATE INDEX quarantine_user_inner_idx ON quarantine (user_id, inner_domain) WHERE inner_domain IS NOT NULL;

-- The record of everything that has left quarantine, and why.
--
-- Spec §2's drop policy is "nothing is dropped without a user-visible notice",
-- and a TTL that merely deletes rows breaks it. Two things enforce it here: the
-- advance warning (quarantine.warned_at, surfaced by the sync channel before
-- anything is removed), and this table, which outlives the message and is
-- served to the client on the same channel. A user can always ask "what
-- happened to the mail I never got to?" and be answered.
--
-- It holds NO content: an ingest id (a one-way digest of the body, the same one
-- the diagnostics ledger already stores), timestamps, hostnames, a bucket. The
-- grammars are the ones parse_diagnostics uses, for the same reason.
CREATE TABLE quarantine_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The quarantine row this record accounts for. Not a foreign key: the row it
  -- names is gone by design. It is UNIQUE so one record can only ever license
  -- one removal — a stale record from an earlier promotion must not authorize
  -- deleting a message that was later held again.
  quarantine_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ingest_id bytea NOT NULL
    CONSTRAINT quarantine_removals_ingest_id_is_256_bits CHECK (octet_length(ingest_id) = 32),

  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  warned_at timestamptz,
  removed_at timestamptz NOT NULL,

  reason text NOT NULL
    CONSTRAINT quarantine_removals_reason_is_closed CHECK (reason IN ('expired','promoted')),

  outer_domain text NOT NULL,
  inner_domain text,
  attested boolean NOT NULL,
  size_bucket int NOT NULL,

  -- The drop policy, as a constraint. An expiry record with no warning instant
  -- is a message that was deleted without the notice §2 promises, and it cannot
  -- be written down — so it cannot happen, because the trigger below refuses
  -- any removal that is not written down first.
  CONSTRAINT quarantine_removals_expiry_was_warned CHECK (reason <> 'expired' OR warned_at IS NOT NULL)
);

CREATE INDEX quarantine_removals_user_removed_idx ON quarantine_removals (user_id, removed_at, id);

-- +goose StatementEnd

-- +goose StatementBegin
--
-- Nothing leaves quarantine without a trace.
--
-- quarantine.Store writes the removal record and deletes the row in one
-- transaction, so this trigger never fires in anger on the normal path. It is
-- the backstop for everything that is not quarantine.Store: a repair script, a
-- psql session, a future caller, a bug. A guarantee that holds only when
-- callers are well behaved is not a guarantee, and this particular one is a
-- published promise (spec §2) rather than an implementation detail.
--
-- The one legitimate removal with no per-message notice is account deletion
-- (§3.10): the user asked for the whole account to go, this table's own rows
-- included, and a per-message record of a purge would be a record that
-- outlived the purge. It is detected by the parent row already being gone —
-- Postgres runs ON DELETE CASCADE as an after-trigger on the parent statement,
-- so by the time this fires for a cascaded delete the users row is no longer
-- visible to the transaction.
--
-- TRUNCATE bypasses row triggers and is not covered. Nothing in this tree
-- truncates; an operator who does is outside every guarantee here.
CREATE FUNCTION quarantine_refuse_untraced_removal() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM quarantine_removals r WHERE r.quarantine_id = OLD.id) THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'quarantine row % cannot be removed: no quarantine_removals record accounts for it (spec section 2 drop policy)',
    OLD.id;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER quarantine_no_untraced_removal
  BEFORE DELETE ON quarantine
  FOR EACH ROW EXECUTE FUNCTION quarantine_refuse_untraced_removal();
-- +goose StatementEnd

-- +goose StatementBegin

-- The origins a user has vouched for.
--
-- Keyed by USER, not by address, and that is load bearing. Spec §3.2:46
-- promises that during a rotation's 7-day grace, mail arriving on the retired
-- address keeps the trusted status its origins earned. inbound_addresses
-- records only ONE hop of the rotation chain, so a user who rotates twice
-- inside a week has two live grace windows and a trust lane that walked that
-- link would find only the newest — silently demoting the oldest address's
-- senders back to quarantine. Keying trust to the account removes the walk
-- entirely: there is no chain to get wrong.
--
-- `scope` says WHICH domain was vouched for: the outer signing domain of the
-- message as we received it, or the inner origin behind a forwarder.
CREATE TABLE sender_allowlist (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- A plain, verified hostname. The 'unverified:' marker deliberately does not
  -- match this grammar: an origin nothing signed can never be allowlisted.
  domain text NOT NULL
    CONSTRAINT sender_allowlist_domain_is_a_hostname CHECK (
      length(domain) <= 253 AND
      domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    ),
  scope text NOT NULL
    CONSTRAINT sender_allowlist_scope_is_closed CHECK (scope IN ('outer','inner')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, domain, scope),

  -- §3.2:51, as a constraint. Allowlisting a mail provider as an OUTER origin
  -- trusts everything that has ever passed through the user's mailbox — one
  -- click that converts the whole design's trusted lane into "anything my inbox
  -- can see". The user's route to trusting their bank behind that provider is
  -- the INNER scope, which requires an attestation, so the same domain is
  -- perfectly legal here as an inner origin.
  --
  -- quarantine.Forwarders() is the source of this list;
  -- TestTheSQLForwarderListMatchesGo keeps them from drifting.
  CONSTRAINT sender_allowlist_no_forwarder_as_outer CHECK (
    scope <> 'outer' OR domain NOT IN (
      'gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com',
      'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com',
      'proton.me', 'protonmail.com', 'zoho.com', 'fastmail.com'
    )
  )
);

-- +goose StatementEnd

-- +goose Down
DROP TABLE sender_allowlist;
DROP TRIGGER IF EXISTS quarantine_no_untraced_removal ON quarantine;
DROP FUNCTION IF EXISTS quarantine_refuse_untraced_removal();
DROP TABLE quarantine_removals;
DROP TABLE quarantine;
