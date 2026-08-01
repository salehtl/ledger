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
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
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
	"ledger/internal/v2/purge"
	"ledger/internal/v2/pushv2"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/relay"
	"ledger/internal/v2/samples"
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
	"record-consent":  runRecordConsent,
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
	// purge is the `purge-user` mode's own command line. It is parsed by the
	// same FlagSet as everything else — a second, mode-specific parser would
	// be a second place the "mode comes first" rule has to be reimplemented —
	// and is meaningless in every other mode.
	purge config.PurgeArgs
	// verify is the command line of `verify` and `parse-rate`, on the same
	// terms.
	verify config.VerifyArgs
	// consent is `record-consent`'s, likewise.
	consent config.ConsentArgs
	// user backs the single --user flag. Four modes take "which account", and
	// binding one flag into each of their argument structs after parsing is
	// what keeps them from drifting into --user, --account and --uuid.
	user string
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
	fs.StringVar(&out.user, "user", "",
		"purge-user|record-consent|verify|parse-rate: the account to act on, as a UUID")
	fs.BoolVar(&out.purge.RetentionDue, "retention-due", false,
		"purge-user: delete every account whose consent retention deadline has passed")
	fs.BoolVar(&out.purge.DryRun, "dry-run", false,
		"purge-user: report what would be deleted and delete nothing")
	fs.StringVar(&out.consent.Document, "document", "",
		"record-consent: identifier of the consent text that was signed, e.g. alpha-plaintext-v1")
	fs.StringVar(&out.consent.RetentionUntil, "retention-until", "",
		"record-consent: the instant this account's plaintext must be gone, as RFC3339")
	fs.StringVar(&out.consent.SignedAt, "signed-at", "",
		"record-consent: when they signed, as RFC3339 (default: now)")
	fs.BoolVar(&out.consent.Show, "show", false,
		"record-consent: list the recorded deadlines and write nothing")
	fs.StringVar(&out.verify.From, "from", "",
		"verify|parse-rate: window start, as an RFC3339 instant")
	fs.StringVar(&out.verify.To, "to", "",
		"verify|parse-rate: window end, as an RFC3339 instant (exclusive)")
	fs.IntVar(&out.verify.Sample, "sample", 0,
		"parse-rate: adjudicate a uniform sample once the population exceeds this many (0 = 200)")
	fs.BoolVar(&out.verify.Adjudicate, "adjudicate", false,
		"parse-rate: PHASE 1 ONLY — read unparsed cold bodies and record a verdict for each")
	fs.BoolVar(&out.verify.JSON, "json", false,
		"verify|parse-rate: emit JSON instead of the operator's text report")
	if err := fs.Parse(rest); err != nil {
		return args{}, err
	}
	if n := fs.NArg(); n > 0 {
		return args{}, fmt.Errorf("unexpected argument %q: the mode comes first (%s)", fs.Arg(0), strings.Join(config.Modes(), "|"))
	}
	// One flag, four destinations. See args.user.
	out.purge.User, out.verify.User, out.consent.User = out.user, out.user, out.user
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
	cfg.Purge = a.purge
	cfg.Verify = a.verify
	cfg.Consent = a.consent
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

	// A rotated LEDGER_DICT_HMAC_KEY silently breaks the merchant dictionary in
	// two directions at once: the k threshold counts distinct HMACs, so one
	// user reappears as one submitter per key generation, and an account purge
	// recomputes a pseudonym that matches nothing and reports success anyway.
	// Neither shows a symptom. So the process refuses to start rather than
	// serving in that state — checked here, before the listener, because the
	// first request is already too late.
	if cfg.DictHMACKey != "" {
		key, err := dict.ParseKey(cfg.DictHMACKey)
		if err != nil {
			return fmt.Errorf("dictionary key: %w", err)
		}
		if err := (&dict.Dict{Pool: pool, HMACKey: key}).VerifyKeyEpoch(ctx); err != nil {
			return err
		}
	}

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
		Addr: cfg.Server.HTTPListen,
		// Handler is assigned BELOW, after the ingest pipeline exists — see
		// there. A client that opens a connection and never finishes its headers costs
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

	// The router is built HERE, after the pipeline, rather than in the
	// http.Server literal above. The backup relay's deliver endpoint (Task 35)
	// hands a forwarded message to the SAME pipeline the SMTP receiver uses, and
	// api.Handler decides at build time whether the relay routes can be mounted
	// at all — so building the router first would produce a server that answers
	// every one of the relay's forwards with a 404, which its drain reads as a
	// permanent rejection and files a whole spool under `rejected/`.
	syncAPI.Mail = pipeline
	// The same pipeline again, for the user-facing half of Task 30: confirming a
	// sender must re-ingest the mail that confirmation releases, or it sits held
	// until it expires. See api.Server.Reprocessor.
	syncAPI.Reprocessor = apiReingestAdapter{pipeline}
	srv.Handler = syncAPI.Handler()

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
	adminSrv, err := adminServer(cfg, pool, reprocessAdapter{pipeline})
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

	// The donated-sample retention sweep (Task 31). Spec §2 publishes a fixed
	// window for the one table that holds a user's mail in the clear, and a
	// published deletion date that nothing enforces is worse than no promise at
	// all — so it is started here, beside the sweep whose absence would be
	// noticed, rather than left to a cron nobody remembers to install.
	sampleSweepDone := startSampleSweep(ctx, syncAPI.Samples)

	// The dictionary-submission retention sweep (Task 33). Spec §2 states, as a
	// fact about the merchant dictionary, that a submitter identifier for an
	// entry that never reaches the k threshold "is expired outright". That
	// sentence was true of a function nothing called: dict.ExpireStaleSubmissions
	// had no production caller at all, so the sweep users were promised simply
	// never ran, and every identifier that fell short of k lived forever.
	//
	// A published retention promise that nothing enforces is worse than no
	// promise, so it is started here beside the other two rather than left to a
	// cron nobody remembers to install.
	dictSweepDone := startDictSweep(ctx, syncAPI.Dict)

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
	<-sampleSweepDone
	<-dictSweepDone
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
func adminServer(cfg config.Config, pool *pgxpool.Pool, reproc admin.Reprocessor) (*http.Server, error) {
	if cfg.Server.AdminToken == "" {
		log.Println("ledgerd serve: *** LEDGER_ADMIN_TOKEN is not set: the admin console " +
			"(template authoring and publishing, the donated-sample queue, diagnostics, the " +
			"waitlist and dictionary moderation) is NOT being served. Set it to enable them. ***")
		return nil, nil
	}
	h, err := adminHandler(cfg, pool, reproc)
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
// reproc is the SAME ingest.Pipeline the SMTP receiver delivers into, wrapped by
// reprocessAdapter — one pipeline per process, so a republish re-parses through
// exactly the code path a live delivery takes. A second pipeline constructed
// here would be a second template cache and a second set of decisions about
// what "the published set" means.
//
// Samples is the SAME store the public intake endpoints write into, wrapped by
// sampleAdapter. It is what makes /validate and /publish run their regression
// gate against real donated mail rather than answering 503 — and it must never
// be left nil quietly: publishTemplate refuses outright without it, because
// reporting an unrun gate as a clean one is how a gate stops being one.
func adminHandler(cfg config.Config, pool *pgxpool.Pool, reproc admin.Reprocessor) (http.Handler, error) {
	h := &admin.Handler{
		Templates: &tmpl.Store{Pool: pool},
		Diag:      &diag.Diag{Pool: pool},
		Waitlist:  &admin.Waitlist{Pool: pool},
		Quarantine: &quarantine.Store{
			Pool: pool, TTL: quarantine.DefaultTTL, WarnBefore: quarantine.DefaultWarnBefore,
		},
		Samples:     sampleAdapter{&samples.Samples{Pool: pool, Retention: samples.DefaultRetention}},
		Reprocessor: reproc,
		Token:       cfg.Server.AdminToken,
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
	if q == nil {
		return closedChan()
	}
	return startSweep(ctx, "quarantine sweep", func(ctx context.Context) (string, error) {
		warned, deleted, err := q.ExpireDue(ctx)
		if err != nil || (warned == 0 && deleted == 0) {
			return "", err
		}
		return fmt.Sprintf("warned %d, expired %d", warned, deleted), nil
	})
}

// startSampleSweep enforces the donated-sample retention window
// (samples.DefaultRetention, published in spec §2).
//
// It is a SEPARATE loop from the quarantine sweep rather than a second call
// inside it, because the two failure modes are not the same and must not share
// a fate: a quarantine sweep that dies stops warning people about mail that is
// about to be deleted, while a sample sweep that dies keeps real mail on disk
// past the date users were told it would be gone. Neither is allowed to be the
// reason the other stopped running.
//
// Retention differs from quarantine's expiry in the one way that matters here:
// there is no warning and no grace, because a donated sample is a duplicate of
// mail already in the donor's own log. Deleting it takes nothing away from
// them, so the only thing a delay would buy is a longer breach window.
func startSampleSweep(ctx context.Context, s *samples.Samples) <-chan struct{} {
	if s == nil {
		return closedChan()
	}
	return startSweep(ctx, "donated-sample retention sweep", func(ctx context.Context) (string, error) {
		n, err := s.ExpireDue(ctx)
		if err != nil || n == 0 {
			return "", err
		}
		return fmt.Sprintf("deleted %d expired donated sample(s)", n), nil
	})
}

// startDictSweep expires merchant-dictionary submitter identifiers that never
// reached the k threshold, and reaps the entries left with nobody behind them.
//
// It is a THIRD loop rather than a branch inside either of the others for the
// reason given on startSampleSweep: these three failures are not the same and
// must not share a fate. This one failing means pseudonyms outlive the window
// spec §2 publishes for them.
//
// The two halves belong together because the second only ever has work when the
// first did: expiring the last identifier for an entry is exactly what leaves a
// merchant string with a count of zero and nobody behind it.
func startDictSweep(ctx context.Context, d *dict.Dict) <-chan struct{} {
	if d == nil {
		return closedChan()
	}
	return startSweep(ctx, "dictionary retention sweep", func(ctx context.Context) (string, error) {
		expired, err := d.ExpireStaleSubmissions(ctx, dict.DefaultSubmissionRetention)
		if err != nil {
			return "", err
		}
		reaped, err := d.ReapOrphanedEntries(ctx)
		if err != nil {
			return "", err
		}
		if expired == 0 && reaped == 0 {
			return "", nil
		}
		return fmt.Sprintf("expired %d submitter identifier(s), reaped %d orphaned entry(s)",
			expired, reaped), nil
	})
}

// startSweep runs one job now and then hourly until ctx is done, returning a
// channel that closes when it has stopped. The job returns a line to log, or ""
// for "nothing happened, say nothing".
//
// A sweep error is logged and the loop CONTINUES, because one failed sweep is a
// transient database problem and stopping would silently end every future one.
// What that costs is unbounded growth, which is why the failure is logged
// loudly rather than swallowed.
func startSweep(ctx context.Context, name string, run func(context.Context) (string, error)) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		tick := time.NewTicker(quarantineSweepInterval)
		defer tick.Stop()
		for {
			// Detached from ctx's cancellation but bounded on its own, so a
			// shutdown signal arriving mid-sweep does not abort a transaction
			// that is part-way through recording removals.
			sweepCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Minute)
			msg, err := run(sweepCtx)
			cancel()
			switch {
			case err != nil:
				log.Printf("ledgerd serve: %s: %v", name, err)
			case msg != "":
				log.Printf("ledgerd serve: %s: %s", name, msg)
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

func closedChan() <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}

// runRelay is the BACKUP MX (spec §3.2): the same binary on a second VPS,
// listed at a lower MX priority, whose only job is to hold mail durably while
// the primary is down and hand it over unchanged when it comes back.
//
// # What this process does NOT have
//
// A database. Not a degraded one, not an optional one — none. It opens no
// Postgres pool, applies no migrations, and holds no user data beyond the
// address replica (`inbound_address -> user public key`) and whatever mail is
// currently spooled. That is the whole security argument for running our own
// relay instead of a managed one: a second box on the internet with a copy of
// everyone's financial history would be a strictly worse trade than the outage
// it protects against.
//
// ⚠ DEPLOYMENT NOTE for Task D3: config.Load still REQUIRES server.dsn, because
// it validates before the mode is known. A relay host must therefore set
// LEDGER_PG_DSN to a placeholder (e.g. "relay-mode-has-no-database"); it is
// never opened. Making config validation mode-aware is the clean fix and is left
// to whoever next owns internal/v2/config.
//
// # The three loops
//
//	receiver   port 25, the same hardened smtpd as the primary, with the relay
//	           as both Resolver (against the replica) and Handler (spool)
//	sync       every 5 minutes, pull the address replica
//	drain      every minute, offer the spool to the primary
//
// A failed first sync is NOT fatal. The relay exists for the case where the
// primary is unreachable, and a process that refused to start without it would
// be absent in exactly the situation it was provisioned for — it comes up with
// whatever replica the last run persisted, or with none, in which case it defers
// every recipient (never refuses permanently) until a sync succeeds.
func runRelay(cfg config.Config) error {
	// Argument validation FIRST, before any I/O at all, so a misconfigured
	// relay fails against its configuration rather than against whatever
	// happens to be listening.
	if cfg.Mail.Domain == "" {
		return errors.New("ledgerd relay: mail.domain is required (LEDGER_MAIL_DOMAIN); the relay " +
			"decides which recipients are ours from it")
	}
	r := &relay.Relay{
		SpoolDir:   cfg.Relay.SpoolDir,
		PrimaryURL: cfg.Relay.PrimaryURL,
		Token:      cfg.Relay.Token,
		Suffix:     cfg.InboundSuffix(),
		Now:        time.Now,
	}
	if err := r.Init(); err != nil {
		return fmt.Errorf("ledgerd relay: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// One attempt before the port opens, so the operator sees immediately
	// whether the token and the URL work — and so a relay restarted during a
	// quiet period has a fresh replica before the first message arrives.
	syncCtx, syncCancel := context.WithTimeout(ctx, relaySyncTimeout)
	if n, err := r.SyncAddresses(syncCtx); err != nil {
		log.Printf("ledgerd relay: the first address sync FAILED (%v). Starting anyway with "+
			"whatever replica the last run left behind; recipients this relay cannot confirm "+
			"will be DEFERRED, never refused permanently.", err)
	} else {
		log.Printf("ledgerd relay: address replica synced: %d address(es)", n)
	}
	syncCancel()

	// The same receiver the primary runs, with the relay behind it. The
	// diagnostics sink is the no-database one: see relayDiagnostics.
	mail := smtpd.New(cfg.Mail, r, r, relayDiagnostics{}, time.Now)
	mailLn, err := net.Listen("tcp", cfg.Mail.SMTPListen)
	if err != nil {
		return fmt.Errorf("ledgerd relay: smtp listen %s: %w", cfg.Mail.SMTPListen, err)
	}

	smtpErrc := make(chan error, 1)
	go func() {
		log.Printf("ledgerd relay: smtp receiver listening on %s for %s; spooling to %s, "+
			"forwarding to %s", mailLn.Addr(), cfg.InboundSuffix(), r.SpoolDir, r.PrimaryURL)
		smtpErrc <- mail.Serve(mailLn)
	}()
	syncDone := startRelaySync(ctx, r)
	drainDone := startRelayDrain(ctx, r)

	var serveErr error
	select {
	case serveErr = <-smtpErrc:
	case <-ctx.Done():
	}
	log.Println("ledgerd relay: shutting down")
	shutCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	if err := mail.Shutdown(shutCtx); err != nil {
		log.Printf("ledgerd relay: smtp shutdown: %v", err)
	}
	<-syncDone
	<-drainDone
	// One last attempt on the way out, on a budget of its own. A relay that is
	// being restarted for a deploy should not leave a message sitting for a
	// minute longer than it has to; a failure here changes nothing, because
	// nothing is deleted that was not delivered.
	finalCtx, finalCancel := context.WithTimeout(context.WithoutCancel(ctx), relayDrainTimeout)
	if sent, failed, err := r.Drain(finalCtx); err != nil {
		log.Printf("ledgerd relay: final drain: %v (nothing was discarded)", err)
	} else if sent > 0 || failed > 0 {
		log.Printf("ledgerd relay: final drain: %d forwarded, %d set aside", sent, failed)
	}
	finalCancel()
	if st, err := r.Stats(); err == nil && (st.Spooled > 0 || st.Rejected > 0) {
		log.Printf("ledgerd relay: exiting with %d message(s) still spooled and %d set aside "+
			"in %s. NOTHING HAS BEEN DISCARDED; they are delivered by the next run.",
			st.Spooled, st.Rejected, r.SpoolDir)
	}
	return serveErr
}

// Timeouts for the relay's two background loops. Each bounds one round trip to
// a primary that may be wedged rather than down, which is the case a bare
// "unreachable" check does not cover.
const (
	relaySyncTimeout  = 2 * time.Minute
	relayDrainTimeout = 10 * time.Minute
)

// relayDiagnostics is the relay's refusal accounting: it has no database, so
// there is nowhere to write a row.
//
// This is a real, stated reduction rather than an oversight, and it is bounded:
// every refusal the relay issues is a REFUSAL, not an acceptance, so no message
// is dropped by it — the sender keeps what it was refused. What is lost is the
// aggregate nuisance counter and the user-scoped notice, both of which are
// reconstructed on the primary as soon as the sender retries there. The
// alternative — giving the relay a Postgres connection to the primary's database
// — would put the whole ledger one credential away from a box whose entire
// purpose is to be exposed on port 25.
//
// Record returns nil rather than an error on purpose: smtpd downgrades an
// unrecordable refusal to a TEMPORARY failure so the sender retries and the
// notice gets another chance. On the relay that would turn every over-quota
// refusal into a 451, which is not wrong but is noise; the honest statement is
// that this deployment accounts for refusals in its log and nowhere else.
type relayDiagnostics struct{}

func (relayDiagnostics) Record(_ context.Context, r diag.Record) error {
	log.Printf("ledgerd relay: refused a message: outcome=%s reason=%s", r.Outcome, r.RejectReason)
	return nil
}

func (relayDiagnostics) CountRejection(ctx context.Context, reason string) error {
	return relayDiagnostics{}.CountRejections(ctx, reason, 1)
}

func (relayDiagnostics) CountRejections(_ context.Context, reason string, n int64) error {
	if n > 0 {
		log.Printf("ledgerd relay: %d protocol rejection(s): %s", n, reason)
	}
	return nil
}

// startRelaySync refreshes the address replica on a ticker.
//
// A failed sync is logged and the loop CONTINUES: during an outage every sync
// fails, and that is precisely when the relay must keep running on its last
// good replica.
func startRelaySync(ctx context.Context, r *relay.Relay) <-chan struct{} {
	return startTicker(ctx, relay.DefaultSyncInterval, func() {
		c, cancel := context.WithTimeout(context.WithoutCancel(ctx), relaySyncTimeout)
		defer cancel()
		if n, err := r.SyncAddresses(c); err != nil {
			log.Printf("ledgerd relay: address sync: %v", err)
		} else {
			log.Printf("ledgerd relay: address replica synced: %d address(es)", n)
		}
	})
}

// startRelayDrain offers the spool to the primary on a ticker.
func startRelayDrain(ctx context.Context, r *relay.Relay) <-chan struct{} {
	return startTicker(ctx, relay.DefaultDrainInterval, func() {
		c, cancel := context.WithTimeout(context.WithoutCancel(ctx), relayDrainTimeout)
		defer cancel()
		sent, failed, err := r.Drain(c)
		switch {
		case sent > 0 || failed > 0:
			log.Printf("ledgerd relay: drain: %d forwarded, %d set aside (err: %v)", sent, failed, err)
		case err != nil:
			// Expected, once a minute, for the whole duration of an outage.
			log.Printf("ledgerd relay: drain: %v", err)
		}
	})
}

// startTicker runs job on an interval until ctx is done, returning a channel
// that closes when it has stopped. It does NOT run the job immediately: both
// callers have already done their first pass explicitly, where a failure gets
// its own message.
func startTicker(ctx context.Context, every time.Duration, job func()) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				job()
			}
		}
	}()
	return done
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

// runPurgeUser deletes a user's account, or enforces the plaintext-retention
// deadline across every account past it, using the schema discovery in
// internal/v2/purge. Task 34, spec §3.10.
//
// This is the OPERATOR's path. The user's own path is DELETE /api/v1/account,
// which is gated on fresh IdP re-authentication plus key possession; this one
// is gated on having a shell on the box, which is the strongest gate available
// and the only one that works for a user who has lost every device.
//
// # Why the retention sweep is a command and not a ticker
//
// runServe starts a sweep for quarantine expiry and one for donated-sample
// retention, and deliberately starts NONE for this. Those two delete a message;
// this deletes a person's entire account, and in a phase with a handful of
// alpha users, no in-app deletion UX yet and a consent deadline that may be
// extended by re-consenting, an unattended timer that removes accounts is a
// footgun with no upside — the operator running `purge-user --retention-due`
// (after `--dry-run`) knows it happened, which is precisely the property an
// automated sweep gives up. It is a deliberate decision, not an oversight;
// revisit it when deletion is self-service and the population is not five
// people the operator can name.
func runPurgeUser(cfg config.Config) error {
	// Argument validation FIRST, before any I/O: a mistyped invocation of a
	// destructive command must fail against the arguments, not against
	// whatever DSN happened to be in the environment.
	switch {
	case cfg.Purge.User == "" && !cfg.Purge.RetentionDue:
		return errors.New("ledgerd purge-user: nothing selected: pass --user <uuid> to delete one " +
			"account, or --retention-due to delete every account past its consent retention deadline")
	case cfg.Purge.User != "" && cfg.Purge.RetentionDue:
		return errors.New("ledgerd purge-user: --user and --retention-due are alternatives; " +
			"pass exactly one")
	}
	var target uuid.UUID
	if cfg.Purge.User != "" {
		var err error
		if target, err = uuid.Parse(cfg.Purge.User); err != nil {
			return fmt.Errorf("ledgerd purge-user: --user %q is not a uuid", cfg.Purge.User)
		}
		if target == uuid.Nil {
			return errors.New("ledgerd purge-user: --user is the nil uuid, which names no account")
		}
	}

	ctx := context.Background()
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd purge-user: open postgres: %w", err)
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd purge-user: migrate: %w", err)
	}

	// The HMAC key is REQUIRED to forget a user's merchant-dictionary
	// submissions, and purge.Purge refuses rather than skipping them when it is
	// absent and the table is not empty. Built the same way api.NewServer does.
	d := &dict.Dict{Pool: pool}
	if cfg.DictHMACKey != "" {
		key, err := dict.ParseKey(cfg.DictHMACKey)
		if err != nil {
			return fmt.Errorf("ledgerd purge-user: %w", err)
		}
		d.HMACKey = key
	}

	if cfg.Purge.DryRun {
		return purgeDryRun(ctx, pool, target, cfg.Purge.RetentionDue)
	}

	var rep purge.Report
	if cfg.Purge.RetentionDue {
		rep, err = purge.EnforceRetention(ctx, pool, d, time.Now())
	} else {
		rep, err = purge.Purge(ctx, pool, d, target)
	}
	// The report is printed even on failure. A purge that failed part-way
	// through is exactly when an operator most needs to know what DID happen,
	// and an error that swallowed the report would leave them guessing.
	printPurgeReport(rep)
	if err != nil {
		return fmt.Errorf("ledgerd purge-user: %w", err)
	}
	if len(rep.Users) == 0 {
		fmt.Println("no accounts matched; nothing was deleted")
	}
	return nil
}

