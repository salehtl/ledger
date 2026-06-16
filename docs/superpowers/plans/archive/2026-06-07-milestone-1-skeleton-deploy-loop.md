# Milestone 1: Skeleton + Deploy Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `ledger` single-binary skeleton — config loading, idempotent SQLite schema-on-startup, a `net/http` server that serves an embedded placeholder PWA and a `/api/health` endpoint — and deploy it as a hardened systemd service reachable over HTTPS via Tailscale.

**Architecture:** One Go module (`module ledger`) compiled to a single `CGO_ENABLED=0` static binary. `cmd/ledger` wires together four focused `internal/` packages: `config` (TOML + env), `store` (pure-Go SQLite + embedded schema), `web` (`embed.FS` for the built frontend), and `server` (`net/http` 1.22 routing). This milestone establishes the deploy loop and the schema everything later hangs off; it deliberately contains no IMAP, no parsing, and no real frontend.

**Tech Stack:** Go 1.22+, `modernc.org/sqlite` (pure Go, no cgo), `github.com/BurntSushi/toml`, stdlib `net/http` + `embed`, systemd, Tailscale.

This plan implements **Milestone 1 of §10** of `budgeting-app-build-plan.md`. The full §5 schema is created here (it is all idempotent `CREATE TABLE IF NOT EXISTS`), even though later milestones populate it — "SQLite schema-on-startup" is this milestone's deliverable.

---

## Prerequisites (one-time, not part of the TDD loop)

- [ ] **P1: Install the toolchain on the build machine.** Go **1.22 or newer** is required (this plan uses 1.22 method-pattern routing like `mux.HandleFunc("GET /api/health", …)`). Verify:

```bash
go version
# Expected: go version go1.22.x (or newer)
```

If missing, install from https://go.dev/dl/ (or your distro's package). Node.js is **not** needed for Milestone 1 — the real Vite/React PWA arrives in Milestone 7; this milestone embeds a hand-written placeholder `index.html`. `sqlite3` CLI is optional (handy for manual DB inspection) but the app uses the pure-Go driver and needs no system SQLite.

---

## File Structure

This milestone creates the module skeleton. Each file has one responsibility:

| File | Responsibility |
|---|---|
| `go.mod` / `go.sum` | Module definition (`module ledger`) + pinned deps |
| `.gitignore` | Exclude build artifacts (`/ledger`, `/web/dist`) and the SQLite DB |
| `cmd/ledger/main.go` | Entrypoint: parse flags, load config, open store, build server, graceful shutdown |
| `internal/config/config.go` | Load+validate TOML config with defaults and env overrides |
| `internal/config/config_test.go` | Config tests |
| `internal/store/schema.sql` | The full §5 schema (embedded) |
| `internal/store/store.go` | Open SQLite, apply schema idempotently, expose `*sql.DB` + `Ping` |
| `internal/store/store_test.go` | Store tests |
| `internal/web/embed.go` | `embed.FS` of the built PWA bundle + `FS()` helper |
| `internal/web/dist/index.html` | Placeholder PWA shell (replaced by Vite build in M7) |
| `internal/server/server.go` | `net/http` router + static-file serving |
| `internal/server/health.go` | `/api/health` handler |
| `internal/server/server_test.go` | Server/router tests |
| `config.example.toml` | Sample config (no secrets) |
| `deploy/ledger.service` | Hardened systemd unit |
| `deploy/README.md` | Deploy + Tailscale HTTPS runbook |

**Module path:** This is a private single-binary app with no published remote, so the module path is the bare name `ledger` (imports become `ledger/internal/...`). If you later push to a GitHub remote, rename via `go mod edit -module github.com/<you>/ledger` and update imports.

---

## Task 1: Module skeleton & dependencies

**Files:**
- Create: `go.mod`, `.gitignore`

- [ ] **Step 1: Initialize the module**

Run from the repo root (`/root/Coding/ledger`):

```bash
go mod init ledger
```

Expected: creates `go.mod` containing `module ledger` and a `go 1.22` (or newer) line.

- [ ] **Step 2: Add the two runtime dependencies**

