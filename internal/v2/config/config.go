// Package config loads ledgerd's (v2) TOML configuration, applying defaults,
// environment overrides, and validation. It is a separate package from v1's
// internal/config: v2 is multi-user, Postgres-backed, and runs alongside v1
// without sharing a port, a database, or a config file.
//
// Secrets are never read from the TOML file; they come from the environment
// only (LEDGER_*). Load rejects a config file that sets a secret's TOML key
// (or any other key it does not recognize) rather than silently ignoring it,
// so a misplaced secret fails loudly at startup instead of quietly missing
// its env override.
package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/BurntSushi/toml"

	"ledger/internal/v2/blob"
)

// Config is the full v2 configuration surface. Every later Phase 1 task
// wires its subsystem's settings into this struct rather than inventing its
// own config path.
type Config struct {
	// Mode is the dispatch mode cmd/ledgerd is running as (see Modes). It is
	// never read from TOML or the environment — main() sets it from
	// os.Args[1] after Load succeeds.
	Mode string `toml:"-"`

	Server ServerConfig `toml:"server"`
	Mail   MailConfig   `toml:"mail"`
	Relay  RelayConfig  `toml:"relay"`
	Push   PushConfig   `toml:"push"`
	Auth   AuthConfig   `toml:"auth"`

	// DictHMACKey keys the merchant-dictionary submitter HMAC (Task 33,
	// LEDGER_DICT_HMAC_KEY). It is a cryptographic key, not a setting:
	// env-only, never TOML.
	DictHMACKey string `toml:"-"`
}

// ServerConfig controls the HTTP/admin listeners and the Postgres DSN.
type ServerConfig struct {
	HTTPListen  string `toml:"http_listen"`
	AdminListen string `toml:"admin_listen"`
	DSN         string `toml:"dsn"`

	// AdminToken authenticates the Tailscale-bound admin API (Task 32,
	// LEDGER_ADMIN_TOKEN). Env-only, never TOML.
	AdminToken string `toml:"-"`
}

// MailConfig controls the SMTP receiver (Task 24) and inbound addressing
// (Task 22). Domain has no default on purpose — see the package doc and
// the plan's D1 task: the domain is not chosen yet, and every inbound
// address v2 issues is derived from it, so a wrong or accidental default
// would be a silent, hard-to-notice misconfiguration.
type MailConfig struct {
	Domain           string        `toml:"domain"`
	SMTPListen       string        `toml:"smtp_listen"`
	MaxMessageBytes  int           `toml:"max_message_bytes"`
	PerAddressDaily  int           `toml:"per_address_daily"`
	InvalidRcptBurst int           `toml:"invalid_rcpt_burst"`
	TarpitBase       time.Duration `toml:"tarpit_base"`
}

// RelayConfig controls both sides of the backup-relay path (Task 35):
// Enabled gates whether the primary mounts the relay-facing API, and
// PrimaryURL/SpoolDir/Token configure a process running in relay mode.
type RelayConfig struct {
	Enabled    bool   `toml:"enabled"`
	PrimaryURL string `toml:"primary_url"`
	SpoolDir   string `toml:"spool_dir"`

	// Token authenticates relay -> primary delivery (Task 35,
	// LEDGER_RELAY_TOKEN). Env-only, never TOML.
	Token string `toml:"-"`
}

// PushConfig controls content-free Expo push (Task 29). Enabled defaults to
// false; Phase 1 wires the Disabled pusher until a client exists.
type PushConfig struct {
	Enabled bool   `toml:"enabled"`
	ExpoURL string `toml:"expo_url"`

	// AccessToken is Expo's optional enhanced-security push token (Task 29,
	// LEDGER_EXPO_ACCESS_TOKEN). Env-only, never TOML.
	AccessToken string `toml:"-"`
}

// AuthConfig controls IdP token verification and session lifetime (Task 6).
// The client IDs are public OAuth identifiers, not secrets, so they are
// ordinary TOML/env settings.
type AuthConfig struct {
	AppleClientIDs  []string      `toml:"apple_client_ids"`
	GoogleClientIDs []string      `toml:"google_client_ids"`
	SessionTTL      time.Duration `toml:"session_ttl"`
}

