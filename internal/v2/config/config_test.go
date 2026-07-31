package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	if cfg.Server.HTTPListen != ":443" {
		t.Fatalf("default HTTPListen = %q", cfg.Server.HTTPListen)
	}
	if cfg.Server.AdminListen != "127.0.0.1:8079" {
		t.Fatalf("default AdminListen = %q", cfg.Server.AdminListen)
	}
	if cfg.Mail.SMTPListen != ":25" {
		t.Fatalf("default SMTPListen = %q", cfg.Mail.SMTPListen)
	}
	if cfg.Mail.MaxMessageBytes != 1<<20 {
		t.Fatalf("default MaxMessageBytes = %d", cfg.Mail.MaxMessageBytes)
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
	for _, n := range []int{0, -1, 1<<20 + 1} {
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
