package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ledger/internal/v2/blob"
)

// clearV2Env blanks every LEDGER_* env var this package reads, via
// t.Setenv, so a test that wants a clean slate isn't at the mercy of
// whatever the host process happens to have exported (v1's
// LEDGER_AI_API_KEY, an operator's shell, CI secrets, ...). t.Setenv
// restores the previous value automatically at test end.
func clearV2Env(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"LEDGER_MAIL_DOMAIN", "LEDGER_PG_DSN", "LEDGER_HTTP_LISTEN",
		"LEDGER_ADMIN_LISTEN", "LEDGER_SMTP_LISTEN", "LEDGER_RELAY_TOKEN",
		"LEDGER_RELAY_PRIMARY_URL", "LEDGER_APPLE_CLIENT_IDS",
		"LEDGER_GOOGLE_CLIENT_IDS", "LEDGER_EXPO_ACCESS_TOKEN",
		"LEDGER_ADMIN_TOKEN", "LEDGER_DICT_HMAC_KEY",
	} {
		t.Setenv(k, "")
	}
}

func TestMailDomainIsRequiredAndDrivesInboundSuffix(t *testing.T) {
	c := defaults()
	c.Server.DSN = "postgres:///x"
	if err := c.validate(); err == nil {
		t.Fatal("expected validate() to reject an empty mail.domain")
	}
	c.Mail.Domain = "example.test"
	if err := c.validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if got := c.InboundSuffix(); got != "@in.example.test" {
		t.Fatalf("InboundSuffix() = %q", got)
	}
}

func TestRefusesV1ProductionSurfaces(t *testing.T) {
	c := defaults()
	c.Mail.Domain = "example.test"
	c.Server.DSN = "postgres:///x"
	c.Server.HTTPListen = "127.0.0.1:8080"
	if err := c.validate(); err == nil {
		t.Fatal("expected validate() to refuse binding :8080 (v1 production)")
	}
}

func TestEveryDispatchModeHasACase(t *testing.T) {
	// cmd/ledgerd's help text and its switch must not drift apart.
	for _, m := range Modes() {
		if !modeIsImplemented(m) {
			t.Fatalf("mode %q is advertised but has no case", m)
		}
	}
}

