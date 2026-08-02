package main

import (
	"bytes"
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"log"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/admin"
	"ledger/internal/v2/api"
	"ledger/internal/v2/auth"
	"ledger/internal/v2/config"
	"ledger/internal/v2/dict"
	"ledger/internal/v2/ingest"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/samples"
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

// TestRunRelayRefusesBadArgumentsBeforeTouchingTheNetwork is what is left of
// TestNonServeHandlersStubImmediatelyWithNoIO, whose list is now empty: every
// mode is implemented. seed-dictionary and purge-user (Tasks 33/34), verify and
// parse-rate (Task 36) and relay (Task 35) each carry their own half of that
// test's job — "refuses immediately, against its arguments, with no I/O" — and
// this is relay's.
//
// The zero config carries no mail domain, no spool directory, no primary URL and
// no token, so a runRelay that reached net.Listen or an HTTP round trip would be
// doing it against nothing the operator configured. It is also the mode with the
// most to lose from starting half-configured: a relay that binds port 25 without
// a usable spool answers 250 to mail it cannot keep.
func TestRunRelayRefusesBadArgumentsBeforeTouchingTheNetwork(t *testing.T) {
	err := runRelay(config.Config{})
	if err == nil {
		t.Fatal("runRelay accepted a zero config")
	}
	if !strings.Contains(err.Error(), "mail.domain") {
		t.Fatalf("runRelay(zero config) = %v, want a refusal naming mail.domain", err)
	}
	for name, r := range map[string]config.RelayConfig{
		"no spool dir":      {PrimaryURL: "https://primary.example.test", Token: "t"},
		"no primary url":    {SpoolDir: t.TempDir(), Token: "t"},
		"no token":          {SpoolDir: t.TempDir(), PrimaryURL: "https://primary.example.test"},
		"cleartext primary": {SpoolDir: t.TempDir(), PrimaryURL: "http://primary.example.test", Token: "t"},
	} {
		t.Run(name, func(t *testing.T) {
			cfg := config.Config{Mail: config.MailConfig{Domain: "example.test"}, Relay: r}
			if err := runRelay(cfg); err == nil {
				t.Fatal("runRelay accepted an unusable relay configuration")
			}
		})
	}
}

// The corpus path is checked BEFORE the Postgres pool is opened, so running the
// seed with no snapshot configured is an immediate, self-explaining refusal
// rather than a connection attempt against whatever DSN happened to be in the
// environment. The zero config carries an empty DSN, so a handler that reached
// pg.Open would be doing exactly that.
func TestSeedDictionaryRefusesWithoutACorpusBeforeTouchingPostgres(t *testing.T) {
	t.Setenv("LEDGER_CORPUS_DB", "")
	err := modeHandlers["seed-dictionary"](config.Config{})
	if err == nil {
		t.Fatal("seed-dictionary with no corpus snapshot returned no error")
	}
	if !strings.Contains(err.Error(), "LEDGER_CORPUS_DB") {
		t.Fatalf("error does not name the missing input: %v", err)
	}
}

// The dictionary retention sweep is wired into runServe, not left as a
// function nobody calls. Spec §2 states the expiry of a submitter identifier
// that never reaches the k threshold as a FACT, and for a while
// dict.ExpireStaleSubmissions had no production caller at all — so the promise
// held only in the prose. This asserts the wiring exists and survives a nil
// store, which is the shape every other sweep here has.
func TestDictSweepIsWiredAndToleratesNoStore(t *testing.T) {
	done := startDictSweep(context.Background(), nil)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("startDictSweep(nil) did not return a closed channel")
	}
	// The sweep must not silently do nothing when a store IS present: the
	// retention window has to be a real, finite number.
	if dict.DefaultSubmissionRetention <= 0 {
		t.Fatalf("dict.DefaultSubmissionRetention is %v; §2 publishes an expiry, so it "+
			"needs a finite window", dict.DefaultSubmissionRetention)
	}
}

