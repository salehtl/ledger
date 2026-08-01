-- +goose Up

-- One counter row per user. It is NOT a Postgres sequence on purpose: the
-- appending transaction UPDATEs this row, which locks it until commit, so
-- commit order is identical to seq order and a committed seq N implies every
-- seq below N is committed. A rolled-back append restores the counter and
-- leaves no hole, where nextval() would burn the value permanently and a
-- watermark would then have to reconstruct what happened. See
-- oplog.Appender.Append for the full argument; do not "optimize" this into a
-- sequence.
--
-- Pre-created with the user (oplog.EnsureSeqRow, called inside
-- auth.UpsertUser's transaction), so Append's INSERT ... ON CONFLICT DO
-- NOTHING is belt-and-braces rather than a live race in steady state.
CREATE TABLE oplog_seq (
  user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  next_seq bigint NOT NULL DEFAULT 1
);

CREATE TABLE op_log (
  user_id        uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq            bigint NOT NULL,
  stream         text   NOT NULL CHECK (stream IN ('hot','cold')),
  writer_id      text   NOT NULL,
  writer_counter bigint NOT NULL,
  -- Deliberately coarse: spec §2 discloses only that SOMETHING was
  -- ingested/edited, not what. The op type lives inside the (Phase 3:
  -- encrypted) blob and must never be lifted into this column.
  type_flag      text   NOT NULL CHECK (type_flag IN ('ingest','edit')),
  blob           bytea  NOT NULL,
  size_bucket    int    NOT NULL,
  blob_hash      bytea  NOT NULL,
  prev_hash      bytea  NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The backstop for gap-freeness: if the counter row were ever reset or
  -- tampered with, a re-used seq collides here and the append fails loudly
  -- instead of silently overwriting history.
  PRIMARY KEY (user_id, seq),
  -- Chains are per (writer_id, stream) — Decision 13. The uniqueness key must
  -- include the stream or two independent chains would collide on counter 1.
  UNIQUE (user_id, writer_id, stream, writer_counter),
  -- oplog.Row.validate rejects all three of these before an append opens a
  -- transaction. They are restated here because a hand-written INSERT, a repair
  -- script or a future task's own SQL is exactly the caller that bypasses that
  -- validation — and a row failing either invariant can be STORED and then
  -- never opened: blob.Open refuses bytes whose length is not a size bucket,
  -- and a chain hash that is not 32 bytes cannot be a SHA-256.
  --
  -- Named rather than left to Postgres's op_log_check/op_log_check1 numbering,
  -- so a violation names the invariant it broke and a test can assert on it.
  CONSTRAINT op_log_blob_fills_bucket CHECK (octet_length(blob) = size_bucket),
  CONSTRAINT op_log_hashes_are_sha256 CHECK (
    octet_length(blob_hash) = 32 AND octet_length(prev_hash) = 32)
);
CREATE INDEX op_log_stream_idx ON op_log (user_id, stream, seq);

-- +goose Down
DROP TABLE op_log;
DROP TABLE oplog_seq;
