// Command ledgerd is the v2 multi-user server. It shares no state, no port and
// no database with the v1 `ledger` binary.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/admin"
	"ledger/internal/v2/api"
	"ledger/internal/v2/arc"
	"ledger/internal/v2/config"
	"ledger/internal/v2/corpus"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/dict"
	"ledger/internal/v2/ingest"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/pg"
	"ledger/internal/v2/pushv2"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/smtpd"
	"ledger/internal/v2/tmpl"
)

// modeHandlers is the single dispatch table main() uses — the real switch,
// as a map instead of a `switch` statement specifically so it can be
// inspected by a test (TestModeHandlersCoverConfigModesExactly, in
// main_test.go) rather than only exercised by one. A `switch`'s case set
// isn't introspectable at runtime; a map's keys are. checkModeHandlers below
// asserts, on every single invocation of this binary — not only under a
// test someone has to remember to run — that this table's key set is
// exactly config.Modes(): no mode advertised without a handler, and no
// handler for a mode nothing advertises.
var modeHandlers = map[string]func(config.Config) error{
	"serve":           runServe,
	"relay":           runRelay,
	"verify":          runVerify,
	"seed-dictionary": runSeedDictionary,
	"purge-user":      runPurgeUser,
	"parse-rate":      runParseRate,
}

// checkModeHandlers panics if modeHandlers and config.Modes() ever name
// different sets of modes. It is called unconditionally at the top of
// main(), so a mode added to one without the other breaks the very first
// time the binary runs anywhere — dev, a test that invokes main's logic,
// or production — rather than staying latent until someone happens to run
// the right test file.
func checkModeHandlers() {
	want := make(map[string]bool, len(modeHandlers))
	for _, m := range config.Modes() {
		want[m] = true
		if _, ok := modeHandlers[m]; !ok {
			panic(fmt.Sprintf("cmd/ledgerd: config.Modes() advertises mode %q but modeHandlers has no case for it", m))
		}
	}
	for m := range modeHandlers {
		if !want[m] {
			panic(fmt.Sprintf("cmd/ledgerd: modeHandlers has a case for mode %q but config.Modes() does not advertise it", m))
		}
	}
}

// args is everything the command line carries: the dispatch mode, which is
// positional and stripped before flag parsing, plus the flags themselves.
type args struct {
	mode       string
	configPath string
	// devAuth and dnsFixtures are TEST-ONLY switches. They have no TOML key
	// and no environment override on purpose — see config.EnableTestOnly,
	// which refuses both off a loopback listener.
	devAuth     bool
	dnsFixtures string
}

// parseArgs strips the leading mode and parses the flags.
//
// Extracted from main() so it can be tested: the mode is positional and
// FIRST — `ledgerd serve --dev-auth`, never `ledgerd --dev-auth serve` — which
// is a hand-rolled rule that no flag package enforces and that breaks silently
// the moment a flag is added. A mode appearing after a flag is refused rather
// than ignored, because ignoring it would run `serve` while the operator asked
// for something else.
func parseArgs(argv []string) (args, error) {
	out := args{mode: "serve"}
	rest := argv
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		out.mode = rest[0]
		rest = rest[1:]
	}
	fs := flag.NewFlagSet("ledgerd", flag.ContinueOnError)
	fs.StringVar(&out.configPath, "config", "", "path to config.toml")
	fs.BoolVar(&out.devAuth, "dev-auth", false,
		"TEST ONLY: accept \"dev:<subject>\" as an ID token and reject every real one (loopback listener only)")
	fs.StringVar(&out.dnsFixtures, "dns-fixtures", "",
		"TEST ONLY: path to a recorded dns.json served as the DKIM/ARC TXT resolver (loopback listener only)")
	if err := fs.Parse(rest); err != nil {
		return args{}, err
	}
	if n := fs.NArg(); n > 0 {
		return args{}, fmt.Errorf("unexpected argument %q: the mode comes first (%s)", fs.Arg(0), strings.Join(config.Modes(), "|"))
	}
	return out, nil
}

