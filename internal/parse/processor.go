package parse

import (
	"context"
	"strings"
	"time"

	"ledger/internal/categorize"
	"ledger/internal/store"
)

// Processor runs the cascade over ingest_log rows and persists results.
// If a provider is installed via SetCategorizerProvider, categorization runs
// immediately after each successful extraction.
type Processor struct {
	store    *store.Store
	cascade  *Cascade
	provider func(ctx context.Context) (*categorize.Categorizer, bool)
	onInsert func(txID, amountFils int64, merchant, direction string)
}

func NewProcessor(st *store.Store, c *Cascade) *Processor {
	return &Processor{store: st, cascade: c}
}

// SetCategorizerProvider installs a per-batch categorizer resolver. The bool it
// returns is whether auto-categorization is enabled; false skips it entirely.
func (p *Processor) SetCategorizerProvider(f func(ctx context.Context) (*categorize.Categorizer, bool)) {
	p.provider = f
}

// resolveCategorizer returns the categorizer for this batch and whether to run it.
// Categorization is skipped (false) when no provider is installed.
func (p *Processor) resolveCategorizer(ctx context.Context) (*categorize.Categorizer, bool) {
	if p.provider != nil {
		return p.provider(ctx)
	}
	return nil, false
}

// SetOnInsert registers a callback invoked after each successful transaction
// insert. Used by main.go to broadcast SSE events.
func (p *Processor) SetOnInsert(fn func(txID, amountFils int64, merchant, direction string)) {
	p.onInsert = fn
}

// ProcessPending selects ingest rows per opts, runs the cascade over each, writes
// a transaction when extracted, and stamps ingest_log. Returns the count of rows
// that produced a transaction.
func (p *Processor) ProcessPending(ctx context.Context, opts store.SelectForParseOpts) (int, error) {
	rows, err := p.store.SelectForParse(opts)
	if err != nil {
		return 0, err
	}
	cz, autoCat := p.resolveCategorizer(ctx)
	// Per-batch merchant→result cache: the categorizer's rule snapshot predates
	// this batch's write-backs, so without it a merchant seen twice would hit
	// the AI twice and write two identical rules.
	catCache := make(map[string]categorize.Result)
	created := 0
	for _, row := range rows {
		text, berr := BodyText(row.RawBody)
		if berr != nil {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", berr.Error())
			continue
		}
		// Recover the original sender/subject and drop the forwarding preamble
		// for inline-forwarded bank mail; a non-forward passes through unchanged.
		from, subject, fwdDate, text := Unwrap(row.FromAddr, row.Subject, text)
		// posted_at fallback for templates whose format has no body date: the
		// forwarded Date header (transaction time even for late forwards),
		// else the mailbox arrival time.
		fallback := row.ReceivedAt
		if fd, err := ParseForwardDate(fwdDate); err == nil {
			fallback = fd
		}
		// A low_confidence row was already extracted by the AI tier once —
		// re-running AI would just re-bill for the same guess. Reprocess exists
		// so a *fixed deterministic parser* can upgrade the row; run the cascade
		// without its AI tier for those rows.
		casc := p.cascade
		if row.ParseStatus == StatusLowConfidence {
			c := *p.cascade
			c.AI = nil
			casc = &c
		}
		res := casc.Run(ctx, from, subject, text, fallback)
		if res.Status == StatusUnparsed {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", res.Err)
			continue
		}
		if res.Status == StatusIgnored {
			// A recognized non-transactional email: no transaction, and the raw
			// body stays in ingest_log (never deleted). SelectForParse only picks
			// up unparsed/low_confidence rows, so this status is never revisited.
			_ = p.store.MarkParsed(row.ID, StatusIgnored, res.Tier, "")
			continue
		}
		// One email must never yield two transactions. The fingerprint index
		// won't dedup a re-parse whose extracted text drifted (a fixed template
		// vs the earlier AI wording), so a row that already produced a
		// transaction only refreshes its parse stamp.
		if _, exists, xerr := p.store.TransactionIDByIngest(row.ID); xerr != nil {
			return created, xerr
		} else if exists {
			if err := p.store.MarkParsed(row.ID, res.Status, res.Tier, ""); err != nil {
				return created, err
			}
			continue
		}
		txStatus := "needs_review"
		if res.Txn.IsTransfer {
			txStatus = "transfer"
		}
		txID, inserted, ierr := p.store.InsertTransaction(store.TransactionRow{
			PostedAt:    res.Txn.PostedAt,
			AmountFils:  res.Txn.AmountFils,
			Currency:    res.Txn.Currency,
			Direction:   res.Txn.Direction,
			MerchantRaw: res.Txn.MerchantRaw,
			Last4:       res.Txn.Last4,
			Status:      txStatus,
			Confidence:  res.Txn.Confidence,
			IngestID:    row.ID,
		})
		if ierr != nil {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", ierr.Error())
			continue
		}
		if inserted {
			created++
			// Never categorize a parser-flagged transfer: UpdateTransactionCategory
			// rewrites status, which would flip the leg to confirmed/needs_review
			// and count it as spending.
			if autoCat && cz != nil && txStatus != "transfer" {
				p.categorizeWith(ctx, cz, catCache, txID, res.Txn.MerchantRaw, res.Tier)
			}
			// Net the opposite transfer leg within 2 hours — regardless of which
			// leg arrived first. A parser-flagged transfer (IsTransfer) still has
			// to find and mark its counterpart, or the credit leg lingers in review.
			if matchID, found, _ := p.store.FindTransferMatch(store.TransferLeg{
				TxID:       txID,
				AmountFils: res.Txn.AmountFils,
				Currency:   res.Txn.Currency,
				Direction:  res.Txn.Direction,
				Last4:      res.Txn.Last4,
				PostedAt:   res.Txn.PostedAt,
			}, 2*time.Hour); found {
				_ = p.store.UpdateTransactionStatus(txID, "transfer")
				_ = p.store.UpdateTransactionStatus(matchID, "transfer")
			}
			if p.onInsert != nil {
				p.onInsert(txID, res.Txn.AmountFils, res.Txn.MerchantRaw, res.Txn.Direction)
			}
		}
		if err := p.store.MarkParsed(row.ID, res.Status, res.Tier, ""); err != nil {
			return created, err
		}
	}
	return created, nil
}

