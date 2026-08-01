-- +goose Up

-- Every user's mail slot: `u-<token>@in.<domain>` (spec §3.2:46). The token is
-- 16 bytes from crypto/rand rendered as 26 lower-case RFC 4648 base32
-- characters, so guessing one is a 2^128 search — which is the ONLY thing
-- standing between an attacker and injecting bank-shaped mail into a stranger's
-- ledger. Task 24's receiver additionally refuses unknown recipients at RCPT
-- with per-IP rate limiting and a tarpit, so the space cannot be swept online.
--
-- Rows are never deleted except with the user. A rotated address is retained
-- with an expiry rather than removed, because "this address was retired on the
-- 4th and stops accepting on the 11th" and "this address never existed" are
-- different facts: the first is a grace window the user was promised, the
-- second is a rejection.
--
-- # The three lifecycle states, and how to read them
--
--   active   expires_at IS NULL      — the address the app shows and the user
--                                      registers with their bank.
--   grace    expires_at > now()      — rotated away from, still accepting.
--   lapsed   expires_at <= now()     — rejected at RCPT like any stranger.
--
-- Expiry is compared in Go against the injected clock (addresses.Addresses.Now)
-- and never against the database's now(), so one clock decides both when a
-- window opens and when it closes — the same rule auth.Writers applies to
-- challenge expiry, and what makes the boundary testable at all.
CREATE TABLE inbound_addresses (
  local_part   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL,

  -- NULL means active. Set to (rotated_at + grace) by a rotation.
  expires_at   timestamptz,
  -- The cutover instant: when this address stopped being the active one. Kept
  -- separately from expires_at because the grace window's LENGTH is a policy
  -- that may change, and "when did this user rotate" must stay answerable
  -- without knowing which policy was in force at the time.
  rotated_at   timestamptz,

  -- The address this one replaced, i.e. the predecessor still inside its grace
  -- window. Spec §3.2:46 promises that during the grace, mail from origins
  -- allowlisted on the OLD address retains trusted status — so the trust lane
  -- (a later task) has to be able to get from the address a message arrived on
  -- to the allowlist that was built up against its predecessor. That linkage
  -- cannot be reconstructed after the fact from timestamps alone once a user
  -- has rotated more than once, so it is recorded at the cutover.
  rotated_from text REFERENCES inbound_addresses(local_part) ON DELETE SET NULL,

  -- The local part is matched against an attacker-controlled RCPT TO. Pinning
  -- its exact shape here means a row this system could never have issued is
  -- also a row it can never store — including one written by a repair script.
  CONSTRAINT inbound_addresses_local_part_shape
    CHECK (local_part ~ '^u-[a-z2-7]{26}$'),
  -- A retired address has both a cutover and a deadline, or it is active and
  -- has neither. The half-set states are all incoherent: an expires_at with no
  -- rotated_at is a window with no beginning, and a rotated_at with no
  -- expires_at is an address that was retired and still accepts forever.
  CONSTRAINT inbound_addresses_grace_is_paired
    CHECK ((expires_at IS NULL) = (rotated_at IS NULL)),
  CONSTRAINT inbound_addresses_grace_runs_forward
    CHECK (expires_at IS NULL OR expires_at > rotated_at),
  CONSTRAINT inbound_addresses_not_self_rotated
    CHECK (rotated_from IS NULL OR rotated_from <> local_part)
);

-- At most one active address per user. This is the invariant that makes "the
-- user's address" a well-defined thing to display, to rotate away from, and to
-- register with a bank; without it a race between two devices opening the app
-- on a fresh account leaves the user with two live slots and no way to know
-- which one the UI will show next.
CREATE UNIQUE INDEX inbound_addresses_one_active
  ON inbound_addresses (user_id) WHERE expires_at IS NULL;

-- Each address is superseded at most once, so the rotation history is a chain
-- rather than a tree. A fork would make "which address is my predecessor"
-- ambiguous for the trust lane above.
CREATE UNIQUE INDEX inbound_addresses_rotated_from_uniq
  ON inbound_addresses (rotated_from) WHERE rotated_from IS NOT NULL;

CREATE INDEX inbound_addresses_user_idx ON inbound_addresses (user_id);

-- Rotation challenges, deliberately a DIFFERENT table from writer_challenges.
--
-- Spec §3.4 puts address rotation in the same class as writer registration and
-- account deletion: a session token alone must not authorize it. The proof of
-- key possession is an Ed25519 signature by an enrolled, live device key over
-- a nonce from this table (see addresses.RotationMessage, which carries its own
-- domain-separation prefix).
--
-- Sharing writer_challenges would have been less code and a real weakening: a
-- nonce minted by the freely available POST /api/v1/writers/challenge could
-- then be spent as half of a rotation authorization. Two stores means a nonce
-- is only ever valid for the capability it was minted for, on top of the
-- domain separation in the signed bytes.
CREATE TABLE address_rotation_challenges (
  nonce      bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at  timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  CONSTRAINT address_rotation_challenges_nonce_is_256_bits
    CHECK (octet_length(nonce) = 32)
);
-- Serves the opportunistic sweep in addresses.RotationChallenge.
CREATE INDEX address_rotation_challenges_expiry_idx
  ON address_rotation_challenges (expires_at);

-- +goose Down
DROP TABLE address_rotation_challenges;
DROP TABLE inbound_addresses;