func TestModesIsTheExactSixInOrder(t *testing.T) {
	want := []string{"serve", "relay", "verify", "seed-dictionary", "purge-user", "parse-rate"}
	got := Modes()
	if len(got) != len(want) {
		t.Fatalf("Modes() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Modes()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestModesReturnsACopy(t *testing.T) {
	// Mutating the returned slice must not corrupt the package's own list.
	got := Modes()
	got[0] = "corrupted"
	if Modes()[0] != "serve" {
		t.Fatal("Modes() leaked its backing array; caller mutation affected later calls")
	}
}

func TestUnimplementedModeIsRejected(t *testing.T) {
	if modeIsImplemented("does-not-exist") {
		t.Fatal("modeIsImplemented(\"does-not-exist\") = true, want false")
	}
}

// writeTOML writes body to a temp file and returns its path.
func writeTOML(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadRejectsASecretPlacedInTOML(t *testing.T) {
	clearV2Env(t)
	path := writeTOML(t, `
[mail]
domain = "example.test"

[server]
dsn = "postgres:///x"
admin_token = "sk-should-not-be-here"
`)
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected Load() to reject a secret key set directly in TOML")
	}
	if !strings.Contains(err.Error(), "admin_token") {
		t.Fatalf("error should name the offending key, got: %v", err)
	}
	if !strings.Contains(err.Error(), "environment") {
		t.Fatalf("error should say secrets come from the environment, got: %v", err)
	}
}

func TestLoadRejectsAnUnknownOrMisspelledKey(t *testing.T) {
	clearV2Env(t)
	path := writeTOML(t, `
[mail]
domain = "example.test"
domian = "typo.example.test"

[server]
dsn = "postgres:///x"
`)
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected Load() to reject a misspelled key rather than silently ignore it")
	}
	if !strings.Contains(err.Error(), "domian") {
		t.Fatalf("error should name the offending key, got: %v", err)
	}
}

func TestLoadAppliesEnvOverridesOverTOMLAndDefaults(t *testing.T) {
	clearV2Env(t)
	path := writeTOML(t, `
[mail]
domain = "from-toml.test"

[server]
dsn = "postgres:///from-toml"
`)
	t.Setenv("LEDGER_MAIL_DOMAIN", "from-env.test")
	t.Setenv("LEDGER_PG_DSN", "postgres:///from-env")
	t.Setenv("LEDGER_HTTP_LISTEN", "127.0.0.1:9443")
	t.Setenv("LEDGER_ADMIN_LISTEN", "127.0.0.1:9079")
	t.Setenv("LEDGER_SMTP_LISTEN", "127.0.0.1:9025")
	t.Setenv("LEDGER_RELAY_TOKEN", "relay-secret")
	t.Setenv("LEDGER_RELAY_PRIMARY_URL", "https://primary.example.test")
	t.Setenv("LEDGER_APPLE_CLIENT_IDS", "com.example.a, com.example.b")
	t.Setenv("LEDGER_GOOGLE_CLIENT_IDS", "g-client-1,g-client-2")
	t.Setenv("LEDGER_EXPO_ACCESS_TOKEN", "expo-secret")
	t.Setenv("LEDGER_ADMIN_TOKEN", "admin-secret")
	t.Setenv("LEDGER_DICT_HMAC_KEY", "hmac-secret")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// Env wins over TOML.
	if cfg.Mail.Domain != "from-env.test" {
		t.Fatalf("Mail.Domain = %q, want env override", cfg.Mail.Domain)
	}
	if cfg.Server.DSN != "postgres:///from-env" {
		t.Fatalf("Server.DSN = %q, want env override", cfg.Server.DSN)
	}
	// Env-only secrets and settings land on the struct.
	if cfg.Server.HTTPListen != "127.0.0.1:9443" {
		t.Fatalf("Server.HTTPListen = %q", cfg.Server.HTTPListen)
	}
	if cfg.Server.AdminListen != "127.0.0.1:9079" {
		t.Fatalf("Server.AdminListen = %q", cfg.Server.AdminListen)
	}
	if cfg.Mail.SMTPListen != "127.0.0.1:9025" {
		t.Fatalf("Mail.SMTPListen = %q", cfg.Mail.SMTPListen)
	}
	if cfg.Relay.Token != "relay-secret" {
		t.Fatalf("Relay.Token = %q", cfg.Relay.Token)
	}
	if cfg.Relay.PrimaryURL != "https://primary.example.test" {
		t.Fatalf("Relay.PrimaryURL = %q", cfg.Relay.PrimaryURL)
	}
	wantApple := []string{"com.example.a", "com.example.b"}
	if len(cfg.Auth.AppleClientIDs) != 2 || cfg.Auth.AppleClientIDs[0] != wantApple[0] || cfg.Auth.AppleClientIDs[1] != wantApple[1] {
		t.Fatalf("Auth.AppleClientIDs = %v, want %v", cfg.Auth.AppleClientIDs, wantApple)
	}
	wantGoogle := []string{"g-client-1", "g-client-2"}
	if len(cfg.Auth.GoogleClientIDs) != 2 || cfg.Auth.GoogleClientIDs[0] != wantGoogle[0] || cfg.Auth.GoogleClientIDs[1] != wantGoogle[1] {
		t.Fatalf("Auth.GoogleClientIDs = %v, want %v", cfg.Auth.GoogleClientIDs, wantGoogle)
	}
	if cfg.Push.AccessToken != "expo-secret" {
		t.Fatalf("Push.AccessToken = %q", cfg.Push.AccessToken)
	}
	if cfg.Server.AdminToken != "admin-secret" {
		t.Fatalf("Server.AdminToken = %q", cfg.Server.AdminToken)
	}
	if cfg.DictHMACKey != "hmac-secret" {
		t.Fatalf("DictHMACKey = %q", cfg.DictHMACKey)
	}
}

func TestLoadWithNoPathUsesDefaultsAndEnv(t *testing.T) {
	clearV2Env(t)
	t.Setenv("LEDGER_MAIL_DOMAIN", "example.test")
	t.Setenv("LEDGER_PG_DSN", "postgres:///x")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load(\"\"): %v", err)
	}
	// Loopback by default: this listener is cleartext until Task D4.
	if cfg.Server.HTTPListen != "127.0.0.1:8443" {
		t.Fatalf("default HTTPListen = %q", cfg.Server.HTTPListen)
	}
	if cfg.Server.AdminListen != "127.0.0.1:8079" {
		t.Fatalf("default AdminListen = %q", cfg.Server.AdminListen)
	}
	if cfg.Mail.SMTPListen != ":25" {
		t.Fatalf("default SMTPListen = %q", cfg.Mail.SMTPListen)
	}
	if cfg.Mail.MaxMessageBytes != blob.MaxColdMail {
		t.Fatalf("default MaxMessageBytes = %d, want blob.MaxColdMail (%d)", cfg.Mail.MaxMessageBytes, blob.MaxColdMail)
	}
	if cfg.Mail.PerAddressDaily != 50 {
		t.Fatalf("default PerAddressDaily = %d", cfg.Mail.PerAddressDaily)
	}
	if cfg.Mail.InvalidRcptBurst != 5 {
		t.Fatalf("default InvalidRcptBurst = %d", cfg.Mail.InvalidRcptBurst)
	}
	if cfg.Mail.TarpitBase != 2*time.Second {
		t.Fatalf("default TarpitBase = %v", cfg.Mail.TarpitBase)
	}
	if cfg.Auth.SessionTTL != 30*24*time.Hour {
		t.Fatalf("default SessionTTL = %v", cfg.Auth.SessionTTL)
	}
}

