# Milestone 2: IMAP Ingest (no parsing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect to the dedicated Gmail mailbox over IMAPS, open it **read-only** (`EXAMINE`), backfill every existing message and poll for new ones, and record each message (full raw body + envelope metadata) in `ingest_log` — with **no parsing** (rows land as `parse_status = 'unparsed'`, awaiting Milestone 3's cascade).

**Architecture:** A new `internal/ingest` package owns ingestion. The testable logic — backfill diffing via stored UIDs, UIDVALIDITY namespacing, idempotent writes, the poll loop — lives in a `Worker` that depends on a small `Mailbox`/`Dialer` interface (the I/O seam) and the concrete `*store.Store` (local, fast, real in tests). A thin `imapMailbox` adapter implements `Mailbox` over `github.com/emersion/go-imap/v2`. The worker dials fresh on every poll, so a dropped connection simply retries next cycle — no long-lived connection to babysit. Auth is app-password only in this milestone, selected behind an `auth` config switch so OAuth2 can be added later without reshaping anything.

**Tech Stack:** Go 1.22+, `github.com/emersion/go-imap/v2` (v2.0.0-beta.8) + its `imapclient`, existing `modernc.org/sqlite` store, stdlib `net/http`. **Live updates are poll-only this milestone** (IDLE deferred); the `use_idle` config field is reserved so adding IDLE later is isolated.

This plan implements **Milestone 2 of §10** of `budgeting-app-build-plan.md` (§6.1 ingest worker, §7 `[imap]` config, §9 security). It deliberately contains **no parsing, no categorization, no bank detection** — every ingested row is stored raw with `parse_status = 'unparsed'` and `bank_detected`/`parse_tier`/`structure_sig` left NULL for Milestone 3.

---

## Prerequisites

- [ ] **P1: Milestone 1 is complete and on `main`.** `go build ./...` and `go test ./...` pass; the binary runs and serves `/api/health`. Verify: `go test ./...` is green before starting.

- [ ] **P2: (User, can run in parallel) the dedicated Gmail mailbox.** Not required to *build* M2 (everything is tested against a fake mailbox and an env-gated live test), but required for Task 10's live verification. The user creates a dedicated Gmail, enables 2-Step Verification, generates a 16-char **App Password**, and sets an iCloud forwarding rule for bank senders. Full steps live in `deploy/README.md` (written in Task 9). IMAP is on by default for Gmail since Jan 2025.

---

## File Structure

| File | Responsibility |
|---|---|
| `internal/config/config.go` | **Modify:** add `IMAPConfig` struct, defaults, env secret, validation, helpers |
| `internal/config/config_test.go` | **Modify:** add IMAP config tests |
| `internal/store/ingest.go` | **Create:** `IngestRecord` + `InsertIngest`, `KnownUIDs`, `CountIngest`, `LastIngestAt` |
| `internal/store/ingest_test.go` | **Create:** store ingest method tests |
| `internal/ingest/ingest.go` | **Create:** `Message`, `Mailbox`, `Dialer` interfaces, `Worker` (`New`, `syncOnce`, `Run`) |
| `internal/ingest/ingest_test.go` | **Create:** worker tests against a fake `Dialer`/`Mailbox` + real temp store |
| `internal/ingest/imap.go` | **Create:** `imapMailbox` adapter + `NewIMAPDialer` over go-imap/v2 |
| `internal/ingest/imap_integration_test.go` | **Create:** env-gated live IMAP test (skips unless `LEDGER_TEST_IMAP_*` set) |
| `internal/server/health.go` | **Modify:** add optional ingest status to `/api/health` |
| `internal/server/server.go` | **Modify:** add `IngestStatus` interface + `SetIngest` setter + fields |
| `internal/server/server_test.go` | **Modify:** add ingest-in-health tests |
| `cmd/ledger/main.go` | **Modify:** start the ingest worker goroutine; wire health ingest source |
| `config.example.toml` | **Modify:** activate the `[imap]` block |
| `deploy/README.md` | **Modify:** dedicated-mailbox setup + secret + verification runbook |

**Module path stays `ledger`.** New imports: `ledger/internal/ingest`.

---

## Task 1: Extend config with `[imap]` + app-password secret

Adds the `[imap]` section to `Config`. Host empty ⇒ ingestion disabled (so an unconfigured deploy still runs, exactly like M1). The app password is a **secret** — never from TOML, only from `LEDGER_IMAP_APP_PASSWORD`. Read-only is enforced (a config setting `read_only = false` is rejected — the app must never be able to alter mail, §9).

**Files:**
- Modify: `internal/config/config.go`
- Test: `internal/config/config_test.go`

- [ ] **Step 1: Add the failing tests**

Append to `internal/config/config_test.go`:

```go
func TestIMAPDisabledByDefault(t *testing.T) {
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if cfg.IMAP.Enabled() {
		t.Error("IMAP should be disabled when no host is configured")
	}
	if cfg.IMAP.Port != 993 {
		t.Errorf("default Port = %d, want 993", cfg.IMAP.Port)
	}
	if cfg.IMAP.Folder != "INBOX" {
		t.Errorf("default Folder = %q, want INBOX", cfg.IMAP.Folder)
	}
	if cfg.IMAP.Auth != "app_password" {
		t.Errorf("default Auth = %q, want app_password", cfg.IMAP.Auth)
	}
	if !cfg.IMAP.ReadOnly {
		t.Error("ReadOnly should default to true")
	}
}

func TestIMAPLoadsFromFileAndEnv(t *testing.T) {
	t.Setenv("LEDGER_IMAP_APP_PASSWORD", "secret-app-pw")
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	contents := "[imap]\nhost = \"imap.gmail.com\"\nusername = \"bankmail@gmail.com\"\nfolder = \"INBOX\"\npoll_interval = \"30s\"\n"
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if !cfg.IMAP.Enabled() {
		t.Fatal("IMAP should be enabled when host is set")
	}
	if cfg.IMAP.Addr() != "imap.gmail.com:993" {
		t.Errorf("Addr() = %q, want imap.gmail.com:993", cfg.IMAP.Addr())
	}
	if cfg.IMAP.AppPassword != "secret-app-pw" {
		t.Errorf("AppPassword = %q, want from env", cfg.IMAP.AppPassword)
	}
	d, err := cfg.IMAP.Interval()
	if err != nil {
		t.Fatalf("Interval error: %v", err)
	}
	if d.String() != "30s" {
		t.Errorf("Interval = %s, want 30s", d)
	}
}

func TestIMAPRequiresUsernameWhenEnabled(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte("[imap]\nhost = \"imap.gmail.com\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected error when host set but username missing")
	}
}

func TestIMAPRequiresAppPasswordWhenEnabled(t *testing.T) {
	// No LEDGER_IMAP_APP_PASSWORD set.
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	c := "[imap]\nhost = \"imap.gmail.com\"\nusername = \"bankmail@gmail.com\"\n"
	if err := os.WriteFile(path, []byte(c), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected error when app_password auth has no secret")
	}
}

func TestIMAPRejectsReadOnlyFalse(t *testing.T) {
	t.Setenv("LEDGER_IMAP_APP_PASSWORD", "x")
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	c := "[imap]\nhost = \"imap.gmail.com\"\nusername = \"u\"\nread_only = false\n"
	if err := os.WriteFile(path, []byte(c), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected error when read_only = false")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/config/`
