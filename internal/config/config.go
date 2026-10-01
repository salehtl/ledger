// Package config loads ledger's TOML configuration, applying defaults and
// environment overrides. Secrets are never read from the TOML file; they come
// from the environment (see later milestones for IMAP/AI credentials).
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config is the subset of config.toml that Milestone 1 needs. Later milestones
// extend this struct; unknown TOML sections are ignored by the decoder.
type Config struct {
	Server     ServerConfig     `toml:"server"`
	IMAP       IMAPConfig       `toml:"imap"`
	AI         AIConfig         `toml:"ai"`
	Monitoring MonitoringConfig `toml:"monitoring"`
}

// ServerConfig controls the HTTP listener and on-disk data location.
type ServerConfig struct {
	Listen  string `toml:"listen"`
	DataDir string `toml:"data_dir"`
}

// IMAPConfig holds all settings for the optional IMAP ingestion feature.
// The app password is never read from TOML; it comes from LEDGER_IMAP_APP_PASSWORD.
type IMAPConfig struct {
	Host         string `toml:"host"`
	Port         int    `toml:"port"`
	Username     string `toml:"username"`
	Auth         string `toml:"auth"`
	Folder       string `toml:"folder"`
	ReadOnly     bool   `toml:"read_only"`
	UseIDLE      bool   `toml:"use_idle"`
	PollInterval string `toml:"poll_interval"`
	AppPassword  string `toml:"-"` // secret — env only, never from TOML
}

// AIConfig holds settings for the AI provider. API keys are NEVER read from
// TOML; they come from LEDGER_TYPESAFE_API_KEY and LEDGER_AI_API_KEY.
type AIConfig struct {
	Enabled bool `toml:"enabled"`
	// Provider answers every AI question: "typesafe" (default), or "anthropic"
	// (sunset 2026-10: Anthropic categorization and extraction, kept only so
	// it can come back).
	Provider string `toml:"provider"`
	// CategorizeProvider is the pre-2026-10 name for Provider, still read.
	CategorizeProvider string `toml:"categorize_provider"`
	TypeSafeModel      string `toml:"typesafe_model"`
	// TxnIgnoreThreshold: a "not a transaction" verdict at or above this sets
	// the email aside. Pick it from `ledger txncheck-eval`.
	TxnIgnoreThreshold float64 `toml:"txn_ignore_threshold"`
	Model              string  `toml:"model"`               // Anthropic model; sunset path only
	AllowAIExtraction  bool    `toml:"allow_ai_extraction"` // sunset path only
	APIKey             string  `toml:"-"`                   // LEDGER_AI_API_KEY, env only
	TypeSafeAPIKey     string  `toml:"-"`                   // LEDGER_TYPESAFE_API_KEY, env only
}

// ProviderKey is the API key the configured provider needs.
func (c AIConfig) ProviderKey() string {
	if c.Provider == "anthropic" {
		return c.APIKey
	}
	return c.TypeSafeAPIKey
}

// MonitoringConfig controls the drift detection window and threshold.
type MonitoringConfig struct {
	DriftWindow string   `toml:"drift_window"` // e.g. "7d", "24h"
	DriftMin    float64  `toml:"drift_min"`    // 0.0–1.0; alert if success rate drops below this
	Senders     []string `toml:"senders"`      // from_addr substrings to drift-check; empty = all senders
}

// ParseDriftWindow parses the drift_window string. Supports "Nd" for days in
// addition to standard time.ParseDuration formats.
func (c MonitoringConfig) ParseDriftWindow() (time.Duration, error) {
	s := strings.TrimSpace(c.DriftWindow)
	if strings.HasSuffix(s, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil {
			return 0, fmt.Errorf("drift_window %q: expected integer days", s)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	return time.ParseDuration(s)
}

// Enabled reports whether IMAP ingestion is configured.
func (c IMAPConfig) Enabled() bool { return c.Host != "" }

// Addr returns the host:port string for the IMAP server.
func (c IMAPConfig) Addr() string { return fmt.Sprintf("%s:%d", c.Host, c.Port) }

// Interval parses and returns the poll interval duration.
func (c IMAPConfig) Interval() (time.Duration, error) { return time.ParseDuration(c.PollInterval) }

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
		AI: AIConfig{
			Model:              "claude-haiku-4-5-20251001",
			AllowAIExtraction:  true,
			TypeSafeModel:      "jev-1.13.0",
			TxnIgnoreThreshold: 0.97,
		},
		Monitoring: MonitoringConfig{
			DriftWindow: "7d",
			DriftMin:    0.80,
			// Only drift-check senders we actually have parsers for; this keeps
			// non-bank noise (Google/iCloud forwards) from raising false alerts.
			Senders: []string{"dib.ae", "emiratesnbd.com"},
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
	if v := os.Getenv("LEDGER_IMAP_HOST"); v != "" {
		cfg.IMAP.Host = v
	}
	if v := os.Getenv("LEDGER_IMAP_USERNAME"); v != "" {
		cfg.IMAP.Username = v
	}
	if v := os.Getenv("LEDGER_IMAP_APP_PASSWORD"); v != "" {
		cfg.IMAP.AppPassword = v
	}
	if v := os.Getenv("LEDGER_AI_API_KEY"); v != "" {
		cfg.AI.APIKey = v
	}
	if v := os.Getenv("LEDGER_TYPESAFE_API_KEY"); v != "" {
		cfg.AI.TypeSafeAPIKey = v
	}
	if cfg.AI.Provider == "" {
		cfg.AI.Provider = cfg.AI.CategorizeProvider
	}
	if cfg.AI.Provider == "" {
		cfg.AI.Provider = "typesafe"
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
	if c.AI.Enabled {
		switch c.AI.Provider {
		case "typesafe":
			if c.AI.TypeSafeAPIKey == "" {
				return fmt.Errorf("ai.provider = \"typesafe\" requires LEDGER_TYPESAFE_API_KEY env var")
			}
		case "anthropic":
			if c.AI.APIKey == "" {
				return fmt.Errorf("ai.provider = \"anthropic\" requires LEDGER_AI_API_KEY env var")
			}
		default:
			return fmt.Errorf("ai.provider must be \"typesafe\" or \"anthropic\" (got %q)", c.AI.Provider)
		}
	}
	if t := c.AI.TxnIgnoreThreshold; t <= 0.5 || t > 1 {
		return fmt.Errorf("ai.txn_ignore_threshold must be above 0.5 and at most 1 (got %v)", t)
	}
	if _, err := c.Monitoring.ParseDriftWindow(); err != nil {
		return fmt.Errorf("monitoring.drift_window invalid: %w", err)
	}
	return nil
}
