-- +goose Up

-- Web Push (VAPID) subscriptions for the PWA.
--
-- # Why this is not push_tokens
--
-- 00010/00019 store EXPO device tokens: one opaque string per install, sent to
-- exp.host, for the native client that was abandoned. A Web Push subscription
-- is a different object with a different shape and a different trust model — an
-- endpoint URL chosen by the browser's own push service, plus the two key
-- halves (p256dh, auth) that the payload is ENCRYPTED to before it leaves this
-- box. Squeezing it into push_tokens.token would mean a column whose meaning
-- depends on which client wrote it, and two senders sharing a CHECK constraint
-- that can only be the union of both grammars.
--
-- The tables are siblings, not replacements. Nothing here retires push_tokens
-- (see "Sunset, don't delete"); a deployment can have both, neither, or one.
--
-- # The payload is content-free, and that is decided elsewhere
--
-- Nothing in this table constrains what is sent. The rule — the notification
-- says that something arrived and NOTHING about what — lives in
-- internal/v2/pushv2/webpush.go and is pinned field-for-field by
-- TestTheWebPushPayloadIsContentFree. It is restated here only so that a person
-- reading the schema first does not conclude that "we encrypt the payload to
-- p256dh/auth" makes the content question moot. It does not:
--
--   * The push service still learns that a notification happened, when, and to
--     which endpoint. Timing is a spending signal on its own (00010 says the
--     same about Expo, and it is no less true here).
--   * Phase 3 seals transaction data so this server holds ciphertext. Composing
--     "AED 240 at Spinneys" server-side means DECRYPTING user data here to
--     build a string — re-establishing exactly the plaintext path Phase 3
--     exists to remove. Encrypting that string afterwards does not undo having
--     had it.
--
-- # Keying: (user_id, endpoint), mirroring 00010's anti-hijack argument
--
-- endpoint alone would be the tidier natural key and it would introduce the
-- same hijack 00010 refused: an endpoint string observed elsewhere, re-posted
-- by another account, would have to REPLACE its owner's row (an upsert replaces
-- something) and would silently end that account's notifications. A push
-- endpoint is a URL that appears in logs, proxies and crash reports; it is not
-- a secret and must not be treated as one. Composite key: two accounts naming
-- one endpoint are two independent rows, and deleting one leaves the other.
--
-- Unlike 00010, that costs nothing awkward here — a browser profile that signs
-- into two accounts genuinely does hold two subscriptions, because it
-- re-subscribes per account and each row carries its own writer and session.
--
-- # writer_id and session_hash: the link 00019 had to add later
--
-- 00010 shipped without them and the consequence was concrete: a phone that was
-- revoked, signed out or handed on kept receiving a live feed of when its
-- former owner spent money, with no way for the user OR the operator to stop
-- it. That hole is not being re-dug. Both columns are NOT NULL from the first
-- migration, both are foreign keys, and auth.forgetPushSubscriptions sweeps
-- this table in the SAME transaction as the key revocation and the sign-out —
-- so "this device can no longer write" and "this device is no longer told" are
-- one fact, not two an operator has to remember to keep in step.
CREATE TABLE push_subscriptions (
  -- The delete handle. A user removing a browser they are not holding has only
  -- this; a client that knows its own endpoint deletes by that instead. Same
  -- shape as push_tokens.id (00019), and for the same reason: the listing
  -- cannot hand back whole endpoints.
  id uuid NOT NULL DEFAULT gen_random_uuid(),

  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The push service's URL for this subscription. Bounded and restricted to
  -- printable non-space ASCII: this string is used to build an outbound HTTP
  -- request, so an unbounded text column with a newline in it is somebody
  -- else's request-splitting surface. The https:// prefix is required — every
  -- push service uses it, and a http:// endpoint would send the VAPID
  -- Authorization header in clear.
  --
  -- The length lives in its own conjunct rather than as a {1,2048} repetition:
  -- Postgres caps a regex repetition count at 255, so {1,2048} is not a looser
  -- check, it is a SYNTAX ERROR that fails the migration (00010 learned this).
  endpoint text NOT NULL
    CONSTRAINT push_subscriptions_endpoint_is_bounded_https
    CHECK (length(endpoint) BETWEEN 1 AND 2048
           AND endpoint ~ '^https://[\x21-\x7e]+$'),

  -- The subscription's P-256 public key and auth secret, base64url as the
  -- browser produced them. Stored as text and handed back to the webpush
  -- library verbatim: this server does not parse them, and a decode here would
  -- be a second place for the encoding to be wrong.
  --
  -- The lengths are the uncompressed-point and 16-byte-secret sizes with slack
  -- for padding variants, checked so that a malformed subscription is refused
  -- at the edge rather than becoming a send that fails forever.
  p256dh text NOT NULL
    CONSTRAINT push_subscriptions_p256dh_is_base64url
    CHECK (length(p256dh) BETWEEN 64 AND 256 AND p256dh ~ '^[A-Za-z0-9_=-]+$'),
  auth text NOT NULL
    CONSTRAINT push_subscriptions_auth_is_base64url
    CHECK (length(auth) BETWEEN 16 AND 64 AND auth ~ '^[A-Za-z0-9_=-]+$'),

  -- The device this subscription belongs to. Composite FK against writers' own
  -- primary key: a writer_id is only unique WITHIN a user, so referencing
  -- writer_id alone would be a different — and wrong — statement about who owns
  -- the browser.
  writer_id text NOT NULL,

  -- The sign-in that created it. Signing out is a different disowning gesture
  -- from revoking a device key, and both must stop the notifications.
  session_hash bytea NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, endpoint),
  CONSTRAINT push_subscriptions_id_uniq UNIQUE (id),
  CONSTRAINT push_subscriptions_writer_fk
    FOREIGN KEY (user_id, writer_id) REFERENCES writers (user_id, writer_id)
    ON DELETE CASCADE,
  CONSTRAINT push_subscriptions_session_fk
    FOREIGN KEY (session_hash) REFERENCES sessions (token_hash)
    ON DELETE CASCADE
);

