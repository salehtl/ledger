-- +goose Up

-- Passkeys: WebAuthn as a THIRD identity provider behind the existing
-- auth.Verifier / Identity / SubjectHash seam (Task 4).
--
-- # Why a third provider and not a replacement
--
-- v2's auth was built for Sign in with Apple and Google Sign-In because the
-- Expo client had to satisfy App Store rule 4.8. The product dropped Expo for a
-- PWA, that rule went with it, and the decision was taken to drop third-party
-- IdPs entirely in favour of passkeys. Nothing about sessions, invite
-- redemption, writer enrolment or the key-history log changes: a passkey
-- ceremony produces an auth.Identity like any other and everything downstream
-- of that is untouched.
--
-- # The identity a passkey names
--
-- `Identity{IdP: "passkey", Subject: base64url(user_handle)}`, where user_handle
-- is 32 bytes from crypto/rand minted once at registration. It is the WebAuthn
-- user handle, so a DISCOVERABLE credential returns it inside the assertion —
-- which is the whole reason username-less sign-in is possible at all: the server
-- learns who is signing in from the authenticator's own response rather than
-- from anything the page typed.
--
-- users.idp_sub_hash is therefore SHA-256("v2|passkey|" + base64url(handle)).
-- SubjectHash's "|" separator is not injective for arbitrary inputs and is safe
-- only because `idp` is a closed vocabulary containing no "|" — enforced by
-- auth.validIdP and by the CHECK below. "passkey" contains no "|", and
-- base64url output cannot contain one either, so widening the vocabulary by this
-- one value keeps the encoding unambiguous. Do not add a value containing "|"
-- without length-prefixing the digest input.

ALTER TABLE users DROP CONSTRAINT users_idp_check;
ALTER TABLE users ADD CONSTRAINT users_idp_check
  CHECK (idp IN ('apple','google','passkey'));

-- One row per enrolled authenticator. A user may hold several (a phone, a
-- laptop, a security key), which is what the add-a-passkey ceremony is for.
CREATE TABLE webauthn_credentials (
  -- The credential id the authenticator minted. It is the lookup key on the
  -- login path: a discoverable assertion carries it as rawId, and it is what
  -- turns "somebody asserted something" into "this account".
  credential_id bytea PRIMARY KEY,

  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The WebAuthn user handle this credential was minted against: the 32 random
  -- bytes whose base64url form IS the account's IdP subject.
  --
  -- It is stored per CREDENTIAL rather than per user because that is what the
  -- ceremony needs on both sides — a registration's `user.id`, and the value the
  -- library compares an assertion's userHandle against — and because there is
  -- nowhere on `users` it could live: users stores the HASH of the subject, and
  -- a hash cannot be turned back into a handle to put in a challenge. Every
  -- credential belonging to one account carries the same handle; the add
  -- ceremony copies it from a row that already exists rather than minting a
  -- second one, because two handles would be two subjects and therefore two
  -- accounts.
  user_handle bytea NOT NULL
    CONSTRAINT webauthn_credentials_handle_is_256_bits CHECK (octet_length(user_handle) = 32),

  -- The COSE-encoded public key. Not a secret; it is the thing signatures are
  -- checked against, and a database copy that leaks it leaks nothing usable.
  public_key bytea NOT NULL,

  -- The authenticator's signature counter, as last seen. A counter that does not
  -- INCREASE is the spec's evidence of a cloned authenticator; see
  -- auth.Passkeys.FinishLogin, which refuses the assertion rather than merely
  -- recording a warning. Many platform authenticators (iCloud Keychain among
  -- them) report a permanent zero, which is why "stayed at zero" is explicitly
  -- not the same fact as "went backwards".
  sign_count bigint NOT NULL DEFAULT 0,

  -- Model identifier and transport hints. Diagnostics only: nothing branches on
  -- them, and they are here so an operator can tell a security key from a phone
  -- when a user asks which device is which.
  aaguid     bytea,
  transports text,

  -- Whether the credential is eligible for, and currently in, an authenticator
  -- backup (i.e. synced to iCloud/Google Password Manager). Recorded because it
  -- changes what losing one device means: a device-bound credential is the only
  -- copy, and an account holding nothing else is one lost phone from being
  -- unrecoverable.
  backup_eligible boolean NOT NULL,
  backup_state    boolean NOT NULL,

  created_at   timestamptz NOT NULL,
  last_used_at timestamptz
);

CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials (user_id);

-- Server-side ceremony state, held between begin and finish.
--
-- go-webauthn's SessionData holds the CHALLENGE. That makes it server-side state
-- and never a client cookie: a challenge the caller can choose is a challenge
-- the caller can replay, and the whole point of the challenge is that it was
-- minted here, before the assertion existed, and is spendable exactly once.
--
-- Rows are DELETED by the finish that consumes them (single use) and swept on
-- expiry. There is deliberately no "used" column: a row that still exists is a
-- ceremony that has not been spent, so a replay of a ceremony id finds nothing
-- and cannot be told apart from a ceremony that never existed.
CREATE TABLE webauthn_ceremonies (
  -- 32 bytes from crypto/rand, base64url. Text rather than bytea because it
  -- travels to the client and back in JSON as an opaque handle.
  id text PRIMARY KEY,

  kind text NOT NULL CHECK (kind IN ('register','login','add')),

  -- The account an 'add' ceremony belongs to. NULL for the other two, which
  -- name no account: a 'register' ceremony's account does not exist yet, and a
  -- 'login' ceremony deliberately does not know who is signing in.
  --
  -- It is here for the purge (spec §3.10): internal/v2/purge refuses to delete
  -- an account while ANY relation is unclassified, and "a table holding a live
  -- user handle for five minutes" is not a table that may survive a deletion
  -- unexamined. The cascade is what makes it die with the account; the NULL rows
  -- attribute to nobody and correctly survive.
  --
  -- It does not replace the ownership check in auth.Passkeys.FinishAdd — that
  -- one compares the ceremony's HANDLE against the session's account through
  -- SubjectHash, which is derived independently of this column, so the two
  -- agreeing is a real check rather than a restatement.
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,

  -- The user handle this ceremony is bound to: freshly minted for 'register',
  -- copied from the account's existing credentials for 'add', and NULL for
  -- 'login' — a discoverable login does not know who is signing in until the
  -- authenticator says so, which is the point of it.
  user_handle bytea,

  -- go-webauthn's SessionData, verbatim. JSONB rather than a set of columns
  -- because the library owns this shape and a hand-copied subset that silently
  -- lost a field would present as "verification fails for no reason".
  session_data jsonb NOT NULL,

  -- The invite code this registration intends to spend, hashed on the same
  -- terms as invite_codes.code_hash (auth.inviteCodeHash). The code itself is
  -- never written here — a ceremony row is short-lived, but "short-lived" is not
  -- a reason to hold a live credential in the clear.
  --
  -- It is REDEEMED at finish, in the transaction that creates the account, so a
  -- ceremony that is abandoned or fails verification spends nothing. NULL for
  -- 'login' and 'add', which create no account and therefore owe no code.
  invite_code_hash bytea,

  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX webauthn_ceremonies_expiry_idx ON webauthn_ceremonies (expires_at);

-- DEPLOYMENT: the two-role split (see 00003_writers.sql's header for the full
-- recipe). ledger_migrate owns the schema; ledger_runtime gets DML only. A
-- deployment that ran the documented ALTER DEFAULT PRIVILEGES steps already
-- covers these tables, and this block is then a no-op — but the failure mode of
-- having missed them is "permission denied for table webauthn_ceremonies" in
-- PRODUCTION ONLY, on the sign-in path, discovered by the first user, so it is
-- granted explicitly here as well.
--
-- Conditional on the role existing: pgtest clusters and single-role
-- deployments have no ledger_runtime, and an unconditional GRANT would fail the
-- migration for every one of them. No sequence grant is needed — neither table
-- has a serial column — which is the one line of 00003's recipe that does not
-- apply here.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON webauthn_credentials TO ledger_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON webauthn_ceremonies  TO ledger_runtime';
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE webauthn_ceremonies;
DROP TABLE webauthn_credentials;
ALTER TABLE users DROP CONSTRAINT users_idp_check;
ALTER TABLE users ADD CONSTRAINT users_idp_check CHECK (idp IN ('apple','google'));
