package admin

// suspend.go is the operator's one lever between "this account is fine" and
// "purge it": P3 of
// docs/superpowers/specs/2026-08-09-account-isolation-design.md.
//
// Without it, the only response to an active abuser is deletion, which destroys
// both their data and the evidence of what they did — an irreversible answer to
// a question the operator has not finished asking. Suspension is reversible,
// and it is deliberately partial: a suspended account keeps READING (the API
// denies non-GET methods only) and mail for it is answered 452 at SMTP so it
// retries across a short pause instead of bouncing. See
// 00030_account_status.sql for the full statement of what the status means, and
// internal/v2/api/guards.go for the half that enforces it.
//
// # Why this is two endpoints and not a role system
//
// Authority here is NETWORK POSITION. This console is permanently tailnet-bound
// (config.CheckAdminBind refuses any other binding, twice) and every route is
// behind the operator token. "Who may suspend" is therefore already answered,
// and the design says outright that no role system is required. These two
// handlers write one column.
//
// # Why suspend and resume are separate routes rather than one PATCH
//
// The two are not symmetrical in consequence: one takes a person's writes away,
// the other gives them back. A single endpoint carrying the new state in a body
// makes them the same gesture and makes a wrong body a silent state change; two
// paths mean the URL in the operator's log says what was done.

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// statusActive and statusSuspended are the closed set users.status may hold,
// pinned by the CHECK constraint in 00030_account_status.sql. Named here rather
// than written inline so the UPDATE below cannot drift from the constraint by a
// typo that only production would notice.
const (
	statusActive    = "active"
	statusSuspended = "suspended"
)

// suspendAccount pauses an account's writes.
func (h *Handler) suspendAccount(w http.ResponseWriter, r *http.Request) {
	h.setAccountStatus(w, r, statusSuspended)
}

// resumeAccount restores them.
func (h *Handler) resumeAccount(w http.ResponseWriter, r *http.Request) {
	h.setAccountStatus(w, r, statusActive)
}

// setAccountStatus writes users.status and reports what the row now holds.
//
// It is idempotent: suspending a suspended account is a 200, not a conflict. An
// operator reaching for this at 3am should not have to care whether the click
// landed the first time, and a 409 would make the recovery path — "press it
// again" — the failing one.
func (h *Handler) setAccountStatus(w http.ResponseWriter, r *http.Request, status string) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "account id must be a uuid")
		return
	}
	// RETURNING is what tells a missing account apart from a no-op update. A
	// bare UPDATE reporting zero rows cannot: it means either "no such account"
	// or "the row was already in that state", and answering 404 for the second
	// would tell an operator their account had vanished.
	var now string
	err = h.Diag.Pool.QueryRow(r.Context(),
		`UPDATE users SET status = $2 WHERE id = $1 RETURNING status`, id, status).Scan(&now)
	if err != nil {
		// pgx returns ErrNoRows from Scan when the UPDATE matched nothing, and
		// there is exactly one way for that to happen here: no such user.
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "no such account")
			return
		}
		h.logf("admin: set status %s for %s: %v", status, id, err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Logged at operator volume, like the donated-sample retirement: this
	// changes what a real person's devices are allowed to do, and the console
	// keeps no audit table of its own (00030's header explains why a reason
	// column was refused), so the process log is the record.
	if status == statusSuspended {
		h.logf("admin: SUSPENDED account %s: writes and inbound mail are refused; reads still serve", id)
	} else {
		h.logf("admin: RESUMED account %s: writes and inbound mail are accepted again", id)
	}
	writeJSON(w, http.StatusOK, map[string]any{"user_id": id, "status": now})
}