Expected: FAIL — `cfg.IMAP undefined` / does not compile.

- [ ] **Step 3: Implement the IMAP config**

In `internal/config/config.go`, add `"fmt"` and `"time"` to imports (keep existing `os`), add the `IMAP` field to `Config`, the `IMAPConfig` type, its defaults, env override, helpers, and validation.

Change the `Config` struct to:

```go
// Config is the subset of config.toml that ledger needs so far. Later milestones
// extend this struct; unknown TOML sections are ignored by the decoder.
type Config struct {
	Server ServerConfig `toml:"server"`
	IMAP   IMAPConfig   `toml:"imap"`
}
```

Add after `ServerConfig`:

```go
// IMAPConfig controls the mailbox the ingest worker reads. Host == "" means
// ingestion is disabled (the app still serves the API/PWA). The app password is
// a secret and is NEVER read from TOML — only from LEDGER_IMAP_APP_PASSWORD.
type IMAPConfig struct {
	Host         string `toml:"host"`
	Port         int    `toml:"port"`
	Username     string `toml:"username"`
	Auth         string `toml:"auth"`          // "app_password" | "oauth2"
	Folder       string `toml:"folder"`
	ReadOnly     bool   `toml:"read_only"`     // must stay true; the app never alters mail
	UseIDLE      bool   `toml:"use_idle"`      // reserved; poll-only in Milestone 2
	PollInterval string `toml:"poll_interval"` // e.g. "60s"
	AppPassword  string `toml:"-"`             // secret, from env only
}

// Enabled reports whether a mailbox is configured.
func (c IMAPConfig) Enabled() bool { return c.Host != "" }

// Addr is the host:port the worker dials.
func (c IMAPConfig) Addr() string { return fmt.Sprintf("%s:%d", c.Host, c.Port) }

// Interval parses PollInterval into a duration.
func (c IMAPConfig) Interval() (time.Duration, error) { return time.ParseDuration(c.PollInterval) }
```

Update `defaults()` to include IMAP defaults:

```go
func defaults() Config {
	return Config{
		Server: ServerConfig{
			Listen:  "127.0.0.1:8080",
			DataDir: "/var/lib/ledger",
		},
		IMAP: IMAPConfig{
			Port:         993,
			Auth:         "app_password",
			Folder:       "INBOX",
			ReadOnly:     true,
			UseIDLE:      false,
			PollInterval: "60s",
		},
	}
}
```

In `Load`, after the existing server env overrides and **before** `cfg.validate()`, add:

```go
	if v := os.Getenv("LEDGER_IMAP_HOST"); v != "" {
		cfg.IMAP.Host = v
	}
	if v := os.Getenv("LEDGER_IMAP_USERNAME"); v != "" {
		cfg.IMAP.Username = v
	}
	if v := os.Getenv("LEDGER_IMAP_APP_PASSWORD"); v != "" {
		cfg.IMAP.AppPassword = v
	}
```

Extend `validate()` (keep the existing server checks, add the IMAP block):

```go
func (c Config) validate() error {
	if c.Server.Listen == "" {
		return fmt.Errorf("server.listen must not be empty")
	}
	if c.Server.DataDir == "" {
		return fmt.Errorf("server.data_dir must not be empty")
	}
	if c.IMAP.Enabled() {
		if !c.IMAP.ReadOnly {
			return fmt.Errorf("imap.read_only must be true (the app must never modify mail)")
		}
		if c.IMAP.Username == "" {
			return fmt.Errorf("imap.username required when imap.host is set")
		}
		switch c.IMAP.Auth {
		case "app_password":
			if c.IMAP.AppPassword == "" {
				return fmt.Errorf("imap app_password auth requires LEDGER_IMAP_APP_PASSWORD")
			}
		case "oauth2":
			return fmt.Errorf("imap auth oauth2 not supported yet; use app_password")
		default:
			return fmt.Errorf("imap.auth must be \"app_password\" (got %q)", c.IMAP.Auth)
		}
		if _, err := c.IMAP.Interval(); err != nil {
			return fmt.Errorf("imap.poll_interval invalid: %w", err)
		}
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/config/`
Expected: PASS (all config tests, old + new).

- [ ] **Step 5: Commit**

```bash
git add internal/config/
git commit -m "feat(config): add [imap] config block with app-password secret and validation"
```

---

## Task 2: Store ingest_log methods (`internal/store/ingest.go`)

Adds the persistence the worker needs: insert a message (idempotent via the `message_uid` UNIQUE constraint), list known UIDs for backfill diffing, and count / last-time for health. Times are stored as RFC3339; `received_at` may be empty.

**Files:**
- Create: `internal/store/ingest.go`
- Test: `internal/store/ingest_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/store/ingest_test.go`:

