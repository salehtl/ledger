// Command ledger is the single binary: it loads config, opens the SQLite store,
// starts the IMAP ingest worker (when configured), and serves the API + embedded
// PWA over HTTP. It binds to localhost and is fronted by Tailscale/Caddy for
// HTTPS (see deploy/README.md).
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"ledger/internal/config"
	"ledger/internal/ingest"
	"ledger/internal/server"
	"ledger/internal/store"
	"ledger/internal/web"
)

func main() {
	configPath := flag.String("config", "", "path to config.toml (optional; defaults apply if empty)")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	st, err := store.Open(cfg.Server.DataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	webFS, err := web.FS()
	if err != nil {
		log.Fatalf("web assets: %v", err)
	}

	srv := server.New(st, webFS)
	srv.SetIngest(st, cfg.IMAP.Enabled())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Start the ingest worker when a mailbox is configured.
	if cfg.IMAP.Enabled() {
		interval, err := cfg.IMAP.Interval()
		if err != nil {
			log.Fatalf("imap poll_interval: %v", err)
		}
		dialer := ingest.NewIMAPDialer(cfg.IMAP)
		worker := ingest.New(dialer, st, interval, log.Default())
		go worker.Run(ctx)
		log.Printf("ingest enabled for %s (mailbox %s, poll %s)", cfg.IMAP.Username, cfg.IMAP.Folder, interval)
	} else {
		log.Printf("ingest disabled (no imap.host configured)")
	}

	httpServer := &http.Server{
		Addr:              cfg.Server.Listen,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("ledger listening on %s (data_dir=%s)", cfg.Server.Listen, cfg.Server.DataDir)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server: %v", err)
		}
	}()

	<-ctx.Done()

	log.Println("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