func main() {
	checkModeHandlers()

	a, err := parseArgs(os.Args[1:])
	if err != nil {
		log.Fatalf("arguments: %v", err)
	}

	cfg, err := config.Load(a.configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	cfg.Mode = a.mode
	if err := cfg.EnableTestOnly(a.devAuth, a.dnsFixtures); err != nil {
		log.Fatalf("config: %v", err)
	}

	if handler, ok := modeHandlers[a.mode]; ok {
		err = handler(cfg)
	} else {
		err = fmt.Errorf("unknown mode %q (%s)", a.mode, strings.Join(config.Modes(), "|"))
	}
	if err != nil {
		log.Fatal(err)
	}
}

// runServe opens the Postgres pool, applies every embedded migration, and
// serves the sync API until SIGINT/SIGTERM.
//
// Plain HTTP on purpose: TLS is deployment Task D4, which adds autocert HERE,
// to this function, so the process terminates TLS itself on the public domain
// (v2 is multi-user with external testers — unlike v1 it is not behind a
// tailnet, and the plan puts no proxy in front of it).
//
// Everything this listener carries is sensitive — a session bearer token on
// every request, the user's whole op log in the responses — so until that
// change lands the restriction is enforced rather than assumed:
// config.validate refuses a non-loopback http_listen and the default is
// loopback. Lifting that rail is part of the same commit that adds autocert.
//
// The SMTP receiver (Task 24) is mounted here too, on the same pool, and so is
// the Tailscale-bound admin console (Task 32) — on its OWN listener, never on
// the one above. The first thing this function does is refuse a public
// admin_listen; see adminHandler and config.CheckAdminBind.
//
// The api.Server — and with it the two IdP verifiers — is built ONCE here,
// before the listener starts. That is load bearing rather than stylistic: every
// JWKS cache, fetch-attempt limit and inflight-herd guard in auth is per
// verifier instance, so a verifier constructed per request would restore the
// unauthenticated outbound amplifier those exist to remove.
func runServe(cfg config.Config) error {
	// FIRST, before any I/O at all. config.validate already refuses a public
	// admin_listen, so a process started through config.Load cannot reach this —
	// which is exactly why it is repeated: a Config assembled in code walks past
	// Load entirely, and spec §3.1's "admin stays tailnet-only" must not depend
	// on which constructor the caller happened to use. It is placed above
	// pg.Open so the refusal is the FIRST thing the operator sees rather than a
	// message after a connection attempt.
	if err := config.CheckAdminBind(cfg.Server.AdminListen); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer pool.Close()

	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	log.Println("ledgerd serve: migrations applied")

	if cfg.DevAuth {
		// Loud, every start, at the top of the log. The flag is only reachable
		// on a loopback listener (config.EnableTestOnly), and this is the second
		// thing that makes leaving it on impossible to miss.
		log.Println("ledgerd serve: *** --dev-auth: \"dev:<subject>\" is accepted as an identity and EVERY real " +
			"Apple/Google token is rejected. TEST ONLY. ***")
	}
	// The TXT resolver every DKIM and ARC check runs through. Real DNS, with a
	// per-lookup deadline and a bounded cache — banks send in bursts and every
	// message in a burst asks for the same selector — unless the operator
	// pointed the process at a recording.
	lookupTXT := origin.NewCachingLookup(
		origin.ResolverLookup(nil, origin.DefaultLookupTimeout), origin.CacheOptions{})
	if cfg.Server.DNSFixtures != "" {
		// Loaded and validated HERE, at startup, so a wrong path or a malformed
		// recording fails the process rather than surfacing later as a DKIM
		// failure that looks like a crypto bug.
		//
		// It REPLACES the resolver rather than joining it, and it is not cached:
		// a fixture file is already an in-memory map, and a cache in front of it
		// would only make a test's expectations depend on lookup order.
		fixtures, n, err := arc.FixtureLookup(cfg.Server.DNSFixtures)
		if err != nil {
			return fmt.Errorf("dns fixtures: %w", err)
		}
		lookupTXT = fixtures
		log.Printf("ledgerd serve: *** --dns-fixtures: %d recorded TXT name(s) loaded from %s; DKIM/ARC use "+
			"them instead of DNS. TEST ONLY. ***", n, cfg.Server.DNSFixtures)
	}

	syncAPI, err := api.NewServer(cfg, pool)
	if err != nil {
		return fmt.Errorf("build api: %w", err)
	}
	srv := &http.Server{
		Addr:    cfg.Server.HTTPListen,
		Handler: syncAPI.Handler(),
		// A client that opens a connection and never finishes its headers costs
		// a goroutine and a file descriptor until it does. This listener is
		// public-facing in every deployment that matters, so the timeout is not
		// optional.
		ReadHeaderTimeout: 10 * time.Second,
		// WriteTimeout is generous, but it is NOT optional, which an earlier
		// version of this file got wrong.
		//
		// The API marshals each response into one buffer, so a max-size pull
		// holds its blobs, their base64 expansion and the marshalled JSON at
		// once — around 15 MB per in-flight request at the current page budget.
		// A client that sends a request and then stops reading pins all of that
		// for as long as the connection lives, and IdleTimeout does not apply
		// mid-response. The per-page byte budget bounds ONE response; it says
		// nothing about how many can be stalled simultaneously, which is the
		// number that runs a box out of memory.
		//
		// Five minutes for a ~12 MB worst-case body is a floor of ~40 KB/s,
		// well under any link a phone syncs on, so a legitimate slow reader is
		// never cut off.
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  2 * time.Minute,
	}

	// The ingest pipeline (Task 29): the seam where an accepted message becomes
	// op-log entries, or a quarantine hold. It replaces the deferHandler this
	// function mounted between Tasks 24 and 29, which answered every message
	// with a 451 so the sender would keep it.
	//
	// pusher is Disabled unless the operator turned push on. The Expo client and
	// its content-free contract exist either way (pushv2), and the ONE call site
	// is inside the pipeline, on a hot-stream append.
	var pusher ingest.Pusher = pushv2.Disabled{}
	if cfg.Push.Enabled {
		pusher = &pushv2.Expo{Pool: pool, AccessToken: cfg.Push.AccessToken, Endpoint: cfg.Push.ExpoURL}
		log.Println("ledgerd serve: content-free push is ENABLED")
	}
	pipeline := &ingest.Pipeline{
		Pool:       pool,
		Templates:  &tmpl.Store{Pool: pool},
		Origin:     ingest.NewResolver(lookupTXT),
		Trust:      syncAPI.Quarantine,
		Appender:   &oplog.Appender{Pool: pool},
		Diag:       &diag.Diag{Pool: pool},
		Quarantine: syncAPI.Quarantine,
		Push:       pusher,
		Now:        time.Now,
	}

	// The inbound SMTP receiver (Task 24). It is the most exposed surface in the
	// system — public, unauthenticated port 25 — so it is built here, once,
	// with the same pool everything else uses.
	mail := smtpd.New(
		cfg.Mail,
		&addresses.Addresses{Pool: pool, Suffix: cfg.InboundSuffix()},
		pipeline,
		&diag.Diag{Pool: pool},
		time.Now,
	)

	// Bound HERE, not inside the goroutine below. Two reasons, both real: a
	// port-25 bind failure (permission, or something already holding it) is a
	// startup error the operator should see immediately rather than one racing
	// the rest of boot, and Shutdown closes the listener it was handed — so a
	// signal arriving during startup must not find the socket still in a
	// goroutine that has not run yet.
	mailLn, err := net.Listen("tcp", cfg.Mail.SMTPListen)
	if err != nil {
		return fmt.Errorf("smtp listen %s: %w", cfg.Mail.SMTPListen, err)
	}

	// The admin console (Task 32), on its own listener. adminHandler returns a
	// nil handler when LEDGER_ADMIN_TOKEN is unset, and the console is then not
	// served AT ALL — see there for why that is the right failure rather than
	// either an open console or a refusal to boot.
	adminSrv, err := adminServer(cfg, pool)
	if err != nil {
		return err
	}
	var adminLn net.Listener
	if adminSrv != nil {
		// Bound here for the same reason mailLn is: a bind failure is a startup
		// error the operator should see immediately, and Shutdown closes the
		// listener it was handed.
		//
		// The bind is checked a THIRD time, immediately before net.Listen, so
		// that no code added between the top of this function and this line can
		// have changed the address in between.
		if err := config.CheckAdminBind(cfg.Server.AdminListen); err != nil {
			return err
		}
		if adminLn, err = net.Listen("tcp", cfg.Server.AdminListen); err != nil {
			return fmt.Errorf("admin listen %s: %w", cfg.Server.AdminListen, err)
		}
	}

	// The quarantine sweep (Task 27). It warns a client that held mail is about
	// to expire and deletes only what it has already warned about, so spec §2's
	// "nothing is dropped without a user-visible notice" holds even for an
	// account nobody has synced in a month.
	//
	// Hourly, and started HERE rather than inside the store, because a store
	// that ran its own timer would sweep once per process that happened to
	// construct one — including every test. It runs once at startup too: a
	// process that restarts every 59 minutes would otherwise never sweep at
	// all, and the warnings the drop policy depends on would simply never go
	// out.
	sweepDone := startQuarantineSweep(ctx, syncAPI.Quarantine)

	errc := make(chan error, 1)
	go func() {
		log.Printf("ledgerd serve: listening on %s", cfg.Server.HTTPListen)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
			return
		}
		errc <- nil
	}()
	smtpErrc := make(chan error, 1)
	go func() {
		log.Printf("ledgerd serve: smtp receiver listening on %s for %s (DKIM/ARC verified; "+
			"trusted mail is appended, everything else is quarantined)",
			mailLn.Addr(), cfg.InboundSuffix())
		smtpErrc <- mail.Serve(mailLn)
	}()
	// Buffered and never closed, so the select below is correct whether or not
	// the admin console is running: an unbuffered nil channel would block
	// forever, which is what we want for "no admin listener", and a buffered one
	// that nothing writes to does the same without a nil-channel special case.
	adminErrc := make(chan error, 1)
	if adminLn != nil {
		go func() {
			log.Printf("ledgerd serve: admin console listening on %s (TAILNET-ONLY; "+
				"loopback or 100.64.0.0/10, enforced at bind)", adminLn.Addr())
			if err := adminSrv.Serve(adminLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
				adminErrc <- err
				return
			}
			adminErrc <- nil
		}()
	}

	// Any listener dying is fatal, but none may be abandoned: returning straight
	// out of this select left the OTHERS running in a process on its way out —
	// an HTTP listener with no receiver behind it, or a public port 25 with
	// nothing left to shut it down.
	var serveErr error
	select {
	case serveErr = <-errc:
	case serveErr = <-smtpErrc:
	case serveErr = <-adminErrc:
	case <-ctx.Done():
	}
	log.Println("shutting down")
	// Detached from ctx, which is already cancelled: in-flight requests get a
	// bounded window to finish rather than being cut off at the signal.
	shutCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	// The receiver first, and on its OWN budget rather than the shared one: a
	// peer MTA is entitled to sit idle between commands, so smtpd.Shutdown
	// spends its whole window before force-closing, and handing it shutCtx
	// would leave the HTTP server nothing.
	mailCtx, mailCancel := context.WithTimeout(shutCtx, 5*time.Second)
	if err := mail.Shutdown(mailCtx); err != nil {
		log.Printf("ledgerd serve: smtp shutdown: %v", err)
	}
	mailCancel()
	if err := srv.Shutdown(shutCtx); err != nil && serveErr == nil {
		serveErr = fmt.Errorf("shutdown: %w", err)
	}
	if adminSrv != nil {
		if err := adminSrv.Shutdown(shutCtx); err != nil && serveErr == nil {
			serveErr = fmt.Errorf("admin shutdown: %w", err)
		}
	}
	<-sweepDone
	return serveErr
}

