-- +goose Up

-- The device tokens a content-free push is delivered to (Task 29).
--
-- # What a row here is, and what it is not
--
-- It is an Expo push token: an opaque per-INSTALL identifier the client hands
-- us so the server can say "something arrived" without the client being open.
-- It is not an identity, it carries no content, and the message sent to it is
-- pinned by pushv2 to exactly {"to", "title", "body"} with an empty body. The
-- privacy argument is entirely in that payload, not here — a notification is
-- rendered on a lock screen and travels through Apple's and Google's
-- infrastructure, neither of which is covered by any encryption this design
-- promises.
--
-- # Why the key is (user_id, token) and not token alone
--
-- A globally unique token would be the tidier schema, and it would introduce a
-- hijack: registering a token you observed elsewhere would DELETE its owner's
-- row (an upsert must replace something) and redirect that account's
-- notifications to your device. Nothing about "somebody's transactions are
-- arriving" is content, but silently ending another account's notifications is
-- a denial of service anyone could perform with a token string.
--
-- The composite key costs the opposite case instead: a phone handed on to
-- another person can hold two users' rows and receive both users' "New
-- transaction" pings until the first user's client deletes its own row. That is
-- noise, it is content-free, and it is recoverable by the user who still has
-- the device. A hijack is neither.
CREATE TABLE push_tokens (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Bounded and printable-ASCII only. An Expo token is
  -- 'ExponentPushToken[...]' or a bare APNs/FCM token, and the grammar is left
  -- deliberately wide (Expo has changed the shape before) while still refusing
  -- anything with whitespace, a control character or a line break in it: this
  -- string is interpolated into a JSON body we send to a third party, so an
  -- unbounded text column here is somebody else's injection surface.
  --
  -- The length lives in its own conjunct rather than in a {1,512} repetition:
  -- Postgres caps a regex repetition count at 255, and a bound expressed as
  -- {1,512} is not a looser check, it is a SYNTAX ERROR that fails the
  -- migration.
  token text NOT NULL
    CONSTRAINT push_tokens_token_is_bounded_printable
    CHECK (length(token) BETWEEN 1 AND 512 AND token ~ '^[\x21-\x7e]+$'),

  -- Closed enum, mirrored by pushv2.Platforms. It exists so an operator can
  -- tell an APNs problem from an FCM one; nothing branches on it.
  platform text NOT NULL
    CONSTRAINT push_tokens_platform_is_closed CHECK (platform IN ('ios','android')),

  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, token)
);

-- +goose Down
DROP TABLE push_tokens;