// purgeDryRun reports what a purge would remove without removing it.
//
// It runs the SAME schema discovery and the same classification check the real
// purge does, so "the dry run was clean" means the real one will not refuse for
// a reason the dry run could have found.
func purgeDryRun(ctx context.Context, pool *pgxpool.Pool, target uuid.UUID, retentionDue bool) error {
	c, err := purge.Classify(ctx, pool)
	if err != nil {
		return fmt.Errorf("ledgerd purge-user: %w", err)
	}
	if len(c.Unclassified) != 0 {
		return fmt.Errorf("ledgerd purge-user: a real purge would REFUSE: unclassified tables %v",
			c.Unclassified)
	}
	targets := []uuid.UUID{target}
	if retentionDue {
		if targets, err = purge.DueForRetention(ctx, pool, time.Now()); err != nil {
			return fmt.Errorf("ledgerd purge-user: %w", err)
		}
	}
	if len(targets) == 0 {
		fmt.Println("dry run: no accounts are past their retention deadline")
		return nil
	}
	total := 0
	for _, u := range targets {
		fmt.Printf("dry run: account %s\n", u)
		for _, r := range c.UserScoped {
			var n int
			// r.SQL() quotes the schema and the name as two identifiers. A
			// relation outside `public` is now discovered, so the preview has
			// to be able to address one.
			if err := pool.QueryRow(ctx,
				`SELECT count(*) FROM `+r.SQL()+` WHERE user_id = $1`, u).Scan(&n); err != nil {
				return fmt.Errorf("ledgerd purge-user: count %s: %w", r, err)
			}
			if n > 0 {
				fmt.Printf("  %-40s %d\n", r, n)
			}
			total += n
		}
	}
	fmt.Printf("dry run: %d rows across %d account(s) would be deleted, plus their "+
		"dictionary submitter identifiers. Nothing was deleted.\n", total, len(targets))
	return nil
}