```go
package store

import (
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func sampleRecord(uid string) IngestRecord {
	return IngestRecord{
		MessageUID:  uid,
		ReceivedAt:  time.Date(2026, 6, 1, 9, 30, 0, 0, time.UTC),
		FromAddr:    "alerts@emiratesnbd.com",
		Subject:     "Transaction Alert",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: alerts@emiratesnbd.com\r\n\r\nYou spent AED 42.00"),
		CreatedAt:   time.Date(2026, 6, 14, 12, 0, 0, 0, time.UTC),
	}
}

func TestInsertIngestReturnsTrueOnNew(t *testing.T) {
	st := newTestStore(t)
	inserted, err := st.InsertIngest(sampleRecord("1-100"))
	if err != nil {
		t.Fatalf("InsertIngest: %v", err)
	}
	if !inserted {
		t.Error("expected inserted = true for a new message")
	}
}

func TestInsertIngestIsIdempotent(t *testing.T) {
	st := newTestStore(t)
	if _, err := st.InsertIngest(sampleRecord("1-100")); err != nil {
		t.Fatal(err)
	}
	inserted, err := st.InsertIngest(sampleRecord("1-100"))
	if err != nil {
		t.Fatalf("second InsertIngest: %v", err)
	}
	if inserted {
		t.Error("expected inserted = false for a duplicate message_uid")
	}
	n, err := st.CountIngest()
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("CountIngest = %d, want 1", n)
	}
}

func TestKnownUIDs(t *testing.T) {
	st := newTestStore(t)
	for _, uid := range []string{"1-100", "1-101", "1-102"} {
		if _, err := st.InsertIngest(sampleRecord(uid)); err != nil {
			t.Fatal(err)
		}
	}
	known, err := st.KnownUIDs()
	if err != nil {
		t.Fatalf("KnownUIDs: %v", err)
	}
	if len(known) != 3 {
		t.Fatalf("KnownUIDs len = %d, want 3", len(known))
	}
	if _, ok := known["1-101"]; !ok {
		t.Error("expected 1-101 in known set")
	}
}

func TestLastIngestAt(t *testing.T) {
	st := newTestStore(t)
	if _, _, err := mustNoLast(t, st); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertIngest(sampleRecord("1-100")); err != nil {
		t.Fatal(err)
	}
	at, ok, err := st.LastIngestAt()
	if err != nil {
		t.Fatalf("LastIngestAt: %v", err)
	}
	if !ok {
		t.Fatal("expected ok = true after an insert")
	}
	if !at.Equal(time.Date(2026, 6, 14, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("LastIngestAt = %s, want 2026-06-14T12:00:00Z", at)
	}
}

// mustNoLast asserts LastIngestAt reports ok=false on an empty table.
func mustNoLast(t *testing.T, st *Store) (time.Time, bool, error) {
	t.Helper()
	at, ok, err := st.LastIngestAt()
	if err == nil && ok {
		t.Fatal("expected ok = false on empty ingest_log")
	}
	return at, ok, err
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/store/`
Expected: FAIL — `undefined: IngestRecord` / `st.InsertIngest undefined`.

- [ ] **Step 3: Write the implementation**

Create `internal/store/ingest.go`:

```go
package store

import (
	"database/sql"
	"time"
)

// IngestRecord is one row destined for ingest_log. Milestone 2 records the raw
// message and envelope metadata only; parse_status is always "unparsed" until
// Milestone 3 runs the cascade. bank_detected, parse_tier, and structure_sig
// stay NULL for now.
type IngestRecord struct {
	MessageUID  string
	ReceivedAt  time.Time
	FromAddr    string
	Subject     string
	ParseStatus string
	RawBody     []byte
	CreatedAt   time.Time
}

func rfc3339OrEmpty(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// InsertIngest writes a message idempotently. It returns true if a new row was
// created, false if message_uid already existed (INSERT OR IGNORE on the UNIQUE
// constraint).
func (s *Store) InsertIngest(r IngestRecord) (bool, error) {
	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO ingest_log
		   (message_uid, received_at, from_addr, subject, parse_status, raw_body, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.MessageUID,
		rfc3339OrEmpty(r.ReceivedAt),
		r.FromAddr,
		r.Subject,
		r.ParseStatus,
		string(r.RawBody),
		rfc3339OrEmpty(r.CreatedAt),
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// KnownUIDs returns the set of message_uid values already stored, for backfill
// diffing.
func (s *Store) KnownUIDs() (map[string]struct{}, error) {
	rows, err := s.DB.Query(`SELECT message_uid FROM ingest_log WHERE message_uid IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	known := make(map[string]struct{})
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		known[uid] = struct{}{}
	}
	return known, rows.Err()
}

