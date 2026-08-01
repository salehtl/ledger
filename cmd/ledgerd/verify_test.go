package main

// Tests for `ledgerd verify` and `ledgerd parse-rate` (Task 36). See verify.go.

import (
	"bufio"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/config"
	"ledger/internal/v2/verify"
)

// verify and parse-rate check their arguments before opening anything, for the
// reason that matters more here than anywhere else: the zero config carries an
// EMPTY DSN, and libpq reads a default host, user and database out of the
// environment when it gets one. A handler that reached pg.Open with an
// unparseable --from would therefore connect to whatever database the operator's
// shell happened to point at — which for this repo's box is production.
func TestVerifyAndParseRateRefuseBadArgumentsBeforeTouchingPostgres(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		v          config.VerifyArgs
		wants      string
	}{
		{"verify: not a uuid", "verify", config.VerifyArgs{User: "alice"}, "not a uuid"},
		{"verify: bad from", "verify", config.VerifyArgs{From: "yesterday"}, "RFC3339"},
		{"verify: bad to", "verify", config.VerifyArgs{To: "soon"}, "RFC3339"},
		{
			"verify: inverted window", "verify",
			config.VerifyArgs{From: "2026-08-02T00:00:00Z", To: "2026-08-01T00:00:00Z"},
			"must be before",
		},
		{"parse-rate: not a uuid", "parse-rate", config.VerifyArgs{User: "alice"}, "not a uuid"},
		{"parse-rate: bad from", "parse-rate", config.VerifyArgs{From: "yesterday"}, "RFC3339"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := modeHandlers[tc.mode](config.Config{Verify: tc.v})
			if err == nil {
				t.Fatal("the handler accepted the arguments")
			}
			if !strings.Contains(err.Error(), tc.wants) {
				t.Fatalf("error does not explain the problem (%q): %v", tc.wants, err)
			}
		})
	}
}

// The window is what both reports ECHO, so it has to resolve to two concrete
// instants whatever the operator left out.
func TestVerifyWindowDefaultsToAConcreteWindow(t *testing.T) {
	const day = 24 * time.Hour
	from, to, err := verifyWindow(config.VerifyArgs{}, 2*day)
	if err != nil {
		t.Fatal(err)
	}
	if from.IsZero() || to.IsZero() {
		t.Fatalf("verifyWindow({}) = %v..%v; a report that says 0001-01-01 is one nobody can compare", from, to)
	}
	if d := to.Sub(from); d != 2*day {
		t.Fatalf("default window is %v, want %v", d, 2*day)
	}

	// An explicit --from with no --to still ends at now, not at the default
	// span past from: "since Tuesday" must not silently mean "Tuesday plus two
	// weeks", which for a window in the past would report a future.
	start := time.Now().Add(-5 * day).UTC().Truncate(time.Second)
	from, to, err = verifyWindow(config.VerifyArgs{From: start.Format(time.RFC3339)}, 2*day)
	if err != nil {
		t.Fatal(err)
	}
	if !from.Equal(start) {
		t.Fatalf("from = %v, want %v", from, start)
	}
	if to.Before(time.Now().Add(-time.Minute)) {
		t.Fatalf("to = %v, want approximately now", to)
	}
}

// A mistyped verdict is a permanent wrong number in the exit measurement, so the
// prompt loops on anything it does not recognise rather than guessing — and it
// stops cleanly on EOF instead of spinning against a non-interactive stdin.
func TestAskVerdictLoopsOnNonsenseAndStopsAtEOF(t *testing.T) {
	got, err := askVerdict(bufio.NewReader(strings.NewReader("maybe\nsort of\nt\n")))
	if err != nil {
		t.Fatal(err)
	}
	if got != verify.VerdictTransaction {
		t.Fatalf("askVerdict = %q, want %q after two unrecognised answers", got, verify.VerdictTransaction)
	}
	if got, err = askVerdict(bufio.NewReader(strings.NewReader(""))); err != nil || got != "" {
		t.Fatalf("askVerdict(EOF) = (%q, %v), want (\"\", nil) so a piped stdin stops rather than spins", got, err)
	}
	if got, err = askVerdict(bufio.NewReader(strings.NewReader("q\n"))); err != nil || got != "" {
		t.Fatalf("askVerdict(q) = (%q, %v), want (\"\", nil)", got, err)
	}
}

func TestClipBodyBoundsWhatIsPrinted(t *testing.T) {
	long := strings.Repeat("x", maxAdjudicationBody+500)
	got := clipBody(long)
	if len(got) >= len(long) {
		t.Fatalf("clipBody did not truncate a %d-byte body", len(long))
	}
	if !strings.HasSuffix(got, "(truncated)") {
		t.Fatal("a truncated body does not say so, so an operator would judge a message they only half saw")
	}
	if short := "one line"; clipBody(short) != short {
		t.Fatalf("clipBody(%q) = %q", short, clipBody(short))
	}
}

// One --user flag feeds three modes' argument structs. Pinned because the
// failure is silent in exactly the same way the purge case is: a --user that
// reached purge but not verify would make `ledgerd verify --user X` audit every
// account on the box while the operator watched a UUID sit on their command
// line.
func TestParseArgsCarriesTheVerifyFlags(t *testing.T) {
	u := uuid.NewString()
	got, err := parseArgs([]string{"parse-rate", "--user", u,
		"--from", "2026-08-01T00:00:00Z", "--to", "2026-08-15T00:00:00Z",
		"--sample", "50", "--adjudicate", "--json"})
	if err != nil {
		t.Fatal(err)
	}
	want := config.VerifyArgs{
		User: u, From: "2026-08-01T00:00:00Z", To: "2026-08-15T00:00:00Z",
		Sample: 50, Adjudicate: true, JSON: true,
	}
	if got.mode != "parse-rate" || got.verify != want {
		t.Fatalf("parseArgs = {%q %+v}, want {parse-rate %+v}", got.mode, got.verify, want)
	}
	if got.purge.User != u {
		t.Fatalf("--user reached verify but not purge: %+v", got.purge)
	}
}
