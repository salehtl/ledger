// Task 36: `ledgerd verify` and `ledgerd parse-rate` — the operator's
// instruments for spec §5's two measurable Phase 1 exit criteria, "zero drops
// without notice" and "≥95% of transaction emails parse".
//
// They live in their own file rather than in main.go for the ordinary reason:
// main.go is the dispatch table plus `serve`, and two subcommands with a text
// renderer, a window parser and an interactive prompt between them are not that.
//
// The arithmetic is all in internal/v2/verify. Everything here is argument
// handling and printing — deliberately, so that the SAME numbers reach an
// operator with a shell (these commands) and an operator with a browser
// (/admin/accounting) without two implementations to disagree.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/config"
	"ledger/internal/v2/pg"
	"ledger/internal/v2/verify"
)

// runVerify is the operator's instrument for spec §5's "zero drops without
// notice" exit criterion (Task 36): the four structural invariants over op_log,
// plus the mail-accounting report over a window.
//
// It exits non-zero on ANY finding from either half, so it is the thing a deploy
// or a cron can gate on. Both halves always run and both are always printed: an
// operator whose accounting balances still wants to know their chains verify,
// and stopping at the first failure would hide the second.
//
// It reads no content. Nothing here opens a blob or looks at a header — see the
// internal/v2/verify package doc, where that rule is the first thing stated,
// because this command is pointed at real users' mail on the production box.
func runVerify(cfg config.Config) error {
	users, err := verifyTargets(cfg.Verify.User)
	if err != nil {
		return err
	}
	from, to, err := verifyWindow(cfg.Verify, verifyDefaultWindow)
	if err != nil {
		return err
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd verify: open postgres: %w", err)
	}
	defer pool.Close()
	// Deliberately NO pg.Migrate, unlike every other subcommand. This one is an
	// audit of stored data, and a tool that applies schema changes to the
	// database it is about to audit has changed the thing it is measuring. A
	// pending migration should be an operator's decision made before the audit,
	// not a side effect of running it — so an unmigrated database fails here
	// with a missing relation, which is the correct and visible answer.

	findings, err := verify.StructuralFor(ctx, pool, users)
	if err != nil {
		return fmt.Errorf("ledgerd verify: %w", err)
	}
	acc, err := verify.Accounting(ctx, pool, from, to)
	if err != nil {
		return fmt.Errorf("ledgerd verify: %w", err)
	}
	findings = append(findings, acc.Findings()...)

	if cfg.Verify.JSON {
		if err := writeJSON(map[string]any{
			"findings": findings, "accounting": acc, "ok": len(findings) == 0,
		}); err != nil {
			return err
		}
	} else {
		printAccounting(acc)
		printFindings(findings)
	}
	if len(findings) > 0 {
		// A plain error, so main's log.Fatal gives exit status 1. The findings
		// are already printed above; this line says how many, not which.
		return fmt.Errorf("ledgerd verify: %d finding(s)", len(findings))
	}
	return nil
}

// verifyDefaultWindow matches the alpha's own cadence: spec §5's exit criteria
// are measured over two weeks.
const verifyDefaultWindow = 14 * 24 * time.Hour

func verifyTargets(user string) ([]uuid.UUID, error) {
	if user == "" {
		return nil, nil
	}
	u, err := uuid.Parse(user)
	if err != nil {
		return nil, fmt.Errorf("ledgerd: --user %q is not a uuid", user)
	}
	return []uuid.UUID{u}, nil
}

