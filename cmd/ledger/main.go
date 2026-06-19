// Command ledger is the single binary: it loads config, opens the SQLite store,
// starts the IMAP ingest worker (which also runs the parse cascade), and serves
// the API + embedded PWA over HTTP.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"ledger/internal/categorize"
	"ledger/internal/config"
	"ledger/internal/importer"
	"ledger/internal/ingest"
	"ledger/internal/monitor"
	"ledger/internal/parse"
	"ledger/internal/push"
	"ledger/internal/server"
	"ledger/internal/store"
	"ledger/internal/web"
)

// buildCategorizer reads live app settings and returns a categorizer plus
// whether auto-categorization is enabled. It returns (nil, false) when settings
// can't be read, auto_categorize is off, or rules can't be read — callers skip
// categorization in that case. cats is the static category list; aiCat is the
// AI categorizer used only when settings.AIEnabled.
// buildCategorizer assembles a categorizer from current settings + rules. A nil
// categorizer with a nil error means categorization is disabled (AutoCategorize
// off) — a benign state, not a failure. A non-nil error means a real read
// failure the caller may want to surface.
func buildCategorizer(st *store.Store, cats []categorize.Category, aiCat categorize.AICategorizer) (*categorize.Categorizer, error) {
	settings, err := st.SelectAppSettings()
	if err != nil {
		return nil, fmt.Errorf("read settings: %w", err)
	}
	if !settings.AutoCategorize {
		return nil, nil
	}
	ruleRows, err := st.SelectActiveRules()
	if err != nil {
		return nil, fmt.Errorf("read active rules: %w", err)
	}
	rules := make([]categorize.Rule, 0, len(ruleRows))
	for _, r := range ruleRows {
		rules = append(rules, categorize.Rule{
			MatchType: r.MatchType, Pattern: r.Pattern, CategoryID: r.CategoryID, Priority: r.Priority,
		})
	}
	ai := categorize.AICategorizer(categorize.DisabledAI{})
	threshold := math.MaxFloat64 // AI suggests but never auto-confirms
	if settings.AIEnabled {
		ai = aiCat
		if settings.AIAutoAccept {
			threshold = settings.AIThreshold
		}
	}
	return categorize.New(rules, cats, ai, threshold, settings.AIAutoAccept), nil
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "import":
			runImport(os.Args[2:])
			return
		case "vapid-keys":
			priv, pub, err := push.GenerateKeys()
			if err != nil {
				log.Fatalf("vapid-keys: %v", err)
			}
			fmt.Printf("LEDGER_VAPID_PRIVATE=%s\nLEDGER_VAPID_PUBLIC=%s\n", priv, pub)
			return
		}
	}

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

	if err := st.EnsureBudgetConfig(); err != nil {
		log.Fatalf("ensure budget config: %v", err)
	}

	if err := st.EnsureAppSettings(); err != nil {
		log.Fatalf("ensure app settings: %v", err)
	}

	webFS, err := web.FS()
	if err != nil {
		log.Fatalf("web assets: %v", err)
	}

	// Build category list for the per-batch categorizer provider.
	storeCats, err := st.SelectCategories()
	if err != nil {
		log.Fatalf("select categories: %v", err)
	}
	domainCats := make([]categorize.Category, len(storeCats))
	for i, c := range storeCats {
		domainCats[i] = categorize.Category{ID: c.ID, Name: c.Name, Kind: c.Kind, Bucket: c.Bucket}
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

	cascade := &parse.Cascade{
		Parsers:   []parse.BankParser{parse.DIBParser{}, parse.ENBDParser{}},
		Heuristic: parse.HeuristicParser{},
		AI:        aiExt,
	}
	processor := parse.NewProcessor(st, cascade)
	processor.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) {
		cat, err := buildCategorizer(st, domainCats, aiCat)
		if err != nil {
			log.Printf("categorizer: skipping categorization: %v", err)
			return nil, false
		}
		return cat, cat != nil
	})

	srv := server.New(st, webFS)
	srv.SetIngest(st, cfg.IMAP.Enabled())
	srv.SetReprocessor(processor)
	srv.SetCategoryStore(st)
	srv.SetSettingsStore(st)
	srv.SetAIKeyPresent(cfg.AI.APIKey != "")
	srv.SetRuleActiveStore(st)
	srv.SetBudgetStore(st)
	srv.SetInsightsStore(st)
	srv.SetRecategorizeFn(func(ctx context.Context, merchantRaw string) (int64, string, bool, error) {
		cat, err := buildCategorizer(st, domainCats, aiCat)
		if err != nil {
			// Real read failure — surface it to the run status.
			return 0, "", false, err
		}
		if cat == nil {
			// Categorization disabled — benign miss, nothing to report.
			return 0, "", false, nil
		}
		result, err := cat.Categorize(ctx, merchantRaw)
		if err != nil {
			if errors.Is(err, categorize.ErrAIUnavailable) {
				// No rule matched and AI is off for this merchant — benign.
				return 0, "", false, nil
			}
			// Genuine failure (AI outage, rate-limit exhaustion, bad response).
			return 0, "", false, err
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
		return result.CategoryID, status, true, nil
	})

	// VAPID push sender (optional — only enabled when both keys are set).
	var pushSend *push.Sender
	if priv := os.Getenv("LEDGER_VAPID_PRIVATE"); priv != "" {
		pub := os.Getenv("LEDGER_VAPID_PUBLIC")
		subscriber := "mailto:" + cfg.IMAP.Username
		if subscriber == "mailto:" {
			subscriber = "mailto:admin@localhost"
		}
		if s, err := push.New(priv, pub, subscriber); err == nil {
			pushSend = s
			srv.SetPushStore(st)
			srv.SetPushSender(pushSend)
			log.Printf("push: VAPID enabled")
		} else {
			log.Printf("push: disabled (%v)", err)
		}
	} else {
		log.Printf("push: disabled (set LEDGER_VAPID_PRIVATE + LEDGER_VAPID_PUBLIC to enable)")
	}

	// SSE hub — broadcasts new transactions and drift alerts.
	hub := server.NewHub()
	srv.SetHub(hub)

	// Wire processor to broadcast SSE events on successful inserts.
	processor.SetOnInsert(func(txID, amountFils int64, merchant, direction string) {
		hub.BroadcastEvent("new_transaction", map[string]any{
			"id":           txID,
			"merchant_raw": merchant,
			"amount":       amountFils,
			"direction":    direction,
		})
		if pushSend != nil {
			subs, _ := st.SelectPushSubs()
			payload, _ := json.Marshal(map[string]string{
				"title": "New transaction",
				"body":  merchant,
			})
			for _, sub := range subs {
				go func(s store.PushSubRow) {
					_ = pushSend.Send(context.Background(), s.Endpoint, s.P256dh, s.Auth, payload)
				}(sub)
			}
		}
	})

	// Drift monitor — check parse-success rates and alert on drift.
	driftWindow, werr := cfg.Monitoring.ParseDriftWindow()
	if werr != nil {
		log.Fatalf("monitoring.drift_window: %v", werr)
	}
	mon := monitor.New(st, driftWindow, cfg.Monitoring.DriftMin, cfg.Monitoring.Senders, func(alerts []monitor.DriftAlert) {
		hub.BroadcastEvent("drift_alert", alerts)
		if pushSend != nil && len(alerts) > 0 {
			subs, _ := st.SelectPushSubs()
			payload, _ := json.Marshal(map[string]string{
				"title": "Parse drift alert",
				"body":  alerts[0].FromAddr + " parse-success dropped",
			})
			for _, sub := range subs {
				go func(s store.PushSubRow) {
					_ = pushSend.Send(context.Background(), s.Endpoint, s.P256dh, s.Auth, payload)
				}(sub)
			}
		}
	})
	srv.SetDriftMonitor(mon)

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

	go mon.Start(ctx)

	<-ctx.Done()
	log.Println("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}

func runImport(args []string) {
	fs := flag.NewFlagSet("import", flag.ExitOnError)
	filePath := fs.String("file", "", "path to CSV or XLSX file (required)")
	mapPath := fs.String("map", "map.toml", "path to map.toml column-mapping file")
	dryRun := fs.Bool("dry-run", false, "validate and report without writing to the database")
	configPath := fs.String("config", "", "path to config.toml (optional; uses defaults if empty)")
	if err := fs.Parse(args); err != nil {
		log.Fatalf("import flags: %v", err)
	}
	if *filePath == "" {
		log.Fatal("import: --file is required")
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	st, err := store.Open(cfg.Server.DataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	m, err := importer.LoadMap(*mapPath)
	if err != nil {
		log.Fatalf("map: %v", err)
	}

	rows, err := importer.ReadFile(*filePath)
	if err != nil {
		log.Fatalf("read file: %v", err)
	}

	// Build rules-only categorizer from live store data, but only when
	// auto_categorize is enabled — if not, imported rows land in needs_review.
	var cat *categorize.Categorizer
	importSettings, err := st.SelectAppSettings()
	if err != nil {
		log.Printf("import: settings read failed, skipping categorization: %v", err)
	}
	if err == nil && importSettings.AutoCategorize {
		storeCats, _ := st.SelectCategories()
		storeRules, _ := st.SelectActiveRules()
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
		cat = categorize.New(domainRules, domainCats, categorize.DisabledAI{}, 0.85, false)
	}

	imp := importer.New(st, cat)
	result, err := imp.Run(context.Background(), rows, m, filepath.Base(*filePath), *dryRun)
	if err != nil {
		log.Fatalf("import: %v", err)
	}

	mode := "COMMITTED"
	if *dryRun {
		mode = "DRY RUN"
	}
	fmt.Printf("\n[%s] %s\n", mode, *filePath)
	fmt.Printf("  Total rows:         %d\n", result.RowsTotal)
	fmt.Printf("  Added (confirmed):  %d\n", result.RowsAdded)
	fmt.Printf("  Review queue:       %d\n", result.RowsReview)
	fmt.Printf("  Skipped (dedup):    %d\n", result.RowsSkipped)
	fmt.Printf("  Errors:             %d\n", result.RowsError)
	if !*dryRun {
		fmt.Printf("  Rules derived:      %d\n", result.DerivedRules)
	}
	if result.RowsError > 0 {
		fmt.Fprintln(os.Stderr, "\nWARNING: some rows had errors — check output above")
		os.Exit(1)
	}
}
