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
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/headroom"
)

// Config is the full v2 configuration surface. Every later Phase 1 task
// wires its subsystem's settings into this struct rather than inventing its
// own config path.
type Config struct {
	// Mode is the dispatch mode cmd/ledgerd is running as (see Modes). It is
	// never read from TOML or the environment — main() sets it from
	// os.Args[1] after Load succeeds.
	Mode string `toml:"-"`

	Server   ServerConfig   `toml:"server"`
	Mail     MailConfig     `toml:"mail"`
	Relay    RelayConfig    `toml:"relay"`
	Push     PushConfig     `toml:"push"`
	Auth     AuthConfig     `toml:"auth"`
	Headroom HeadroomConfig `toml:"headroom"`

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

	// Invite carries `ledgerd mint-invite`'s arguments. Command-line only, on
	// the same terms: a code minted because a note sat in a config file is a
	// beta invitation nobody decided to send.
	Invite InviteArgs `toml:"-"`
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

// InviteArgs is the `mint-invite` mode's command line.
//
// The closed beta's gate (Phase 2, Decision 8) is a code the OPERATOR mints and
// hands over out of band, because the thing that would otherwise key an
// allowlist — the IdP subject — is not knowable until the sign-in being gated.
// So there has to be a command, and this is its argument list.
type InviteArgs struct {
	// Note is the operator's own words about who the code is for. Optional, and
	// free text: nothing machine-reads it, and a gate whose audit trail is a
	// slug is a gate nobody can audit six weeks later.
	Note string
	// Show lists what has been minted and redeemed, and mints nothing.
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

	// TLSDomains are the host names runServe obtains Let's Encrypt
	// certificates for, via golang.org/x/crypto/acme/autocert. It is the ONE
	// switch that lifts validate()'s loopback rail on HTTPListen: a
	// non-loopback listener is permitted if and only if this is non-empty,
	// because that is the only configuration under which the listener is not
	// cleartext. Empty means plain HTTP, and then loopback only.
	//
	// Bare host names, no scheme and no port — they are matched against the
	// SNI server name (autocert.HostWhitelist). Not a secret.
	TLSDomains []string `toml:"tls_domains"`

	// AutocertCache is the directory autocert keeps issued certificates and
	// its account key in, created 0700. Required whenever TLSDomains is set:
	// a deployment with nowhere to cache re-requests certificates on every
	// restart and walks into Let's Encrypt's issuance rate limit, which is a
	// week-long outage produced by a missing directory.
	AutocertCache string `toml:"autocert_cache"`

	// AdminToken authenticates the Tailscale-bound admin API (Task 32,
	// LEDGER_ADMIN_TOKEN). Env-only, never TOML.
	//
	// It is required for the console to mount AT ALL, including when
	// AdminTokenOnly is false: the token is the fallback for `curl`, for a
	// script and for a box with no `tailscale serve` mount, and a console
	// reachable by exactly one mechanism is one that becomes unreachable the
	// day that mechanism is not there.
	AdminToken string `toml:"-"`

	// AdminTokenOnly turns OFF the second way to authenticate to the console:
	// the caller identity `tailscale serve` injects
	// (`Tailscale-User-Login`), which lets the operator open the panel on
	// their own tailnet without fetching a token off the box first. See
	// internal/v2/admin/identity.go for what is trusted and why.
	//
	// It is INVERTED — the zero value trusts the identity — because that is
	// the posture the deployment wants and a `false` in a config file should
	// not be load-bearing. Set it when the box has no serve mount and the
	// listener is plain loopback, since then any local process could send the
	// header itself. That is documented rather than defended against: a local
	// process can already read LEDGER_ADMIN_TOKEN out of the unit's
	// environment, so the header gives it nothing new.
	//
	// It does NOT loosen the binding. CheckAdminBind is unchanged and still
	// refuses anything but loopback or 100.64.0.0/10.
	AdminTokenOnly bool `toml:"admin_token_only"`

	// AdminTailscaleLogins optionally narrows which Tailscale logins count as
	// the operator, e.g. ["salehtl@github"]. Empty — the default — accepts any
	// identity the tailnet vouches for, because the tailnet is the boundary
	// and a one-operator tailnet has one member. Inert when AdminTokenOnly is
	// set. Not a secret.
	AdminTailscaleLogins []string `toml:"admin_tailscale_logins"`

	// DNSFixtures is the path to a recorded dns.json (arc.FixtureLookup),
	// served as the DKIM/ARC TXT resolver so mail verification is
	// deterministic and offline. TEST ONLY: set by `ledgerd serve
	// --dns-fixtures`, never by TOML, and refused off loopback.
	DNSFixtures string `toml:"-"`
}

// HeadroomConfig configures the box-level disk fuse (internal/v2/headroom),
// P4 of docs/superpowers/specs/2026-08-09-account-isolation-design.md: one
// goroutine samples free space on Path every Interval, and below Floor bytes
// every durable write — INCLUDING SIGNING IN — is refused with a temporary
// error while reads keep serving.
//
// # Why all three are settings and not constants
//
// Path is per deployment by definition: the number that matters is the free
// space on the filesystem Postgres writes to, and where that is mounted is not
// this program's decision. Floor and Interval are here because the fuse is the
// one control an operator may genuinely need to move DURING an incident — a
// box that has tripped is a box whose operator wants to lower the floor by a
// gigabyte to get writes back while they free space, and a config key is a
// restart where a constant is a rebuild.
//
// None of the three is a secret: they are a mount point and two numbers.
type HeadroomConfig struct {
	// Path is any path on the filesystem to watch. It is the DATA directory
	// rather than, say, the binary's own location, because the bytes that fill
	// this box are the database's.
	//
	// The fuse never writes to it and never creates it — it calls statfs, so
	// any existing path on the right filesystem answers the same number. A path
	// that does not exist is not a startup failure (headroom keeps its previous
	// state on a sampling error) but it IS a fuse that never trips, which is
	// why the sampling failure is logged every interval rather than once.
	Path string `toml:"path"`

	// FloorBytes is the reserved free space below which writes stop. The
	// design's number is 8 GB (headroom.DefaultFloor): enough that Postgres can
	// still write its WAL, a backup can still land somewhere, and the
	// operator's shell still works while they repair it.
	//
	// Zero is refused rather than treated as "use the default", because a zero
	// floor and an absent one look identical in a file and one of them is a
	// fuse that can never trip.
	FloorBytes int64 `toml:"floor_bytes"`

	// Interval is how often free space is sampled. 30s by default
	// (headroom.DefaultInterval). The lag this admits is bounded by one
	// interval, which is affordable precisely because the floor is gigabytes.
	Interval time.Duration `toml:"interval"`
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

	// WebEnabled turns on Web Push (VAPID) for the PWA. It is a SEPARATE switch
	// from Enabled and not a mode of it: the two have different audiences (a
	// browser subscription vs an Expo install), different tables, different
	// credentials, and the Expo rail below — which refuses `enabled = true`
	// without an access token — says nothing about this path. Folding them into
	// one boolean would mean an operator who wants browser notifications has to
	// satisfy Expo's precondition to get them.
	WebEnabled bool `toml:"web_enabled"`

	// VAPIDSubject is the `sub` claim of the VAPID JWT: a mailto: or https: URL
	// through which a push service operator can reach whoever runs this
	// deployment. RFC 8292 requires it, and push services do reject sends
	// without a usable one.
	//
	// It is TOML rather than env because it is not a secret — it is a contact
	// address, published to Apple, Google and Mozilla on every single send.
	VAPIDSubject string `toml:"vapid_subject"`

	// VAPIDPublic and VAPIDPrivate are the application server key pair
	// (LEDGER_VAPID_PUBLIC / LEDGER_VAPID_PRIVATE). Env-only, never TOML —
	// the private half signs the JWT that authorizes every send.
	//
	// The PUBLIC half is env-only too, and that is deliberate rather than
	// over-caution: it is not a secret, but it is half of a PAIR, and a
	// deployment that keeps one half in a file and the other in the environment
	// is a deployment where the two can drift. A mismatched pair does not fail
	// loudly — the browser subscribes under the public key it was served and
	// every send is then rejected by the push service — so the two values must
	// come from one place.
	//
	// The v1 binary's `ledger vapid-keys` mints a pair in exactly this format
	// (both binaries encode through the same webpush-go). ledgerd deliberately
	// has no such mode: a key-minting subcommand next to a running server is an
	// invitation to run it twice, and the second run silently invalidates every
	// subscription on the deployment with nothing telling the users.
	VAPIDPublic  string `toml:"-"`
	VAPIDPrivate string `toml:"-"`
}

// AuthConfig controls IdP token verification and session lifetime (Task 6).
// The client IDs are public OAuth identifiers, not secrets, so they are
// ordinary TOML/env settings.
type AuthConfig struct {
	AppleClientIDs  []string      `toml:"apple_client_ids"`
	GoogleClientIDs []string      `toml:"google_client_ids"`
	SessionTTL      time.Duration `toml:"session_ttl"`

	// The WebAuthn relying party (auth.Passkeys). None of these is a secret
	// either — RPID and RPOrigins are the site's own public identity, and that
	// is exactly why they are configuration: they are what binds a ceremony to
	// THIS deployment, and a passkey minted under one RPID is unusable under
	// another.
	//
	// RPID empty means the six passkey routes are NOT MOUNTED, on the same rule
	// as Addresses and Dict in api.Server: a deployment that has not been told
	// its own domain cannot run a ceremony, and a route that exists only to fail
	// is one a client retries forever.
	//
	// RPID is the effective domain with no scheme and no port
	// ("ledger.example.com"); RPOrigins are the fully qualified origins that may
	// run a ceremony ("https://ledger.example.com"). They are separate because
	// they are checked against different things — the RPID against the
	// credential's scope, the origin against the browser's own report of which
	// page called it — and conflating them is how a ceremony ends up bound to
	// nothing.
	RPID          string   `toml:"rp_id"`
	RPDisplayName string   `toml:"rp_display_name"`
	RPOrigins     []string `toml:"rp_origins"`
}

// modeOrder lists every dispatch mode cmd/ledgerd's main() is meant to
// recognize, in the order its dispatch table declares them. This package
// cannot see cmd/ledgerd (config is imported by main, not the reverse), so
// it cannot itself verify that main's dispatch table actually has an entry
// for each of these — see the "cross-package coverage" note on
// modeImplemented below for where that's actually checked.
var modeOrder = []string{"serve", "relay", "verify", "seed-dictionary", "seed-templates", "purge-user", "record-consent", "parse-rate", "mint-invite", "load-corpus"}

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
	"seed-templates":  true,
	"purge-user":      true,
	"record-consent":  true,
	"parse-rate":      true,
	"mint-invite":     true,
	"load-corpus":     true,
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
			// Loopback, not ":443". With no tls_domains configured cmd/ledgerd
			// serves PLAIN HTTP, and session bearer tokens plus the whole op
			// log travel over it — so the default must not be a public
			// interface. validate() refuses one too unless TLS is configured;
			// see there.
			HTTPListen:  "127.0.0.1:8443",
			AdminListen: "127.0.0.1:8079",
			// Where autocert caches certificates and its ACME account key. A
			// default rather than a required setting because it is inert until
			// tls_domains is set, and the failure it prevents (re-issuing on
			// every restart until the rate limit bites) is one nobody would
			// think to configure their way out of in advance.
			AutocertCache: "/var/lib/ledger-v2/autocert",
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
		Headroom: HeadroomConfig{
			// The v2 data directory, which is where autocert's cache already
			// lives — one filesystem, and the one Postgres shares on this box.
			Path: "/var/lib/ledger-v2",
			// The design's numbers, taken from the package that implements the
			// fuse rather than repeated here, so there is one place they can be
			// revised and no way for the two to disagree.
			FloorBytes: int64(headroom.DefaultFloor),
			Interval:   headroom.DefaultInterval,
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
	if v := os.Getenv("LEDGER_RP_ID"); v != "" {
		cfg.Auth.RPID = v
	}
	if v := os.Getenv("LEDGER_RP_DISPLAY_NAME"); v != "" {
		cfg.Auth.RPDisplayName = v
	}
	if v := os.Getenv("LEDGER_RP_ORIGINS"); v != "" {
		cfg.Auth.RPOrigins = splitCSV(v)
	}
	if v := os.Getenv("LEDGER_EXPO_ACCESS_TOKEN"); v != "" {
		cfg.Push.AccessToken = v
	}
	if v := os.Getenv("LEDGER_VAPID_PUBLIC"); v != "" {
		cfg.Push.VAPIDPublic = v
	}
	if v := os.Getenv("LEDGER_VAPID_PRIVATE"); v != "" {
		cfg.Push.VAPIDPrivate = v
	}
	if v := os.Getenv("LEDGER_ADMIN_TOKEN"); v != "" {
		cfg.Server.AdminToken = v
	}
	// Both of the console's identity knobs get an environment override for the
	// same reason HeadroomConfig's do: the moment an operator most wants to
	// turn one off is while they are trying to work out whether it is the
	// reason they cannot get in, and `systemctl set-environment` plus a
	// restart beats editing a file under time pressure. Neither is a secret.
	if v := os.Getenv("LEDGER_ADMIN_TOKEN_ONLY"); v != "" {
		cfg.Server.AdminTokenOnly = truthy(v)
	}
	if v := os.Getenv("LEDGER_ADMIN_TAILSCALE_LOGINS"); v != "" {
		cfg.Server.AdminTailscaleLogins = splitCSV(v)
	}
	if v := os.Getenv("LEDGER_DICT_HMAC_KEY"); v != "" {
		cfg.DictHMACKey = v
	}
	// The fuse's three knobs get environment overrides for the reason stated on
	// HeadroomConfig: the moment an operator most wants to move the floor is
	// during the incident it caused, and `systemctl set-environment` plus a
	// restart is a faster path than editing a file under time pressure.
	// A malformed value is an ERROR rather than a fallback to the default —
	// silently ignoring LEDGER_HEADROOM_FLOOR_BYTES=8GB would leave the
	// operator believing they had lowered a floor they had not touched.
	if v := os.Getenv("LEDGER_HEADROOM_PATH"); v != "" {
		cfg.Headroom.Path = v
	}
	if v := os.Getenv("LEDGER_HEADROOM_FLOOR_BYTES"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("LEDGER_HEADROOM_FLOOR_BYTES %q is not a number of bytes: %w", v, err)
		}
		cfg.Headroom.FloorBytes = n
	}
	if v := os.Getenv("LEDGER_HEADROOM_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("LEDGER_HEADROOM_INTERVAL %q is not a duration: %w", v, err)
		}
		cfg.Headroom.Interval = d
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
// # This rail is now the load-bearing one
//
// It used to be implied: validate() refused every non-loopback http_listen, so
// this check could not fire. Task D3 lifted that general rail for a
// TLS-configured listener, so a public production config is now a legal config
// — and this check is the only thing between it and a server that accepts
// `dev:anyone` as a credential. TestEnableTestOnlyRefusesDevAuthOnAPublicTLSListener
// asserts exactly that, against a config it first proves validate() accepts.
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

// truthy reads a boolean environment override.
//
// It accepts only the affirmative spellings and treats EVERYTHING else as
// false, including "yes", "on" and a typo. That asymmetry is deliberate for the
// one setting that uses it: LEDGER_ADMIN_TOKEN_ONLY makes the console stricter,
// and a misspelled value that silently left it off would be a security setting
// the operator believed they had set. False is also the default, so a typo
// changes nothing rather than changing something unexpected — and `serve` logs
// which posture the console came up in either way.
func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true":
		return true
	}
	return false
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
	// The HTTP listener is CLEARTEXT unless server.tls_domains is configured.
	// Everything it carries is sensitive — the session bearer token on every
	// request, and the user's entire op log in the responses — so binding it to
	// anything but loopback puts all of that on the wire in the clear.
	//
	// A deployment assumption that nothing enforces is one a hurried
	// `LEDGER_HTTP_LISTEN=:443` silently breaks with no visible symptom. This
	// is the hard rail, in the same spirit as the :8080 refusal above.
	//
	// Task D3 lifted it EXACTLY as far as TLS reaches, and no further: runServe
	// terminates TLS itself with autocert when tls_domains is non-empty (v2 is
	// multi-user with external alpha testers, so unlike v1 it is not behind a
	// tailnet, and there is no reverse proxy in the plan to hide behind
	// either). Plain HTTP off loopback stays refused, because the remedy was
	// always real TLS in this process rather than a promise about the network.
	if err := CheckPublicBind(c.Server.HTTPListen, c.Server.TLSDomains); err != nil {
		return err
	}
	if err := c.validateTLS(); err != nil {
		return err
	}
	if c.Server.AdminListen == "" {
		return fmt.Errorf("server.admin_listen must not be empty")
	}
	// The admin rail, and the sibling of the http_listen one above. It is
	// STRICTER: http_listen may go to the public internet once tls_domains
	// gives it real TLS, whereas the admin console never becomes public at all — spec §3.1 keeps it tailnet-only for the life of the
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
	if err := c.validatePasskeys(); err != nil {
		return err
	}
	if err := c.validatePush(); err != nil {
		return err
	}
	if err := c.validateHeadroom(); err != nil {
		return err
	}
	return nil
}

