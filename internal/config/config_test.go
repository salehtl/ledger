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
