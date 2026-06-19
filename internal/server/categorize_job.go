package server

import (
	"context"
	"encoding/json"
	"net/http"
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
	failed    int    // rows a genuine error left uncategorized this run
	errMsg    string // first genuine error seen this run (surfaced to the UI)
}

type recatOutcome struct {
	catID  int64
	status string
	ok     bool
	err    error // non-nil = genuine failure (benign misses carry ok=false, err=nil)
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
	j.failed = 0
	j.errMsg = ""
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
		processed, total, failed, errMsg := j.processed, j.total, j.failed, j.errMsg
		j.mu.Unlock()
		s.BroadcastEvent("categorize", map[string]any{"status": "idle", "processed": processed, "total": total, "failed": failed, "error": errMsg})
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
			catID, status, ok, err := s.recatFn(ctx, item.MerchantRaw)
			res = recatOutcome{catID: catID, status: status, ok: ok, err: err}
			cache[item.MerchantRaw] = res
		}
		if res.ok {
			_ = s.catStore.UpdateTransactionCategory(item.ID, res.catID, res.status)
		}
		j.mu.Lock()
		j.processed++
		if res.err != nil {
			// A genuine failure left this row uncategorized — count it and keep
			// the first message so the UI can tell the user what went wrong.
			j.failed++
			if j.errMsg == "" {
				j.errMsg = res.err.Error()
			}
		}
		processed, total, failed, errMsg := j.processed, j.total, j.failed, j.errMsg
		j.mu.Unlock()
		// Throttle progress to ~3/sec so the SSE stream isn't chatty.
		if time.Since(lastBroadcast) > 300*time.Millisecond {
			lastBroadcast = time.Now()
			s.BroadcastEvent("categorize", map[string]any{"status": "running", "processed": processed, "total": total, "failed": failed, "error": errMsg})
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

// categorizeStatus returns the current run state, including how many rows a
// genuine error left uncategorized and the first such error message. The failed
// count and message persist after the run ends (until the next run resets them)
// so the UI can show the outcome of the last run.
func (s *Server) categorizeStatus() (status string, processed, total, failed int, errMsg string) {
	j := &s.catJob
	j.mu.Lock()
	defer j.mu.Unlock()
	status = "idle"
	if j.running {
		status = "running"
	}
	return status, j.processed, j.total, j.failed, j.errMsg
}

type categorizeRunReq struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (s *Server) handleCategorizeRun(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil || s.recatFn == nil {
		http.Error(w, `{"error":"categorize unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req categorizeRunReq
	_ = json.NewDecoder(r.Body).Decode(&req) // empty/absent body = all time
	started, err := s.startCategorize(req.From, req.To)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if !started {
		http.Error(w, `{"error":"already running"}`, http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"started": true})
}

func (s *Server) handleCategorizeStop(w http.ResponseWriter, r *http.Request) {
	s.stopCategorize()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"stopped": true})
}

func (s *Server) handleCategorizeStatus(w http.ResponseWriter, r *http.Request) {
	status, processed, total, failed, errMsg := s.categorizeStatus()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": status, "processed": processed, "total": total, "failed": failed, "error": errMsg})
}