// runRecordConsent writes (or replaces) an account's signed-consent record, or
// with --show lists what is on file. Spec §5, Task 34.
//
// It exists because the enforcer had no input. `purge-user --retention-due`
// reads user_consent.retention_until, and until this command landed NOTHING
// anywhere wrote that column: a sweep run a hundred years past every deadline
// purged zero accounts and reported one as having no record. A retention
// commitment with a table, an enforcer and no way to record a deadline is a
// commitment in name only.
//
// Recording is deliberately manual. The row asserts that a specific person
// signed a specific document on a specific date; a row written automatically by
// the sign-up path would be the server asserting a signature nobody made.
func runRecordConsent(cfg config.Config) error {
	// Argument validation FIRST, before any I/O, on the same terms as
	// purge-user: this command sets a date on which an account gets deleted.
	var (
		target                uuid.UUID
		signedAt, retainUntil time.Time
		err                   error
	)
	if !cfg.Consent.Show {
		switch {
		case cfg.Consent.User == "":
			return errors.New("ledgerd record-consent: --user <uuid> is required (or --show to list what is on file)")
		case cfg.Consent.Document == "":
			return errors.New("ledgerd record-consent: --document <identifier> is required, e.g. " +
				"--document alpha-plaintext-v1; it names the consent text that was signed")
		case cfg.Consent.RetentionUntil == "":
			return errors.New("ledgerd record-consent: --retention-until <RFC3339> is required; " +
				"it is the instant this account's plaintext must be gone, and the whole point of the record")
		}
		if target, err = uuid.Parse(cfg.Consent.User); err != nil || target == uuid.Nil {
			return fmt.Errorf("ledgerd record-consent: --user %q is not a uuid", cfg.Consent.User)
		}
		if retainUntil, err = time.Parse(time.RFC3339, cfg.Consent.RetentionUntil); err != nil {
			return fmt.Errorf("ledgerd record-consent: --retention-until %q is not an RFC3339 instant "+
				"(e.g. 2027-01-31T00:00:00Z)", cfg.Consent.RetentionUntil)
		}
		signedAt = time.Now()
		if cfg.Consent.SignedAt != "" {
			if signedAt, err = time.Parse(time.RFC3339, cfg.Consent.SignedAt); err != nil {
				return fmt.Errorf("ledgerd record-consent: --signed-at %q is not an RFC3339 instant",
					cfg.Consent.SignedAt)
			}
		}
		if !retainUntil.After(signedAt) {
			return fmt.Errorf("ledgerd record-consent: --retention-until %s is not after the signature %s",
				retainUntil.UTC(), signedAt.UTC())
		}
	}

	ctx := context.Background()
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd record-consent: open postgres: %w", err)
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd record-consent: migrate: %w", err)
	}

	if cfg.Consent.Show {
		return showConsent(ctx, pool)
	}
	if err := purge.RecordConsent(ctx, pool, target, cfg.Consent.Document, signedAt, retainUntil); err != nil {
		return fmt.Errorf("ledgerd record-consent: %w", err)
	}
	fmt.Printf("recorded consent for %s: document %s, signed %s, plaintext retained until %s\n",
		target, cfg.Consent.Document, signedAt.UTC().Format(time.RFC3339), retainUntil.UTC().Format(time.RFC3339))
	fmt.Println("enforce with: ledgerd record-consent --show, then " +
		"ledgerd purge-user --retention-due --dry-run")
	return nil
}