// validateHeadroom refuses the two configurations that look like a fuse and are
// not one.
//
// Both failures are silent by nature: nothing about a zero floor or an empty
// path produces an error at any point afterwards. The process starts, the
// goroutine runs, the flag never trips, and the first anyone hears of it is a
// full filesystem — the exact outcome the fuse exists to prevent, arrived at
// through the fuse being present. So they are refused at load, where the
// operator is looking.
//
// A path that does not exist is NOT refused here: statfs is the only thing that
// can answer whether it is usable, headroom logs that failure every interval,
// and a config check would have to stat the filesystem at load time — which is
// a different question (does it exist now) from the one that matters (can it be
// sampled for the life of the process).
func (c Config) validateHeadroom() error {
	if c.Headroom.Path == "" {
		return fmt.Errorf("headroom.path must not be empty (LEDGER_HEADROOM_PATH): " +
			"it is the filesystem the disk fuse samples, and with no path there is nothing " +
			"between a full disk and every account losing writes at once")
	}
	if c.Headroom.FloorBytes <= 0 {
		return fmt.Errorf("headroom.floor_bytes is %d (LEDGER_HEADROOM_FLOOR_BYTES): it must be "+
			"positive — a zero floor is a fuse that can never trip, which is indistinguishable "+
			"from having no fuse at all",
			c.Headroom.FloorBytes)
	}
	if c.Headroom.Interval <= 0 {
		return fmt.Errorf("headroom.interval is %v (LEDGER_HEADROOM_INTERVAL): it must be positive",
			c.Headroom.Interval)
	}
	return nil
}