// verifyWindow resolves --from/--to. An absent end is now and an absent start is
// one default window before it, so the report always ECHOES a concrete window: a
// report that says "from 0001-01-01" is one nobody can compare against another.
func verifyWindow(a config.VerifyArgs, def time.Duration) (from, to time.Time, err error) {
	parse := func(name, raw string) (time.Time, error) {
		if raw == "" {
			return time.Time{}, nil
		}
		t, perr := time.Parse(time.RFC3339, raw)
		if perr != nil {
			return time.Time{}, fmt.Errorf("ledgerd: --%s %q is not an RFC3339 instant "+
				"(e.g. 2026-08-01T00:00:00Z)", name, raw)
		}
		return t, nil
	}
	if to, err = parse("to", a.To); err != nil {
		return
	}
	if from, err = parse("from", a.From); err != nil {
		return
	}
	if to.IsZero() {
		to = time.Now()
	}
	if from.IsZero() {
		from = to.Add(-def)
	}
	if !to.After(from) {
		return time.Time{}, time.Time{}, fmt.Errorf("ledgerd: --from (%s) must be before --to (%s)",
			from.Format(time.RFC3339), to.Format(time.RFC3339))
	}
	return from, to, nil
}

func writeJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return fmt.Errorf("ledgerd: write report: %w", err)
	}
	return nil
}

// printAccounting prints the equation, term by term, in the order it is
// asserted. The blind spots are printed WITH it and not as an appendix: a report
// that says "unaccounted: 0" without saying what it cannot see is claiming
// something stronger than the receiver can support.
func printAccounting(a verify.Report) {
	fmt.Printf("mail accounting %s .. %s\n",
		a.From.UTC().Format(time.RFC3339), a.To.UTC().Format(time.RFC3339))
	fmt.Printf("  inbound_total (delivery attempts)  %d\n", a.InboundTotal)
	fmt.Printf("  distinct messages                  %d\n", a.InboundIdentities)
	for _, o := range verify.ArrivalOutcomes {
		fmt.Printf("    %-28s  %d\n", o, a.Arrival[o])
	}
	fmt.Printf("    %-28s  %d\n", "unaccounted", a.Unaccounted)
	fmt.Printf("  = %d (parts) + %d (unaccounted) = %d\n",
		a.ArrivalSum(), a.Unaccounted, a.ArrivalSum()+a.Unaccounted)

	fmt.Printf("  reprocess (never folded in)     %d\n", a.ReprocessSum())
	for _, o := range verify.ReprocessOutcomes {
		fmt.Printf("    %-28s  %d\n", o, a.Reprocess[o])
	}
	fmt.Printf("  protocol rejections (%s..%s)  %d\n",
		a.RejectionDays[0], a.RejectionDays[1], a.ProtocolRejectionsTotal())
	for _, r := range sortedCounts(a.ProtocolRejections) {
		fmt.Printf("    %-28s  %d\n", r.name, r.n)
	}
	fmt.Printf("  discarded duplicates            %d  (refused as already-held, held nowhere)\n",
		a.Discarded)
	q := a.Quarantine
	fmt.Printf("  quarantine (all time)           expected %d = held %d + expired %d + promoted %d "+
		"(distinct %d)\n", q.Expected, q.Held, q.Expired, q.Promoted, q.Accounted)
	fmt.Printf("    untraced %d (lost), extra %d (held with no diagnostics row)\n",
		q.Untraced, q.Extra)

	fmt.Println("  what this report CANNOT see:")
	for _, b := range a.BlindSpots {
		fmt.Printf("    [%s] %s: %s\n", b.Direction, b.ID, b.Reason)
	}
}

type namedCount struct {
	name string
	n    int64
}

