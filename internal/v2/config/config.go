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
	"net"
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

	// DevAuth makes the sign-in exchange accept `dev:<subject>` as an ID
	// token and REJECT every real one (auth.NewDevVerifier). TEST ONLY: it
	// is set by `ledgerd serve --dev-auth`, never by TOML and never by the
	// environment, and EnableTestOnly refuses it off loopback.
	DevAuth bool `toml:"-"`

	// Purge carries `ledgerd purge-user`'s own arguments. Command-line only,
	// on the same terms as Mode and DevAuth: which account an operator is
	// about to delete must be answerable from the command that ran and from
	// nowhere else. A TOML key or an environment variable here would be a
	// standing instruction to destroy an account, sitting in a file.
	Purge PurgeArgs `toml:"-"`

	// Verify carries the arguments of `ledgerd verify` and `ledgerd
	// parse-rate`. Command-line only, for a plainer reason than Purge's: these
	// are measurements over a window an operator names when they run them, and
	// a window pinned in a config file would silently answer a question nobody
	// asked.
	Verify VerifyArgs `toml:"-"`

	// Consent carries `ledgerd record-consent`'s arguments. Command-line only,
	// like the two above, and for Purge's reason inverted: what this writes is
	// the deadline after which an account gets deleted, so a value sitting in a
	// config file would be a destruction date nobody typed.
	Consent ConsentArgs `toml:"-"`
}

// ConsentArgs is the `record-consent` mode's command line.
//
// It exists because a retention DEADLINE that only lives in a signed PDF is not
// a deadline. `purge-user --retention-due` enforces user_consent.retention_until
// (spec §5's plaintext-retention commitment), and until this command landed
// nothing anywhere wrote that column — the enforcer had a table and no
// populated input, so a sweep a century past every deadline purged nothing.
//
// Recording is an OPERATOR action and deliberately not automatic. The consent
// it records is a document a person actually signed; a row written by the
// sign-up path would be the server asserting a signature that never happened.
type ConsentArgs struct {
	// User is the account, as a UUID.
	User string
	// Document identifies the consent text that was signed, e.g.
	// "alpha-plaintext-v1". Not the text: an identifier.
	Document string
	// RetentionUntil is the instant that account's plaintext must be gone, as
	// an RFC3339 timestamp.
	RetentionUntil string
	// SignedAt is when they signed, as RFC3339. Empty means now.
	SignedAt string
	// Show lists the recorded deadlines and writes nothing.
	Show bool
}

// PurgeArgs is the `purge-user` mode's command line.
//
// Exactly one of User and RetentionDue is required; runPurgeUser refuses both
// and neither, before it opens a database connection.
type PurgeArgs struct {
	// User is the account to delete, as a UUID.
	User string
	// RetentionDue selects every account whose consent record's retention
	// deadline has passed (spec §5's plaintext-retention commitment).
	RetentionDue bool
	// DryRun reports what would be deleted and deletes nothing.
	DryRun bool
}

// VerifyArgs is the command line shared by `verify` and `parse-rate`.
//
// From and To are kept as STRINGS rather than parsed here: config.Load runs
// before the mode is known, and a malformed --from must be reported by the
// command that reads it, naming the format it wanted, rather than failing the
// whole binary's configuration load with a message about a flag the mode does
// not use.
type VerifyArgs struct {
	// User scopes either command to one account. Empty means every account.
	// It is the same --user flag purge-user takes; a second spelling of "which
	// account" would be a second thing to get wrong.
	User string
	// From and To bound the window, as RFC3339 instants. Empty means the
	// command's own default.
	From, To string
	// Sample is `parse-rate --sample`: the population size above which a
	// uniform sample is drawn instead of adjudicating everything. Zero means
	// verify.DefaultSample.
	Sample int
	// Adjudicate turns `parse-rate` from a report into the interactive pass
	// that READS COLD BODIES. ⚠ PHASE 1 ONLY — it is opt-in precisely so that
	// reading a user's mail is never a side effect of asking for a number.
	Adjudicate bool
	// JSON emits machine-readable output instead of the operator's text report.
	JSON bool
}