func TestLoadFailsLoudlyWithoutDomainOrDSN(t *testing.T) {
	clearV2Env(t)
	if _, err := Load(""); err == nil {
		t.Fatal("expected Load(\"\") with no domain/dsn to fail")
	} else if !strings.Contains(err.Error(), "mail.domain") {
		t.Fatalf("error should name the missing field, got: %v", err)
	}

	t.Setenv("LEDGER_MAIL_DOMAIN", "example.test")
	if _, err := Load(""); err == nil {
		t.Fatal("expected Load(\"\") with no dsn to fail")
	} else if !strings.Contains(err.Error(), "server.dsn") {
		t.Fatalf("error should name the missing field, got: %v", err)
	}
}

func TestLoadRejectsATOMLDecodeError(t *testing.T) {
	path := writeTOML(t, `this is not valid toml =====`)
	if _, err := Load(path); err == nil {
		t.Fatal("expected Load() to surface a TOML syntax error")
	}
}

// TestLoadRejectsASemanticallyInvalidDuration and
// TestLoadRejectsASemanticallyInvalidInteger pin BurntSushi/toml v1.6.0's
// existing behavior for a value that parses as valid TOML but has the wrong
// type for its destination field: it already fails loudly (a "toml: ...
// incompatible types" / "invalid duration" decode error), so this is a
// regression test for behavior Load already benefits from, not a new check
// Load itself performs. Losing it silently — e.g. a future Go/toml upgrade
// that started coercing "bogus" to a zero duration instead of erroring —
// would be exactly the kind of "looks configured, silently wrong" failure
// this package exists to prevent, so it is worth pinning explicitly.
func TestLoadRejectsASemanticallyInvalidDuration(t *testing.T) {
	clearV2Env(t)
	path := writeTOML(t, `
[mail]
domain      = "example.test"
tarpit_base = "bogus"

[server]
dsn = "postgres:///x"
`)
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected Load() to reject tarpit_base = \"bogus\" (not a valid duration)")
	}
	if !strings.Contains(err.Error(), "tarpit_base") {
		t.Fatalf("error should name the offending key, got: %v", err)
	}
}

func TestLoadRejectsASemanticallyInvalidInteger(t *testing.T) {
	clearV2Env(t)
	path := writeTOML(t, `
[mail]
domain             = "example.test"
max_message_bytes  = "abc"

[server]
dsn = "postgres:///x"
`)
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected Load() to reject max_message_bytes = \"abc\" (not an integer)")
	}
	if !strings.Contains(err.Error(), "max_message_bytes") {
		t.Fatalf("error should name the offending key, got: %v", err)
	}
}