// CountIngest returns the number of rows in ingest_log.
func (s *Store) CountIngest() (int, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM ingest_log`).Scan(&n)
	return n, err
}

// LastIngestAt returns the most recent created_at. ok is false when the table is
// empty.
func (s *Store) LastIngestAt() (time.Time, bool, error) {
	var v sql.NullString
	if err := s.DB.QueryRow(`SELECT MAX(created_at) FROM ingest_log`).Scan(&v); err != nil {
		return time.Time{}, false, err
	}
	if !v.Valid || v.String == "" {
		return time.Time{}, false, nil
	}
	t, err := time.Parse(time.RFC3339Nano, v.String)
	if err != nil {
		return time.Time{}, false, err
	}
	return t, true, nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/store/`
Expected: PASS (M1 store tests + new ingest tests).

- [ ] **Step 5: Commit**

```bash
git add internal/store/ingest.go internal/store/ingest_test.go
git commit -m "feat(store): ingest_log writes, known-UID set, and ingest stats"
```

---

## Task 3: Ingest interfaces & message type (`internal/ingest/ingest.go`)

Defines the I/O seam — the `Mailbox` the worker reads and the `Dialer` that opens one — plus the `Message` value type. No behavior yet; this is the contract Tasks 4–6 build against. Keeping it in its own step means the worker (Task 4) and the real adapter (Task 6) code against an agreed interface.

**Files:**
- Create: `internal/ingest/ingest.go` (interfaces + types only in this task)

- [ ] **Step 1: Create the package with interfaces and the message type**

Create `internal/ingest/ingest.go`:

```go
// Package ingest owns reading the dedicated mailbox and recording every message
// in ingest_log. It does NOT parse: Milestone 2 stores raw bodies + envelope
// metadata with parse_status "unparsed"; the parse cascade arrives in M3.
//
// The Worker holds all the testable logic and depends on the Mailbox/Dialer
// interfaces (the I/O seam). The real IMAP implementation lives in imap.go.
package ingest

import (
	"context"
	"time"
)

// Message is one email as the worker needs it: the IMAP UID, envelope metadata,
// and the full raw RFC822 body (never discarded, so a future parser can backfill).
type Message struct {
	UID        uint32
	From       string
	Subject    string
	ReceivedAt time.Time
	Raw        []byte
}

// Mailbox is a read-only view of one IMAP mailbox. Implementations open with
// EXAMINE so the app can never alter mail.
type Mailbox interface {
	// Examine opens the mailbox read-only and returns its UIDVALIDITY.
	Examine(ctx context.Context) (uidValidity uint32, err error)
	// ListUIDs returns every message UID currently in the mailbox.
	ListUIDs(ctx context.Context) ([]uint32, error)
	// Fetch returns the full message for one UID.
	Fetch(ctx context.Context, uid uint32) (Message, error)
	// Close releases the connection.
	Close() error
}

// Dialer opens a fresh Mailbox. The worker dials per sync cycle, so reconnects
// are automatic.
type Dialer interface {
	Dial(ctx context.Context) (Mailbox, error)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `go build ./internal/ingest/`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add internal/ingest/ingest.go
git commit -m "feat(ingest): define Mailbox/Dialer interfaces and Message type"
```

---

## Task 4: Worker backfill logic (`syncOnce`)

The heart of ingestion: dial, examine (get UIDVALIDITY), list UIDs, skip ones already stored (namespaced by UIDVALIDITY so a mailbox reset can't collide), fetch the rest oldest→newest, and write each to `ingest_log`. Tested against a **fake** `Dialer`/`Mailbox` plus a **real** temp store.

**Files:**
- Modify: `internal/ingest/ingest.go` (add `Worker`, `New`, `syncOnce`)
- Test: `internal/ingest/ingest_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/ingest/ingest_test.go`:

```go
package ingest

import (
	"context"
	"errors"
	"io"
	"log"
	"testing"
	"time"

	"ledger/internal/store"
)

// fakeMailbox is a scripted, in-memory Mailbox.
type fakeMailbox struct {
	uidValidity uint32
	messages    map[uint32]Message
	uids        []uint32
	fetchErr    error
	closed      bool
}

func (f *fakeMailbox) Examine(ctx context.Context) (uint32, error) { return f.uidValidity, nil }
func (f *fakeMailbox) ListUIDs(ctx context.Context) ([]uint32, error) {
	return append([]uint32(nil), f.uids...), nil
}
func (f *fakeMailbox) Fetch(ctx context.Context, uid uint32) (Message, error) {
	if f.fetchErr != nil {
		return Message{}, f.fetchErr
	}
	return f.messages[uid], nil
}
func (f *fakeMailbox) Close() error { f.closed = true; return nil }

// fakeDialer hands out a fixed mailbox.
type fakeDialer struct {
	mb      *fakeMailbox
	dialErr error
}

func (d *fakeDialer) Dial(ctx context.Context) (Mailbox, error) {
	if d.dialErr != nil {
		return nil, d.dialErr
	}
	return d.mb, nil
}

func msg(uid uint32, from string) Message {
	return Message{
		UID:        uid,
		From:       from,
		Subject:    "Alert",
		ReceivedAt: time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC),
		Raw:        []byte("raw body for uid"),
	}
}

func mailboxWith(uidValidity uint32, msgs ...Message) *fakeMailbox {
	mb := &fakeMailbox{uidValidity: uidValidity, messages: map[uint32]Message{}}
	for _, m := range msgs {
		mb.messages[m.UID] = m
		mb.uids = append(mb.uids, m.UID)
	}
	return mb
}

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func quietLogger() *log.Logger { return log.New(io.Discard, "", 0) }

func TestSyncOnceInsertsAllMessages(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"), msg(101, "b@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, time.Minute, quietLogger())

	n, err := w.syncOnce(context.Background())
	if err != nil {
		t.Fatalf("syncOnce: %v", err)
	}
	if n != 2 {
		t.Errorf("inserted = %d, want 2", n)
	}
	count, _ := st.CountIngest()
	if count != 2 {
		t.Errorf("CountIngest = %d, want 2", count)
	}
	if !mb.closed {
		t.Error("expected mailbox to be closed after syncOnce")
	}
	// UID is namespaced by UIDVALIDITY.
	known, _ := st.KnownUIDs()
	if _, ok := known["42-100"]; !ok {
		t.Errorf("expected key 42-100 in %v", known)
	}
}

func TestSyncOnceIsIdempotent(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"), msg(101, "b@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, time.Minute, quietLogger())

	if _, err := w.syncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	n, err := w.syncOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("second sync inserted = %d, want 0", n)
	}
}

func TestSyncOnceInsertsOnlyNew(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, time.Minute, quietLogger())
	if _, err := w.syncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	// A new message arrives.
	mb.messages[101] = msg(101, "c@bank.com")
	mb.uids = append(mb.uids, 101)
	n, err := w.syncOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("inserted = %d, want 1 (only the new message)", n)
	}
}

func TestSyncOnceFetchErrorPropagates(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"))
	mb.fetchErr = errors.New("boom")
	w := New(&fakeDialer{mb: mb}, st, time.Minute, quietLogger())
	if _, err := w.syncOnce(context.Background()); err == nil {
		t.Fatal("expected fetch error to propagate")
	}
}

func TestSyncOnceDialErrorPropagates(t *testing.T) {
	st := newTestStore(t)
	w := New(&fakeDialer{dialErr: errors.New("no net")}, st, time.Minute, quietLogger())
	if _, err := w.syncOnce(context.Background()); err == nil {
		t.Fatal("expected dial error to propagate")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/ingest/`
Expected: FAIL — `undefined: New` / `w.syncOnce undefined`.

- [ ] **Step 3: Implement `Worker`, `New`, and `syncOnce`**

Append to `internal/ingest/ingest.go` (add `"fmt"`, `"log"`, `"sort"` to the import block alongside `context` and `time`, and import `"ledger/internal/store"`):

```go
// Worker ingests the mailbox into the store. It depends on a Dialer (the I/O
// seam) and the concrete store. now is injectable for deterministic tests.
type Worker struct {
	dialer   Dialer
	store    *store.Store
	interval time.Duration
	log      *log.Logger
	now      func() time.Time
}

// New builds a Worker. interval is the poll cadence; logger receives operational
// messages.
func New(d Dialer, st *store.Store, interval time.Duration, logger *log.Logger) *Worker {
	return &Worker{
		dialer:   d,
		store:    st,
		interval: interval,
		log:      logger,
		now:      time.Now,
	}
}

// syncOnce dials, examines the mailbox read-only, and writes any not-yet-seen
// messages to ingest_log oldest→newest. It returns the number of new rows.
func (w *Worker) syncOnce(ctx context.Context) (int, error) {
	mb, err := w.dialer.Dial(ctx)
	if err != nil {
		return 0, fmt.Errorf("dial: %w", err)
	}
	defer mb.Close()

	uidValidity, err := mb.Examine(ctx)
	if err != nil {
		return 0, fmt.Errorf("examine: %w", err)
	}
	uids, err := mb.ListUIDs(ctx)
	if err != nil {
		return 0, fmt.Errorf("list uids: %w", err)
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })

	known, err := w.store.KnownUIDs()
	if err != nil {
		return 0, fmt.Errorf("known uids: %w", err)
	}

	inserted := 0
	for _, uid := range uids {
		key := fmt.Sprintf("%d-%d", uidValidity, uid)
		if _, seen := known[key]; seen {
			continue
		}
		msg, err := mb.Fetch(ctx, uid)
		if err != nil {
			return inserted, fmt.Errorf("fetch uid %d: %w", uid, err)
		}
		ok, err := w.store.InsertIngest(store.IngestRecord{
			MessageUID:  key,
			ReceivedAt:  msg.ReceivedAt,
			FromAddr:    msg.From,
			Subject:     msg.Subject,
			ParseStatus: "unparsed",
			RawBody:     msg.Raw,
			CreatedAt:   w.now().UTC(),
		})
		if err != nil {
			return inserted, fmt.Errorf("insert uid %d: %w", uid, err)
		}
		if ok {
			inserted++
		}
	}
	return inserted, nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/ingest/`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/ingest/
git commit -m "feat(ingest): worker syncOnce backfills new messages idempotently"
```

---

## Task 5: Worker poll loop (`Run`)

Wraps `syncOnce` in a poll loop that retries each `interval`, logs (doesn't crash on) transient errors, and exits promptly on context cancellation (systemd SIGTERM → graceful shutdown).

**Files:**
- Modify: `internal/ingest/ingest.go` (add `Run`)
- Test: `internal/ingest/ingest_test.go` (add loop tests)

- [ ] **Step 1: Write the failing test**

Append to `internal/ingest/ingest_test.go`:

```go
func TestRunStopsOnContextCancel(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, 10*time.Millisecond, quietLogger())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		w.Run(ctx)
		close(done)
	}()
	cancel()

	select {
	case <-done:
		// Run returned promptly after cancel.
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return within 2s of context cancel")
	}
}