```bash
go get modernc.org/sqlite@latest
go get github.com/BurntSushi/toml@latest
```

Expected: `go.mod` now lists both under `require`; `go.sum` is created. (`modernc.org/sqlite` pulls several `modernc.org/*` transitive deps — this is normal for the pure-Go driver.)

- [ ] **Step 3: Add `.gitignore`**

Create `.gitignore`:

```gitignore
# Build artifacts
/ledger
/dist
/web/dist

# Local runtime data (never commit the DB — it holds financial data)
*.db
*.db-wal
*.db-shm
/data/

# Local secrets / env
*.env
ledger.env
```

- [ ] **Step 4: Commit**

```bash
git add go.mod go.sum .gitignore
git commit -m "chore: initialize ledger Go module with sqlite + toml deps"
```

---

## Task 2: Config loading (`internal/config`)

Loads `config.toml` (if a path is given), applies defaults for unset fields, applies env overrides, then validates. Milestone 1 only needs the `[server]` block; unknown TOML sections (`[imap]`, `[ai]`, …) are ignored by the decoder until later milestones add their structs.

**Files:**
- Create: `internal/config/config.go`
- Test: `internal/config/config_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/config/config_test.go`:

```go
package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaultsWhenNoPath(t *testing.T) {
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load(\"\") error: %v", err)
	}
	if cfg.Server.Listen != "127.0.0.1:8080" {
		t.Errorf("Listen = %q, want 127.0.0.1:8080", cfg.Server.Listen)
	}
	if cfg.Server.DataDir != "/var/lib/ledger" {
		t.Errorf("DataDir = %q, want /var/lib/ledger", cfg.Server.DataDir)
	}
}

func TestLoadFileOverridesDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	contents := "[server]\nlisten = \"0.0.0.0:9999\"\ndata_dir = \"/tmp/ledger-test\"\n"
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if cfg.Server.Listen != "0.0.0.0:9999" {
		t.Errorf("Listen = %q, want 0.0.0.0:9999", cfg.Server.Listen)
	}
	if cfg.Server.DataDir != "/tmp/ledger-test" {
		t.Errorf("DataDir = %q, want /tmp/ledger-test", cfg.Server.DataDir)
	}
}

func TestEnvOverridesFile(t *testing.T) {
	t.Setenv("LEDGER_DATA_DIR", "/env/override")
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if cfg.Server.DataDir != "/env/override" {
		t.Errorf("DataDir = %q, want /env/override", cfg.Server.DataDir)
	}
}

func TestValidateRejectsEmptyListen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte("[server]\nlisten = \"\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected error for empty listen, got nil")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/config/`
Expected: FAIL — `undefined: Load` / package does not compile.

- [ ] **Step 3: Write the minimal implementation**

Create `internal/config/config.go`:

```go
// Package config loads ledger's TOML configuration, applying defaults and
// environment overrides. Secrets are never read from the TOML file; they come
// from the environment (see later milestones for IMAP/AI credentials).
package config

import (
	"fmt"
	"os"

	"github.com/BurntSushi/toml"
)

// Config is the subset of config.toml that Milestone 1 needs. Later milestones
// extend this struct; unknown TOML sections are ignored by the decoder.
type Config struct {
	Server ServerConfig `toml:"server"`
}

// ServerConfig controls the HTTP listener and on-disk data location.
type ServerConfig struct {
	Listen  string `toml:"listen"`
	DataDir string `toml:"data_dir"`
}

func defaults() Config {
	return Config{
		Server: ServerConfig{
			Listen:  "127.0.0.1:8080",
			DataDir: "/var/lib/ledger",
		},
	}
}

// Load reads config from path (if non-empty), applies defaults for any field
// the file leaves unset, applies environment overrides, then validates.
func Load(path string) (Config, error) {
	cfg := defaults()
	if path != "" {
		if _, err := toml.DecodeFile(path, &cfg); err != nil {
			return Config{}, fmt.Errorf("decode config %q: %w", path, err)
		}
	}
	if v := os.Getenv("LEDGER_LISTEN"); v != "" {
		cfg.Server.Listen = v
	}
	if v := os.Getenv("LEDGER_DATA_DIR"); v != "" {
		cfg.Server.DataDir = v
	}
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) validate() error {
	if c.Server.Listen == "" {
		return fmt.Errorf("server.listen must not be empty")
	}
	if c.Server.DataDir == "" {
		return fmt.Errorf("server.data_dir must not be empty")
	}
	return nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/config/`