// CheckPublicBind refuses a cleartext listener on anything but loopback.
//
// It is the sibling of CheckAdminBind and is called from the same two places
// for the same reason: Config.validate refuses at load, so no deployment
// configured this way ever starts, and cmd/ledgerd's runServe calls it again
// immediately before it serves, so a Config assembled in code rather than
// through Load — which every test does, and which a future subcommand might —
// cannot slip past. It is the MORE consequential of the two rails, so it does
// not get the weaker treatment.
//
// tlsDomains being non-empty is the whole exemption: runServe then terminates
// TLS in-process with autocert, and there is no cleartext to protect. Callers
// must pass the same slice configureTLS gates on, so the two decisions cannot
// diverge.
func CheckPublicBind(addr string, tlsDomains []string) error {
	if isLoopbackListen(addr) || len(tlsDomains) > 0 {
		return nil
	}
	return fmt.Errorf(
		"refusing to bind server.http_listen to %q with no server.tls_domains: this listener "+
			"is then plain HTTP and it carries session tokens and the whole op log. Either bind "+
			"loopback (e.g. 127.0.0.1:8443) or set tls_domains, which makes runServe terminate "+
			"TLS in-process with autocert",
		addr)
}

// validHostname reports whether s has the shape of a DNS host name autocert
// could actually match against a TLS server name.
//
// The rule is deliberately narrow — letters, digits and hyphens per label, no
// leading or trailing hyphen, at least two labels, 253 bytes overall — because
// the failure this prevents is not a crash. An entry autocert can never match
// produces a deployment where every handshake is refused with "host not
// configured", which reads exactly like a DNS or firewall problem and sends
// the operator looking anywhere but at this list. Whitespace, a bare "-" and
// ".." all used to pass and all have that symptom.
//
// Wildcards are rejected with the rest: autocert.HostWhitelist compares literal
// names, and DNS-01 (the only challenge type that could issue a wildcard) is
// not wired up.
func validHostname(s string) bool {
	if s == "" || len(s) > 253 || strings.HasPrefix(s, ".") || strings.HasSuffix(s, ".") {
		return false
	}
	labels := strings.Split(s, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if l == "" || len(l) > 63 || strings.HasPrefix(l, "-") || strings.HasSuffix(l, "-") {
			return false
		}
		for _, r := range l {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-':
			default:
				return false
			}
		}
	}
	return true
}