-- Revocation sweeps. Both are a DELETE ... WHERE on the hot path of a security
-- action, so neither may be a sequential scan of every user's devices.
CREATE INDEX push_subscriptions_writer_idx ON push_subscriptions (user_id, writer_id);
CREATE INDEX push_subscriptions_session_idx ON push_subscriptions (session_hash);

-- The fan-out order, DESCENDING, and it is a correctness property rather than a
-- performance one — see 00019's note on the same index. pushv2 caps one Notify
-- at MaxDevicesPerUser; ascending order would keep the OLDEST registrations, so
-- the browser the user is actually holding is the one silently excluded. The
-- API enforces the identical cap with the identical expression at INSERT, so
-- the two cannot disagree about which rows survive.
CREATE INDEX push_subscriptions_fanout_idx
  ON push_subscriptions (user_id, created_at DESC, endpoint DESC);

-- DEPLOYMENT: the two-role split (00003_writers.sql's header has the full
-- recipe). ledger_migrate owns the schema; ledger_runtime gets DML only. A
-- deployment that ran the documented ALTER DEFAULT PRIVILEGES steps is already
-- covered and this block is a no-op — but the failure mode of having missed
-- them is "permission denied for table push_subscriptions" in PRODUCTION ONLY,
-- on the first subscribe, discovered by a user, so it is granted explicitly
-- here as well.
--
-- Conditional on the role existing: pgtest clusters and single-role deployments
-- have no ledger_runtime and an unconditional GRANT would fail the migration
-- for every one of them.
--
-- No sequence grant is needed and that is checked, not assumed: every default
-- on this table is a function call (gen_random_uuid(), now()), there is no
-- serial or identity column, so no INSERT here calls nextval(). That is the one
-- line of 00003's recipe that does not apply — the line whose absence made
-- every registration fail with "permission denied for sequence" the first time.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO ledger_runtime';
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE push_subscriptions;