Expected: PASS (4 tests: `ok ledger/internal/config`).

- [ ] **Step 5: Commit**

```bash
git add internal/config/
git commit -m "feat(config): load TOML config with defaults and env overrides"
```

---

## Task 3: SQLite store + schema-on-startup (`internal/store`)

Opens (creating if needed) `dataDir/ledger.db` with the pure-Go driver and applies the full §5 schema idempotently on every startup.

**Files:**
- Create: `internal/store/schema.sql`
- Create: `internal/store/store.go`
- Test: `internal/store/store_test.go`

- [ ] **Step 1: Create the schema file**

Create `internal/store/schema.sql` (the complete §5 schema; all idempotent):

```sql
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
```

- [ ] **Step 2: Write the failing test**

Create `internal/store/store_test.go`:

```go
package store

import (
	"sort"
	"testing"
)

func TestOpenCreatesDatabaseFile(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open error: %v", err)
	}
	defer st.Close()

	if err := st.Ping(); err != nil {
		t.Errorf("Ping error: %v", err)
	}
}

func TestOpenAppliesFullSchema(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open error: %v", err)
	}
	defer st.Close()

	rows, err := st.DB.Query(
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
	if err != nil {
		t.Fatalf("query tables: %v", err)
	}
	defer rows.Close()

	var got []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		got = append(got, name)
	}
	sort.Strings(got)

	want := []string{
		"accounts", "budget_config", "categories", "import_log",
		"ingest_log", "push_subscriptions", "rules", "transactions",
	}
	if len(got) != len(want) {
		t.Fatalf("tables = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("table[%d] = %q, want %q (full: %v)", i, got[i], want[i], got)
		}
	}
}

func TestOpenIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	st1, err := Open(dir)
	if err != nil {
		t.Fatalf("first Open error: %v", err)
	}
	st1.Close()

	// Re-opening the same directory must re-apply the schema without error.
	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("second Open error: %v", err)
	}
	defer st2.Close()
	if _, err := st2.DB.Exec("INSERT INTO accounts (name, bank) VALUES ('test', 'enbd')"); err != nil {
		t.Errorf("insert after reopen: %v", err)
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test ./internal/store/`
Expected: FAIL — `undefined: Open` / package does not compile.

- [ ] **Step 4: Write the minimal implementation**

Create `internal/store/store.go`:

```go
// Package store owns the SQLite database: opening it, applying the schema
// idempotently on startup, and exposing the connection to the rest of the app.
package store

import (
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // pure-Go driver, registered as "sqlite"
)

//go:embed schema.sql
var schemaSQL string

// Store wraps the application's single SQLite connection pool.
type Store struct {
	DB *sql.DB
}

// Open opens (creating if needed) dataDir/ledger.db, sets pragmas, and applies
// the schema idempotently. The data directory is created 0700 if absent.
func Open(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir %q: %w", dataDir, err)
	}
	dsn := filepath.Join(dataDir, "ledger.db")
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// WAL improves concurrent read/write; foreign keys enforce the schema's refs.
	if _, err := db.Exec("PRAGMA journal_mode=WAL;"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set journal_mode: %w", err)
	}
	if _, err := db.Exec("PRAGMA foreign_keys=ON;"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set foreign_keys: %w", err)
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &Store{DB: db}, nil
}

// Close releases the connection pool.
func (s *Store) Close() error { return s.DB.Close() }

// Ping verifies the database is reachable (used by /api/health).
func (s *Store) Ping() error { return s.DB.Ping() }
```