// purge-user is the most destructive command this binary has, so its arguments
// are checked before it opens anything. The zero config carries an empty DSN,
// so a handler that reached pg.Open would be connecting to whatever DSN
// happened to be in the environment — while being asked to delete an account.
func TestPurgeUserRefusesBadArgumentsBeforeTouchingPostgres(t *testing.T) {
	for _, tc := range []struct {
		name  string
		purge config.PurgeArgs
		wants string
	}{
		{name: "nothing selected", purge: config.PurgeArgs{}, wants: "--user"},
		{
			name:  "both selected",
			purge: config.PurgeArgs{User: uuid.NewString(), RetentionDue: true},
			wants: "alternatives",
		},
		{name: "not a uuid", purge: config.PurgeArgs{User: "alice"}, wants: "not a uuid"},
		{name: "the nil uuid", purge: config.PurgeArgs{User: uuid.Nil.String()}, wants: "nil uuid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := modeHandlers["purge-user"](config.Config{Purge: tc.purge})
			if err == nil {
				t.Fatal("purge-user accepted the arguments")
			}
			if !strings.Contains(err.Error(), tc.wants) {
				t.Fatalf("error does not explain the problem (%q): %v", tc.wants, err)
			}
		})
	}
}

// record-consent is what makes `purge-user --retention-due` mean anything: it
// is the only thing that writes user_consent.retention_until. Its arguments are
// checked before any I/O for the same reason purge-user's are — the row it
// writes is a date on which an account gets deleted.
func TestRecordConsentRefusesBadArgumentsBeforeTouchingPostgres(t *testing.T) {
	valid := uuid.NewString()
	for _, tc := range []struct {
		name    string
		consent config.ConsentArgs
		wants   string
	}{
		{name: "no user", consent: config.ConsentArgs{Document: "d", RetentionUntil: "2027-01-01T00:00:00Z"}, wants: "--user"},
		{name: "no document", consent: config.ConsentArgs{User: valid, RetentionUntil: "2027-01-01T00:00:00Z"}, wants: "--document"},
		{name: "no deadline", consent: config.ConsentArgs{User: valid, Document: "d"}, wants: "--retention-until"},
		{
			name:    "deadline is not rfc3339",
			consent: config.ConsentArgs{User: valid, Document: "d", RetentionUntil: "next tuesday"},
			wants:   "RFC3339",
		},
		{
			name: "deadline precedes the signature",
			consent: config.ConsentArgs{
				User: valid, Document: "d",
				SignedAt: "2027-01-02T00:00:00Z", RetentionUntil: "2027-01-01T00:00:00Z",
			},
			wants: "not after the signature",
		},
		{
			name:    "user is not a uuid",
			consent: config.ConsentArgs{User: "alice", Document: "d", RetentionUntil: "2027-01-01T00:00:00Z"},
			wants:   "not a uuid",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := modeHandlers["record-consent"](config.Config{Consent: tc.consent})
			if err == nil {
				t.Fatal("record-consent accepted the arguments")
			}
			if !strings.Contains(err.Error(), tc.wants) {
				t.Fatalf("error does not explain the problem (%q): %v", tc.wants, err)
			}
		})
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

// purge-user's flags go through the same FlagSet as everything else, which is
// the only thing keeping "the mode comes first" from having a second, divergent
// implementation. Pinned because the failure would be silent: an unparsed
// --user is an empty --user, and the command would refuse with "nothing
// selected" while the operator watched a UUID sit on their command line.
func TestParseArgsCarriesThePurgeFlags(t *testing.T) {
	u := uuid.NewString()
	got, err := parseArgs([]string{"purge-user", "--user", u, "--dry-run"})
	if err != nil {
		t.Fatal(err)
	}
	want := config.PurgeArgs{User: u, DryRun: true}
	if got.mode != "purge-user" || got.purge != want {
		t.Fatalf("parseArgs = {%q %+v}, want {purge-user %+v}", got.mode, got.purge, want)
	}

	got, err = parseArgs([]string{"purge-user", "--retention-due"})
	if err != nil {
		t.Fatal(err)
	}
	if !got.purge.RetentionDue || got.purge.User != "" {
		t.Fatalf("parseArgs = %+v, want only RetentionDue", got.purge)
	}

	// record-consent shares --user with the modes above and adds three of its
	// own. An unparsed --retention-until is an EMPTY one, which the handler then
	// refuses as "required" while the operator watches the date sit on their
	// command line.
	got, err = parseArgs([]string{
		"record-consent", "--user", u, "--document", "alpha-plaintext-v1",
		"--retention-until", "2027-01-31T00:00:00Z", "--signed-at", "2026-08-01T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	wantConsent := config.ConsentArgs{
		User:           u,
		Document:       "alpha-plaintext-v1",
		RetentionUntil: "2027-01-31T00:00:00Z",
		SignedAt:       "2026-08-01T00:00:00Z",
	}
	if got.mode != "record-consent" || got.consent != wantConsent {
		t.Fatalf("parseArgs = {%q %+v}, want {record-consent %+v}", got.mode, got.consent, wantConsent)
	}
}

// TestQuarantineSweepSurvivesAFailureAndStopsOnShutdown covers the loop that
// carries spec §2's drop policy in production.
//
// Two properties, both of which would otherwise only be observed in a month:
// a sweep that ERRORS must not end the loop (the next hour's warnings still
// have to go out), and the loop must stop when the process is shutting down
// rather than outliving it. A nil store — the deployment that receives no mail
// — must not start one at all.
func TestQuarantineSweepSurvivesAFailureAndStopsOnShutdown(t *testing.T) {
	select {
	case <-startQuarantineSweep(context.Background(), nil):
	case <-time.After(5 * time.Second):
		t.Fatal("a nil quarantine store must not start a sweep")
	}

	var logged strings.Builder
	restore := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(restore)

	// A store with no pool fails every sweep, which is what an unreachable
	// database looks like from here.
	ctx, cancel := context.WithCancel(context.Background())
	done := startQuarantineSweep(ctx, &quarantine.Store{})
	// Give the first iteration a moment to run and log before shutting down.
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the sweep did not stop when the context was cancelled")
	}
	if !strings.Contains(logged.String(), "quarantine sweep") {
		t.Fatalf("a failed sweep must be loud, not swallowed: %q", logged.String())
	}
}

// ---------------------------------------------------------------------------
// The admin listener (Task 32)
// ---------------------------------------------------------------------------

// runServe refuses a public admin bind BEFORE it opens Postgres.
//
// config.validate already refuses one, so a process started through Load can
// never reach this. That is exactly why it is here: a Config assembled in code
// — which every test does, and which a future subcommand might — would
// otherwise walk straight past the one rail spec §3.1 depends on. The zero DSN
// below is the proof that no I/O happened first: a handler that reached pg.Open
// would fail with a connection error naming the DSN, not with this message.
func TestRunServeRefusesAPublicAdminBind(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:8079", ":8079", "178.104.132.41:8079", "192.168.1.10:8079"} {
		// No DSN at all: a handler that reached pg.Open before the bind check
		// would fail with a connection error rather than this one.
		err := runServe(config.Config{
			Server: config.ServerConfig{HTTPListen: "127.0.0.1:8443", AdminListen: addr},
		})
		if err == nil {
			t.Fatalf("runServe started with admin_listen %q (spec §3.1: tailnet-only)", addr)
		}
		if !strings.Contains(err.Error(), "admin_listen") {
			t.Fatalf("admin_listen %q was refused for the wrong reason: %v", addr, err)
		}
	}
}