// showConsent lists every account beside its deadline, including the ones with
// no record at all — which are the interesting ones, since they are the
// accounts the retention sweep will report and refuse to act on.
func showConsent(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := pool.Query(ctx, `
		SELECT u.id, c.document, c.signed_at, c.retention_until
		  FROM users u LEFT JOIN user_consent c ON c.user_id = u.id
		 ORDER BY c.retention_until NULLS FIRST, u.id`)
	if err != nil {
		return fmt.Errorf("ledgerd record-consent: %w", err)
	}
	defer rows.Close()
	missing, now := 0, time.Now()
	for rows.Next() {
		var (
			id                  uuid.UUID
			doc                 *string
			signed, retainUntil *time.Time
		)
		if err := rows.Scan(&id, &doc, &signed, &retainUntil); err != nil {
			return fmt.Errorf("ledgerd record-consent: %w", err)
		}
		if retainUntil == nil {
			missing++
			fmt.Printf("%s  NO CONSENT RECORD — the retention sweep will report and skip this account\n", id)
			continue
		}
		state := "current"
		if !retainUntil.After(now) {
			state = "OVERDUE"
		}
		fmt.Printf("%s  %-24s signed %s  retained until %s  %s\n",
			id, *doc, signed.UTC().Format(time.RFC3339),
			retainUntil.UTC().Format(time.RFC3339), state)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("ledgerd record-consent: %w", err)
	}
	if missing > 0 {
		fmt.Printf("\n%d account(s) have no consent record. Spec §5 admits alphas under signed "+
			"consent with a retention limit; an account without one is outside that promise.\n", missing)
	}
	return nil
}

