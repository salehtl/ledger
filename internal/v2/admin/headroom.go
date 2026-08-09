package admin

// headroom.go puts the box-level disk fuse on the console — P4 of
// docs/superpowers/specs/2026-08-09-account-isolation-design.md, whose one
// sentence about the operator surface is that a tripped fuse is "shown loudly on
// the admin console".
//
// A tripped fuse is the most consequential state this server can be in and the
// only one with NO user-visible explanation: below the floor every durable write
// is refused with a temporary error, INCLUDING SIGN-IN, while reads keep
// serving. To a user that looks like "the app works but nothing saves". The
// operator has to be able to see the cause, and the size of it, from the page
// they already have open.
//
// # It shows the number, not just the state
//
// "Tripped" alone is not actionable: an operator cannot tell whether the box is
// 1 MB or 30 GB below the floor, which is the difference between deleting a log
// file and moving the database. So the panel shows the floor, the free space and
// the shortfall, and an operator never has to open a shell to size the problem.
//
// # Operational data only, still
//
// Bytes free on a filesystem, a floor and a boolean. Nothing here is a
// transaction, an amount or a merchant, and nothing here becomes unreadable when
// Phase 3 seals the blobs — this panel keeps working unchanged after sealing,
// which is the test every console surface has to pass.
//
// # Why the free space is sampled per request rather than read off the fuse
//
// internal/v2/headroom keeps ONE atomic bool and no number: that is deliberate
// there, because Tripped() is consulted on every mutating request and a fuse
// nobody can afford to ask is not a fuse. So the console takes its own sample
// when an operator asks, which is at most a few statfs calls a minute on a
// tailnet-only listener.
//
// The two readings are therefore INDEPENDENT observations and can disagree for
// up to one sampling interval — the flag is what admission actually enforces,
// and the number is the fresher fact. The panel says which is which rather than
// hiding the difference, because an operator who has just freed 40 GB and still
// sees writes refused needs to know they are waiting on the next sample and not
// looking at a stuck server.

import (
	"net/http"
)

// Headroom is the box-level disk fuse, as the console needs it.
//
// It is an interface rather than a *headroom.Fuse so this package does not
// import headroom, and — more usefully — so a test can trip a fuse, or break its
// sampler, without a filesystem to fill. cmd/ledgerd adapts the real fuse to it:
// Path, Floor and Tripped are the fuse's own accessors, and Free is a sample
// taken through the fuse's own sampler, so the console and the enforcement point
// are measuring the same filesystem by the same means.
type Headroom interface {
	// Path is the filesystem being watched.
	Path() string
	// Floor is the reserved byte floor below which durable writes are refused.
	Floor() uint64
	// Tripped is the flag the API and the SMTP receiver actually enforce.
	Tripped() bool
	// Free samples the bytes currently available on Path.
	//
	// It may fail, and a failure is NOT an emergency: statfs can return an error
	// while the fuse's last flag remains perfectly valid. The status reports the
	// flag either way and says the number is unavailable, which is the honest
	// pair — the alternative, inventing a zero, would render a healthy box as
	// catastrophically full.
	Free() (uint64, error)
}

// headroomStatus is the console's view of the fuse.
//
// Bytes rather than a formatted string: the page formats, and a JSON route that
// answered "6.1 GB" would be one nobody could compute against.
type headroomStatus struct {
	// Configured is false when this process has no fuse at all — a deployment
	// with the console mounted and the watcher unwired. It is reported rather
	// than omitted: "no fuse" and "fuse fine" look identical on a page that
	// leaves the field out, and they are opposite facts.
	Configured bool   `json:"configured"`
	Path       string `json:"path,omitempty"`
	FloorBytes int64  `json:"floor_bytes,omitempty"`
	// FreeBytes is null when the sample failed. See Headroom.Free.
	FreeBytes *int64 `json:"free_bytes"`
	// DeficitBytes is how far BELOW the floor the box is, and zero when it is
	// above or when the free space could not be measured. It exists so the page
	// does not do arithmetic on two numbers and get the sign wrong, and so the
	// one question a tripped fuse raises — how far — is answered by a field
	// rather than by an operator.
	DeficitBytes int64 `json:"deficit_bytes"`
	// Tripped is the enforced state. It is the fuse's own flag and NOT derived
	// from FreeBytes: the flag is what refuses writes, and a status that
	// recomputed it from a fresher sample would tell an operator writes were
	// flowing while they were being refused.
	Tripped bool `json:"tripped"`
	// SampleError is why FreeBytes is null: a path and an errno, never content.
	SampleError string `json:"sample_error,omitempty"`
}

// status is the console's box-level state. Read-only, and today that is the
// fuse.
//
// It is its own route rather than a field on the roster because the panel shows
// it on EVERY tab: a fuse that is only visible under "Accounts" is one an
// operator reading the mail tab at 3am does not see.
func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"headroom": h.headroomStatus()})
}

func (h *Handler) headroomStatus() headroomStatus {
	if h.Headroom == nil {
		return headroomStatus{}
	}
	floor := h.Headroom.Floor()
	out := headroomStatus{
		Configured: true,
		Path:       h.Headroom.Path(),
		FloorBytes: int64(floor),
		Tripped:    h.Headroom.Tripped(),
	}
	free, err := h.Headroom.Free()
	if err != nil {
		// The flag survives; only the number is missing. Logged as well as
		// reported, because a sampler that has stopped working means the fuse is
		// frozen at whatever it last saw — see headroom.Check.
		h.logf("admin: headroom: could not sample %s: %v", out.Path, err)
		out.SampleError = err.Error()
		return out
	}
	f := int64(free)
	out.FreeBytes = &f
	if free < floor {
		out.DeficitBytes = int64(floor - free)
	}
	return out
}