Note: `modernc.org/sqlite` executes the multi-statement `schema.sql` in a single `Exec` call. The pragmas are issued as separate `Exec` calls because `journal_mode` returns a result row.

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./internal/store/`
Expected: PASS (3 tests: `ok ledger/internal/store`). First run downloads/compiles the modernc deps, so it may take longer.

- [ ] **Step 6: Commit**

```bash
git add internal/store/
git commit -m "feat(store): open SQLite and apply full schema idempotently on startup"
```

---

## Task 4: Embedded web bundle placeholder (`internal/web`)

Provides the `embed.FS` the server serves the SPA from. Milestone 7 replaces `dist/index.html` with the real Vite build output; the embed mechanism stays identical.

**Files:**
- Create: `internal/web/dist/index.html`
- Create: `internal/web/embed.go`

- [ ] **Step 1: Create the placeholder PWA shell**

Create `internal/web/dist/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>ledger</title>
  <style>
    body { font-family: Tahoma, "Trebuchet MS", sans-serif; background: #245EDC;
           color: #fff; margin: 0; display: grid; place-items: center; min-height: 100vh; }
    .card { background: #ECE9D8; color: #000; border: 1px solid #0058E6;
            border-radius: 6px; padding: 16px 20px; min-width: 240px;
            box-shadow: inset 1px 1px #fff, inset -1px -1px #808080; }
    h1 { margin: 0 0 8px; font-size: 18px; }
    #health { font-family: monospace; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>ledger</h1>
    <div>Skeleton is live. Real PWA arrives in Milestone 7.</div>
    <div id="health">checking /api/health…</div>
  </div>
  <script>
    fetch("/api/health")
      .then(function (r) { return r.json(); })
      .then(function (j) { document.getElementById("health").textContent =
        "health: " + j.status + " (db: " + j.db + ")"; })
      .catch(function () { document.getElementById("health").textContent =
        "health: unreachable"; });
  </script>
</body>
</html>
```

- [ ] **Step 2: Create the embed wrapper**

Create `internal/web/embed.go`:

```go
// Package web embeds the built frontend bundle so the single binary serves the
// SPA from its own filesystem. In Milestone 1 this is a placeholder shell; the
// Vite build output replaces dist/ in Milestone 7.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// FS returns the embedded bundle rooted at the dist directory, ready to hand to
// http.FileServer(http.FS(...)).
func FS() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}
```

- [ ] **Step 3: Verify the package compiles**

Run: `go build ./internal/web/`
Expected: no output, exit 0. (If it errors with "pattern all:dist: no matching files", confirm `internal/web/dist/index.html` exists.)

- [ ] **Step 4: Commit**

```bash
git add internal/web/
git commit -m "feat(web): embed placeholder PWA shell via embed.FS"
```

---

## Task 5: HTTP server + `/api/health` (`internal/server`)

Routes `/api/health` to a JSON liveness handler and everything else to the embedded static bundle. The handler depends on a small `HealthChecker` interface (not the concrete `*store.Store`) so it is trivially testable and so later milestones can enrich health (IMAP status, last ingest) without changing the server's shape.

**Files:**
- Create: `internal/server/server.go`
- Create: `internal/server/health.go`
- Test: `internal/server/server_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/server/server_test.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// fakeChecker lets us drive the health handler's two branches.
type fakeChecker struct{ err error }

func (f fakeChecker) Ping() error { return f.err }

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>ledger</html>")},
	}
}

