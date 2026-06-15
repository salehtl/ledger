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
  category_id     INTEGER REFERENCES categories(id),
  bucket_snapshot TEXT,
  status          TEXT NOT NULL,
  confidence      REAL,
  fingerprint     TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'email',  -- 'email' | 'import' | 'manual'
  ingest_id       INTEGER REFERENCES ingest_log(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_posted ON transactions(posted_at);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_fingerprint ON transactions(fingerprint);

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