func printPurgeReport(rep purge.Report) {
	for _, u := range rep.Users {
		fmt.Printf("purged account %s\n", u)
	}
	tables := make([]string, 0, len(rep.Rows))
	for tb := range rep.Rows {
		tables = append(tables, tb)
	}
	sort.Strings(tables)
	for _, tb := range tables {
		if rep.Rows[tb] > 0 {
			fmt.Printf("  %-40s %d\n", tb, rep.Rows[tb])
		}
	}
	if rep.DictSubmissions > 0 {
		fmt.Printf("  %-40s %d\n", "dict_submissions", rep.DictSubmissions)
	}
	if len(rep.SweptWithoutCascade) > 0 {
		fmt.Printf("WARNING: these tables needed an explicit sweep because their user_id "+
			"foreign key is missing ON DELETE CASCADE: %v\n", rep.SweptWithoutCascade)
	}
	if len(rep.RefreshedViews) > 0 {
		fmt.Printf("WARNING: these MATERIALIZED VIEWS held rows for the purged account and had "+
			"to be refreshed: %v. A matview is a stored copy of user data that nothing else in "+
			"the system tracks; check that it should exist at all.\n", rep.RefreshedViews)
	}
	if len(rep.WithoutConsentRecord) > 0 {
		fmt.Printf("NOTE: %d account(s) have no consent record and therefore no retention "+
			"deadline; they were NOT purged: %v\n",
			len(rep.WithoutConsentRecord), rep.WithoutConsentRecord)
	}
}