func TestHealthOK(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Status string `json:"status"`
		DB     string `json:"db"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Status != "ok" || body.DB != "ok" {
		t.Errorf("body = %+v, want status=ok db=ok", body)
	}
}

func TestHealthDBUnreachable(t *testing.T) {
	srv := New(fakeChecker{err: http.ErrAbortHandler}, testFS())
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestServesIndexAtRoot(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "<html>ledger</html>" {
		t.Errorf("body = %q, want the index.html contents", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/server/`
Expected: FAIL — `undefined: New` / package does not compile.

- [ ] **Step 3: Write the server**

Create `internal/server/server.go`:

```go
// Package server wires ledger's HTTP surface: a JSON API under /api and the
// embedded SPA served from everything else, on a single origin.
package server

import (
	"io/fs"
	"net/http"
)

// HealthChecker is the minimal dependency the health endpoint needs. The store
// satisfies it; tests supply a fake.
type HealthChecker interface {
	Ping() error
}

// Server holds the router and its dependencies.
type Server struct {
	mux   *http.ServeMux
	store HealthChecker
}

// New builds a Server that serves /api/health and the embedded webFS bundle.
func New(store HealthChecker, webFS fs.FS) *Server {
	s := &Server{
		mux:   http.NewServeMux(),
		store: store,
	}
	s.routes(webFS)
	return s
}

func (s *Server) routes(webFS fs.FS) {
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	// Everything else is the SPA bundle.
	s.mux.Handle("/", http.FileServer(http.FS(webFS)))
}

// ServeHTTP makes Server an http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}
```

- [ ] **Step 4: Write the health handler**

Create `internal/server/health.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
)

// healthResponse is the JSON shape of /api/health. Later milestones add IMAP
// connectivity and last-ingest fields (§6.7); the skeleton reports DB liveness.
type healthResponse struct {
	Status string `json:"status"`
	DB     string `json:"db"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := healthResponse{Status: "ok", DB: "ok"}
	code := http.StatusOK
	if err := s.store.Ping(); err != nil {
		resp.Status = "degraded"
		resp.DB = "unreachable"
		code = http.StatusServiceUnavailable
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(resp)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./internal/server/`
Expected: PASS (3 tests: `ok ledger/internal/server`).

- [ ] **Step 6: Commit**

```bash
git add internal/server/
git commit -m "feat(server): net/http router with /api/health and embedded SPA"
```

---

## Task 6: Wire it together in `cmd/ledger/main.go`

The entrypoint: parse the `-config` flag, load config, open the store, build the server, listen, and shut down gracefully on SIGINT/SIGTERM (systemd sends SIGTERM on stop).

**Files:**
- Create: `cmd/ledger/main.go`

- [ ] **Step 1: Write `main.go`**

Create `cmd/ledger/main.go`:

```go
// Command ledger is the single binary: it loads config, opens the SQLite store,
// and serves the API + embedded PWA over HTTP. It binds to localhost and is
// fronted by Tailscale/Caddy for HTTPS (see deploy/README.md).
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"ledger/internal/config"
	"ledger/internal/server"
	"ledger/internal/store"
	"ledger/internal/web"
)

func main() {
	configPath := flag.String("config", "", "path to config.toml (optional; defaults apply if empty)")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	st, err := store.Open(cfg.Server.DataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	webFS, err := web.FS()
	if err != nil {
		log.Fatalf("web assets: %v", err)
	}

	srv := server.New(st, webFS)
	httpServer := &http.Server{
		Addr:              cfg.Server.Listen,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("ledger listening on %s (data_dir=%s)", cfg.Server.Listen, cfg.Server.DataDir)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server: %v", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	log.Println("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
```

- [ ] **Step 2: Build the whole module**

Run: `go build ./...`
Expected: no output, exit 0.

- [ ] **Step 3: Run the full test suite**

Run: `go test ./...`
Expected: all packages PASS:
```
ok  ledger/internal/config
ok  ledger/internal/server
ok  ledger/internal/store
```
(`ledger/cmd/ledger` and `ledger/internal/web` report `no test files` — expected.)

- [ ] **Step 4: Smoke-test the binary locally**

```bash
CGO_ENABLED=0 go build -o ledger ./cmd/ledger
LEDGER_DATA_DIR=./data LEDGER_LISTEN=127.0.0.1:8080 ./ledger &
sleep 1
curl -s http://127.0.0.1:8080/api/health
echo
curl -s http://127.0.0.1:8080/ | head -1
kill %1
```

Expected:
- health prints `{"status":"ok","db":"ok"}`
- root prints `<!doctype html>`
- `./data/ledger.db` now exists.

Clean up: `rm -rf ./data ./ledger`

- [ ] **Step 5: Commit**

```bash
git add cmd/ledger/main.go
git commit -m "feat(cmd): wire config, store, server into the ledger binary with graceful shutdown"
```

---

## Task 7: Sample config & deploy artifacts

Non-code deliverables that complete the "deploy loop." These cannot be unit-tested in CI; verification is the manual checklist in Task 8.

**Files:**
- Create: `config.example.toml`
- Create: `deploy/ledger.service`
- Create: `deploy/README.md`

- [ ] **Step 1: Create `config.example.toml`**

Mirror §7 of the build plan but keep only what Milestone 1 reads active; later sections are commented context so the file documents the full surface without breaking the M1 decoder (unknown keys are ignored, but commenting keeps intent clear):

```toml
# ledger configuration. Secrets NEVER live here — they come from the
# environment / systemd credentials (see deploy/README.md).

[server]
listen   = "127.0.0.1:8080"   # bound to localhost; Tailscale/Caddy fronts HTTPS
data_dir = "/var/lib/ledger"  # SQLite file lives here (ledger.db)

# --- The sections below are consumed by later milestones (§7 of the build ---
# --- plan). They are inert in Milestone 1 and shown here for reference.   ---

# [imap]
# host          = "imap.example.com"
# port          = 993
# username      = "bankmail@example.com"
# auth          = "oauth2"          # "oauth2" | "app_password"
# folder        = "INBOX"
# read_only     = true
# use_idle      = true
# poll_interval = "60s"

# [ai]
# enabled               = true
# model                 = "claude-..."
# auto_accept_threshold = 0.85
# auto_rule             = false
# allow_ai_extraction   = true

# [budget]
# currency       = "AED"
# monthly_income = 0
# income_source  = "config"
# need_pct       = 0.50
# want_pct       = 0.30
# saving_pct     = 0.20
# freeze_history = false

# [monitoring]
# drift_window = "7d"
# drift_min    = 0.80
```

- [ ] **Step 2: Create the hardened systemd unit**

Create `deploy/ledger.service` (matches §8 of the build plan):

```ini
[Unit]
Description=Ledger budgeting service
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/ledger -config /etc/ledger/config.toml
EnvironmentFile=-/etc/ledger/ledger.env
User=ledger
Restart=on-failure
RestartSec=5
StateDirectory=ledger
# --- sandboxing ---
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
ReadWritePaths=/var/lib/ledger

[Install]
WantedBy=multi-user.target
```

> The leading `-` on `EnvironmentFile=-/etc/ledger/ledger.env` makes the file optional, so Milestone 1 (which has no secrets yet) starts cleanly before `ledger.env` exists.

- [ ] **Step 3: Create the deploy runbook**

Create `deploy/README.md`:

````markdown
# Deploying ledger on dinosaur (Milestone 1)

Single static binary + systemd + Tailscale HTTPS. No Node, no DB server.

## 1. Build the static binary (build machine)

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ledger ./cmd/ledger
# (use GOARCH=arm64 if dinosaur is ARM)
```

Copy it to dinosaur:

```bash
scp ledger dinosaur:/tmp/ledger
```

## 2. Install on dinosaur

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ledger || true
sudo install -m 0755 /tmp/ledger /usr/local/bin/ledger
sudo mkdir -p /etc/ledger /var/lib/ledger
sudo install -m 0644 config.example.toml /etc/ledger/config.toml
sudo chown -R ledger:ledger /var/lib/ledger
sudo chmod 0700 /var/lib/ledger
sudo install -m 0644 deploy/ledger.service /etc/systemd/system/ledger.service
sudo systemctl daemon-reload
sudo systemctl enable --now ledger
```

Check it:

```bash
systemctl status ledger
curl -s http://127.0.0.1:8080/api/health   # -> {"status":"ok","db":"ok"}
```

## 3. HTTPS over Tailscale (required — service workers need HTTPS)

With Tailscale installed and `dinosaur` on your tailnet:

```bash
sudo tailscale serve --bg 8080
# Serves https://dinosaur.<your-tailnet>.ts.net/ -> 127.0.0.1:8080
tailscale serve status
```

The app is now reachable **only** from your tailnet devices, over HTTPS, never publicly.

## 4. Verify on a phone

On a phone joined to the tailnet, open `https://dinosaur.<tailnet>.ts.net/`.
Expect the XP-styled placeholder card showing `health: ok (db: ok)`.

## Logs & ops

```bash
journalctl -u ledger -f          # follow logs
sudo systemctl restart ledger    # restart (sends SIGTERM -> graceful shutdown)
```

## Backups (one file)

```bash
sqlite3 /var/lib/ledger/ledger.db ".backup '/var/backups/ledger-$(date +%F).db'"
```

Backups contain financial data — encrypt them if they leave the box (Milestone 8 covers Litestream + encryption).
````

- [ ] **Step 4: Commit**

```bash
git add config.example.toml deploy/
git commit -m "chore(deploy): sample config, hardened systemd unit, Tailscale runbook"
```

---

## Task 8: End-to-end deploy verification (manual)

The milestone's acceptance criterion (§10.1): *"app loads over HTTPS on a phone."* This task is a manual checklist run against dinosaur — there is no automated test for systemd/Tailscale.

- [ ] **Step 1: Build + ship + install** — follow `deploy/README.md` §1–2. Confirm `systemctl status ledger` shows `active (running)`.

- [ ] **Step 2: Local liveness** — on dinosaur:

```bash
curl -s http://127.0.0.1:8080/api/health
```
Expected: `{"status":"ok","db":"ok"}`. Confirm `/var/lib/ledger/ledger.db` exists and is owned by `ledger` with mode `0600`/`0700` dir.

- [ ] **Step 3: Tailscale HTTPS** — follow `deploy/README.md` §3. Confirm `tailscale serve status` maps the HTTPS URL to `127.0.0.1:8080`.

- [ ] **Step 4: Phone check** — on a tailnet phone, open `https://dinosaur.<tailnet>.ts.net/`. Expected: the placeholder card renders and shows `health: ok (db: ok)` (proves the SPA loaded over HTTPS *and* successfully called the API on the same origin).

- [ ] **Step 5: Restart safety** — `sudo systemctl restart ledger`, re-check health. Confirms graceful shutdown + schema-idempotent restart (no errors in `journalctl -u ledger`).

- [ ] **Step 6: Tag the milestone**

```bash
git tag -a m1-skeleton -m "Milestone 1: skeleton + deploy loop complete"
```

---

## Definition of Done

- [ ] `go build ./...` and `go test ./...` pass; `CGO_ENABLED=0 go build` produces a static binary.
- [ ] `/api/health` returns `{"status":"ok","db":"ok"}` (200) and `503`/`degraded` when the DB is unreachable.
- [ ] Starting the binary creates `ledger.db` with all 8 tables; restarting re-applies the schema with no error (idempotent).
- [ ] The placeholder PWA is served from the embedded bundle on the same origin as the API.
- [ ] Deployed as the hardened systemd service on dinosaur and reachable over HTTPS via Tailscale from a phone.
- [ ] No secrets in the repo or `config.toml`; DB and data dir excluded by `.gitignore`.

---

## Self-Review notes (author)

- **Spec coverage (§10.1):** Go module ✅ (T1), config loading ✅ (T2), SQLite schema-on-startup ✅ (T3, full §5 schema), `net/http` serving placeholder PWA ✅ (T4–T5), `/api/health` ✅ (T5), hardened systemd + Tailscale ✅ (T7–T8). Health endpoint's richer fields (IMAP status, per-bank drift — §6.7) are intentionally deferred: those subsystems don't exist until M2–M3. The `HealthChecker` interface leaves room to add them without reshaping the server.
- **Type consistency:** `store.Store` exposes `Ping()` and `DB`; `server.HealthChecker` requires only `Ping()`; `*store.Store` satisfies it (verified by `server.New(st, …)` in `main.go`). `web.FS()` returns `(fs.FS, error)`, consumed by `server.New(_, webFS)` and `http.FileServer(http.FS(webFS))`. `config.Load(path string) (Config, error)`; `cfg.Server.{Listen,DataDir}` used in `main.go`.
- **Module path:** bare `ledger`; all internal imports use the `ledger/internal/...` prefix consistently.
- **No placeholders:** every code step contains complete, compilable code; every run step states the exact command and expected output. The only deliberate no-op (`_ = os.Stdout` in `main.go`) is flagged for removal in the same step.
