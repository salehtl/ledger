// Command ledgerd is the v2 multi-user server. It shares no state, no port and
// no database with the v1 `ledger` binary.
package main

import (
	"context"
	"crypto/tls"
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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/acme/autocert"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/admin"
	"ledger/internal/v2/api"
	"ledger/internal/v2/arc"
	"ledger/internal/v2/auth"
	"ledger/internal/v2/config"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/dict"
	"ledger/internal/v2/ingest"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/pg"
	"ledger/internal/v2/pushv2"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/samples"
	"ledger/internal/v2/smtpd"
	"ledger/internal/v2/tmpl"
	"ledger/internal/v2/webui"
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
//
// "vapid-keys" is the one entry here that main() never actually reaches
// through this map: it is dispatched before config.Load, in main() itself,
// because it must work when Load would refuse to run (see vapidkeys.go). The
// entry below — which ignores the config.Config it is handed — exists only
// so checkModeHandlers' cross-check against config.Modes() has something to
// find on every invocation, including ones that never touch vapid-keys at
// all.
var modeHandlers = map[string]func(config.Config) error{
	"serve":           runServe,
	"relay":           runRelay,
	"verify":          runVerify,
	"seed-dictionary": runSeedDictionary,
	"seed-templates":  runSeedTemplates,
	"purge-user":      runPurgeUser,
	"record-consent":  runRecordConsent,
	"parse-rate":      runParseRate,
	"mint-invite":     runMintInvite,
	"load-corpus":     runLoadCorpus,
	"vapid-keys":      func(config.Config) error { return runVAPIDKeys() },
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
	// invite is `mint-invite`'s, likewise.
	invite config.InviteArgs
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
		"record-consent|mint-invite: list what is on file and write nothing")
	fs.StringVar(&out.invite.Note, "note", "",
		"mint-invite: the operator's own words about who this code is for")
	registerLoadCorpusFlags(fs, &out.user) // load-corpus's own flags; see loadcorpus.go
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
	// --show likewise means the same thing in both modes that take it: list
	// what is on file and write nothing. A second flag spelled --list would be
	// the same idea under a second name.
	out.invite.Show = out.consent.Show
	return out, nil
}

