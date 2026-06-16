package server

import (
	"context"
	"sync"
	"time"

	"ledger/internal/store"
)

// categorizeJob is the single in-memory background categorization run. One run
// at a time; each transaction is committed as it's categorized, so a restart
// mid-run just leaves the rest in needs_review.
type categorizeJob struct {
	mu        sync.Mutex
	running   bool
	cancel    context.CancelFunc
	processed int
	total     int
}

type recatOutcome struct {
	catID  int64
	status string
	ok     bool
}

// startCategorize launches a run over needs_review transactions in [from,to]
// (empty bounds = all time). Returns false if a run is already in progress or
// categorization isn't wired.
func (s *Server) startCategorize(from, to string) (bool, error) {
	if s.catStore == nil || s.recatFn == nil {
		return false, nil
	}
	j := &s.catJob
	j.mu.Lock()
	if j.running {
		j.mu.Unlock()
		return false, nil
	}
	items, err := s.catStore.SelectTransactions("needs_review", from, to)
	if err != nil {
		j.mu.Unlock()
		return false, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	j.running = true
	j.cancel = cancel
	j.processed = 0
	j.total = len(items)
	j.mu.Unlock()

	go s.runCategorize(ctx, items)
	return true, nil
}

func (s *Server) runCategorize(ctx context.Context, items []store.ReviewItem) {
	j := &s.catJob
	defer func() {
		j.mu.Lock()
		j.running = false
		j.cancel = nil
		processed, total := j.processed, j.total
		j.mu.Unlock()
		s.BroadcastEvent("categorize", map[string]any{"status": "idle", "processed": processed, "total": total})
	}()

	// Dedupe by merchant: categorizing a given merchant is deterministic, so
	// call recatFn once per distinct merchant and apply to all matching rows.
	cache := make(map[string]recatOutcome)
	var lastBroadcast time.Time
	for _, item := range items {
		select {
		case <-ctx.Done():
			return
		default:
		}
		res, cached := cache[item.MerchantRaw]
		if !cached {
			catID, status, ok := s.recatFn(ctx, item.MerchantRaw)
			res = recatOutcome{catID: catID, status: status, ok: ok}
			cache[item.MerchantRaw] = res
		}
		if res.ok {
			_ = s.catStore.UpdateTransactionCategory(item.ID, res.catID, res.status)
		}
		j.mu.Lock()
		j.processed++
		processed, total := j.processed, j.total
		j.mu.Unlock()
		// Throttle progress to ~3/sec so the SSE stream isn't chatty.
		if time.Since(lastBroadcast) > 300*time.Millisecond {
			lastBroadcast = time.Now()
			s.BroadcastEvent("categorize", map[string]any{"status": "running", "processed": processed, "total": total})
		}
	}
}

// stopCategorize cancels the running job (this is both "pause" and "stop").
func (s *Server) stopCategorize() {
	j := &s.catJob
	j.mu.Lock()
	if j.cancel != nil {
		j.cancel()
	}
	j.mu.Unlock()
}

// categorizeStatus returns the current run state.
func (s *Server) categorizeStatus() (status string, processed, total int) {
	j := &s.catJob
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.running {
		return "running", j.processed, j.total
	}
	return "idle", j.processed, j.total
}
