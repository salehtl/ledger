-- Bank accounts the user holds
CREATE TABLE IF NOT EXISTS accounts (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  bank       TEXT NOT NULL,
  last4      TEXT,
  currency   TEXT NOT NULL DEFAULT 'AED',
  is_active  INTEGER NOT NULL DEFAULT 1
);

-- Categories. Bucket assignment is user-editable (see §6.6).
CREATE TABLE IF NOT EXISTS categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  kind      TEXT NOT NULL DEFAULT 'spending',  -- 'spending' | 'income' | 'excluded'
  bucket    TEXT,                              -- 'need' | 'want' | 'saving'
  parent_id INTEGER REFERENCES categories(id),
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Merchant -> category rules (the self-improving lookup)
CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY,
  match_type  TEXT NOT NULL,                   -- 'contains' | 'exact' | 'regex'
  pattern     TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  priority    INTEGER NOT NULL DEFAULT 100,
  source      TEXT NOT NULL,                   -- 'manual' | 'ai_confirmed'
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- Raw ingest log: every email seen, parsed or not. Nothing is ever dropped.
CREATE TABLE IF NOT EXISTS ingest_log (
  id            INTEGER PRIMARY KEY,
  message_uid   TEXT UNIQUE,
  received_at   TEXT,
  from_addr     TEXT,
  subject       TEXT,
  bank_detected TEXT,
  parse_status  TEXT NOT NULL,                 -- 'parsed' | 'unparsed' | 'low_confidence' | 'ignored'
  parse_tier    TEXT,                          -- 'template' | 'heuristic' | 'ai' | null
  parse_error   TEXT,
  structure_sig TEXT,
  raw_body      TEXT,
  created_at    TEXT NOT NULL
);

-- Drift monitor aggregates over a recent created_at window every 5 minutes;
-- without this it full-scans the table each time.
CREATE INDEX IF NOT EXISTS idx_ingest_created ON ingest_log(created_at);

-- The transactions themselves
CREATE TABLE IF NOT EXISTS transactions (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER REFERENCES accounts(id),
  posted_at       TEXT NOT NULL,
  amount          INTEGER NOT NULL,            -- fils, always positive
  currency        TEXT NOT NULL DEFAULT 'AED',
  direction       TEXT NOT NULL,               -- 'debit' | 'credit'
  merchant_raw    TEXT,
  description     TEXT,
  last4           TEXT,                         -- account last-4 from the bank email; used by self-transfer matching
  category_id     INTEGER REFERENCES categories(id),
  bucket_snapshot TEXT,
  status          TEXT NOT NULL,
  confidence      REAL,
  fingerprint     TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'email',  -- 'email' | 'import' | 'manual'
  archived_from   TEXT,                            -- pre-archive status; set only while status='archived'
  ingest_id       INTEGER REFERENCES ingest_log(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_posted ON transactions(posted_at);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_fingerprint ON transactions(fingerprint);
CREATE INDEX IF NOT EXISTS idx_tx_ingest ON transactions(ingest_id);

-- Budget configuration (singleton)
CREATE TABLE IF NOT EXISTS budget_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  monthly_income  INTEGER NOT NULL,
  need_pct        REAL NOT NULL DEFAULT 0.50,
  want_pct        REAL NOT NULL DEFAULT 0.30,
  saving_pct      REAL NOT NULL DEFAULT 0.20,
  income_source   TEXT NOT NULL DEFAULT 'config',  -- 'config' | 'categories'
  freeze_history  INTEGER NOT NULL DEFAULT 0
);

-- Runtime app settings (singleton). Controls categorization behavior.
CREATE TABLE IF NOT EXISTS app_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  auto_categorize INTEGER NOT NULL DEFAULT 1,
  ai_enabled      INTEGER NOT NULL DEFAULT 0,
  ai_auto_accept  INTEGER NOT NULL DEFAULT 0,
  ai_threshold    REAL    NOT NULL DEFAULT 0.85
);

-- Web push subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Bulk import batches, for auditability and resumable seeding (§6.9)
CREATE TABLE IF NOT EXISTS import_log (
  id           INTEGER PRIMARY KEY,
  file_name    TEXT,
  rows_total   INTEGER,
  rows_added   INTEGER,
  rows_skipped INTEGER,
  rows_review  INTEGER,
  rows_error   INTEGER,
  created_at   TEXT NOT NULL
);

-- Anthropic API usage log — one row per call for cost transparency.
CREATE TABLE IF NOT EXISTS ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,   -- unix seconds
  path          TEXT    NOT NULL,   -- 'extract' | 'categorize'
  model         TEXT    NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_musd     INTEGER NOT NULL,   -- micro-USD (1e-6 USD)
  ok            INTEGER NOT NULL,   -- 1 = 200 response, 0 = error
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(at);