// modeOrder lists every dispatch mode cmd/ledgerd's main() is meant to
// recognize, in the order its dispatch table declares them. This package
// cannot see cmd/ledgerd (config is imported by main, not the reverse), so
// it cannot itself verify that main's dispatch table actually has an entry
// for each of these — see the "cross-package coverage" note on
// modeImplemented below for where that's actually checked.
var modeOrder = []string{"serve", "relay", "verify", "seed-dictionary", "purge-user", "parse-rate"}

// modeImplemented is this package's own declared expectation of which modes
// in modeOrder are meant to have a real dispatch entry in cmd/ledgerd.
// "Implemented" means dispatched, not that the mode's subsystem is
// finished — runRelay, runVerify, runSeedDictionary, runPurgeUser and
// runParseRate return a "not implemented yet" error naming the task that
// fills them in, until that task lands.
//
// Cross-package coverage, read this before trusting TestEveryDispatchModeHasACase:
// modeOrder and modeImplemented are both defined in this file, so a test
// that only compares them (as TestEveryDispatchModeHasACase below does) is
// checking this package's internal bookkeeping against itself — it cannot
// detect a mode added here without a matching case in cmd/ledgerd's actual
// dispatch table, which lives in a different package entirely. That
// real check — the one that would actually catch a mode advertised here
// with no cmd/ledgerd handler — is cmd/ledgerd/main_test.go's
// TestModeHandlersCoverConfigModesExactly, which reads cmd/ledgerd's own
// modeHandlers map directly, plus a checkModeHandlers() call at the top of
// main() that panics on the same drift at runtime, every time the binary
// is invoked. Keep both in sync by hand; nothing here enforces it.
var modeImplemented = map[string]bool{
	"serve":           true,
	"relay":           true,
	"verify":          true,
	"seed-dictionary": true,
	"purge-user":      true,
	"parse-rate":      true,
}

// Modes returns every mode cmd/ledgerd is meant to dispatch on. cmd/ledgerd
// builds its default-case usage message from this slice rather than
// repeating the literal list, so at least that part can't drift; whether
// every entry actually has a dispatch case is verified in cmd/ledgerd's own
// tests (see the modeImplemented doc comment above).
func Modes() []string {
	out := make([]string, len(modeOrder))
	copy(out, modeOrder)
	return out
}

func modeIsImplemented(mode string) bool { return modeImplemented[mode] }

// InboundSuffix returns the domain suffix every v2 inbound address ends
// with, e.g. "@in.example.test" for Mail.Domain "example.test".
func (c Config) InboundSuffix() string { return "@in." + c.Mail.Domain }

func defaults() Config {
	return Config{
		Server: ServerConfig{
			HTTPListen:  ":443",
			AdminListen: "127.0.0.1:8079",
		},
		Mail: MailConfig{
			SMTPListen:       ":25",
			MaxMessageBytes:  blob.MaxColdMail,
			PerAddressDaily:  50,
			InvalidRcptBurst: 5,
			TarpitBase:       2 * time.Second,
		},
		Auth: AuthConfig{
			SessionTTL: 30 * 24 * time.Hour,
		},
	}
}

