package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// clearLedgerEnv neutralizes every env override Load consults, so tests
// assert on the TOML they wrote rather than on whatever the invoking shell
// happens to export (the dev sandbox exports LEDGER_AI_API_KEY, which made
// TestAIConfigEnabledRequiresAPIKey fail on some machines and pass on others).
// t.Setenv also registers cleanup, restoring the caller's env afterwards.
func clearLedgerEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		// keep in lockstep with the os.Getenv calls in config.go
		"LEDGER_LISTEN", "LEDGER_DATA_DIR",
		"LEDGER_IMAP_HOST", "LEDGER_IMAP_USERNAME", "LEDGER_IMAP_APP_PASSWORD",
		"LEDGER_AI_API_KEY", "LEDGER_TYPESAFE_API_KEY",
	} {
		t.Setenv(k, "")
	}
}

func TestLoadDefaultsWhenNoPath(t *testing.T) {
	clearLedgerEnv(t)
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
	clearLedgerEnv(t)
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
	clearLedgerEnv(t)
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
	clearLedgerEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte("[server]\nlisten = \"\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected error for empty listen, got nil")
	}
}

func TestIMAPDisabledByDefault(t *testing.T) {
	clearLedgerEnv(t)
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
	clearLedgerEnv(t)
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
	clearLedgerEnv(t)
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
	clearLedgerEnv(t)
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
	clearLedgerEnv(t)
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

func writeTOML(t *testing.T, content string) string {
	t.Helper()
	f := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(f, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestAIConfigDefaults(t *testing.T) {
	clearLedgerEnv(t)
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.Enabled {
		t.Error("AI must default to disabled")
	}
	if cfg.AI.Model != "claude-haiku-4-5-20251001" {
		t.Errorf("model default = %q, want claude-haiku-4-5-20251001", cfg.AI.Model)
	}
	if !cfg.AI.AllowAIExtraction {
		t.Error("AllowAIExtraction must default to true")
	}
}

func TestAIConfigEnvAPIKey(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_AI_API_KEY", "sk-test-key")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.APIKey != "sk-test-key" {
		t.Errorf("APIKey = %q, want sk-test-key", cfg.AI.APIKey)
	}
}

func TestAIConfigEnabledRequiresAPIKey(t *testing.T) {
	clearLedgerEnv(t)
	f := writeTOML(t, `
[ai]
enabled = true
`)
	_, err := Load(f)
	if err == nil {
		t.Error("expected error when AI enabled but no API key")
	}
}

func TestAIProviderDefaults(t *testing.T) {
	clearLedgerEnv(t)
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.Provider != "typesafe" || cfg.AI.TypeSafeModel != "jev-1.13.0" || cfg.AI.TxnIgnoreThreshold != 0.97 {
		t.Errorf("defaults = %q %q %v", cfg.AI.Provider, cfg.AI.TypeSafeModel, cfg.AI.TxnIgnoreThreshold)
	}
}

func TestTypeSafeProviderNeedsTypeSafeKey(t *testing.T) {
	clearLedgerEnv(t)
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"typesafe\"\n")
	if _, err := Load(p); err == nil || !strings.Contains(err.Error(), "LEDGER_TYPESAFE_API_KEY") {
		t.Errorf("err = %v, want a LEDGER_TYPESAFE_API_KEY error", err)
	}
}

// Anthropic is sunset: the TypeSafe provider never needs its key, whatever
// allow_ai_extraction says.
func TestTypeSafeNeverNeedsAnthropicKey(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "ts")
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"typesafe\"\nallow_ai_extraction = true\n")
	if _, err := Load(p); err != nil {
		t.Errorf("err = %v, want nil", err)
	}
}

func TestAnthropicProviderNeedsAnthropicKey(t *testing.T) {
	clearLedgerEnv(t)
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"anthropic\"\n")
	if _, err := Load(p); err == nil || !strings.Contains(err.Error(), "LEDGER_AI_API_KEY") {
		t.Errorf("err = %v, want a LEDGER_AI_API_KEY error", err)
	}
}

func TestUnknownProviderRejected(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_AI_API_KEY", "a")
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "ts")
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"openai\"\n")
	if _, err := Load(p); err == nil {
		t.Error("want an error for an unknown provider")
	}
}

// Production's /etc/ledger/config.toml as of 2026-10-01, verbatim [ai] block.
func TestCategorizeProviderAliasStillRead(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "ts")
	p := writeTOML(t, "[ai]\nenabled = true\ncategorize_provider = \"typesafe\"\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.Provider != "typesafe" {
		t.Errorf("Provider = %q, want typesafe from the old key", cfg.AI.Provider)
	}
}

// The alias test above uses the default value, so it would pass even if the
// old key were ignored. This one uses the other value, so it cannot.
func TestCategorizeProviderAliasNonDefault(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_AI_API_KEY", "a")
	p := writeTOML(t, "[ai]\nenabled = true\ncategorize_provider = \"anthropic\"\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.Provider != "anthropic" {
		t.Errorf("Provider = %q, want anthropic from the old key", cfg.AI.Provider)
	}
}

func TestProviderWinsOverAlias(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_AI_API_KEY", "a")
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"anthropic\"\ncategorize_provider = \"typesafe\"\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.Provider != "anthropic" {
		t.Errorf("Provider = %q, want anthropic", cfg.AI.Provider)
	}
}

func TestTxnIgnoreThresholdBounds(t *testing.T) {
	clearLedgerEnv(t)
	for _, v := range []string{"0.5", "0", "1.01"} {
		p := writeTOML(t, "[ai]\ntxn_ignore_threshold = "+v+"\n")
		if _, err := Load(p); err == nil {
			t.Errorf("threshold %s: want an error", v)
		}
	}
	p := writeTOML(t, "[ai]\ntxn_ignore_threshold = 0.9\n")
	if cfg, err := Load(p); err != nil || cfg.AI.TxnIgnoreThreshold != 0.9 {
		t.Errorf("threshold 0.9: cfg %v err %v", cfg.AI.TxnIgnoreThreshold, err)
	}
}

func TestProviderKey(t *testing.T) {
	c := AIConfig{Provider: "typesafe", APIKey: "a", TypeSafeAPIKey: "ts"}
	if c.ProviderKey() != "ts" {
		t.Errorf("typesafe key = %q", c.ProviderKey())
	}
	c.Provider = "anthropic"
	if c.ProviderKey() != "a" {
		t.Errorf("anthropic key = %q", c.ProviderKey())
	}
}
