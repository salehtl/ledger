-- +goose Up

-- The per-user SMTP allowance, made to survive a restart.
--
-- Today internal/v2/smtpd.Limiter is entirely in memory and says so: "it is
-- IN-MEMORY and bounded, and a restart resets it." That was defensible while
-- the allowance was only a nuisance control. It is not defensible once the
-- allowance is one of the walls holding a per-account budget up, because a
-- restart — a deploy, a crash, an OOM — hands every account a fresh day's worth
-- of mail, and an attacker who can provoke restarts can reset their own quota.
--
-- # What is persisted, and why it is FAITHFUL rather than an approximation
--
-- The obvious worry is that this counter is not a calendar day. It is a
-- decaying rolling window: `counter` holds the current bucket's count, the
-- previous bucket's count, and the instant the current bucket started, and the
-- reported value is cur + prev * (1 - elapsed/window). A "messages sent today"
-- integer could not reproduce that.
--
-- But the counter's ENTIRE state is those three scalars, and both roll() and
-- weighted() are pure functions of (start, cur, prev, now, window). So storing
-- the three scalars restores the estimate exactly — not a summary of it, the
-- state itself. A row read back after any gap produces precisely the number the
-- process would have produced had it never stopped, including the two boundary
-- cases roll() handles: one window of silence shifts cur into prev, and more
-- than two windows of silence ages everything out to zero. Nothing has to be
-- approximated, and nothing is stored that the limiter cannot use.
--
-- window_seconds is stored WITH the state because that is what makes the claim
-- checkable. cur/prev/window_start only mean something under the window they
-- were accumulated at; if the deployment's DailyWindow later differs from the
-- stored value the row is not convertible and the loader must DISCARD it rather
-- than reinterpret it. A discarded row costs one account one window of leniency,
-- once, at a configuration change. Reinterpreting it would silently mis-state
-- every account's allowance with no way to notice.
--
-- # Flushing is periodic, and that is a bounded, one-directional loss
--
-- Writing a row per accepted message would put a database round trip on the
-- SMTP hot path, inside the transaction an attacker controls the rate of. The
-- intended shape is an upsert of the whole state on a timer and on shutdown.
-- The worst case is losing the counts since the last flush — bounded by the
-- flush interval, and it only ever makes the limiter more permissive, never
-- less, so a flush failure cannot lock an honest user out of their own mail.
--
-- # What is NOT persisted: the per-source (IP) tarpit counters
--
-- Deliberately, and it is not an omission. That map is keyed by a value the
-- attacker chooses — the source address, folded to a /64 — on a port anybody
-- can reach, so persisting it converts an LRU-bounded in-memory map into an
-- unbounded, remotely-writable table: a storage-amplification primitive
-- attached to the very control that exists to stop one. It is also the part of
-- the limiter that is genuinely only a nuisance control (the real bound on a
-- sweep is the disconnect threshold and the per-source connection cap), and it
-- decays within the hour. The USER-scoped counters below are safe to persist
-- for the mirror-image reason: a row can only exist for a RESOLVED recipient,
-- so the table's size is bounded by the number of real accounts.
CREATE TABLE smtp_user_counters (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Which of the limiter's user-scoped counters this row is.
  --   'messages' — Limiter.AllowMessage's daily allowance (userState.msgs).
  --   'notice'   — one of userState.notices, the per-reason bound on
  --                user-scoped diagnostics rows a refusal may write.
  kind text NOT NULL
    CONSTRAINT smtp_user_counters_kind_is_closed CHECK (kind IN ('messages','notice')),

  -- The diag reject reason a 'notice' counter is keyed by; empty for
  -- 'messages'. It is part of the key rather than a separate table because
  -- userState.notices is a map keyed by exactly this string, bounded by
  -- maxNoticeReasons.
  reason text NOT NULL DEFAULT ''
    CONSTRAINT smtp_user_counters_reason_is_bounded CHECK (length(reason) <= 64),
  -- A 'messages' row with a reason, or a 'notice' row without one, is a key
  -- that does not correspond to any counter in the limiter — it would be read
  -- back into nothing, or shadow the row that should have been read.
  CONSTRAINT smtp_user_counters_reason_matches_kind
    CHECK ((kind = 'notice') = (reason <> '')),

  -- The window these counts were accumulated at. See the header: a row whose
  -- window does not match the running configuration is discarded, not scaled.
  window_seconds integer NOT NULL
    CONSTRAINT smtp_user_counters_window_is_positive CHECK (window_seconds > 0),

  -- counter.start: the instant the current bucket began.
  window_start timestamptz NOT NULL,
  -- counter.cur and counter.prev, exactly as the struct holds them.
  cur bigint NOT NULL
    CONSTRAINT smtp_user_counters_cur_is_non_negative CHECK (cur >= 0),
  prev bigint NOT NULL
    CONSTRAINT smtp_user_counters_prev_is_non_negative CHECK (prev >= 0),
  -- counterCeiling (1 << 30) is where counter.add stops incrementing, so a
  -- stored value above it never came from the limiter. Pinned here so a repair
  -- script or a future writer cannot plant an allowance nobody can spend.
  CONSTRAINT smtp_user_counters_are_below_the_ceiling
    CHECK (cur <= 1073741824 AND prev <= 1073741824),

  -- When this row was last flushed. It bounds how much unflushed activity a
  -- restart could have lost, and it is what a housekeeping sweep uses to remove
  -- rows that have been silent for more than two windows — at which point
  -- counter.roll would zero them anyway, so the row carries no information.
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, kind, reason)
);

-- Serves the sweep described above.
CREATE INDEX smtp_user_counters_updated_idx ON smtp_user_counters (updated_at);

-- Nothing is backfilled, and there is nothing to backfill from: the counters
-- have only ever existed in memory, and the process holding them is not this
-- one. The first flush after deploy writes the first rows. This is the opposite
-- case to account_usage in 00031, where durable rows already existed and
-- starting from zero would have been wrong.

-- DEPLOYMENT: the two-role split; see 00003_writers.sql for the full recipe and
-- 00031 for the argument. No sequence grant: no serial or identity column here.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON smtp_user_counters TO ledger_runtime';
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE smtp_user_counters;