func TestTheShippedExampleConfigActuallyLoads(t *testing.T) {
	// config.v2.example.toml is the documented starting point for a deploy —
	// copy it to /etc/ledger-v2/config.toml and fill in the secrets. Nothing
	// loaded it, so every validation rule added after it was written could
	// invalidate it silently and the first person to find out would be someone
	// following the runbook into a fatal startup error.
	//
	// This test is deliberately Load(), not a hand-built Config: Load is what
	// rejects an unrecognized or misspelled key, so a key renamed in this
	// package without being renamed in the example fails here too.
	const path = "../../../config.v2.example.toml"
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the plan mandates this file exist: %v", err)
	}
	// The two values the example deliberately leaves empty because they are
	// per-deployment: the domain is not chosen yet (plan task D1) and the DSN
	// carries a password, so it is env-only in practice.
	t.Setenv("LEDGER_MAIL_DOMAIN", "example.test")
	t.Setenv("LEDGER_PG_DSN", "postgres:///ledger_v2")
	// Neutralise any ambient overrides so this asserts the FILE's contents.
	for _, k := range []string{"LEDGER_HTTP_LISTEN", "LEDGER_ADMIN_LISTEN", "LEDGER_SMTP_LISTEN"} {
		t.Setenv(k, "")
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("the shipped example config does not load: %v", err)
	}
	if !isLoopbackListen(cfg.Server.HTTPListen) {
		t.Fatalf("example http_listen = %q, which validate() only accepts by accident", cfg.Server.HTTPListen)
	}
}

func TestRefusesToServeCleartextOnANonLoopbackAddress(t *testing.T) {
	// ledgerd serves plain HTTP until deployment Task D4 lands TLS, and session
	// bearer tokens plus the whole op log travel over it. "It is only reached
	// over Tailscale" is a deployment assumption nothing enforces, so the
	// binding itself is the place to enforce it.
	base := func() Config {
		c := defaults()
		c.Mail.Domain = "example.test"
		c.Server.DSN = "postgres:///x"
		return c
	}
	for _, addr := range []string{":443", "0.0.0.0:8443", "[::]:8443", "192.168.1.10:8443"} {
		c := base()
		c.Server.HTTPListen = addr
		err := c.validate()
		if err == nil {
			t.Fatalf("validate() accepted cleartext on %q", addr)
		}
		if !strings.Contains(err.Error(), "http_listen") {
			t.Fatalf("error for %q does not name the setting: %v", addr, err)
		}
	}
	for _, addr := range []string{"127.0.0.1:8443", "[::1]:8443", "localhost:8443"} {
		c := base()
		c.Server.HTTPListen = addr
		if err := c.validate(); err != nil {
			t.Fatalf("validate() refused loopback %q: %v", addr, err)
		}
	}
}

