-- +goose Up

-- The versioned template store (spec §3.5): the bank parsers, as DATA.
--
-- A template is authored once in an admin console, validated at publish time
-- against the regex dialect (internal/v2/tmpl/dialect.go), stored here, and
-- then executed by TWO independent engines — the Go executor at ingest and the
-- TypeScript executor on the user's device. That is the whole reason this table
-- exists rather than the parsers staying as Go code: a parser fix has to reach
-- every device without shipping a binary.
--
-- # Rows are never updated in place, and never deleted
--
-- Every stored transaction records the (template_id, template_version) that
-- produced it. Rewriting a published definition, or dropping an old one, makes
-- that reference point at something other than what actually ran — the parse
-- becomes unreproducible and the diagnostics ledger starts describing a
-- template nobody can read. So a fix is a NEW VERSION: the previous row is
-- retired, not modified.
--
-- # The four statuses
--
--   draft      authored, never live
--   testing    a candidate being replayed against donated samples
--   published  THE live version — at most one per id, enforced below
--   retired    was live, superseded by a later version
--
-- 'retired' is not in the plan's three-status sketch, and it is here because
-- supersession has to be expressible. With only draft/testing/published, a
-- cutover would have to demote the outgoing version to 'testing' — putting a
-- retired parser back into the candidate pool, where the next operator to look
-- would find it indistinguishable from a template awaiting evaluation. That is
-- how an old, broken parser gets re-published.
CREATE TABLE templates (
  id                 text NOT NULL,
  version            int  NOT NULL,
  bank               text NOT NULL,
  normalizer_version int  NOT NULL,

  -- The canonical (sorted-key, total) encoding of the definition. jsonb rather
  -- than text because operators query it — "which templates anchor on this
  -- string" is a real question during an intake triage — and the executor
  -- re-derives the canonical bytes on read, so jsonb's key reordering costs
  -- nothing.
  definition jsonb NOT NULL,

  status text NOT NULL
    CONSTRAINT templates_status_is_closed
    CHECK (status IN ('draft','testing','published','retired')),

  created_at   timestamptz NOT NULL,
  published_at timestamptz,

  PRIMARY KEY (id, version),

  -- The id grammar tmpl.ValidateDefinition enforces, repeated here so a row
  -- this system could never have published is also a row it can never store —
  -- including one written by a repair script.
  CONSTRAINT templates_id_shape CHECK (id ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'),
  CONSTRAINT templates_version_is_positive CHECK (version >= 1),
  CONSTRAINT templates_normalizer_version_is_positive CHECK (normalizer_version >= 1),

  -- published_at is the instant this VERSION first went live, and it is kept
  -- after retirement because "when did this parser run" stays answerable only
  -- if it is. The three implications below are the coherent states: a live row
  -- has a publication instant, a draft has never had one, and a retired row
  -- must have had one to be retired from.
  CONSTRAINT templates_published_row_has_an_instant
    CHECK (status <> 'published' OR published_at IS NOT NULL),
  CONSTRAINT templates_draft_was_never_published
    CHECK (status <> 'draft' OR published_at IS NULL),
  CONSTRAINT templates_retired_row_was_published
    CHECK (status <> 'retired' OR published_at IS NOT NULL),
  CONSTRAINT templates_publication_follows_creation
    CHECK (published_at IS NULL OR published_at >= created_at),

  -- The columns and the definition are two views of one template, and every
  -- consumer reads a different one: the executor reads the definition, the
  -- admin console and every operator query read the columns. A row where they
  -- disagree is a template that is one thing to the machine and another to the
  -- person looking at it.
  --
  -- Written as ->> plus COALESCE rather than a cast so a missing or non-numeric
  -- key FAILS the check instead of yielding NULL (which a CHECK passes) or
  -- raising a cast error, and so every operand stays immutable, which a CHECK
  -- constraint requires.
  CONSTRAINT templates_definition_agrees_with_columns CHECK (
        COALESCE(definition->>'id', '')                 = id
    AND COALESCE(definition->>'version', '')            = version::text
    AND COALESCE(definition->>'bank', '')               = bank
    AND COALESCE(definition->>'normalizer_version', '') = normalizer_version::text
  )
);

-- At most one live version per template. This is the invariant that makes "the
-- DIB card parser" a well-defined thing for the ingest pipeline to load: with
-- two published rows, which one runs would depend on row order, and two
-- devices could disagree about how the same message parses.
CREATE UNIQUE INDEX templates_one_published ON templates (id) WHERE status = 'published';

-- Serves the ingest pipeline's one query: every published template, at start-up
-- and after a publish.
CREATE INDEX templates_published_idx ON templates (status) WHERE status = 'published';

-- +goose Down
DROP TABLE templates;