// reprocessAdapter is the seam between ingest's Reprocess and the admin
// console's. It exists so internal/v2/admin does not import internal/v2/ingest,
// which would drag half of v2 into a package whose tests want a fake.
//
// ⚠ PHASE 1 ONLY, inherited from what it wraps: server-side reprocessing reads
// cold bodies, and those are HPKE-sealed from Phase 3 onward. See Task 30's
// v2-phase1-only-inventory.
type reprocessAdapter struct{ p *ingest.Pipeline }

func (a reprocessAdapter) Reprocess(ctx context.Context, userID uuid.UUID, ids [][]byte) (admin.Report, error) {
	rep, err := a.p.Reprocess(ctx, userID, ids)
	return toAdminReport(rep), err
}

// apiReingestAdapter is the same seam for the USER-facing side: confirming a
// sender re-ingests the mail it releases (spec §3.2:58), which is the only way
// held mail ever enters the integrity chains.
//
// A second type rather than a second method, because Go cannot give one adapter
// two Reprocess methods with different return types, and neither package may
// import the other's Report: internal/v2/api is the public listener and
// internal/v2/admin is the tailnet console, and a shared type between them is a
// coupling that would eventually carry an admin-only field onto the public API.
// Both are the SAME pipeline instance, so a confirmation and a template
// republish re-parse through identical code.
type apiReingestAdapter struct{ p *ingest.Pipeline }