// Load reads config from path (if non-empty), applies defaults for any
// field the file leaves unset, applies environment overrides, then
// validates. A TOML file that sets a key with no matching field — most
// importantly a secret field, which is tagged `toml:"-"` precisely so it
// can never be filled from a file — is rejected outright rather than
// silently ignored: BurntSushi/toml's default behavior for an unmapped key
// is to leave it undecoded and say nothing, which for a secret means the
// operator believes they've set LEDGER_ADMIN_TOKEN-equivalent config from a
// file that has no effect at all.
func Load(path string) (Config, error) {
	cfg := defaults()
	if path != "" {
		meta, err := toml.DecodeFile(path, &cfg)
		if err != nil {
			return Config{}, fmt.Errorf("decode config %q: %w", path, err)
		}
		if bad := meta.Undecoded(); len(bad) > 0 {
			keys := make([]string, len(bad))
			for i, k := range bad {
				keys[i] = k.String()
			}
			return Config{}, fmt.Errorf(
				"config %q sets unrecognized key(s) %s: secrets (tokens, keys) must come from "+
					"the environment (LEDGER_*) and are never read from TOML, and misspelled keys "+
					"are rejected rather than silently ignored",
				path, strings.Join(keys, ", "))
		}
	}

	if v := os.Getenv("LEDGER_MAIL_DOMAIN"); v != "" {
		cfg.Mail.Domain = v
	}
	if v := os.Getenv("LEDGER_PG_DSN"); v != "" {
		cfg.Server.DSN = v
	}
	if v := os.Getenv("LEDGER_HTTP_LISTEN"); v != "" {
		cfg.Server.HTTPListen = v
	}
	if v := os.Getenv("LEDGER_ADMIN_LISTEN"); v != "" {
		cfg.Server.AdminListen = v
	}
	if v := os.Getenv("LEDGER_SMTP_LISTEN"); v != "" {
		cfg.Mail.SMTPListen = v
	}
	if v := os.Getenv("LEDGER_RELAY_TOKEN"); v != "" {
		cfg.Relay.Token = v
	}
	if v := os.Getenv("LEDGER_RELAY_PRIMARY_URL"); v != "" {
		cfg.Relay.PrimaryURL = v
	}
	if v := os.Getenv("LEDGER_APPLE_CLIENT_IDS"); v != "" {
		cfg.Auth.AppleClientIDs = splitCSV(v)
	}
	if v := os.Getenv("LEDGER_GOOGLE_CLIENT_IDS"); v != "" {
		cfg.Auth.GoogleClientIDs = splitCSV(v)
	}
	if v := os.Getenv("LEDGER_EXPO_ACCESS_TOKEN"); v != "" {
		cfg.Push.AccessToken = v
	}
	if v := os.Getenv("LEDGER_ADMIN_TOKEN"); v != "" {
		cfg.Server.AdminToken = v
	}
	if v := os.Getenv("LEDGER_DICT_HMAC_KEY"); v != "" {
		cfg.DictHMACKey = v
	}

	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// splitCSV splits a comma-separated env value into trimmed, non-empty parts.
func splitCSV(v string) []string {
	fields := strings.Split(v, ",")
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		f = strings.TrimSpace(f)
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}

func (c Config) validate() error {
	if c.Mail.Domain == "" {
		return fmt.Errorf("mail.domain is required (LEDGER_MAIL_DOMAIN); v2 derives every inbound address from it")
	}
	if c.Server.DSN == "" {
		return fmt.Errorf("server.dsn is required (LEDGER_PG_DSN)")
	}
	// Hard rail: v1 owns :8080 and /var/lib/ledger on this box.
	for _, addr := range []string{c.Server.HTTPListen, c.Server.AdminListen, c.Mail.SMTPListen} {
		if strings.HasSuffix(addr, ":8080") {
			return fmt.Errorf("refusing to bind %q: :8080 belongs to the running v1 instance", addr)
		}
	}
	if strings.Contains(c.Server.DSN, "/var/lib/ledger") {
		return fmt.Errorf("refusing a dsn pointing at the v1 data directory")
	}
	// Spec section 3.2 caps DATA at 1 MB; blob.MaxColdMail is stricter, and it
	// is the binding one. A message is stored as a cold blob with its bytes
	// base64'd inside a JSON record, so incompressible mail reaches gzip already
	// inflated 4/3 and a message in the top fraction of a percent of the 1 MiB
	// range frames past the largest size bucket. Accepting mail over SMTP that
	// the ingest path then cannot store is the worst available failure, so the
	// receiver refuses it at DATA instead.
	if c.Mail.MaxMessageBytes <= 0 || c.Mail.MaxMessageBytes > blob.MaxColdMail {
		return fmt.Errorf("mail.max_message_bytes must be 1..%d (blob.MaxColdMail: the largest message that always fits a size bucket)", blob.MaxColdMail)
	}
	if c.Server.HTTPListen == "" {
		return fmt.Errorf("server.http_listen must not be empty")
	}
	if c.Server.AdminListen == "" {
		return fmt.Errorf("server.admin_listen must not be empty")
	}
	if c.Mail.SMTPListen == "" {
		return fmt.Errorf("mail.smtp_listen must not be empty")
	}
	if c.Mail.PerAddressDaily <= 0 {
		return fmt.Errorf("mail.per_address_daily must be positive")
	}
	if c.Mail.InvalidRcptBurst <= 0 {
		return fmt.Errorf("mail.invalid_rcpt_burst must be positive")
	}
	if c.Mail.TarpitBase <= 0 {
		return fmt.Errorf("mail.tarpit_base must be positive")
	}
	if c.Auth.SessionTTL <= 0 {
		return fmt.Errorf("auth.session_ttl must be positive")
	}
	return nil
}
