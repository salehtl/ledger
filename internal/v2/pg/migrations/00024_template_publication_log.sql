-- +goose Up
CREATE TABLE template_publication_log (
  seq bigserial PRIMARY KEY,
  template_id text NOT NULL,
  template_version int,
  action text NOT NULL CHECK (action IN ('published','removed')),
  created_at timestamptz NOT NULL,
  CHECK ((action = 'published') = (template_version IS NOT NULL))
);
CREATE INDEX template_publication_log_since ON template_publication_log (seq);

-- Seed the delta channel with what had already shipped before this migration.
INSERT INTO template_publication_log (template_id, template_version, action, created_at)
SELECT id, version, 'published', COALESCE(published_at, now())
FROM templates WHERE status = 'published' ORDER BY id;

-- +goose Down
DROP TABLE template_publication_log;
