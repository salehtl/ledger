package config

import (
	"strings"
	"testing"
)

// The rule spec §3.1 states in one line — "admin stays tailnet-only" — as the
// set of addresses this process will actually bind.
//
// The brief writes this test against a `checkAdminBind`; it is exported here
// because cmd/ledgerd's runServe has to call the same predicate immediately
// before net.Listen, and a second copy of a security rail is a second thing to
// get wrong.
func TestAdminListenerRefusesAPublicBind(t *testing.T) {
	refused := []string{
		"0.0.0.0:8079",        // every interface, explicitly
		":8079",               // every interface, idiomatically — the dangerous one
		"178.104.132.41:8079", // this box's real public address
		"[::]:8079",           // every interface, v6
		"100.63.255.255:8079", // one below the CGNAT range
		"100.128.0.0:8079",    // one above it
		"192.168.1.10:8079",   // a LAN address is not a tailnet
		"10.0.0.5:8079",       // nor is RFC1918 generally
		"example.test:8079",   // a name that is not localhost
		"8079",                // not host:port at all
		"",                    // empty
		"127.0.0.1",           // no port
		"100.100.215.38",      // no port, tailnet host
	}
	for _, addr := range refused {
		if err := CheckAdminBind(addr); err == nil {
			t.Errorf("admin must refuse %q (spec §3.1: tailnet-only)", addr)
		}
	}

	allowed := []string{
		"127.0.0.1:8079",
		"localhost:8079",
		"[::1]:8079",
		"127.0.0.53:8079",
		"100.100.215.38:8079", // a real Tailscale address
		"100.64.0.0:8079",     // the bottom of the CGNAT range
		"100.127.255.254:8079",
	}
	for _, addr := range allowed {
		if err := CheckAdminBind(addr); err != nil {
			t.Errorf("%q: %v", addr, err)
		}
	}
}

// The refusal has to name the rule, not just fail. An operator who set
// LEDGER_ADMIN_LISTEN=:8079 to "make it reachable" is doing the exact thing the
// rail exists to stop, and the message is the only chance to say so.
func TestAdminBindRefusalExplainsTheTailnetRule(t *testing.T) {
	err := CheckAdminBind("0.0.0.0:8079")
	if err == nil {
		t.Fatal("expected a refusal")
	}
	for _, want := range []string{"admin", "100.64.0.0/10", "loopback"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal does not mention %q: %v", want, err)
		}
	}
}

// Load is the door every deployment comes through, so the rail belongs in
// validate() and not only in cmd/ledgerd. The comment in
// config.v2.example.toml has claimed this since Task 18; this is the test that
// makes the claim true.
func TestLoadRefusesANonTailnetAdminListen(t *testing.T) {
	t.Setenv("LEDGER_MAIL_DOMAIN", "example.test")
	t.Setenv("LEDGER_PG_DSN", "postgres:///ledger_v2_test")
	t.Setenv("LEDGER_ADMIN_LISTEN", "0.0.0.0:8079")
	if _, err := Load(""); err == nil {
		t.Fatal("Load accepted a public admin_listen")
	}
}

func TestLoadAcceptsATailnetAdminListen(t *testing.T) {
	t.Setenv("LEDGER_MAIL_DOMAIN", "example.test")
	t.Setenv("LEDGER_PG_DSN", "postgres:///ledger_v2_test")
	t.Setenv("LEDGER_ADMIN_LISTEN", "100.100.215.38:8079")
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server.AdminListen != "100.100.215.38:8079" {
		t.Fatalf("admin_listen = %q", cfg.Server.AdminListen)
	}
}

// The shipped example must load. Task 10's review caught this file drifting
// into an invalid state with no test reading it; the admin_listen comment is
// the second claim in it that only a test can keep honest.
func TestTheShippedExampleConfigSatisfiesTheAdminRail(t *testing.T) {
	t.Setenv("LEDGER_PG_DSN", "postgres:///ledger_v2_test")
	cfg, err := Load("../../../config.v2.example.toml")
	if err != nil {
		t.Fatalf("config.v2.example.toml does not load: %v", err)
	}
	if err := CheckAdminBind(cfg.Server.AdminListen); err != nil {
		t.Fatalf("config.v2.example.toml's admin_listen: %v", err)
	}
}