// adminServer builds the Tailscale-bound admin console, or returns (nil, nil)
// when it must not be served.
//
// # No token means NO CONSOLE, not an open one and not a dead process
//
// admin.Handler.Routes refuses to mount without LEDGER_ADMIN_TOKEN, and there
// were three possible responses to that. Mounting it open is out of the
// question. Failing the whole process would take the sync API and the mail
// receiver down with it — an operator who has not yet set an admin token would
// find that forgetting a variable used for template authoring stopped users'
// mail from being received, which is a far worse outcome than not having a
// console. So the console is simply absent, and the log says so at WARNING
// volume on every start.
//
// # Everything here shares the pool and nothing shares a route
//
// The console gets its own http.ServeMux. It is never merged with the sync
// API's, and the two are handed to different net.Listeners, so there is no
// composition of middleware or route ordering that could expose an /admin/ path
// on the public listener — the public mux does not contain those patterns at
// all. cmd/ledgerd's TestTheAdminConsoleIsNotMountedOnThePublicListener reads
// both handlers and asserts it in both directions.
func adminServer(cfg config.Config, pool *pgxpool.Pool) (*http.Server, error) {
	if cfg.Server.AdminToken == "" {
		log.Println("ledgerd serve: *** LEDGER_ADMIN_TOKEN is not set: the admin console " +
			"(template authoring and publishing, the donated-sample queue, diagnostics, the " +
			"waitlist and dictionary moderation) is NOT being served. Set it to enable them. ***")
		return nil, nil
	}
	h, err := adminHandler(cfg, pool)
	if err != nil {
		return nil, err
	}
	return &http.Server{
		Handler: h,
		// Same reasoning as the public listener's. The tailnet is not a trusted
		// network in the sense that would make these optional — it is a smaller
		// set of principals, not a set that cannot leak a goroutine.
		ReadHeaderTimeout: 10 * time.Second,
		// Generous: the operator's quarantine view can carry raw messages, and a
		// diagnostics page can be large. This is not a public listener, so the
		// stalled-reader arithmetic that sized the API's 5 minutes does not
		// apply with the same force.
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  2 * time.Minute,
	}, nil
}