func sortedCounts(m map[string]int64) []namedCount {
	out := make([]namedCount, 0, len(m))
	for k, v := range m {
		out = append(out, namedCount{k, v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func printFindings(f []verify.Finding) {
	if len(f) == 0 {
		fmt.Println("verify: no findings")
		return
	}
	fmt.Printf("verify: %d finding(s)\n", len(f))
	for _, x := range f {
		if x.UserID == uuid.Nil {
			fmt.Printf("  %-24s %s\n", x.ID, x.Detail)
			continue
		}
		fmt.Printf("  %-24s user %s: %s\n", x.ID, x.UserID, x.Detail)
	}
}

// runParseRate reports spec §5's ≥95% parse-rate exit criterion, and — with
// --adjudicate — collects the judgements that make the denominator exist at all.
//
// # Why this command has two halves
//
// The numerator is a query. The denominator is not: parse_diagnostics stores no
// content, so nothing in the schema knows whether an unparsed message was a bank
// alert or a newsletter. Without adjudication the report REFUSES to print a
// rate and names the messages it is waiting on, which is the honest answer and
// not a limitation to be worked around.
//
// # ⚠ PHASE 1 ONLY, and --adjudicate is why
//
// Judging a message means reading it. The reporting half reads no content; the
// adjudication half reads plaintext cold bodies, which is item 4 of
// docs/superpowers/specs/v2-phase1-only-inventory.md and is impossible from
// Phase 3 on. It is opt-in behind its own flag and prints a banner, so reading a
// user's mail can never be a side effect of asking for a number.
func runParseRate(cfg config.Config) error {
	if cfg.Verify.User != "" {
		if _, err := verifyTargets(cfg.Verify.User); err != nil {
			return err
		}
	}
	from, to, err := verifyWindow(cfg.Verify, verifyDefaultWindow)
	if err != nil {
		return err
	}
	opts := verify.ParseRateOptions{From: from, To: to, Sample: cfg.Verify.Sample}
	if cfg.Verify.User != "" {
		opts.User = uuid.MustParse(cfg.Verify.User)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd parse-rate: open postgres: %w", err)
	}
	defer pool.Close()
	// Migrate here, unlike runVerify: this command WRITES, to a table
	// (parse_rate_adjudications) that a database migrated before Task 36 does
	// not have. Same clean no-op as every other subcommand when it is already
	// up to date.
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd parse-rate: migrate: %w", err)
	}

	rep, err := verify.ParseRate(ctx, pool, opts)
	if errors.Is(err, verify.ErrUnadjudicated) && cfg.Verify.Adjudicate {
		if err := adjudicatePending(ctx, pool, rep.Pending); err != nil {
			return err
		}
		rep, err = verify.ParseRate(ctx, pool, opts)
	}
	switch {
	case errors.Is(err, verify.ErrUnadjudicated):
		printParseRate(rep, cfg.Verify.JSON)
		return fmt.Errorf("ledgerd parse-rate: %d message(s) still need a verdict; "+
			"run again with --adjudicate", len(rep.Pending))
	case err != nil:
		return fmt.Errorf("ledgerd parse-rate: %w", err)
	}
	printParseRate(rep, cfg.Verify.JSON)
	return nil
}

func printParseRate(rep verify.ParseRateReport, asJSON bool) {
	if asJSON {
		_ = writeJSON(rep)
		return
	}
	fmt.Printf("parse rate %s .. %s\n",
		rep.From.UTC().Format(time.RFC3339), rep.To.UTC().Format(time.RFC3339))
	fmt.Printf("  parsed (numerator)       %d  (template %d, heuristic %d)\n",
		rep.Parsed, rep.ByTier["template"], rep.ByTier["heuristic"])
	fmt.Printf("  unparsed population      %d\n", rep.Unparsed)
	fmt.Printf("  adjudicated              %d  (transaction %d, non-transactional %d, unreadable %d)\n",
		rep.Adjudicated, rep.Transaction, rep.NonTransactional, rep.Unreadable)
	for _, e := range sortedCounts(rep.Excluded) {
		fmt.Printf("    excluded %-14s %d\n", e.name, e.n)
	}
	if !rep.HasRate {
		fmt.Printf("  NO RATE: %d message(s) await a verdict. The denominator is a judgement, "+
			"not a query.\n", len(rep.Pending))
		return
	}
	if rep.Sampled {
		fmt.Printf("  rate (point estimate)    %.2f%%  [SAMPLED]\n", rep.Rate*100)
		fmt.Printf("  Wilson 95%% lower bound   %.2f%%  <- THIS is the gate\n", rep.LowerBound*100)
	} else {
		fmt.Printf("  rate                     %.2f%%  (whole population adjudicated, no sampling error)\n",
			rep.Rate*100)
	}
	fmt.Printf("  exit gate (>= %.0f%%)       %v\n", verify.GateThreshold*100, rep.MeetsGate())
	fmt.Printf("  NOTE: %s\n", verify.ParseRateCaveat)
}

// adjudicatePending is the interactive pass. One scan of each user's cold
// stream per batch, then one prompt per message.
//
// ⚠ PHASE 1 ONLY. This function is the reason internal/v2/verify's "reads no
// content" rule has an exception, and it is deleted at the Phase 3 cutover.
func adjudicatePending(ctx context.Context, pool *pgxpool.Pool, pending []verify.Pending) error {
	fmt.Println("=====================================================================")
	fmt.Println(" ⚠  PHASE 1 ONLY: the next screens show the CONTENT of users' mail.")
	fmt.Println(" This is possible only because Phase 1 stores cold bodies in plaintext.")
	fmt.Println(" It is disclosed in the alpha consent document; do not screenshot it,")
	fmt.Println(" and do not paste any of it into a bug report or a template.")
	fmt.Println("=====================================================================")

	byUser := map[uuid.UUID][][]byte{}
	for _, p := range pending {
		byUser[p.UserID] = append(byUser[p.UserID], p.IngestID)
	}
	texts := map[uuid.UUID]map[string]string{}
	for u, idsFor := range byUser {
		got, err := verify.ColdTexts(ctx, pool, nil, u, idsFor)
		if err != nil {
			return fmt.Errorf("ledgerd parse-rate: %w", err)
		}
		texts[u] = got
	}

	in := bufio.NewReader(os.Stdin)
	for i, p := range pending {
		hexID := fmt.Sprintf("%x", p.IngestID)
		fmt.Printf("\n--- %d/%d  user %s  ingest %s  from %s  received %s\n",
			i+1, len(pending), p.UserID, hexID[:12], p.SenderDomain,
			p.ReceivedAt.UTC().Format(time.RFC3339))
		body, ok := texts[p.UserID][hexID]
		if !ok {
			// No body recovered. Recorded as 'unreadable' WITHOUT asking: there
			// is nothing for the operator to look at, and leaving it unjudged
			// would make the tool ask for it again forever.
			fmt.Println("(the cold body could not be read; recorded as unreadable)")
			if err := verify.RecordVerdict(ctx, pool, p.UserID, p.IngestID, verify.VerdictUnreadable); err != nil {
				return fmt.Errorf("ledgerd parse-rate: %w", err)
			}
			continue
		}
		fmt.Println(clipBody(body))
		v, err := askVerdict(in)
		if err != nil {
			return err
		}
		if v == "" {
			fmt.Println("stopping; verdicts recorded so far are kept")
			return nil
		}
		if err := verify.RecordVerdict(ctx, pool, p.UserID, p.IngestID, v); err != nil {
			return fmt.Errorf("ledgerd parse-rate: %w", err)
		}
	}
	return nil
}

// maxAdjudicationBody bounds what is printed. Deciding "was this a transaction"
// takes the first screen; dumping a 300 KB marketing mail into a terminal buys
// nothing and scrolls the question off the top.
const maxAdjudicationBody = 4000

func clipBody(s string) string {
	if len(s) <= maxAdjudicationBody {
		return s
	}
	return s[:maxAdjudicationBody] + "\n… (truncated)"
}

// askVerdict reads one keystroke-ish answer. It returns "" when the operator
// wants to stop, and it LOOPS on anything it does not understand rather than
// guessing — a mistyped verdict is a permanent wrong number in the exit
// measurement.
func askVerdict(in *bufio.Reader) (string, error) {
	for {
		fmt.Print("[t]ransaction / [n]ot transactional / [u]nreadable / [q]uit: ")
		line, err := in.ReadString('\n')
		if err != nil && line == "" {
			// EOF with nothing typed: a non-interactive stdin. Stop rather than
			// spin, and keep what was already recorded.
			fmt.Println()
			return "", nil
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "t", "transaction":
			return verify.VerdictTransaction, nil
		case "n", "non_transactional":
			return verify.VerdictNonTransactional, nil
		case "u", "unreadable":
			return verify.VerdictUnreadable, nil
		case "q", "quit":
			return "", nil
		}
	}
}
