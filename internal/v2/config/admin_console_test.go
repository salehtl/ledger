package config

// The console's two identity knobs. Both are inert until the operator sets
// them, and neither can loosen the binding — admin_bind_test.go covers that half
// and is deliberately untouched by this feature.

import (
	"strings"
	"testing"
)

// The default posture: the Tailscale identity `tailscale serve` injects is
// trusted, and no login allowlist narrows it. That is what removes the token
// from the operator's daily path, so it is pinned rather than left to the zero
// value nobody reads.
func TestTheConsoleTrustsTheTailscaleIdentityByDefault(t *testing.T) {
	c := defaults()
	if c.Server.AdminTokenOnly {
		t.Fatal("admin_token_only defaults to true; the operator would still have to paste a token")
	}
	if len(c.Server.AdminTailscaleLogins) != 0 {
		t.Fatalf("admin_tailscale_logins defaults to %v, want empty (any tailnet identity)",
			c.Server.AdminTailscaleLogins)
	}
}

func TestTheConsoleIdentityKnobsComeFromTOMLAndEnv(t *testing.T) {
	clearV2Env(t)
	path := writeTOML(t, `
[mail]
domain = "example.test"

[server]
dsn = "postgres:///x"
admin_token_only = true
admin_tailscale_logins = ["from-toml@github"]
`)
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Server.AdminTokenOnly {
		t.Fatal("admin_token_only was not read from TOML")
	}
	if len(cfg.Server.AdminTailscaleLogins) != 1 || cfg.Server.AdminTailscaleLogins[0] != "from-toml@github" {
		t.Fatalf("admin_tailscale_logins = %v", cfg.Server.AdminTailscaleLogins)
	}

	// Env wins, and it can turn the strictness back OFF — which is the direction
	// that matters during an incident, when the operator is locked out and
	// editing a file under time pressure is the slow path.
	t.Setenv("LEDGER_ADMIN_TOKEN_ONLY", "0")
	t.Setenv("LEDGER_ADMIN_TAILSCALE_LOGINS", " a@github , b@github ")
	cfg, err = Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.AdminTokenOnly {
		t.Fatal("LEDGER_ADMIN_TOKEN_ONLY=0 did not override the TOML")
	}
	if got := strings.Join(cfg.Server.AdminTailscaleLogins, "|"); got != "a@github|b@github" {
		t.Fatalf("logins = %q, want the trimmed pair", got)
	}
}

// truthy accepts only the affirmative spellings. A typo leaves the setting at
// its default rather than silently enabling something — see truthy's doc for
// which direction that is safe in.
func TestTruthyIsDeliberatelyNarrow(t *testing.T) {
	for _, v := range []string{"1", "true", "TRUE", " True "} {
		if !truthy(v) {
			t.Errorf("truthy(%q) = false", v)
		}
	}
	for _, v := range []string{"", "0", "false", "yes", "on", "ture"} {
		if truthy(v) {
			t.Errorf("truthy(%q) = true", v)
		}
	}
}
