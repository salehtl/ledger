package main

import (
	"strings"
	"testing"

	"ledger/internal/v2/config"
)

// TestModeHandlersCoverConfigModesExactly is the real coverage the config
// package's TestEveryDispatchModeHasACase cannot provide: that test only
// compares two structures both defined in internal/v2/config/config.go
// (Modes() and modeImplemented), so it is trivially self-consistent and
// cannot see whether cmd/ledgerd's actual dispatch table has a matching
// entry. This test reads modeHandlers directly — the literal map main()
// dispatches through — so a mode added to config.Modes() without a
// corresponding handler here fails this test, not just the config
// package's internal bookkeeping.
func TestModeHandlersCoverConfigModesExactly(t *testing.T) {
	for _, m := range config.Modes() {
		if _, ok := modeHandlers[m]; !ok {
			t.Fatalf("config.Modes() advertises %q but modeHandlers has no case for it", m)
		}
	}
	for m := range modeHandlers {
		found := false
		for _, cm := range config.Modes() {
			if cm == m {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("modeHandlers has a case for %q but config.Modes() does not advertise it", m)
		}
	}
}

// TestCheckModeHandlersPanicsOnDrift proves checkModeHandlers (called
// unconditionally at the top of main(), before any flag parsing or config
// load) actually panics when modeHandlers is missing an entry for a mode
// config.Modes() advertises — not just that the two happen to agree today.
// It temporarily removes a real entry, so this is the RED case for
// TestModeHandlersCoverConfigModesExactly made permanent as its own test:
// if a future change ever lets modeHandlers and config.Modes() diverge
// silently, this is the test (and the runtime panic) that catches it.
func TestCheckModeHandlersPanicsOnDrift(t *testing.T) {
	const victim = "relay"
	saved, ok := modeHandlers[victim]
	if !ok {
		t.Fatalf("test assumes modeHandlers has %q; it does not", victim)
	}
	delete(modeHandlers, victim)
	defer func() { modeHandlers[victim] = saved }()

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected checkModeHandlers to panic when a config.Modes() entry has no handler")
		}
	}()
	checkModeHandlers()
}

// TestCheckModeHandlersPanicsOnAnExtraHandler is the mirror case: a handler
// registered for a mode config.Modes() does not advertise (e.g. a stale
// entry left behind after a mode was renamed or retired) must also panic,
// not silently ship a dead, untested code path.
func TestCheckModeHandlersPanicsOnAnExtraHandler(t *testing.T) {
	const ghost = "does-not-exist-in-config-modes"
	modeHandlers[ghost] = runServe
	defer delete(modeHandlers, ghost)

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected checkModeHandlers to panic on a handler with no matching config.Modes() entry")
		}
	}()
	checkModeHandlers()
}

// TestUnknownModeIsNotInTheDispatchTable exercises the same lookup main()
// performs (modeHandlers[mode]) for a mode that is neither in config.Modes()
// nor in modeHandlers, confirming it takes the "unknown mode" path rather
// than silently matching something.
func TestUnknownModeIsNotInTheDispatchTable(t *testing.T) {
	if _, ok := modeHandlers["not-a-real-mode"]; ok {
		t.Fatal(`modeHandlers["not-a-real-mode"] unexpectedly present`)
	}
}

// TestNonServeHandlersStubImmediatelyWithNoIO proves each non-"serve" entry
// in modeHandlers is the function it looks like: calling it directly (as
// main() would) returns the expected "not implemented yet" stub error, with
// no network or database access — only "serve" does real I/O, and that path
// is covered separately by manual verification against a live pgtest
// cluster (see task-3-report.md) rather than a fast unit test, since it
// necessarily depends on external process state a unit test shouldn't own.
func TestNonServeHandlersStubImmediatelyWithNoIO(t *testing.T) {
	for _, m := range []string{"relay", "verify", "seed-dictionary", "purge-user", "parse-rate"} {
		h, ok := modeHandlers[m]
		if !ok {
			t.Fatalf("modeHandlers missing %q", m)
		}
		err := h(config.Config{})
		if err == nil || !strings.Contains(err.Error(), "not implemented yet") {
			t.Fatalf("modeHandlers[%q](zero config) = %v, want a \"not implemented yet\" stub error", m, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Argument parsing (Task 14)
// ---------------------------------------------------------------------------

// main() strips the mode from os.Args before flag.Parse, which is exactly the
// kind of hand-rolled step that breaks silently when a flag is added. parseArgs
// is that step, extracted so it can be exercised without a process.
func TestParseArgs(t *testing.T) {
	for _, tc := range []struct {
		name        string
		args        []string
		mode        string
		cfgPath     string
		devAuth     bool
		dnsFixtures string
		wantErr     bool
	}{
		{name: "no arguments defaults to serve", args: nil, mode: "serve"},
		{name: "a bare mode", args: []string{"verify"}, mode: "verify"},
		{name: "flags only, no mode", args: []string{"-config", "/etc/x.toml"}, mode: "serve", cfgPath: "/etc/x.toml"},
		{
			name: "the exit test's own invocation",
			args: []string{"serve", "--dev-auth", "--dns-fixtures", "testdata/dns.json"},
			mode: "serve", devAuth: true, dnsFixtures: "testdata/dns.json",
		},
		{name: "mode after flags is not a mode", args: []string{"-config", "x", "serve"}, wantErr: true},
		{name: "an unknown flag", args: []string{"serve", "--nope"}, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseArgs(tc.args)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseArgs(%q) = %+v, want an error", tc.args, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseArgs(%q) = %v", tc.args, err)
			}
			if got.mode != tc.mode || got.configPath != tc.cfgPath || got.devAuth != tc.devAuth || got.dnsFixtures != tc.dnsFixtures {
				t.Fatalf("parseArgs(%q) = %+v, want {%q %q %v %q}", tc.args, got, tc.mode, tc.cfgPath, tc.devAuth, tc.dnsFixtures)
			}
		})
	}
}
