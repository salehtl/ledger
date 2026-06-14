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