func main() {
	checkModeHandlers()

	a, err := parseArgs(os.Args[1:])
	if err != nil {
		log.Fatalf("arguments: %v", err)
	}

	// vapid-keys is dispatched HERE, before config.Load, rather than through
	// modeHandlers like every other mode. It needs no config, no database and
	// no network — and it must stay reachable even when Load would fail,
	// which matters because the one failure mode it exists to fix is exactly
	// that: push.web_enabled true with LEDGER_VAPID_* unset makes Load refuse
	// to run, naming this very command in the error. Dispatching after Load,
	// the way every other mode does, would make the fix unreachable at the
	// one moment an operator needs it. See vapidkeys.go.
	if a.mode == "vapid-keys" {
		if err := runVAPIDKeys(); err != nil {
			log.Fatal(err)
		}
		return
	}

	cfg, err := config.Load(a.configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	cfg.Mode = a.mode
	cfg.Purge = a.purge
	cfg.Verify = a.verify
	cfg.Consent = a.consent
	cfg.Invite = a.invite
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
// TLS is terminated HERE, in this process, when server.tls_domains is set:
// configureTLS puts autocert on the public listener (v2 is multi-user with
// external testers — unlike v1 it is not behind a tailnet, and the plan puts no
// proxy in front of it). With no tls_domains the listener is plain HTTP, and
// then everything it carries is sensitive in the clear — a session bearer token
// on every request, the user's whole op log in the responses — so
// config.validate refuses a non-loopback address in that case and the default
// is loopback. TLS is the only thing that lifts that rail.
//
// The embedded PWA is served from the SAME listener, behind the API routes; see
// publicHandler for why one origin is load bearing rather than tidy.
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

	// Immediately after the migrations and before anything can accept a
	// message. A migrated database with no templates in it is not a working
	// deployment — it is one that takes mail, stores it, and parses none of
	// it — so the two steps belong together. Idempotent; see seedtemplates.go.
	if err := logSeededTemplates(ctx, pool); err != nil {
		return err
	}

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
	// pusher is Disabled unless the operator turned push on. The content-free
	// contract exists either way (pushv2), and the ONE call site is inside the
	// pipeline, on a hot-stream append.
	//
	// Senders are COMPOSED rather than chosen between, so a deployment can have
	// several audiences, one, or none. Only Web Push ships today — the Expo
	// channel went with the native client on 2026-08-10 — but pushv2.Multi is
	// the seam a second one is added at, and it is not the pipeline.
	// pushv2.Multi over an empty slice would be a valid no-op, but Disabled is
	// kept as the zero case so that "push is off" reads the same in the log and
	// in a stack trace as it always has.
	var pusher ingest.Pusher = pushv2.Disabled{}
	var senders pushv2.Multi
	if cfg.Push.Enabled {
		// push.enabled drove the Expo sender, which no longer exists. The key
		// still loads — the config loader rejects a TOML with an unknown key,
		// so removing the field would stop this binary booting against a
		// deployed config that sets it — and it now does nothing. Said out
		// loud, because an operator who set it is expecting notifications.
		log.Println("ledgerd serve: push.enabled is set but INERT — it drove the Expo sender, " +
			"removed with the native client on 2026-08-10. Set push.web_enabled for the PWA.")
	}
	if cfg.Push.WebEnabled {
		senders = append(senders, &pushv2.Web{
			Pool:         pool,
			VAPIDPublic:  cfg.Push.VAPIDPublic,
			VAPIDPrivate: cfg.Push.VAPIDPrivate,
			Subscriber:   cfg.Push.VAPIDSubject,
		})
		log.Println("ledgerd serve: content-free web push is ENABLED")
	}
	if len(senders) > 0 {
		pusher = senders
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
	// TLS (Task D3) is configured HERE, before the handler, because the same
	// answer decides both: whether autocert terminates TLS, and whether the
	// responses may carry HSTS. One predicate, one variable, so the two cannot
	// disagree — an HSTS header on a plain-HTTP listener would pin a browser to
	// an https:// URL that does not exist, and it would stay pinned for the
	// whole max-age.
	serveTLS, err := configureTLS(cfg, srv)
	if err != nil {
		return err
	}
	if srv.Handler, err = publicHandler(syncAPI.Handler(), serveTLS); err != nil {
		return err
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

	// The deleted-account tombstone sweep. It used to be the last statement of
	// 00021's BEFORE DELETE trigger, where it ran on POSTGRES's clock over rows
	// carrying auth.Sessions' — two clocks deciding one fact, which deleted the
	// tombstone it had just written and answered 401 where a device needed 410.
	// It lives here now for the same reason the other three do: the alternative
	// was the session-lookup path, which every unrecognized bearer token
	// reaches, and a sweep an anonymous caller can trigger is a write an
	// anonymous caller can trigger.
	tombstoneSweepDone := startTombstoneSweep(ctx, syncAPI.Sessions)
	// And the fifth, for the same reason and with the same shape: a passkey
	// ceremony is a row an UNAUTHENTICATED caller causes this server to write,
	// and it is claimed by the finish that spends it — so the ones that are
	// never finished are exactly the ones nothing else removes. Sweeping on the
	// finish path instead would have put the write back where an anonymous
	// caller can trigger it.
	ceremonySweepDone := startCeremonySweep(ctx, syncAPI.Passkeys)

	// The cleartext rail, re-checked immediately before the listener starts —
	// the same treatment CheckAdminBind gets above, and for the same reason: a
	// Config assembled in code rather than through Load never passed
	// validate(). This one is the MORE consequential of the two (it is the
	// listener carrying every session token and every op log), so it does not
	// get the weaker version. It is checked against the same tls_domains
	// configureTLS gated on, so "serving TLS" and "allowed to be public" cannot
	// come apart.
	if err := config.CheckPublicBind(cfg.Server.HTTPListen, cfg.Server.TLSDomains); err != nil {
		return err
	}

	errc := make(chan error, 1)
	go func() {
		if serveTLS {
			log.Printf("ledgerd serve: listening on %s with TLS for %s (autocert, TLS-ALPN-01; "+
				"cache %s)", cfg.Server.HTTPListen, strings.Join(cfg.Server.TLSDomains, ", "),
				cfg.Server.AutocertCache)
			// Empty cert and key paths: the certificate comes from
			// TLSConfig.GetCertificate, i.e. from autocert.
			if err := srv.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errc <- err
				return
			}
			errc <- nil
			return
		}
		log.Printf("ledgerd serve: listening on %s (plain HTTP, loopback only)", cfg.Server.HTTPListen)
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
	<-tombstoneSweepDone
	<-ceremonySweepDone
	return serveErr
}

// configureTLS puts autocert on the public listener, and reports whether the
// caller must serve TLS. It reports false, and changes nothing, when
// server.tls_domains is empty — the loopback development case.
//
// # TLS-ALPN-01, so port 80 stays shut
//
// The manager's TLSConfig advertises the "acme-tls/1" protocol, and Let's
// Encrypt then validates by opening a TLS connection to :443 with that ALPN
// name. Nothing listens on :80 and nothing needs to: no HTTP-to-HTTPS redirect
// server, and no firewall rule for port 80 in the deploy step. That is a
// deliberate reduction of surface — the only other option, HTTP-01, would put
// an unauthenticated cleartext listener on the public internet whose only
// purpose is to prove we own the name.
//
// # The cache is not optional
//
// autocert.DirCache stores the issued certificates AND the ACME account key. A
// deployment that cannot write it re-registers and re-issues on every restart
// and hits Let's Encrypt's duplicate-certificate limit, which is a week of
// failed handshakes traced back to a directory. So it is created 0700 HERE, at
// startup, before the listener — a permission problem is a startup error, not a
// handshake failure at 3am. config.validate refuses an empty path.
func configureTLS(cfg config.Config, srv *http.Server) (bool, error) {
	if len(cfg.Server.TLSDomains) == 0 {
		return false, nil
	}
	if err := os.MkdirAll(cfg.Server.AutocertCache, 0o700); err != nil {
		return false, fmt.Errorf("autocert cache %s: %w", cfg.Server.AutocertCache, err)
	}
	// MkdirAll applies its mode ONLY to directories it creates, so a cache
	// directory an operator (or an earlier deploy) made by hand at 0755 would
	// keep 0755 and leave the ACME account key world-readable — silently, since
	// everything works. Tighten unconditionally, and refuse a path that is not
	// a directory rather than letting autocert fail later at first write.
	info, err := os.Stat(cfg.Server.AutocertCache)
	if err != nil {
		return false, fmt.Errorf("autocert cache %s: %w", cfg.Server.AutocertCache, err)
	}
	if !info.IsDir() {
		return false, fmt.Errorf("autocert cache %s is not a directory", cfg.Server.AutocertCache)
	}
	if info.Mode().Perm() != 0o700 {
		if err := os.Chmod(cfg.Server.AutocertCache, 0o700); err != nil {
			return false, fmt.Errorf("tighten autocert cache %s to 0700 (it holds the ACME "+
				"account key): %w", cfg.Server.AutocertCache, err)
		}
		log.Printf("ledgerd serve: tightened autocert cache %s from %o to 0700",
			cfg.Server.AutocertCache, info.Mode().Perm())
	}
	m := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		Cache:      autocert.DirCache(cfg.Server.AutocertCache),
		HostPolicy: autocert.HostWhitelist(cfg.Server.TLSDomains...),
	}
	tlsCfg := m.TLSConfig()
	// TLS 1.2 floor. autocert's own default is Go's, which is the same today,
	// but this listener carries session bearer tokens and the whole op log and
	// the floor should not be inherited silently.
	tlsCfg.MinVersion = tls.VersionTLS12
	srv.TLSConfig = tlsCfg
	return true, nil
}

// publicHandler composes what the public listener serves: the sync API, and
// behind it the embedded PWA (Task D4).
//
// ONE listener, ONE origin, and that is the whole reason this composition
// exists rather than a separate static host. A WebAuthn ceremony is bound to
// the origin the browser reports it ran on, so serving the PWA anywhere else
// would mean CORS on every sync request, a second entry in auth.rp_origins, and
// a credential story that has to survive a cross-site fetch. Same origin
// removes all three, and the Client's `server` base URL stays "".
//
// Order is load bearing: /api/ is routed to the API mux FIRST, so an unrouted
// API path reaches api.Server's catch-all 404 JSON rather than the SPA
// fallback's 200 HTML. webui.Handler declines the /api/ prefix on its own too —
// belt and braces, because "the API is mounted first" is a property of this
// function that a later edit could reorder with nothing to catch it.
func publicHandler(apiHandler http.Handler, tlsEnabled bool) (http.Handler, error) {
	files, err := webui.FS()
	if err != nil {
		return nil, fmt.Errorf("embedded pwa: %w", err)
	}
	// Loud, once, at startup — not fatal. See webui.CheckBundle: a committed
	// dist/ is what lets a fresh clone build without Node, and it is also what
	// makes a stale bundle completely silent. Refusing to boot during a cutover
	// would be worse than a warning an operator can act on.
	if err := webui.CheckBundle(files); err != nil {
		log.Printf("ledgerd serve: *** %v ***", err)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", apiHandler)
	mux.Handle("/", webui.Handler(files))
	return securityHeaders(mux, tlsEnabled), nil
}

// contentSecurityPolicy is the CSP served with every response.
//
// 'wasm-unsafe-eval' is required and is not a loosening of 'unsafe-eval': the
// browser SqlDriver compiles sql.js's WebAssembly, which CSP treats as
// evaluation. 'unsafe-inline' in style-src is required too — Framer Motion
// animates by writing style attributes — and is the one directive here that is
// genuinely weak; it is scoped to styles, never to scripts.
//
// connect-src 'self' is the one that matters most for this app: the PWA and the
// API share an origin, so a same-origin-only connect policy is not a
// compromise, it is exactly the rule. An injected script cannot exfiltrate an
// op log to another host.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; " +
	"font-src 'self'; " +
	"connect-src 'self'; " +
	"worker-src 'self' blob:; " +
	"manifest-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'"

// hstsValue is 180 days, without includeSubDomains and without preload.
//
// includeSubDomains is omitted deliberately rather than forgotten: it would
// commit EVERY name under the apex — including any operator tooling, and any
// future subdomain nobody has thought of yet — to HTTPS for the whole max-age,
// with no way to take it back inside that window. app. and api. are the only
// names served over HTTP and both are covered directly. preload is omitted for
// the stronger version of the same reason: it is not reversible on our
// timetable at all.
const hstsValue = "max-age=15552000"

// securityHeaders is the one place response headers are set for the public
// listener. It wraps BOTH the API and the PWA, because nosniff and a CSP matter
// for a JSON 404 as much as for a page.
//
// # Why HSTS is gated on TLS rather than always set
//
// Two failures, in opposite directions, and both are why this takes a bool
// rather than sniffing the request.
//
// Setting it on a plain-HTTP loopback listener would pin the developer's
// browser to https://127.0.0.1:<port>, which nothing serves, for the whole
// max-age — a local machine broken for six months by a header. So it is set
// only when this process actually terminates TLS.
//
// And it must be set when we do, because of the challenge type: TLS-ALPN-01
// means nothing ever listens on :80. There is no redirect server, so a browser
// that tries http://app.sirdab.ae first gets whatever an attacker on the path
// chooses to answer with. HSTS is the only thing that stops that request from
// being made at all — the ONE mechanism that turns "we never bind :80" from a
// smaller surface into a closed one.
//
// # The rest, and why they are unconditional
//
//   - nosniff: the SPA fallback answers 200 with an HTML body on every unknown
//     path, so content-type sniffing has plenty to work with. Also stops a JSON
//     error body being sniffed as something executable.
//   - Referrer-Policy: URLs here carry account and transaction identifiers.
//     no-referrer means none of that leaves in a header, ever.
//   - X-Frame-Options + frame-ancestors 'none': a financial app is never framed.
//   - Cross-Origin-Opener-Policy: severs window.opener between origins.
func securityHeaders(next http.Handler, tlsEnabled bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		if tlsEnabled {
			h.Set("Strict-Transport-Security", hstsValue)
		}
		next.ServeHTTP(w, r)
	})
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

// startTombstoneSweep bounds the deleted-account tombstone table
// (00021_deleted_account_sessions.sql), reaping rows whose sessions expired
// more than auth's grace ago.
//
// It is a FOURTH loop for the reason given on startSampleSweep, and it exists
// at all because the sweep it replaces was a `DELETE … now() - interval
// '30 days'` inside the BEFORE DELETE trigger — Postgres's clock judging rows
// written from auth.Sessions'. See 00022_tombstone_sweep_leaves_the_trigger.sql.
//
// This one failing is the mildest of the four: the table only grows, and every
// row in it still answers correctly because auth.Sessions.deletedOrUnknown
// refuses anything past its own expires_at regardless of whether it was reaped.
// It is logged loudly anyway — unbounded growth nobody is told about is how a
// table becomes a surprise.
func startTombstoneSweep(ctx context.Context, s *auth.Sessions) <-chan struct{} {
	if s == nil {
		return closedChan()
	}
	return startSweep(ctx, "deleted-account tombstone sweep", func(ctx context.Context) (string, error) {
		n, err := s.ReapDeletedAccountTombstones(ctx)
		if err != nil || n == 0 {
			return "", err
		}
		return fmt.Sprintf("reaped %d expired deleted-account tombstone(s)", n), nil
	})
}

// startCeremonySweep bounds webauthn_ceremonies (00025_passkeys.sql).
//
// A ceremony is deleted by the finish that claims it, so what this removes is
// the abandoned ones: a user who dismissed the browser prompt, a tab that was
// closed, and anything a caller minted for no reason at all. That last case is
// why it exists — four of the six passkey routes are unauthenticated, and while
// the rate limiter bounds how fast rows appear, only this bounds how long they
// stay.
//
// It is the FIFTH loop for the reason given on startSampleSweep. Failing is mild
// in the same way the tombstone sweep's is: an unswept row still answers
// correctly, because auth.Passkeys.claimCeremony refuses anything past its own
// expires_at whether or not it was reaped. The cost is growth, and growth nobody
// is told about is how a table becomes a surprise.
func startCeremonySweep(ctx context.Context, p *auth.Passkeys) <-chan struct{} {
	if p == nil {
		return closedChan()
	}
	return startSweep(ctx, "passkey ceremony sweep", func(ctx context.Context) (string, error) {
		n, err := p.ReapExpiredCeremonies(ctx)
		if err != nil || n == 0 {
			return "", err
		}
		return fmt.Sprintf("reaped %d expired passkey ceremony(s)", n), nil
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
