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

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/api"
	"ledger/internal/v2/arc"
	"ledger/internal/v2/config"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/pg"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/smtpd"
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
// The SMTP receiver (Task 24) is mounted here too, on the same pool; the
// Tailscale-bound admin listener (Task 32) joins this startup sequence when its
// task lands.
//
// The api.Server — and with it the two IdP verifiers — is built ONCE here,
// before the listener starts. That is load bearing rather than stylistic: every
// JWKS cache, fetch-attempt limit and inflight-herd guard in auth is per
// verifier instance, so a verifier constructed per request would restore the
// unauthenticated outbound amplifier those exist to remove.
func runServe(cfg config.Config) error {
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
	if cfg.Server.DNSFixtures != "" {
		// Loaded and validated HERE, at startup, so a wrong path or a malformed
		// recording fails the process rather than surfacing later as a DKIM
		// failure that looks like a crypto bug.
		//
		// STILL NOT WIRED, and deliberately so. Task 24 landed the receiver
		// below, but nothing in this process VERIFIES a signature yet — that is
		// Task 25 — so there is still nothing for a TXT resolver to serve.
		// internal/v2/smtpd hands Task 25's work the raw message and inspects no
		// header itself, so this fixture lookup reaches its consumer when that
		// task adds one, not before. Until then the flag's only effect is the
		// validation and the count below — which is exactly what it should be,
		// rather than a lookup handed to nothing while reading as implemented.
		_, n, err := arc.FixtureLookup(cfg.Server.DNSFixtures)
		if err != nil {
			return fmt.Errorf("dns fixtures: %w", err)
		}
		log.Printf("ledgerd serve: *** --dns-fixtures: %d recorded TXT name(s) loaded from %s; DKIM/ARC will use "+
			"them instead of DNS once Task 25 lands verification. TEST ONLY. ***", n, cfg.Server.DNSFixtures)
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

	// The inbound SMTP receiver (Task 24). It is the most exposed surface in the
	// system — public, unauthenticated port 25 — so it is built here, once,
	// with the same pool everything else uses.
	//
	// Its Handler is Task 29's ingest path, which does not exist yet, so what is
	// mounted is deferHandler: every accepted message is answered with a
	// TEMPORARY failure and the sending MTA retries. That is deliberate and it
	// is the ONLY safe placeholder. A handler that returned nil would have the
	// receiver answer 250 — "I have taken responsibility for this message" — to
	// mail it then discards, which is the silent drop spec §2 forbids, and the
	// sender would never retry it. Retries last ~1-3 days, so the port can be
	// live and hardened before the pipeline behind it is finished.
	mail := smtpd.New(
		cfg.Mail,
		&addresses.Addresses{Pool: pool, Suffix: cfg.InboundSuffix()},
		deferHandler{},
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
		log.Printf("ledgerd serve: smtp receiver listening on %s for %s (DKIM/ARC verification is Task 25; "+
			"the ingest handler is Task 29, so accepted mail is DEFERRED with a 451 and retried by the sender)",
			mailLn.Addr(), cfg.InboundSuffix())
		smtpErrc <- mail.Serve(mailLn)
	}()

	// Either listener dying is fatal, but neither may be abandoned: returning
	// straight out of this select left the OTHER server running in a process on
	// its way out — an HTTP listener with no receiver behind it, or a public
	// port 25 with nothing left to shut it down.
	var serveErr error
	select {
	case serveErr = <-errc:
	case serveErr = <-smtpErrc:
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
	<-sweepDone
	return serveErr
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

// deferHandler is the Task 29 seam. See the comment at its use in runServe for
// why the placeholder must FAIL rather than succeed.
type deferHandler struct{}

func (deferHandler) Deliver(ctx context.Context, d smtpd.Delivery) error {
	return errors.New("ingest pipeline not implemented yet (Task 29)")
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

// runSeedDictionary will one-shot import the operator's v1 categorization
// rules into the merchant dictionary, bypassing the k-submitter threshold
// because it is the operator's own data, not a crowd signal. Task 33.
func runSeedDictionary(cfg config.Config) error {
	return errors.New("ledgerd seed-dictionary: not implemented yet (Task 33)")
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