// ServerConfig controls the HTTP/admin listeners and the Postgres DSN.
type ServerConfig struct {
	HTTPListen  string `toml:"http_listen"`
	AdminListen string `toml:"admin_listen"`
	DSN         string `toml:"dsn"`

	// AdminToken authenticates the Tailscale-bound admin API (Task 32,
	// LEDGER_ADMIN_TOKEN). Env-only, never TOML.
	AdminToken string `toml:"-"`

	// DNSFixtures is the path to a recorded dns.json (arc.FixtureLookup),
	// served as the DKIM/ARC TXT resolver so mail verification is
	// deterministic and offline. TEST ONLY: set by `ledgerd serve
	// --dns-fixtures`, never by TOML, and refused off loopback.
	DNSFixtures string `toml:"-"`
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
var modeOrder = []string{"serve", "relay", "verify", "seed-dictionary", "purge-user", "record-consent", "parse-rate"}

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
	"record-consent":  true,
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
			// Loopback, not ":443". cmd/ledgerd serves PLAIN HTTP until
			// deployment Task D4 lands TLS, and session bearer tokens plus the
			// whole op log travel over it — so the default must not be a
			// public interface. validate() refuses one too; see there.
			HTTPListen:  "127.0.0.1:8443",
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

// EnableTestOnly applies the two test-only server flags — `--dev-auth` and
// `--dns-fixtures` — and refuses BOTH unless the HTTP listener binds loopback.
// It leaves the config untouched when it refuses.
//
// It is a method rather than part of Load because the flags come from the
// command line and Load only ever reads a file and the environment. That
// separation is the point: neither switch has a TOML key or an env override, so
// "is this deployment accepting dev tokens" is answerable from the command line
// that started it and from nowhere else.
//
// # The loopback rail is currently implied, and is written anyway
//
// validate() already refuses a non-loopback http_listen for every config, so
// today this check cannot fire. Deployment Task D4 is the change that lifts
// that general rail (it adds autocert to runServe and moves the listener to
// :443), and on that day this is the only thing between a public deployment and
// a server that accepts `dev:anyone` as a credential. A rail that is currently
// redundant costs four lines; discovering it was load bearing after the fact
// costs an account takeover.
func (c *Config) EnableTestOnly(devAuth bool, dnsFixtures string) error {
	if !devAuth && dnsFixtures == "" {
		return nil
	}
	if !isLoopbackListen(c.Server.HTTPListen) {
		return fmt.Errorf(
			"refusing --dev-auth/--dns-fixtures with server.http_listen %q: both are TEST-ONLY switches "+
				"(--dev-auth accepts \"dev:<subject>\" as an identity and rejects every real token) and are "+
				"permitted only on a loopback listener",
			c.Server.HTTPListen)
	}
	c.DevAuth = devAuth
	c.Server.DNSFixtures = dnsFixtures
	return nil
}

// isLoopbackListen reports whether a listen address binds only the loopback
// interface. An address with no host (":8443") binds every interface and is
// therefore NOT loopback — that is the case this exists to catch, since it is
// both the Go idiom and the wrong answer here.
func isLoopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		// Not host:port at all. Refusing is the safe reading: an address this
		// function cannot parse is one it cannot vouch for.
		return false
	}
	if host == "" {
		return false
	}
	// "localhost" is resolved by the resolver, not by us, so it is matched by
	// name. Anything else must parse as an IP and be in a loopback range.
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
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
	// The HTTP listener is CLEARTEXT until deployment Task D4 terminates TLS.
	// Everything it carries is sensitive — the session bearer token on every
	// request, and the user's entire op log in the responses — so binding it to
	// anything but loopback puts all of that on the wire in the clear.
	//
	// A deployment assumption that nothing enforces is one a hurried
	// `LEDGER_HTTP_LISTEN=:443` silently breaks with no visible symptom. This
	// is the hard rail, in the same spirit as the :8080 refusal above.
	//
	// Task D4 is the change that lifts it, and it does so by adding autocert to
	// cmd/ledgerd's runServe: the process terminates TLS ITSELF on the public
	// domain. That matters for anyone reading this message — v2 is multi-user
	// with external alpha testers, so unlike v1 it is not behind a tailnet, and
	// there is no reverse proxy in the plan to hide behind either. The remedy
	// is real TLS in this process, not a tunnel around it.
	if !isLoopbackListen(c.Server.HTTPListen) {
		return fmt.Errorf(
			"refusing to bind server.http_listen to %q: this listener is plain HTTP and carries "+
				"session tokens and the whole op log. Bind loopback (e.g. 127.0.0.1:8443) until "+
				"deployment Task D4 adds autocert to runServe, which terminates TLS in-process on "+
				"the public domain and is the change that lifts this rail",
			c.Server.HTTPListen)
	}
	if c.Server.AdminListen == "" {
		return fmt.Errorf("server.admin_listen must not be empty")
	}
	// The admin rail, and the sibling of the http_listen one above. It is
	// STRICTER: http_listen is loopback-only until Task D4 gives it real TLS and
	// then moves to the public internet, whereas the admin console never becomes
	// public at all — spec §3.1 keeps it tailnet-only for the life of the
	// system, because the binding is what stops an attacker who has the bearer
	// token. See CheckAdminBind for the full reasoning.
	if err := CheckAdminBind(c.Server.AdminListen); err != nil {
		return err
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
