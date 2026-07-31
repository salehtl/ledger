-- +goose Up
-- gen_random_uuid() has been built into core since PG13, so pgcrypto is not
-- actually required for it on the PG16 this project targets (test and prod
-- alike). Kept anyway on the chance a later migration wants pgcrypto's other
-- functions (digest(), crypt(), ...); harmless either way.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idp          text NOT NULL CHECK (idp IN ('apple','google')),
  idp_sub_hash bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idp, idp_sub_hash)
);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- +goose Down
DROP TABLE sessions;
DROP TABLE users;
