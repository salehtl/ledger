// Command ledgerd is the v2 multi-user server. It shares no state, no port and
// no database with the v1 `ledger` binary.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"ledger/internal/v2/api"
	"ledger/internal/v2/config"
	"ledger/internal/v2/pg"
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

func main() {
	checkModeHandlers()

	mode := "serve"
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		mode = os.Args[1]
		os.Args = append(os.Args[:1], os.Args[2:]...)
	}
	var cfgPath string
	flag.StringVar(&cfgPath, "config", "", "path to config.toml")
	flag.Parse()

	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	cfg.Mode = mode

	if handler, ok := modeHandlers[mode]; ok {
		err = handler(cfg)
	} else {
		err = fmt.Errorf("unknown mode %q (%s)", mode, strings.Join(config.Modes(), "|"))
	}
	if err != nil {
		log.Fatal(err)
	}
}

// runServe opens the Postgres pool, applies every embedded migration, and
// serves the sync API until SIGINT/SIGTERM.
//
// Plain HTTP on purpose: TLS/autocert is deployment Task D4. Everything this
// listener carries is sensitive — a session bearer token on every request, the
// user's whole op log in the responses — so "it is only reached over Tailscale"
// cannot be left as a comment: config.validate REFUSES a non-loopback
// http_listen, and the default is loopback, until the change that adds TLS
// lifts that rail deliberately. The SMTP receiver (Task 24) and the
// Tailscale-bound admin listener (Task 32) mount onto this same startup
// sequence as their tasks land.
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

	errc := make(chan error, 1)
	go func() {
		log.Printf("ledgerd serve: listening on %s", cfg.Server.HTTPListen)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
			return
		}
		errc <- nil
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Println("shutting down")
	// Detached from ctx, which is already cancelled: in-flight requests get a
	// bounded window to finish rather than being cut off at the signal.
	shutCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return <-errc
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