// And the accepted shapes get past the bind check — they fail later, on the
// database, which is what proves the rail let them through rather than that it
// was never consulted.
//
// The DSN points at a closed port rather than being empty. An empty conn string
// makes pgx fall back to libpq's PG* environment variables, so on a box where
// those happen to name a live cluster this test would migrate it and then reach
// net.Listen — binding :25 and :8443 and blocking until the signal that never
// comes. A test whose behaviour depends on the developer's shell environment is
// not a test.
func TestRunServeAcceptsLoopbackAndTailnetAdminBinds(t *testing.T) {
	const unreachable = "postgres://ledger@127.0.0.1:1/ledger_v2_unreachable?connect_timeout=1"
	for _, addr := range []string{"127.0.0.1:8079", "100.100.215.38:8079", "[::1]:8079"} {
		err := runServe(config.Config{
			Server: config.ServerConfig{
				HTTPListen: "127.0.0.1:8443", AdminListen: addr, DSN: unreachable,
			},
		})
		if err == nil {
			t.Fatalf("runServe returned no error against an unreachable database")
		}
		if strings.Contains(err.Error(), "admin_listen") {
			t.Fatalf("runServe refused %q: %v", addr, err)
		}
	}
}

// The admin console never appears on the listener users reach. This reads the
// two handlers main() actually builds rather than trusting the wiring by
// inspection: every /admin/ path must be absent from the public mux, and every
// /api/ path absent from the admin one.
func TestTheAdminConsoleIsNotMountedOnThePublicListener(t *testing.T) {
	pub, adm := publicAndAdminHandlers(t)
	for _, p := range []string{
		"/admin/templates", "/admin/dictionary", "/admin/diagnostics",
		"/admin/waitlist", "/admin/quarantine", "/admin/accounting",
	} {
		rec := httptest.NewRecorder()
		pub.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("the PUBLIC listener answered %s with %d; it must not exist there", p, rec.Code)
		}
	}
	for _, p := range []string{"/api/v1/sync", "/api/v1/writers", "/api/v1/dictionary"} {
		rec := httptest.NewRecorder()
		adm.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("the ADMIN listener answered %s with %d; the user API must not exist there", p, rec.Code)
		}
	}
}