// validateTLS checks the autocert settings whenever tls_domains is set.
//
// Both refusals are about failures that are invisible until they are
// expensive. A whitelist entry that is not a bare host name never matches an
// SNI server name, so autocert answers every handshake with "host not
// configured" and the deployment looks like a DNS or firewall problem. And a
// cache-less deployment re-requests certificates on every restart until Let's
// Encrypt's duplicate-certificate limit stops issuing for a week — by which
// point the missing directory is nobody's leading hypothesis.
func (c Config) validateTLS() error {
	if len(c.Server.TLSDomains) == 0 {
		return nil
	}
	for _, d := range c.Server.TLSDomains {
		if !validHostname(d) {
			return fmt.Errorf("server.tls_domains entry %q is not a bare host name: "+
				"these are matched against the TLS server name, so a scheme, a port, a path, "+
				"a wildcard or stray whitespace never matches and no certificate is ever "+
				"served for it", d)
		}
	}
	if c.Server.AutocertCache == "" {
		return fmt.Errorf("server.tls_domains is set but server.autocert_cache is empty: " +
			"without a cache directory every restart re-requests certificates from Let's Encrypt " +
			"and the deployment runs into the issuance rate limit")
	}
	return nil
}

// validatePasskeys refuses the two half-configured relying parties.
//
// Neither is a hypothetical. An RPID with no origins is the shape a `.env` in a
// hurry produces, and it is the one that fails LATEST: every ceremony begins
// happily and every finish is refused, because there is no origin to compare the
// browser's client data against. An origin list with no RPID is the mirror image
// and is quieter still — the routes are simply not mounted, and the operator
// discovers it when the first tester's sign-in 404s.
//
// It is checked whenever EITHER is set, not only when passkeys are "enabled",
// for the reason validatePush states about expo_url: a wrong value that sits
// inert in a file until somebody sets the other one is exactly the failure this
// exists to refuse.
//
// The origins are required to be absolute URLs with a scheme and host, because a
// bare "ledger.example.com" in rp_origins is the most likely typo of all — it is
// what rp_id looks like — and go-webauthn would compare it as an opaque string
// against the browser's "https://ledger.example.com" and never match.
func (c Config) validatePasskeys() error {
	if c.Auth.RPID == "" && len(c.Auth.RPOrigins) == 0 {
		return nil // Passkeys are not configured at all; the routes are not mounted.
	}
	if c.Auth.RPID == "" {
		return fmt.Errorf("auth.rp_origins is set but auth.rp_id is empty (LEDGER_RP_ID): " +
			"without the relying party id the passkey routes are not mounted at all")
	}
	if strings.Contains(c.Auth.RPID, "/") || strings.Contains(c.Auth.RPID, ":") {
		return fmt.Errorf("auth.rp_id is %q: it must be a bare effective domain "+
			"(\"ledger.example.com\"), with no scheme and no port — the fully qualified "+
			"form belongs in auth.rp_origins", c.Auth.RPID)
	}
	if len(c.Auth.RPOrigins) == 0 {
		return fmt.Errorf("auth.rp_id is set but auth.rp_origins is empty (LEDGER_RP_ORIGINS): " +
			"a WebAuthn ceremony is bound to the origin that ran it, and with none configured " +
			"every registration and every sign-in would be refused at the finish step")
	}
	for _, o := range c.Auth.RPOrigins {
		u, err := url.Parse(o)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return fmt.Errorf("auth.rp_origins entry %q is not an absolute origin: "+
				"it must carry a scheme and a host (\"https://ledger.example.com\")", o)
		}
	}
	return nil
}