func (a apiReingestAdapter) Reprocess(ctx context.Context, userID uuid.UUID, ids [][]byte) (api.Report, error) {
	rep, err := a.p.Reprocess(ctx, userID, ids)
	return toAPIReport(rep), err
}

// toAPIReport is toAdminReport's twin, and is a separate function for the same
// reason the adapter is a separate type. Every field is carried; a dropped one
// would under-report a re-ingest to the user who just asked for it.
func toAPIReport(r ingest.Report) api.Report {
	return api.Report{
		Examined:   r.Examined,
		Appended:   r.Appended,
		Superseded: r.Superseded,
		Unchanged:  r.Unchanged,
		Failed:     r.Failed,
	}
}

// toAdminReport is the field-for-field mapping, extracted from the method so a
// test can exercise it without a pipeline. Every field is carried; a report that
// silently dropped one would under-count in the operator's own accounting.
func toAdminReport(r ingest.Report) admin.Report {
	return admin.Report{
		Examined:   r.Examined,
		Appended:   r.Appended,
		Superseded: r.Superseded,
		Unchanged:  r.Unchanged,
		Failed:     r.Failed,
	}
}

// sampleAdapter joins the donated-sample store to the admin console.
//
// Same shape and same reason as reprocessAdapter: admin declares an interface
// rather than importing the package, so the two Sample types meet here. The
// conversion is dull on purpose — a Raw or a ReceivedAt dropped in it would
// mean the publish gate replaying an empty corpus and reporting every
// regression as clean, which is the one failure mode of this whole feature that
// looks exactly like success. TestTheSampleAdapterCarriesEveryField pins it.
type sampleAdapter struct{ s *samples.Samples }