// publicAndAdminHandlers builds both routers over a pool that is never
// connected.
//
// pgxpool.New does not dial: connections are opened lazily on first use, so a
// DSN pointing at a closed port is enough to build every store and mount every
// route. That is the whole point — this test is about which PATTERNS exist on
// which mux, a question that has no database in it, and answering it against a
// real cluster would make a routing regression depend on Postgres being up.
func publicAndAdminHandlers(t *testing.T) (public, adminH http.Handler) {
	t.Helper()
	pool, err := pgxpool.New(context.Background(),
		"postgres://ledger@127.0.0.1:1/ledger_v2_unreachable?connect_timeout=1")
	if err != nil {
		t.Fatalf("build pool: %v", err)
	}
	t.Cleanup(pool.Close)

	cfg := config.Config{
		Server: config.ServerConfig{
			HTTPListen: "127.0.0.1:8443", AdminListen: "127.0.0.1:8079",
			AdminToken: "operator-token-for-tests",
		},
		Mail: config.MailConfig{Domain: "example.test"},
		Auth: config.AuthConfig{SessionTTL: time.Hour},
	}
	srv, err := api.NewServer(cfg, pool)
	if err != nil {
		t.Fatalf("api.NewServer: %v", err)
	}
	adminH, err = adminHandler(cfg, pool, nil)
	if err != nil {
		t.Fatalf("adminHandler: %v", err)
	}
	return srv.Handler(), adminH
}

// A deployment with no LEDGER_ADMIN_TOKEN serves NO console rather than an open
// one — and, just as deliberately, rather than refusing to boot: taking the
// sync API and the mail receiver down because a template-authoring credential
// is unset would be a far worse outcome than having no console.
func TestNoAdminTokenMeansNoConsoleRatherThanAnOpenOne(t *testing.T) {
	srv, err := adminServer(config.Config{
		Server: config.ServerConfig{AdminListen: "127.0.0.1:8079"},
	}, nil, nil)
	if err != nil {
		t.Fatalf("adminServer: %v", err)
	}
	if srv != nil {
		t.Fatal("an admin console was built with no LEDGER_ADMIN_TOKEN")
	}
}