// adminHandler builds the console's router. Split from adminServer so a test
// can read the routes without a listener or a timeout policy.
//
// Samples and Reprocessor are left nil: Task 31's donated-sample store and Task
// 30's Pipeline.Reprocess do not exist yet. That is not a silent gap — the
// endpoints that need them answer 503 with a reason, which is the difference
// between "not built yet" and "found nothing", and admin.Handler.publishTemplate
// refuses to publish rather than reporting an unrun regression gate as a clean
// one. When those tasks land, the adapters go HERE.
func adminHandler(cfg config.Config, pool *pgxpool.Pool) (http.Handler, error) {
	h := &admin.Handler{
		Templates: &tmpl.Store{Pool: pool},
		Diag:      &diag.Diag{Pool: pool},
		Waitlist:  &admin.Waitlist{Pool: pool},
		Quarantine: &quarantine.Store{
			Pool: pool, TTL: quarantine.DefaultTTL, WarnBefore: quarantine.DefaultWarnBefore,
		},
		Token: cfg.Server.AdminToken,
	}
	// The dictionary console needs no HMAC key — moderation reads and approves,
	// it never writes a submitter pseudonym — so it is mounted whether or not
	// LEDGER_DICT_HMAC_KEY is configured. A deployment that cannot accept
	// submissions can still approve the operator's own seeded rules.
	h.Dict = &dict.Dict{Pool: pool}
	if cfg.DictHMACKey != "" {
		key, err := dict.ParseKey(cfg.DictHMACKey)
		if err != nil {
			return nil, fmt.Errorf("admin console: %w", err)
		}
		h.Dict.HMACKey = key
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		return nil, err
	}
	return mux, nil
}