func TestValidateRejectsNonPositiveRateLimitsAndTTLs(t *testing.T) {
	base := func() Config {
		c := defaults()
		c.Mail.Domain = "example.test"
		c.Server.DSN = "postgres:///x"
		return c
	}
	tests := []struct {
		name    string
		mutate  func(c *Config)
		wantErr string
	}{
		{"zero PerAddressDaily", func(c *Config) { c.Mail.PerAddressDaily = 0 }, "per_address_daily"},
		{"negative InvalidRcptBurst", func(c *Config) { c.Mail.InvalidRcptBurst = -1 }, "invalid_rcpt_burst"},
		{"zero TarpitBase", func(c *Config) { c.Mail.TarpitBase = 0 }, "tarpit_base"},
		{"negative SessionTTL", func(c *Config) { c.Auth.SessionTTL = -time.Hour }, "session_ttl"},
		{"empty HTTPListen", func(c *Config) { c.Server.HTTPListen = "" }, "http_listen"},
		{"empty AdminListen", func(c *Config) { c.Server.AdminListen = "" }, "admin_listen"},
		{"empty SMTPListen", func(c *Config) { c.Mail.SMTPListen = "" }, "smtp_listen"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := base()
			tt.mutate(&c)
			err := c.validate()
			if err == nil {
				t.Fatalf("expected validate() to reject %s", tt.name)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

func TestValidateRejectsAdminListenAt8080Too(t *testing.T) {
	c := defaults()
	c.Mail.Domain = "example.test"
	c.Server.DSN = "postgres:///x"
	c.Server.AdminListen = "127.0.0.1:8080"
	if err := c.validate(); err == nil {
		t.Fatal("expected validate() to refuse admin_listen on :8080 too")
	}
}

func TestValidateRejectsSMTPListenAt8080Too(t *testing.T) {
	c := defaults()
	c.Mail.Domain = "example.test"
	c.Server.DSN = "postgres:///x"
	c.Mail.SMTPListen = "127.0.0.1:8080"
	if err := c.validate(); err == nil {
		t.Fatal("expected validate() to refuse smtp_listen on :8080 too")
	}
}

func TestValidateRejectsMaxMessageBytesOutOfRange(t *testing.T) {
	// 1 MiB is rejected on purpose: spec section 3.2 allows it, but a message
	// that big can frame past the largest size bucket once it is base64'd into
	// a cold blob, and accepting mail the ingest path cannot store is worse
	// than refusing it at DATA. blob.MaxColdMail is the binding limit.
	for _, n := range []int{0, -1, blob.MaxColdMail + 1, 1 << 20} {
		c := defaults()
		c.Mail.Domain = "example.test"
		c.Server.DSN = "postgres:///x"
		c.Mail.MaxMessageBytes = n
		if err := c.validate(); err == nil {
			t.Fatalf("expected validate() to reject max_message_bytes=%d", n)
		}
	}
}

func TestValidateRejectsDSNPointingAtV1DataDir(t *testing.T) {
	c := defaults()
	c.Mail.Domain = "example.test"
	c.Server.DSN = "sqlite:///var/lib/ledger/ledger.db"
	if err := c.validate(); err == nil {
		t.Fatal("expected validate() to refuse a dsn touching /var/lib/ledger")
	}
}

// ---------------------------------------------------------------------------
// The two test-only server flags (Task 14)
// ---------------------------------------------------------------------------

// EnableTestOnly is the ONE place both flags are turned on, and it refuses
// both unless the HTTP listener is loopback.
//
// Today validate() already refuses a non-loopback http_listen for every
// config, so this rail is implied — and that is exactly why it is written
// separately rather than leaned on. Deployment Task D4 lifts the general rail
// (it adds autocert and moves the listener to :443); on that day this check is
// the only thing standing between a production deployment and an accepted
// "dev:anyone" token.
func TestEnableTestOnlyRefusesANonLoopbackListener(t *testing.T) {
	cfg := Config{Server: ServerConfig{HTTPListen: "0.0.0.0:8443"}}
	if err := cfg.EnableTestOnly(true, ""); err == nil {
		t.Fatal("EnableTestOnly on 0.0.0.0 returned no error")
	}
	if cfg.DevAuth {
		t.Fatal("EnableTestOnly left DevAuth set after refusing")
	}
	cfg = Config{Server: ServerConfig{HTTPListen: ":8443"}}
	if err := cfg.EnableTestOnly(false, "some/path.json"); err == nil {
		t.Fatal("EnableTestOnly with dns fixtures on a wildcard listener returned no error")
	}
}

func TestEnableTestOnlyAcceptsLoopback(t *testing.T) {
	cfg := Config{Server: ServerConfig{HTTPListen: "127.0.0.1:8091"}}
	if err := cfg.EnableTestOnly(true, "dns.json"); err != nil {
		t.Fatalf("EnableTestOnly on loopback = %v", err)
	}
	if !cfg.DevAuth || cfg.Server.DNSFixtures != "dns.json" {
		t.Fatalf("EnableTestOnly did not apply: %+v", cfg.Server)
	}
}

// Neither flag has a TOML key: they are test-only switches, and a config file
// able to set them would make "is this deployment accepting dev tokens" a
// question about a file on disk rather than about the command line.
func TestTestOnlyFlagsHaveNoTOMLKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte("[server]\ndev_auth = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	clearV2Env(t)
	t.Setenv("LEDGER_MAIL_DOMAIN", "example.test")
	t.Setenv("LEDGER_PG_DSN", "postgres:///x")
	if _, err := Load(path); err == nil {
		t.Fatal("a config file setting dev_auth was accepted")
	}
}

// Nothing may turn dev auth on by default: a zero Config is what every
// non-serve mode and every test constructs.
func TestDevAuthIsOffByDefault(t *testing.T) {
	if defaults().DevAuth {
		t.Fatal("defaults() has DevAuth set")
	}
	clearV2Env(t)
	t.Setenv("LEDGER_MAIL_DOMAIN", "example.test")
	t.Setenv("LEDGER_PG_DSN", "postgres:///x")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DevAuth || cfg.Server.DNSFixtures != "" {
		t.Fatalf("Load() enabled a test-only flag: %+v", cfg.Server)
	}
}
