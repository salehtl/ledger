// Command ledger is the single binary: it loads config, opens the SQLite store,
// starts the IMAP ingest worker (which also runs the parse cascade), and serves
// the API + embedded PWA over HTTP.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"ledger/internal/categorize"
	"ledger/internal/config"
	"ledger/internal/ingest"
	"ledger/internal/parse"
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

	// Build categorizer from live store data.
	storeCats, err := st.SelectCategories()
	if err != nil {
		log.Fatalf("select categories: %v", err)
	}
	storeRules, err := st.SelectRules()
	if err != nil {
		log.Fatalf("select rules: %v", err)
	}
	domainCats := make([]categorize.Category, len(storeCats))
	for i, c := range storeCats {
		domainCats[i] = categorize.Category{ID: c.ID, Name: c.Name, Kind: c.Kind, Bucket: c.Bucket}
	}
	domainRules := make([]categorize.Rule, len(storeRules))
	for i, r := range storeRules {
		domainRules[i] = categorize.Rule{
			MatchType:  r.MatchType,
			Pattern:    r.Pattern,
			CategoryID: r.CategoryID,
			Priority:   r.Priority,
		}
	}

	// Pick AI clients based on config.
	var aiCat categorize.AICategorizer = categorize.DisabledAI{}
	var aiExt parse.Extractor = parse.DisabledExtractor{}
	if cfg.AI.Enabled {
		aiCat = categorize.NewAnthropicCategorizer(cfg.AI.APIKey, cfg.AI.Model)
		if cfg.AI.AllowAIExtraction {
			aiExt = parse.NewAnthropicExtractor(cfg.AI.APIKey, cfg.AI.Model)
		}
		log.Printf("ai: enabled (model=%s, threshold=%.2f, auto_rule=%v, allow_extraction=%v)",
			cfg.AI.Model, cfg.AI.AutoAcceptThreshold, cfg.AI.AutoRule, cfg.AI.AllowAIExtraction)
	} else {
		log.Printf("ai: disabled (set ai.enabled=true + LEDGER_AI_API_KEY to activate)")
	}

	cat := categorize.New(domainRules, domainCats, aiCat, cfg.AI.AutoAcceptThreshold, cfg.AI.AutoRule)

	cascade := &parse.Cascade{
		Parsers:   []parse.BankParser{parse.DIBParser{}},
		Heuristic: parse.HeuristicParser{},
		AI:        aiExt,
	}
	processor := parse.NewProcessorWithCategorizer(st, cascade, cat)

	srv := server.New(st, webFS)
	srv.SetIngest(st, cfg.IMAP.Enabled())
	srv.SetReprocessor(processor)
	srv.SetCategoryStore(st)
	srv.SetRecategorizeFn(func(ctx context.Context, merchantRaw string) (int64, string, bool) {
		result, ok := cat.Categorize(ctx, merchantRaw)
		if !ok {
			return 0, "", false
		}
		status := "needs_review"
		if result.AboveThreshold {
			status = "confirmed"
		}
		if result.ProposedRule != nil {
			_ = st.InsertRule(store.RuleRow{
				MatchType:  result.ProposedRule.MatchType,
				Pattern:    result.ProposedRule.Pattern,
				CategoryID: result.ProposedRule.CategoryID,
				Priority:   result.ProposedRule.Priority,
				Source:     "ai_confirmed",
			})
		}
		return result.CategoryID, status, true
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if cfg.IMAP.Enabled() {
		interval, err := cfg.IMAP.Interval()
		if err != nil {
			log.Fatalf("imap poll_interval: %v", err)
		}
		dialer := ingest.NewIMAPDialer(cfg.IMAP)
		worker := ingest.New(dialer, st, interval, log.Default())
		worker.SetPostProcess(func(ctx context.Context) (int, error) {
			return processor.ProcessPending(ctx, store.SelectForParseOpts{OnlyUnparsed: true})
		})
		go worker.Run(ctx)
		log.Printf("ingest+parse enabled for %s (mailbox %s, poll %s)", cfg.IMAP.Username, cfg.IMAP.Folder, interval)
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