// quarantineSweepInterval is how often held mail is checked for a due warning
// or a due expiry. An hour is far finer than the boundaries it enforces (a
// 30-day TTL warned 7 days ahead), which is the point: the resolution of the
// sweep must never be the thing that decides whether a warning went out in
// time.
const quarantineSweepInterval = time.Hour

// startQuarantineSweep runs ExpireDue now and then on a ticker until ctx is
// done, returning a channel that closes when it has stopped.
//
// A sweep error is logged and the loop CONTINUES, because one failed sweep is
// a transient database problem and stopping would silently end every future
// warning. The failure is safe in the direction that matters: nothing is
// deleted that has not been warned about, so a sweep broken for a week DELAYS
// expiries rather than dropping mail. What it costs instead is unbounded
// growth, which is why the failure is logged loudly rather than swallowed.
func startQuarantineSweep(ctx context.Context, q *quarantine.Store) <-chan struct{} {
	done := make(chan struct{})
	if q == nil {
		close(done)
		return done
	}
	go func() {
		defer close(done)
		tick := time.NewTicker(quarantineSweepInterval)
		defer tick.Stop()
		for {
			// Detached from ctx's cancellation but bounded on its own, so a
			// shutdown signal arriving mid-sweep does not abort a transaction
			// that is part-way through recording removals.
			sweepCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Minute)
			warned, deleted, err := q.ExpireDue(sweepCtx)
			cancel()
			switch {
			case err != nil:
				log.Printf("ledgerd serve: quarantine sweep: %v", err)
			case warned > 0 || deleted > 0:
				log.Printf("ledgerd serve: quarantine sweep: warned %d, expired %d", warned, deleted)
			}
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
	}()
	return done
}