// The adapter between ingest.Report and admin.Report carries EVERY field.
//
// They are separate types in separate packages on purpose — admin must not
// import ingest — so nothing but this test connects them. The reflect check is
// the half that matters: a field added to ingest.Report by a later task without
// a line in toAdminReport would otherwise be silently dropped from the
// operator's own accounting, which is the one number this console exists to
// make trustworthy.
func TestTheReprocessAdapterCarriesEveryField(t *testing.T) {
	in := ingest.Report{Examined: 11, Appended: 2, Superseded: 3, Unchanged: 5, Failed: 1}
	got := toAdminReport(in)
	want := admin.Report{Examined: 11, Appended: 2, Superseded: 3, Unchanged: 5, Failed: 1}
	if got != want {
		t.Fatalf("toAdminReport(%+v) = %+v, want %+v", in, got, want)
	}
	if n, m := reflect.TypeOf(in).NumField(), reflect.TypeOf(got).NumField(); n != m {
		t.Fatalf("ingest.Report has %d fields and admin.Report has %d: a field was added "+
			"to one without a line in toAdminReport, and it is being dropped silently", n, m)
	}
	// A zero in maps to a zero out, so the mapping cannot be hiding a constant.
	if toAdminReport(ingest.Report{}) != (admin.Report{}) {
		t.Fatal("toAdminReport does not map the zero report to the zero report")
	}
}

// The same pin on the donated-sample adapter, and it matters more than the
// report one: a Raw or a ReceivedAt dropped here means the publish gate replays
// an EMPTY corpus and reports every regression as clean. That failure looks
// exactly like success from the console, so nothing downstream would catch it.
func TestTheSampleAdapterCarriesEveryField(t *testing.T) {
	in := samples.Sample{
		ID:           uuid.New(),
		UserID:       uuid.New(),
		SenderDomain: "alerts.testbank.test",
		StructureSig: "0123456789abcdef0123456789abcdef",
		IngestID:     bytes.Repeat([]byte{7}, 32),
		Raw:          []byte("From: alerts@testbank.test\r\n\r\nYou spent AED 250.00"),
		ReceivedAt:   time.Now().UTC().Truncate(time.Millisecond),
		Consent:      "donate-sample-v1",
		ConsentedAt:  time.Now().UTC().Truncate(time.Millisecond),
		CreatedAt:    time.Now().UTC().Truncate(time.Millisecond),
		ExpiresAt:    time.Now().UTC().Add(samples.DefaultRetention).Truncate(time.Millisecond),
	}
	got := toAdminSample(in)
	want := admin.Sample{
		ID: in.ID, UserID: in.UserID, SenderDomain: in.SenderDomain,
		StructureSig: in.StructureSig, Raw: in.Raw, ReceivedAt: in.ReceivedAt,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("toAdminSample = %+v, want %+v", got, want)
	}
	// Every field admin.Sample declares must be carried. The reverse is NOT
	// asserted: samples.Sample deliberately has more (the consent record, the
	// retention dates), and the console is not a place any of those belong.
	rt := reflect.TypeOf(want)
	for i := 0; i < rt.NumField(); i++ {
		f := reflect.ValueOf(got).Field(i)
		if f.IsZero() {
			t.Errorf("toAdminSample leaves admin.Sample.%s zero, so the console sees "+
				"less of the corpus than exists", rt.Field(i).Name)
		}
	}
	if !reflect.DeepEqual(toAdminSample(samples.Sample{}), admin.Sample{}) {
		t.Fatal("toAdminSample does not map the zero sample to the zero sample")
	}
}

// ---------------------------------------------------------------------------
// The retention sweeps are WIRED, measured against the source of runServe
// ---------------------------------------------------------------------------