func (p *Processor) categorizeWith(ctx context.Context, cz *categorize.Categorizer, cache map[string]categorize.Result, txID int64, merchantRaw, tier string) {
	key := strings.ToLower(strings.TrimSpace(merchantRaw))
	if key == "" {
		// Nothing meaningful to classify; a blank merchant must never reach the
		// AI or produce a write-back rule.
		return
	}
	result, cached := cache[key]
	if !cached {
		var err error
		result, err = cz.Categorize(ctx, merchantRaw)
		if err != nil {
			// Unresolved (no rule match with AI disabled, or an AI failure) — leave
			// the transaction in review for the manual run / categorizer deck.
			return
		}
		cache[key] = result
		// Write-back happens once per merchant per batch; later cache hits for
		// the same merchant must not duplicate the rule.
		if result.ProposedRule != nil {
			_, _ = p.store.InsertRule(store.RuleRow{
				MatchType:  result.ProposedRule.MatchType,
				Pattern:    result.ProposedRule.Pattern,
				CategoryID: result.ProposedRule.CategoryID,
				Priority:   result.ProposedRule.Priority,
				Source:     "ai_confirmed",
			})
		}
	}
	// Only a template-tier extraction may be auto-confirmed. Heuristic and AI
	// tiers are guesses about amount/date/direction — a confident *category*
	// does not make the *extraction* trustworthy, so those stay in review with
	// the category attached.
	status := "needs_review"
	if result.AboveThreshold && tier == TierTemplate {
		status = "confirmed"
	}
	_ = p.store.UpdateTransactionCategory(txID, result.CategoryID, status)
}