// runRelay will start the SMTP receiver in relay mode: a durable local spool
// plus a drain loop that forwards to the primary. Task 35.
func runRelay(cfg config.Config) error {
	return errors.New("ledgerd relay: not implemented yet (Task 35)")
}

// runVerify will run the offline structural checker and mail-accounting
// report against cfg.Server.DSN. Task 36.
func runVerify(cfg config.Config) error {
	return errors.New("ledgerd verify: not implemented yet (Task 36)")
}

// runSeedDictionary one-shot imports the operator's v1 categorization rules
// into the merchant dictionary (spec §3.6, Task 33).
//
// The seed bypasses the k-submitter threshold and ONLY that: it is one
// identified party's own data contributed deliberately, not a crowd signal that
// could be a single user's fingerprint, so there is nobody for the threshold to
// protect. It does NOT bypass moderation — every seeded entry lands unmoderated
// and publishes nothing until the operator approves it, which for a few hundred
// of the operator's own rules is what POST /admin/dictionary/approve-seed is
// for.
//
// It is idempotent: re-running it after fixing v1's rules adds what is new and
// leaves every moderation decision already made alone.
//
// The reconciliation output is the point of the printed summary. v1's rule
// table is not a clean set — it holds inactive rules, exact duplicates, and
// genuine conflicts where one pattern was confirmed into two different
// categories — so "seeded N" alone would not add up against
// `select count(*) from rules` and the operator would be left guessing which
// direction the discrepancy went.
func runSeedDictionary(cfg config.Config) error {
	path := corpus.DefaultPath()
	if path == "" {
		return errors.New("ledgerd seed-dictionary: set LEDGER_CORPUS_DB to a `.backup` " +
			"snapshot of the v1 database (internal/v2/corpus refuses the live one)")
	}
	db, err := corpus.Open(path)
	if err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: %w", err)
	}
	defer db.Close()

	rules, err := db.Rules()
	if err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: %w", err)
	}

	// Canonicalize and dedupe HERE rather than inside dict.SeedFromV1, so the
	// numbers below are the ones actually written and not an estimate.
	var (
		entries  []dict.Entry
		seen     = map[dict.Entry]bool{}
		inactive int
		dupes    int
		skipped  []string
	)
	for _, r := range rules {
		if !r.Active {
			inactive++
			continue
		}
		e, err := dict.Canonicalize(dict.Entry{
			Pattern: r.Pattern, Match: r.MatchType, Category: r.Category,
		})
		if err != nil {
			// A rule v2 will not accept — a regex, an out-of-range pattern —
			// is REPORTED, never dropped silently: a missing rule shows up
			// later as a merchant that stopped categorizing, with nothing to
			// connect it to this run.
			skipped = append(skipped, fmt.Sprintf("%s %q: %v", r.MatchType, r.Pattern, err))
			continue
		}
		key := dict.Entry{Pattern: e.Pattern, Category: e.Category}
		if seen[key] {
			dupes++
			continue
		}
		seen[key] = true
		entries = append(entries, e)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: open postgres: %w", err)
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: migrate: %w", err)
	}

	// No HMAC key is needed: seeding writes no submitter identifier, because a
	// seeded entry never needs a count. Requiring one here would make the
	// operator configure a secret this command does not use.
	d := &dict.Dict{Pool: pool}
	if err := d.SeedFromV1(ctx, entries); err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: %w", err)
	}

	for _, s := range skipped {
		log.Printf("seed-dictionary: skipped %s", s)
	}
	fmt.Printf("seeded %d operator rules (from %d v1 rules: %d inactive, %d duplicate, %d unusable)\n",
		len(entries), len(rules), inactive, dupes, len(skipped))
	fmt.Println("all seeded entries are UNMODERATED and publish nothing until approved " +
		"(POST /admin/dictionary/approve-seed)")
	return nil
}

// runPurgeUser will delete a user's account and enforce retention limits
// across every table Task 34's schema discovery finds. Task 34.
func runPurgeUser(cfg config.Config) error {
	return errors.New("ledgerd purge-user: not implemented yet (Task 34)")
}

// runParseRate will report the Task 36 parse-rate instrument used to measure
// the alpha's two-week exit criterion. PHASE 1 ONLY. Task 36.
func runParseRate(cfg config.Config) error {
	return errors.New("ledgerd parse-rate: not implemented yet (Task 36)")
}
