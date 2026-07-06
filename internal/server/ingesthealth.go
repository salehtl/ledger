package server

import (
	"time"

	"ledger/internal/ingest"
)

// IngestHealthFunc returns the ingest worker's current poll-health snapshot.
type IngestHealthFunc func() ingest.HealthSnapshot

// SetIngestHealth wires the worker's health snapshot into /api/health.
func (s *Server) SetIngestHealth(fn IngestHealthFunc) { s.ingestHealthFn = fn }

// Reason keys reported for a warn status. The PWA switches copy on these.
const (
	reasonPollsFailing = "polls_failing"
	reasonPollStale    = "poll_stale"
	reasonMailSilent   = "mail_silent"
)

// deriveIngestStatus turns the worker snapshot + mail recency into the
// verdict the PWA renders. Pure: table-tested without HTTP.
//
//   - polls_failing: ≥3 consecutive failures and no success in 15 min
//     (or no success ever) — IMAP auth/network is broken.
//   - poll_stale: no successful poll in max(3×interval, 5 min); anchors on
//     worker start when no poll ever succeeded (covers a hung first poll).
//   - mail_silent: polls fine but no email in silenceDays days — catches a
//     broken auto-forward rule. Never fires before the first email ever.
func deriveIngestStatus(snap ingest.HealthSnapshot, lastMailAt time.Time, haveMail bool, silenceDays int, now time.Time) (string, []string) {
	reasons := []string{}

	window := 3 * snap.Interval
	if window < 5*time.Minute {
		window = 5 * time.Minute
	}

	if snap.LastAttemptAt.IsZero() && now.Sub(snap.StartedAt) <= window {
		return "starting", reasons
	}

	if snap.ConsecutiveFailures >= 3 &&
		(snap.LastSuccessAt.IsZero() || now.Sub(snap.LastSuccessAt) > 15*time.Minute) {
		reasons = append(reasons, reasonPollsFailing)
	}

	anchor := snap.LastSuccessAt
	if anchor.IsZero() {
		anchor = snap.StartedAt
	}
	if now.Sub(anchor) > window {
		reasons = append(reasons, reasonPollStale)
	}

	if haveMail && now.Sub(lastMailAt) > time.Duration(silenceDays)*24*time.Hour {
		reasons = append(reasons, reasonMailSilent)
	}

	if len(reasons) > 0 {
		return "warn", reasons
	}
	return "ok", reasons
}
