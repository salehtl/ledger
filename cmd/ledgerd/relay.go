package main

// relay.go — `ledgerd relay`, the backup MX (spec §3.2, Task 35). Split out of
// main.go for the same reason verify.go and seedtemplates.go were: main.go is
// the dispatch table plus `serve`, and a second long-running mode with its own
// two background loops is not that.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os/signal"
	"syscall"
	"time"

	"ledger/internal/v2/config"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/relay"
	"ledger/internal/v2/smtpd"
)

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