func TestRunIngestsThenKeepsRunningOnError(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"))
	// First cycle succeeds; we then break fetch to prove the loop survives errors.
	w := New(&fakeDialer{mb: mb}, st, 5*time.Millisecond, quietLogger())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)

	// Wait for the first message to land.
	deadline := time.After(2 * time.Second)
	for {
		n, _ := st.CountIngest()
		if n >= 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("message was not ingested within 2s")
		case <-time.After(5 * time.Millisecond):
		}
	}
	// Inducing an error must not panic or stop the loop; cancel ends the test.
	mb.fetchErr = errors.New("transient")
	mb.messages[101] = msg(101, "b@bank.com")
	mb.uids = append(mb.uids, 101)
	time.Sleep(30 * time.Millisecond) // a few error cycles
	cancel()
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/ingest/ -run TestRun`
Expected: FAIL — `w.Run undefined`.

- [ ] **Step 3: Implement `Run`**

Append to `internal/ingest/ingest.go`:

```go
// Run polls the mailbox every interval until ctx is cancelled. Transient errors
// are logged and retried on the next cycle; the worker never crashes the process.
func (w *Worker) Run(ctx context.Context) {
	w.log.Printf("ingest worker started (poll every %s)", w.interval)
	for {
		n, err := w.syncOnce(ctx)
		switch {
		case ctx.Err() != nil:
			w.log.Printf("ingest worker stopping")
			return
		case err != nil:
			w.log.Printf("ingest sync error: %v", err)
		case n > 0:
			w.log.Printf("ingest: %d new message(s)", n)
		}
		select {
		case <-ctx.Done():
			w.log.Printf("ingest worker stopping")
			return
		case <-time.After(w.interval):
		}
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/ingest/`
Expected: PASS (all ingest tests).

- [ ] **Step 5: Run with the race detector** (the worker is concurrent)

Run: `go test -race ./internal/ingest/`
Expected: PASS, no race warnings.

- [ ] **Step 6: Commit**

```bash
git add internal/ingest/
git commit -m "feat(ingest): poll loop with graceful context cancellation"
```

---

## Task 6: Real IMAP adapter (`internal/ingest/imap.go`)

The thin translation layer from `Mailbox`/`Dialer` to `github.com/emersion/go-imap/v2`. Dials TLS, logs in with the app password, opens the folder with `EXAMINE` (read-only), lists UIDs via `UID SEARCH ALL`, and fetches envelope + full body. Auth is app-password only; `oauth2` returns a clear "not implemented" error so config stays forward-compatible.

**Files:**
- Create: `internal/ingest/imap.go`
- Test: `internal/ingest/imap_integration_test.go` (env-gated; skips by default)

- [ ] **Step 1: Add the dependency**

```bash
go get github.com/emersion/go-imap/v2@v2.0.0-beta.8
```

Expected: `go.mod` now requires `github.com/emersion/go-imap/v2`.

- [ ] **Step 2: Write the adapter**

Create `internal/ingest/imap.go`:

```go
package ingest

import (
	"context"
	"fmt"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"ledger/internal/config"
)

// imapDialer opens authenticated, read-only IMAP connections from config.
type imapDialer struct {
	cfg config.IMAPConfig
}

// NewIMAPDialer returns a Dialer backed by go-imap/v2.
func NewIMAPDialer(cfg config.IMAPConfig) Dialer { return &imapDialer{cfg: cfg} }

func (d *imapDialer) Dial(ctx context.Context) (Mailbox, error) {
	c, err := imapclient.DialTLS(d.cfg.Addr(), nil)
	if err != nil {
		return nil, fmt.Errorf("imap dial %s: %w", d.cfg.Addr(), err)
	}
	switch d.cfg.Auth {
	case "app_password", "":
		if err := c.Login(d.cfg.Username, d.cfg.AppPassword).Wait(); err != nil {
			_ = c.Close()
			return nil, fmt.Errorf("imap login: %w", err)
		}
	case "oauth2":
		_ = c.Close()
		return nil, fmt.Errorf("imap auth oauth2 not implemented yet; use app_password")
	default:
		_ = c.Close()
		return nil, fmt.Errorf("imap: unknown auth %q", d.cfg.Auth)
	}
	return &imapMailbox{c: c, folder: d.cfg.Folder}, nil
}

type imapMailbox struct {
	c      *imapclient.Client
	folder string
}

func (m *imapMailbox) Examine(ctx context.Context) (uint32, error) {
	// ReadOnly = true makes Select issue EXAMINE: the server forbids any mutation.
	data, err := m.c.Select(m.folder, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		return 0, fmt.Errorf("examine %q: %w", m.folder, err)
	}
	return data.UIDValidity, nil
}

func (m *imapMailbox) ListUIDs(ctx context.Context) ([]uint32, error) {
	// Empty criteria == SEARCH ALL.
	data, err := m.c.UIDSearch(&imap.SearchCriteria{}, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("uid search: %w", err)
	}
	uids := data.AllUIDs()
	out := make([]uint32, len(uids))
	for i, u := range uids {
		out[i] = uint32(u)
	}
	return out, nil
}

func (m *imapMailbox) Fetch(ctx context.Context, uid uint32) (Message, error) {
	section := &imap.FetchItemBodySection{} // zero value == whole body (BODY[])
	opts := &imap.FetchOptions{
		Envelope:     true,
		InternalDate: true,
		UID:          true,
		BodySection:  []*imap.FetchItemBodySection{section},
	}
	msgs, err := m.c.Fetch(imap.UIDSetNum(imap.UID(uid)), opts).Collect()
	if err != nil {
		return Message{}, fmt.Errorf("fetch uid %d: %w", uid, err)
	}
	if len(msgs) == 0 {
		return Message{}, fmt.Errorf("fetch uid %d: no message returned", uid)
	}
	buf := msgs[0]
	out := Message{UID: uid, Raw: buf.FindBodySection(section)}
	if buf.Envelope != nil {
		out.Subject = buf.Envelope.Subject
		out.ReceivedAt = buf.Envelope.Date
		if len(buf.Envelope.From) > 0 {
			out.From = buf.Envelope.From[0].Addr()
		}
	}
	if !buf.InternalDate.IsZero() {
		out.ReceivedAt = buf.InternalDate
	}
	return out, nil
}

func (m *imapMailbox) Close() error {
	_ = m.c.Logout().Wait()
	return m.c.Close()
}
```

- [ ] **Step 3: Write the env-gated live test**

Create `internal/ingest/imap_integration_test.go`:

```go
package ingest

import (
	"context"
	"os"
	"testing"

	"ledger/internal/config"
)

// TestIMAPDialerLive exercises the real adapter against a real mailbox. It is
// skipped unless LEDGER_TEST_IMAP_HOST / _USERNAME / _APP_PASSWORD are set, so
// `go test ./...` stays hermetic in CI. Run on dinosaur to validate the adapter:
//
//	LEDGER_TEST_IMAP_HOST=imap.gmail.com \
//	LEDGER_TEST_IMAP_USERNAME=bankmail@gmail.com \
//	LEDGER_TEST_IMAP_APP_PASSWORD=xxxxxxxxxxxxxxxx \
//	go test ./internal/ingest/ -run TestIMAPDialerLive -v
func TestIMAPDialerLive(t *testing.T) {
	host := os.Getenv("LEDGER_TEST_IMAP_HOST")
	if host == "" {
		t.Skip("set LEDGER_TEST_IMAP_* to run the live IMAP adapter test")
	}
	cfg := config.IMAPConfig{
		Host:        host,
		Port:        993,
		Username:    os.Getenv("LEDGER_TEST_IMAP_USERNAME"),
		Auth:        "app_password",
		Folder:      "INBOX",
		ReadOnly:    true,
		AppPassword: os.Getenv("LEDGER_TEST_IMAP_APP_PASSWORD"),
	}
	d := NewIMAPDialer(cfg)
	mb, err := d.Dial(context.Background())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer mb.Close()

	if _, err := mb.Examine(context.Background()); err != nil {
		t.Fatalf("Examine: %v", err)
	}
	uids, err := mb.ListUIDs(context.Background())
	if err != nil {
		t.Fatalf("ListUIDs: %v", err)
	}
	t.Logf("mailbox has %d messages", len(uids))
	if len(uids) > 0 {
		m, err := mb.Fetch(context.Background(), uids[0])
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if len(m.Raw) == 0 {
			t.Error("fetched message has empty raw body")
		}
		t.Logf("first message: from=%q subject=%q bytes=%d", m.From, m.Subject, len(m.Raw))
	}
}
```

- [ ] **Step 4: Verify it compiles and the suite passes (live test skips)**

Run: `go build ./... && go test ./internal/ingest/`
Expected: build clean; tests PASS with `TestIMAPDialerLive` reported as skipped.
(If the build fails on a go-imap symbol, the pinned version's signature differs — reconcile against `go doc github.com/emersion/go-imap/v2/imapclient` for the installed version; the worker logic in Tasks 4–5 is unaffected.)

- [ ] **Step 5: Tidy and commit**

```bash
go mod tidy
git add internal/ingest/imap.go internal/ingest/imap_integration_test.go go.mod go.sum
git commit -m "feat(ingest): real go-imap/v2 read-only adapter (app-password auth)"
```

---

## Task 7: Surface ingest status in `/api/health`

Enriches the health endpoint (§6.7) with whether IMAP is configured, how many messages have been ingested, and the last ingest time — the signal that proves the worker is alive. M1's `New(store, webFS)` signature is preserved (the ingest source is set separately), so existing tests keep passing.

**Files:**
- Modify: `internal/server/server.go`
- Modify: `internal/server/health.go`
- Test: `internal/server/server_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/server/server_test.go` (note: add `"time"` to the import block):

```go
// fakeIngest drives the ingest portion of the health response.
type fakeIngest struct {
	count int
	last  time.Time
	ok    bool
}

func (f fakeIngest) CountIngest() (int, error)              { return f.count, nil }
func (f fakeIngest) LastIngestAt() (time.Time, bool, error) { return f.last, f.ok, nil }

func TestHealthIncludesIngestWhenSet(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	srv.SetIngest(fakeIngest{count: 3, last: time.Date(2026, 6, 14, 12, 0, 0, 0, time.UTC), ok: true}, true)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	var body struct {
		Ingest *struct {
			Configured bool   `json:"configured"`
			Count      int    `json:"count"`
			LastAt     string `json:"last_at"`
		} `json:"ingest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Ingest == nil {
		t.Fatal("expected ingest section in health response")
	}
	if !body.Ingest.Configured || body.Ingest.Count != 3 {
		t.Errorf("ingest = %+v, want configured=true count=3", *body.Ingest)
	}
}

func TestHealthOmitsIngestWhenUnset(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if got := rec.Body.String(); contains(got, "\"ingest\"") {
		t.Errorf("did not expect ingest section when unset: %s", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/server/`
Expected: FAIL — `srv.SetIngest undefined`.

- [ ] **Step 3: Add the ingest source to the server**

In `internal/server/server.go`, add the `"time"` import, the `IngestStatus` interface, the two new `Server` fields, and the `SetIngest` setter.

Add to the imports:

```go
import (
	"io/fs"
	"net/http"
	"time"
)
```

Add after the `HealthChecker` interface:

```go
// IngestStatus is the optional ingest data the health endpoint reports. The
// store satisfies it; if unset, /api/health omits the ingest section.
type IngestStatus interface {
	CountIngest() (int, error)
	LastIngestAt() (time.Time, bool, error)
}
```

Change the `Server` struct to:

```go
// Server holds the router and its dependencies.
type Server struct {
	mux            *http.ServeMux
	store          HealthChecker
	ingest         IngestStatus
	imapConfigured bool
}
```

Add the setter (after `New`):

```go
// SetIngest wires the optional ingest status into /api/health. configured
// reflects whether a mailbox is set in config.
func (s *Server) SetIngest(src IngestStatus, configured bool) {
	s.ingest = src
	s.imapConfigured = configured
}
```

- [ ] **Step 4: Populate the ingest section in the handler**

In `internal/server/health.go`, replace the file contents with:

```go
package server

import (
	"encoding/json"
	"net/http"
	"time"
)

// healthResponse is the JSON shape of /api/health. The ingest section is present
// only when an ingest source has been wired (SetIngest).
type healthResponse struct {
	Status string        `json:"status"`
	DB     string        `json:"db"`
	Ingest *ingestHealth `json:"ingest,omitempty"`
}

type ingestHealth struct {
	Configured bool   `json:"configured"`
	Count      int    `json:"count"`
	LastAt     string `json:"last_at,omitempty"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := healthResponse{Status: "ok", DB: "ok"}
	code := http.StatusOK
	if err := s.store.Ping(); err != nil {
		resp.Status = "degraded"
		resp.DB = "unreachable"
		code = http.StatusServiceUnavailable
	}
	if s.ingest != nil {
		ih := &ingestHealth{Configured: s.imapConfigured}
		if count, err := s.ingest.CountIngest(); err == nil {
			ih.Count = count
		}
		if at, ok, err := s.ingest.LastIngestAt(); err == nil && ok {
			ih.LastAt = at.UTC().Format(time.RFC3339)
		}
		resp.Ingest = ih
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(resp)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./internal/server/`
Expected: PASS (M1 health tests + the two new ingest tests).

- [ ] **Step 6: Commit**

```bash
git add internal/server/
git commit -m "feat(server): report ingest status (configured/count/last) in /api/health"
```

---

## Task 8: Wire the worker into `cmd/ledger/main.go`

Starts the ingest worker as a goroutine when IMAP is configured, sharing the signal context so SIGTERM stops it cleanly. Wires the store as the health ingest source.

**Files:**
- Modify: `cmd/ledger/main.go`

- [ ] **Step 1: Rewrite `main.go`**

Replace `cmd/ledger/main.go` with (adds `ingest` import, moves the signal context above the worker, wires `SetIngest`):

```go
// Command ledger is the single binary: it loads config, opens the SQLite store,
// starts the IMAP ingest worker (when configured), and serves the API + embedded
// PWA over HTTP. It binds to localhost and is fronted by Tailscale/Caddy for
// HTTPS (see deploy/README.md).
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
	"ledger/internal/ingest"
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
	srv.SetIngest(st, cfg.IMAP.Enabled())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Start the ingest worker when a mailbox is configured.
	if cfg.IMAP.Enabled() {
		interval, err := cfg.IMAP.Interval()
		if err != nil {
			log.Fatalf("imap poll_interval: %v", err)
		}
		dialer := ingest.NewIMAPDialer(cfg.IMAP)
		worker := ingest.New(dialer, st, interval, log.Default())
		go worker.Run(ctx)
		log.Printf("ingest enabled for %s (mailbox %s, poll %s)", cfg.IMAP.Username, cfg.IMAP.Folder, interval)
	} else {
		log.Printf("ingest disabled (no imap.host configured)")
	}

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

	<-ctx.Done()

	log.Println("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
```

- [ ] **Step 2: Build and run the full suite**

Run: `go build ./... && go test ./...`
Expected: build clean; all packages PASS (`cmd/ledger`, `internal/web` report no test files).

- [ ] **Step 3: Smoke-test the binary with ingestion disabled (no imap config)**

```bash
CGO_ENABLED=0 go build -o ledger ./cmd/ledger
LEDGER_DATA_DIR=./data LEDGER_LISTEN=127.0.0.1:8080 ./ledger &
sleep 1
curl -s http://127.0.0.1:8080/api/health
echo
kill %1
rm -rf ./data ./ledger
```

Expected: health prints `{"status":"ok","db":"ok","ingest":{"configured":false,"count":0}}` and the log shows `ingest disabled (no imap.host configured)`.

- [ ] **Step 4: Commit**

```bash
git add cmd/ledger/main.go
git commit -m "feat(cmd): start the ingest worker and wire ingest health when imap configured"
```

---

## Task 9: Sample config & deploy runbook for the mailbox

Documents the `[imap]` block and the dedicated-mailbox setup (Gmail + app password + iCloud forwarding) plus where the secret lives. Non-code; verified manually in Task 10.

**Files:**
- Modify: `config.example.toml`
- Modify: `deploy/README.md`

- [ ] **Step 1: Activate the `[imap]` block in `config.example.toml`**

Replace the commented `# [imap]` block with an active one (leave `[ai]`, `[budget]`, `[monitoring]` commented as before):

```toml
[imap]
host          = "imap.gmail.com"        # dedicated mailbox provider
port          = 993                     # implicit TLS (IMAPS); cert is verified
username      = "salehledgerbank@gmail.com"
auth          = "app_password"          # "app_password" (only supported in M2) | "oauth2" (later)
folder        = "INBOX"
read_only     = true                    # opened with EXAMINE; the app can never alter mail
use_idle      = false                   # reserved; Milestone 2 is poll-only
poll_interval = "60s"
# Secret is NEVER stored here. Set it in the environment / systemd:
#   LEDGER_IMAP_APP_PASSWORD = the 16-char Gmail App Password
```

- [ ] **Step 2: Add the mailbox setup + secret + verification sections to `deploy/README.md`**

Append to `deploy/README.md`:

````markdown
## 5. Dedicated mailbox (Milestone 2 — ingest)

ledger reads a **dedicated mailbox** that contains *only* forwarded bank mail, so its
credential can never reach your personal email (§9). Recommended: a fresh Gmail.

### 5a. Create the mailbox + app password

1. Create a new Gmail used for nothing else, e.g. `salehledgerbank@gmail.com`.
2. Enable **2-Step Verification** (Google Account → Security). Use standard 2SV,
   **not** Advanced Protection (which disables app passwords).
3. Generate a 16-character **App Password** (Security → App passwords). Copy it once.
4. IMAP is on by default for new Gmail accounts; host is `imap.gmail.com:993`.

### 5b. Forward bank mail from your primary inbox

In **iCloud Mail → Settings → Rules** (icloud.com), add one rule per bank sender:

> If a message **is from** `alerts@emiratesnbd.com` → **Forward to** `salehledgerbank@gmail.com`

Repeat for each bank sender. (You can add senders later as you discover them.)

### 5c. Configure ledger on dinosaur

Point config at the mailbox (no secret here):

```toml
# in /etc/ledger/config.toml
[imap]
host          = "imap.gmail.com"
port          = 993
username      = "salehledgerbank@gmail.com"
auth          = "app_password"
folder        = "INBOX"
read_only     = true
poll_interval = "60s"
```

Put the secret in the root-only env file the unit already loads:

```bash
sudo install -m 0600 /dev/stdin /etc/ledger/ledger.env <<'EOF'
LEDGER_IMAP_APP_PASSWORD=xxxxxxxxxxxxxxxx
EOF
sudo chown ledger:ledger /etc/ledger/ledger.env
sudo systemctl restart ledger
```

> The systemd unit reads `EnvironmentFile=-/etc/ledger/ledger.env`. For stronger
> protection, switch to systemd's encrypted credential store (`LoadCredential=` /
> `systemd-creds`) later — the env file is the simplest secure default.

### 5d. Verify ingestion

```bash
journalctl -u ledger -f          # expect "ingest enabled ..." then "ingest: N new message(s)"
curl -s http://127.0.0.1:8080/api/health    # ingest.configured=true, count rises as mail arrives
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "SELECT count(*), max(created_at) FROM ingest_log;"
```

Send a test email from one of the configured bank senders (or wait for a real
transaction alert) and confirm `ingest_log` grows. Because the mailbox is opened
read-only (`EXAMINE`), ledger can never delete or modify the mail.
````

- [ ] **Step 3: Commit**

```bash
git add config.example.toml deploy/README.md
git commit -m "docs(deploy): dedicated mailbox setup, secret handling, and ingest verification"
```

---

## Task 10: Live ingest verification on dinosaur (manual)

The milestone's acceptance criterion (§10.2): *"`ingest_log` fills as forwarded bank emails arrive; the app cannot alter mail."* This is a manual checklist run on dinosaur — there is no automated test for a live mailbox. Requires the user to have completed P2 (Gmail + app password + forwarding).

- [ ] **Step 1: Adapter sanity check (live).** On dinosaur, with the app password exported, run the env-gated adapter test:

```bash
LEDGER_TEST_IMAP_HOST=imap.gmail.com \
LEDGER_TEST_IMAP_USERNAME=salehledgerbank@gmail.com \
LEDGER_TEST_IMAP_APP_PASSWORD=xxxxxxxxxxxxxxxx \
go test ./internal/ingest/ -run TestIMAPDialerLive -v
```

Expected: PASS, logging the mailbox message count (proves TLS + login + EXAMINE + fetch all work against real Gmail).

- [ ] **Step 2: Deploy the new binary.** Follow `deploy/README.md` §1–2 to build and install the updated binary, then configure the mailbox per §5c.

- [ ] **Step 3: Confirm ingestion starts.** `journalctl -u ledger -f` shows `ingest enabled ...`. Within one `poll_interval`, any existing mail backfills: `ingest: N new message(s)`.

- [ ] **Step 4: Confirm health reflects ingestion.**

```bash
curl -s http://127.0.0.1:8080/api/health
```
Expected: `ingest.configured = true`, `ingest.count > 0` (if the mailbox has mail), `ingest.last_at` set.

- [ ] **Step 5: Confirm a new transaction lands.** Trigger or wait for a fresh bank email (or forward a sample). Within `poll_interval`, `ingest_log` count increments and `last_at` advances.

- [ ] **Step 6: Confirm read-only.** From the Gmail web UI, the mail is untouched (unread stays unread, nothing deleted) — ledger opened with `EXAMINE`. Optionally confirm no `\Seen` flag changes.

- [ ] **Step 7: Restart safety.** `sudo systemctl restart ledger`; confirm the worker resumes and does **not** re-insert already-seen messages (count holds steady, no duplicates — idempotent via stored UIDs).

- [ ] **Step 8: Tag the milestone.**

```bash
git tag -a m2-ingest -m "Milestone 2: IMAP ingest (no parsing) complete"
git push origin m2-ingest
```

---

## Definition of Done

- [ ] `go build ./...`, `go vet ./...`, `go test ./...`, and `go test -race ./internal/ingest/` all pass; `CGO_ENABLED=0 go build` still produces a static binary.
- [ ] With no `[imap]` config, the app runs exactly as in M1 (ingest disabled, health shows `ingest.configured=false`).
- [ ] With `[imap]` configured + `LEDGER_IMAP_APP_PASSWORD` set, the worker connects over TLS, opens the mailbox read-only, backfills existing mail, and polls for new mail — every message stored in `ingest_log` with full `raw_body` and `parse_status='unparsed'`.
- [ ] Ingestion is idempotent: restarting never double-inserts (UID + UIDVALIDITY namespacing; `INSERT OR IGNORE`).
- [ ] `/api/health` reports ingest configured/count/last_at.
- [ ] The app opens with `EXAMINE` and cannot alter mail (verified live in Task 10).
- [ ] No secrets in the repo or `config.toml`; the app password comes only from the environment.
- [ ] Deployed on dinosaur reading the dedicated Gmail mailbox; `ingest_log` fills as bank mail arrives.

---

## Self-Review notes (author)

- **Spec coverage (§10.2 / §6.1 / §7 / §9):** IMAP over TLS ✅ (T6, `DialTLS`), read-only `EXAMINE` ✅ (T6 `SelectOptions{ReadOnly:true}`, enforced in config T1), backfill via stored UIDs ✅ (T4 `KnownUIDs` diff), live updates ✅ poll loop (T5; IDLE deferred by decision — `use_idle` reserved), full raw body retained ✅ (T2/T4 `raw_body`), nothing parsed ✅ (`parse_status='unparsed'`, bank/ tier/sig NULL). Robust to reconnects ✅ (dial-per-cycle). Auth app-password ✅ with OAuth2 stubbed to a clear error (T1 validate + T6 Dial). Secret via env only ✅ (T1). Health enrichment (§6.7 IMAP/last-ingest) ✅ partial — connection liveness is implicit via last-ingest; explicit "imap connected" indicator deferred until IDLE/persistent connection exists.
- **Deferred deliberately:** IDLE (poll-only), bank detection + `structure_sig` (M3 parse cascade), OAuth2 auth, encrypted credential store (env file is the M2 default, noted for upgrade).
- **Type consistency:** `Mailbox`/`Dialer`/`Message` (T3) consumed by `Worker` (T4–5) and implemented by `imapMailbox`/`imapDialer` (T6). `store.IngestRecord` + `InsertIngest/KnownUIDs/CountIngest/LastIngestAt` (T2) used by the worker (T4) and `server.IngestStatus` (T7, satisfied by `*store.Store`). `config.IMAPConfig` (T1) consumed by `NewIMAPDialer` (T6) and `main` (T8). `New(d Dialer, st *store.Store, interval time.Duration, logger *log.Logger)` consistent across T4/T5 tests and T8 wiring.
- **External-lib risk:** the go-imap/v2 signatures in T6 were verified against `v2.0.0-beta.8` (`DialTLS`, `Client.Login/Select/UIDSearch/Fetch`, `SelectData.UIDValidity`, `SearchData.AllUIDs`, `FetchMessageBuffer.FindBodySection/Envelope/InternalDate`, `imap.UIDSetNum`, `Address.Addr`). T6 step 4 catches drift if a different version is resolved; the tested worker logic (T4–5) is library-agnostic.
- **No placeholders:** every code step is complete and compilable; every run step states the command and expected output.
```