// pushHosts are the hosts push.expo_url may name. Expo's documented endpoints
// are https://exp.host/--/api/v2/push/send and https://api.expo.dev/v2/push/send;
// subdomains of expo.dev are admitted because that is where Expo has moved
// endpoints before, and a deployment that cannot follow its provider is a
// deployment whose operator edits this list under time pressure.
var pushHosts = []string{"exp.host", "expo.dev"}

// validatePush is the rail this config had for every other deployment
// assumption and did not have for the one OUTBOUND path in the whole system.
//
// Two refusals, both in the spirit of the :8080 and loopback rails above:
//
//   - Enabled with no access token. Expo's push endpoint accepts
//     unauthenticated POSTs unless the project opts into enhanced security, and
//     the access token is what opts in. Without it, anyone who learns a user's
//     Expo push token can POST an arbitrary title and body to that lock screen
//     through Expo's public endpoint. This package's content-free guarantee
//     bounds what THIS SERVER sends; it cannot bound what the channel can
//     display, and the only thing that does is the credential. Silently
//     accepting `enabled = true` with LEDGER_EXPO_ACCESS_TOKEN unset produced a
//     deployment that looked configured and had opted into nothing.
//
//   - A non-https or unknown expo_url. It was accepted verbatim from TOML and
//     used as the POST target, so `expo_url = "http://collector.example/x"`
//     would ship the deployment's Bearer credential AND the exact timestamp of
//     every user's every bank transaction, in cleartext, to whoever asked for
//     it. The URL is checked whenever it is SET rather than only when push is
//     enabled: a wrong value that sits inert in a file until somebody flips a
//     boolean is the failure mode this whole function exists to refuse.
func (c Config) validatePush() error {
	if err := c.validateWebPush(); err != nil {
		return err
	}
	if c.Push.Enabled && c.Push.AccessToken == "" {
		return fmt.Errorf(
			"push.enabled is true but LEDGER_EXPO_ACCESS_TOKEN is unset: Expo's push endpoint " +
				"accepts unauthenticated sends unless the project's access token is presented, so " +
				"without it anyone holding a user's push token can write to that lock screen. " +
				"Set the token or set push.enabled = false")
	}
	if c.Push.ExpoURL == "" {
		return nil // pushv2.DefaultEndpoint, which is https and is exp.host
	}
	u, err := url.Parse(c.Push.ExpoURL)
	if err != nil {
		return fmt.Errorf("push.expo_url %q is not a URL: %w", c.Push.ExpoURL, err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf(
			"refusing push.expo_url %q: this is the only request this server makes to a third "+
				"party, and it carries the Expo access token plus the timing of every user's "+
				"transactions. It must be https",
			c.Push.ExpoURL)
	}
	host := u.Hostname()
	for _, h := range pushHosts {
		if host == h || strings.HasSuffix(host, "."+h) {
			return nil
		}
	}
	return fmt.Errorf(
		"refusing push.expo_url %q: %q is not an Expo host (want %s or a subdomain). Pointing "+
			"this at another host sends the deployment's Bearer credential and every user's "+
			"transaction timing there",
		c.Push.ExpoURL, host, strings.Join(pushHosts, " / "))
}

// validateWebPush refuses a half-configured Web Push deployment.
//
// Every refusal here has the same shape: the failure it prevents is SILENT.
// Nothing about a missing VAPID key produces an error a user or an operator
// sees — the browser subscribes happily against whatever public key it was
// served, the row lands in push_subscriptions, and each send is then rejected
// by the push service in a goroutine whose error is logged and swallowed
// (pushv2.Web.Notify treats a delivery failure as a courtesy that did not
// arrive, correctly). "Notifications are on" and "notifications work" would
// differ with nothing in the product able to tell them apart.
//
//   - Both keys, or neither. They are a PAIR. Serving a public key with no
//     private half means every subscription is dead on arrival; holding a
//     private half with no public one means the client is never told what to
//     subscribe under, so nothing subscribes at all.
//
//   - A subject that is mailto: or https:. RFC 8292 §2.1 admits those two, and
//     push services reject a JWT whose `sub` they cannot act on. It is required
//     rather than defaulted because a default would be a contact address the
//     operator never chose, published to Apple and Google on every send.
func (c Config) validateWebPush() error {
	if !c.Push.WebEnabled {
		// The keys are checked only when the feature is on. Unlike expo_url —
		// which is validated whenever SET, because a bad value there LEAKS —
		// an unused VAPID key sitting in the environment sends nothing
		// anywhere, and refusing to boot over it would break every deployment
		// that keeps one env file across two services.
		return nil
	}
	if c.Push.VAPIDPublic == "" || c.Push.VAPIDPrivate == "" {
		return fmt.Errorf(
			"push.web_enabled is true but the VAPID key pair is incomplete: set BOTH " +
				"LEDGER_VAPID_PUBLIC and LEDGER_VAPID_PRIVATE (mint them ONCE with " +
				"`ledger vapid-keys`, and never regenerate them — the public half is what " +
				"every browser already subscribed under). Or set push.web_enabled = false")
	}
	sub := c.Push.VAPIDSubject
	if sub == "" {
		return fmt.Errorf(
			"push.web_enabled is true but push.vapid_subject is unset: RFC 8292 requires a " +
				"mailto: or https: contact for the people who run this deployment, and push " +
				"services reject sends without one")
	}
	if !strings.HasPrefix(sub, "mailto:") && !strings.HasPrefix(sub, "https://") {
		return fmt.Errorf(
			"push.vapid_subject %q must be a mailto: or an https: URL (RFC 8292 §2.1)", sub)
	}
	return nil
}
