// Package config loads ledger's TOML configuration, applying defaults and
// environment overrides. Secrets are never read from the TOML file; they come
// from the environment (see later milestones for IMAP/AI credentials).
package config

import (
	"fmt"
	"os"
	"time"

	"github.com/BurntSushi/toml"
)

// Config is the subset of config.toml that Milestone 1 needs. Later milestones
// extend this struct; unknown TOML sections are ignored by the decoder.
type Config struct {
	Server ServerConfig `toml:"server"`
	IMAP   IMAPConfig   `toml:"imap"`
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
	return nil
}
