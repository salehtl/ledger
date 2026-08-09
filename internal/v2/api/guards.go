package api

// guards.go holds the two admission checks that are about the ACCOUNT or the
// BOX rather than about one endpoint: suspension and the headroom fuse. They are
// P3 and P4 of docs/superpowers/specs/2026-08-09-account-isolation-design.md.
//
// Both live in one place on purpose. The design's principle is that "admission
// must fail closed against that account's budget — in one place, not per
// endpoint", because an endpoint check is the thing the next feature forgets.
// Suspension therefore sits in requireSession, which every session-authenticated
// route already passes through, and the fuse sits in a middleware wrapped around
// the whole mux, which even the UNAUTHENTICATED writes (sign-in, the passkey
// ceremonies) pass through.
//
// # The shape both checks share: reads keep working
//
// Neither check touches a GET. That is not leniency, it is the point:
//
//   - A suspended user's devices keep pulling their own history. A suspension
//     that also blanked the app would be indistinguishable, to the user, from
//     the operator having deleted them — and the operator's lever needs to be
//     reversible without a user first concluding their data is gone.
//   - A box out of disk keeps serving what it already stored. Reads cost no
//     durable bytes, and refusing them would convert a storage emergency into a
//     total outage for people who are not causing it.
//
// HEAD is treated as a read alongside GET: it is a GET whose body is discarded,
// and net/http answers one from a GET handler.

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Fuse is the box-level headroom fuse, as this package needs it.
//
// It is an interface rather than a *headroom.Fuse so that api does not import
// headroom — and, more usefully, so a test can trip the fuse without a
// filesystem. internal/v2/headroom's type satisfies it.
type Fuse interface {
	// Tripped reports whether durable writes must be refused. It is called on
	// every non-read request, so it must be cheap and must not block.
	Tripped() bool
}

// statusSuspended is the one non-active value users.status may hold
// (00030_account_status.sql pins the set with a CHECK constraint).
const statusSuspended = "suspended"

// isRead reports whether a method may proceed while the account is suspended or
// the fuse is tripped. See the file header.
func isRead(method string) bool {
	return method == http.MethodGet || method == http.MethodHead
}

// headroomGate refuses every non-read request while the fuse is tripped.
//
// It wraps the WHOLE mux rather than sitting inside requireSession, and that
// difference is the substance of the check: the writes that must stop include
// the ones that have no session yet. Signing in writes a session row, so while
// the fuse is tripped NOBODY CAN SIGN IN — deliberately, and stated in
// headroom's package doc so it is never filed as a bug. A carve-out for sign-in
// would grow one endpoint at a time until the fuse protected nothing.
//
// 503 with Retry-After, not 429 or 507: the condition is temporary, it is the
// SERVER's state and not the caller's fault, and a client must retry rather than
// treat its outbox as rejected. Nothing is lost — the device still holds every
// op it could not upload, which is what makes pausing writes survivable at all.
func (s *Server) headroomGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Headroom != nil && !isRead(r.Method) && s.Headroom.Tripped() {
			s.logf("api: %s %s: refused, the headroom fuse is tripped", r.Method, r.URL.Path)
			// A minute: long enough that a fleet of retrying clients does not
			// become its own load, short enough that writes resume promptly
			// once an operator frees space.
			w.Header().Set("Retry-After", "60")
			writeErr(w, http.StatusServiceUnavailable, "no_headroom",
				"the server is low on disk space and is not accepting writes; "+
					"your data is safe on this device and will upload when it resumes")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// accountSuspended reads users.status.
//
// It is a separate round trip rather than a join onto session resolution because
// session resolution lives in internal/v2/auth, which this task may not change,
// and because the cost is only paid where it buys something: requireSession
// calls this for NON-READ methods only, so the pull path — the one a suspended
// account keeps using, and the one every device hits constantly — is unchanged.
//
// A missing row is not possible in practice (the session resolved, and a deleted
// account is caught earlier by auth.ErrSessionAccountDeleted), but if it happens
// it is an error rather than "not suspended": a status that cannot be read is
// not evidence of permission.
func (s *Server) accountSuspended(ctx context.Context, userID uuid.UUID) (bool, error) {
	var status string
	err := s.Pool.QueryRow(ctx, `SELECT status FROM users WHERE id = $1`, userID).Scan(&status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, errors.New("api: no users row for a session that resolved")
		}
		return false, err
	}
	return status == statusSuspended, nil
}

// writeAccountSuspended is the ONE 403 account_suspended this package emits.
//
// A distinct code, not the generic "forbidden", because the client renders a
// different thing for it: "your account is paused" rather than an error that
// looks like a bug, and never a sign-out or a local wipe. The detail is written
// for a person, since unlike a 401 there is no oracle to worry about — the
// caller already holds this account's session and is being told a fact about
// their own account.
func writeAccountSuspended(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "account_suspended",
		"this account is paused, so changes are not being accepted; "+
			"your data is still here and still readable")
}