-- FX rates for converting foreign-currency transactions to AED.
-- rate_micro is AED per 1 unit of currency × 1,000,000 (integer; money math never uses floats).
-- AED itself never has a row (identity). Rates are user-maintained via /api/rates.
CREATE TABLE IF NOT EXISTS fx_rates (
  currency   TEXT PRIMARY KEY,
  rate_micro INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- Temporary life-projects: a named budget bucket orthogonal to categories.
CREATE TABLE IF NOT EXISTS projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  budget_fils      INTEGER,                           -- AED minor units; NULL = no budget
  color            TEXT,
  starts_on        TEXT,
  ends_on          TEXT,                              -- label only
  status           TEXT    NOT NULL DEFAULT 'active', -- 'active' | 'completed'
  count_in_monthly INTEGER NOT NULL DEFAULT 0,        -- 0 = carved out of 50/30/20
  completed_at     TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

-- AI category-suggestion memo: every successful AI categorization is remembered
-- (even below the auto-accept threshold) so an unreviewed merchant is never
-- paid for twice across runs and restarts. Keyed by lowercased/trimmed merchant.
CREATE TABLE IF NOT EXISTS ai_suggestions (
  merchant_norm TEXT PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  confidence    REAL NOT NULL,
  created_at    TEXT NOT NULL
);

-- v3: per-category budgeting target (envelope depth). One target per category.
CREATE TABLE IF NOT EXISTS category_targets (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,                    -- 'set_aside' | 'refill' | 'save_by_date'
  amount_fils INTEGER NOT NULL,                 -- AED fils
  cadence     TEXT NOT NULL DEFAULT 'monthly',  -- 'weekly' | 'monthly' | 'yearly'
  due_date    TEXT,                             -- 'YYYY-MM-DD'; save_by_date only
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- v3: per-month envelope assignments ("give every dirham a job").
CREATE TABLE IF NOT EXISTS envelope_assignments (
  id            INTEGER PRIMARY KEY,
  month         TEXT NOT NULL,                  -- 'YYYY-MM'
  category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  assigned_fils INTEGER NOT NULL,               -- AED fils
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_envelope_month_cat ON envelope_assignments(month, category_id);

-- v3: recurring bills/income — hand-entered or mined from ingest history by
-- the deterministic detector. Matcher bookkeeping lives on the row.
CREATE TABLE IF NOT EXISTS scheduled_transactions (
  id                  INTEGER PRIMARY KEY,
  normalized_merchant TEXT NOT NULL,
  label               TEXT NOT NULL DEFAULT '',
  amount_fils         INTEGER NOT NULL,         -- expected amount, AED fils
  tolerance_pct       INTEGER NOT NULL DEFAULT 10, -- ± percent points (integer; money math never uses floats)
  interval_days       INTEGER NOT NULL,         -- 7/14/30/365-style cadence
  next_due            TEXT NOT NULL,            -- 'YYYY-MM-DD'
  direction           TEXT NOT NULL DEFAULT 'debit', -- 'debit' | 'credit'
  category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  account_id          INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  source              TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'detected'
  status              TEXT NOT NULL DEFAULT 'active',   -- 'proposed' | 'active' | 'paused' | 'dismissed'
  last_matched_tx_id  INTEGER REFERENCES transactions(id),
  last_matched_at     TEXT,
  last_amount_fils    INTEGER,                  -- most recent matched amount
  missed              INTEGER NOT NULL DEFAULT 0, -- next_due + grace passed, no match
  price_change        INTEGER NOT NULL DEFAULT 0, -- last match was outside tolerance
  provenance          TEXT NOT NULL DEFAULT '',   -- detector provenance JSON (count, avg interval, last amounts, tx ids); '' for manual rows
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_next_due ON scheduled_transactions(next_due);

-- v3: split transactions — divide one transaction across categories. Split
-- amounts are in the PARENT's currency minor units and always sum exactly to
-- the parent amount (enforced by the store, not by SQL). The parent keeps its
-- fingerprint/ingest provenance and carries category_id NULL while split.
CREATE TABLE IF NOT EXISTS transaction_splits (
  id             INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id    INTEGER NOT NULL REFERENCES categories(id),
  amount_fils    INTEGER NOT NULL,              -- parent-currency minor units, > 0
  note           TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_splits_tx ON transaction_splits(transaction_id);

-- v3: balance ground truth — 30-second check-ins and balance adjustments.
-- Latest row per account is the account's stated balance anchor.
CREATE TABLE IF NOT EXISTS account_balances (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of        TEXT NOT NULL,                   -- RFC3339
  balance_fils INTEGER NOT NULL,                -- AED fils; may be negative (credit cards)
  source       TEXT NOT NULL DEFAULT 'checkin', -- 'checkin' | 'adjustment'
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_balances_account ON account_balances(account_id, as_of);