func (a sampleAdapter) ForSender(ctx context.Context, domain string) ([]admin.Sample, error) {
	got, err := a.s.ForSender(ctx, domain)
	if err != nil {
		return nil, err
	}
	out := make([]admin.Sample, 0, len(got))
	for _, s := range got {
		out = append(out, toAdminSample(s))
	}
	return out, nil
}

func (a sampleAdapter) Clusters(ctx context.Context) ([]admin.Cluster, error) {
	got, err := a.s.Clusters(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]admin.Cluster, 0, len(got))
	for _, c := range got {
		out = append(out, admin.Cluster{
			SenderDomain: c.SenderDomain,
			StructureSig: c.StructureSig,
			UserCount:    c.UserCount,
			SampleCount:  c.SampleCount,
			DonatedCount: c.DonatedCount,
			FirstSeen:    c.FirstSeen,
		})
	}
	return out, nil
}

func (a sampleAdapter) Retire(ctx context.Context, id uuid.UUID) (bool, error) {
	return a.s.Retire(ctx, id)
}

// toAdminSample carries every field admin.Sample has. It deliberately does NOT
// carry the consent record: the console's job is to know whether a parser
// works, and nothing it renders is a place to put the identifier of a text
// somebody agreed to.
func toAdminSample(s samples.Sample) admin.Sample {
	return admin.Sample{
		ID:           s.ID,
		UserID:       s.UserID,
		SenderDomain: s.SenderDomain,
		StructureSig: s.StructureSig,
		Raw:          s.Raw,
		ReceivedAt:   s.ReceivedAt,
	}
}