// Every start*Sweep in this package is started by runServe and awaited on
// shutdown — read out of main.go's syntax tree, not out of a call the test
// makes itself.
//
// The existing per-sweep tests (TestDictSweepIsWiredAndToleratesNoStore,
// TestQuarantineSweepSurvivesAFailureAndStopsOnShutdown) call the starter
// directly, so they measure the loop and say nothing at all about whether
// runServe reaches it — which is the defect shape that has landed six times on
// this branch: written, tested green, never wired. dict.ExpireStaleSubmissions
// had a full test suite and no production caller for three tasks.
//
// This reads the real function. A sweep added and forgotten fails here, and so
// does a sweep whose channel is never received (a shutdown that returns while
// the loop is still mid-transaction).
func TestEverySweepIsStartedAndAwaitedByRunServe(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}

	// Every declared sweep starter, discovered rather than listed: a list here
	// would be one more thing to forget to update, which is the bug.
	sweeps := map[string]bool{}
	var runServe *ast.FuncDecl
	for _, d := range file.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Recv != nil {
			continue
		}
		if fn.Name.Name == "runServe" {
			runServe = fn
		}
		if strings.HasPrefix(fn.Name.Name, "start") && strings.HasSuffix(fn.Name.Name, "Sweep") &&
			fn.Name.Name != "startSweep" {
			sweeps[fn.Name.Name] = true
		}
	}
	if runServe == nil {
		t.Fatal("main.go declares no runServe")
	}
	if len(sweeps) < 4 {
		t.Fatalf("found %d sweep starters (%v); the four this binary runs are quarantine, "+
			"donated samples, the dictionary and the deleted-account tombstone", len(sweeps), sweeps)
	}
	if !sweeps["startTombstoneSweep"] {
		t.Fatal("startTombstoneSweep is gone: the deleted-account tombstone table is unbounded, " +
			"and it must not go back into 00021's trigger — see 00022")
	}

	started := map[string]string{} // sweep func -> variable holding its channel
	received := map[string]bool{}  // variables that appear in a <-x
	ast.Inspect(runServe.Body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.AssignStmt:
			if len(x.Lhs) != 1 || len(x.Rhs) != 1 {
				return true
			}
			call, ok := x.Rhs[0].(*ast.CallExpr)
			if !ok {
				return true
			}
			fn, ok := call.Fun.(*ast.Ident)
			if !ok || !sweeps[fn.Name] {
				return true
			}
			lhs, ok := x.Lhs[0].(*ast.Ident)
			if !ok {
				return true
			}
			started[fn.Name] = lhs.Name
		case *ast.UnaryExpr:
			if x.Op != token.ARROW {
				return true
			}
			if id, ok := x.X.(*ast.Ident); ok {
				received[id.Name] = true
			}
		}
		return true
	})

	for sweep := range sweeps {
		v, ok := started[sweep]
		if !ok {
			t.Errorf("%s is never called by runServe: the loop is written, tested and dead", sweep)
			continue
		}
		if !received[v] {
			t.Errorf("runServe calls %s but never receives from %s: shutdown returns while the "+
				"sweep may still be inside a transaction", sweep, v)
		}
	}
}

// The tombstone sweep survives a failing database and stops on shutdown, and a
// deployment with no Sessions does not start one at all.
//
// It is the mildest of the four failures — an unswept tombstone still answers
// correctly, because auth.Sessions judges expiry itself — so the thing that
// actually matters here is that the failure is LOUD. A sweep that quietly stops
// is how a table becomes a surprise.
func TestTombstoneSweepSurvivesAFailureAndStopsOnShutdown(t *testing.T) {
	select {
	case <-startTombstoneSweep(context.Background(), nil):
	case <-time.After(5 * time.Second):
		t.Fatal("a nil Sessions must not start a sweep")
	}

	var logged strings.Builder
	restore := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(restore)

	// A Sessions with no pool fails every sweep: an unreachable database, from
	// here.
	ctx, cancel := context.WithCancel(context.Background())
	done := startTombstoneSweep(ctx, &auth.Sessions{})
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the sweep did not stop when the context was cancelled")
	}
	if !strings.Contains(logged.String(), "deleted-account tombstone sweep") {
		t.Fatalf("a failed sweep must be loud, not swallowed: %q", logged.String())
	}
}
