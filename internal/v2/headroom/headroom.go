// Package headroom is the box-level fuse: one goroutine that watches free disk
// space and, below a reserved floor, refuses ALL durable writes while reads
// keep serving.
//
// It is P4 of docs/superpowers/specs/2026-08-09-account-isolation-design.md.
// Per-account budgets multiplied by the number of accounts can still exceed the
// disk, and Postgres has no native per-role storage quota, so something has to
// hold the last few gigabytes back. A full filesystem stops Postgres writing,
// which stops ingest and sync for EVERY user, and it is the one failure that an
// operator cannot fix quickly because the tools they would use — a backup, a
// dump, a log — all need space themselves.
//
// # What "all durable writes" includes, said here so it is never reported as a bug
//
// It includes CREATING A SESSION. While the fuse is tripped NOBODY CAN SIGN IN:
// a sign-in writes a session row, that row is a durable write, and the fuse
// makes no exception for it. That is deliberate and it is correct for an
// emergency state — the box is protecting its own ability to recover, and the
// alternative is a carve-out that grows one endpoint at a time until the fuse
// protects nothing. Devices that already hold a session keep READING (pull,
// hashes, listings), which is what makes the state survivable: a user's own data
// stays visible on the devices that have it.
//
// It follows that the operator's copy must say so. "Writes are paused while the
// server is out of disk space, and new sign-ins are paused with them" is the
// honest sentence; "the service is down" is not, and "sign in again" is worse,
// because it sends a user at the one door that cannot open.
//
// # Why a flag sampled on a timer, and not a check per write
//
// A statfs per request would put a syscall on every write path for a number that
// changes on the scale of minutes, and it would make the fuse's cost
// proportional to the traffic it is defending against. One sample every 30
// seconds costs nothing and is late by at most one interval — which is
// affordable precisely because the floor is 8 GB, not 8 MB. The floor is sized
// so that everything still running when the fuse trips (Postgres, its WAL, the
// operator's shell) has room to keep running and to be repaired.
//
// # This package does not start itself
//
// New returns a stopped fuse. Wiring — who calls Start, on which path, with
// which floor — belongs to cmd/ledgerd, and Tripped is what the API consults per
// request. That separation is what lets a test inject a floor and a sampler and
// never touch the real disk.
package headroom

import (
	"errors"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// DefaultFloor is the reserved space below which durable writes stop: 8 GB,
	// the design's number. It is not a guess about Postgres's working set — it
	// is the space an operator needs to have a chance: a database that can still
	// write its WAL, a `pg_dump` or a `.backup` that can land somewhere, and a
	// shell whose history and log files do not fail to write while they work.
	DefaultFloor uint64 = 8 << 30

	// DefaultInterval is how often free space is sampled. See the package doc:
	// the lag this admits is bounded by one interval, and the floor is three
	// orders of magnitude larger than anything one interval's writes can consume.
	DefaultInterval = 30 * time.Second
)

// Fuse holds the flag. The zero value is not usable; call New.
type Fuse struct {
	path     string
	floor    uint64
	interval time.Duration

	// Sample reports the bytes available to an unprivileged writer on path.
	// It defaults to the platform statfs and exists as a field ONLY so a test
	// can drive the fuse across its floor without a real disk to fill. A test
	// that measured the actual filesystem would pass or fail depending on how
	// much space the machine running it happened to have, which is the same as
	// not being a test at all.
	//
	// Read at Start and by Check; do not change it while the fuse is running.
	Sample func(path string) (avail uint64, err error)

	// Logf receives the reason the flag changed, and every sampling failure.
	// Defaults to log.Printf.
	Logf func(format string, args ...any)

	// tripped is the whole public state, and it is atomic because Tripped is on
	// the request path of every mutating route in the process.
	tripped atomic.Bool

	mu   sync.Mutex
	stop chan struct{}
	done chan struct{}
}

// New returns a fuse over path, tripping below floor bytes free, sampling every
// interval. Zero floor or interval take the defaults.
//
// The fuse starts UNTRIPPED and stays that way until the first sample says
// otherwise. That is fail-open at construction on purpose: the alternative — a
// process that refuses every write for its first 30 seconds, or forever if
// statfs is broken — is an outage caused by the thing that exists to prevent
// one. The fuse's job is to catch a slow fill, and a slow fill is never missed
// by one interval.
func New(path string, floor uint64, interval time.Duration) *Fuse {
	if floor == 0 {
		floor = DefaultFloor
	}
	if interval <= 0 {
		interval = DefaultInterval
	}
	return &Fuse{path: path, floor: floor, interval: interval, Sample: statfsAvail}
}

// Floor reports the reserved byte floor, for an operator surface that wants to
// say what the number is rather than repeat it.
func (f *Fuse) Floor() uint64 { return f.floor }

// Path reports the filesystem being watched.
func (f *Fuse) Path() string { return f.path }

// Tripped reports whether durable writes must be refused. It is a single atomic
// load: cheap enough to consult on every request, which is the point — a fuse
// nobody can afford to ask is not a fuse.
//
// A nil Fuse is never tripped, so an unwired field is an absent fuse rather than
// a panic, matching Limiter.Allow.
func (f *Fuse) Tripped() bool {
	if f == nil {
		return false
	}
	return f.tripped.Load()
}

// Check samples once and updates the flag, returning the sampling error if
// there was one. Start calls it on a ticker; a test calls it directly.
//
// # A failed sample does not change the flag
//
// If statfs fails there is no free-space number, and both available answers to
// that are wrong in a different direction: tripping would refuse every write on
// the box because of a transient stat error, and clearing would announce
// headroom nobody measured. So the previous state stands and the error is
// logged. That means the very first sample failing leaves the fuse open (see
// New), and a fuse that trips and then loses its sampler STAYS tripped — the
// safe direction for the state that matters.
func (f *Fuse) Check() error {
	sample := f.Sample
	if sample == nil {
		sample = statfsAvail
	}
	avail, err := sample(f.path)
	if err != nil {
		f.logf("headroom: statfs %s: %v (the fuse keeps its previous state: tripped=%v)",
			f.path, err, f.tripped.Load())
		return err
	}
	f.set(avail < f.floor, avail)
	return nil
}

// set applies the new state and logs only the TRANSITIONS. A line per sample
// would be a line every 30 seconds forever, which is how an operator learns to
// filter out the one message that mattered.
func (f *Fuse) set(tripped bool, avail uint64) {
	if was := f.tripped.Swap(tripped); was == tripped {
		return
	}
	if tripped {
		f.logf("headroom: TRIPPED: %s has %d bytes free, below the %d byte floor; "+
			"ALL durable writes are refused, INCLUDING SIGN-IN, until it clears. Reads keep serving.",
			f.path, avail, f.floor)
		return
	}
	f.logf("headroom: cleared: %s has %d bytes free, above the %d byte floor; writes resume.",
		f.path, avail, f.floor)
}

// Start samples immediately and then every interval until Stop. Calling it on a
// running fuse is a no-op, so a double-wire cannot produce two goroutines
// fighting over one flag.
//
// The first sample is synchronous, so a process that starts with a full disk is
// already refusing writes by the time it serves its first request rather than
// for the first interval.
func (f *Fuse) Start() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stop != nil {
		return
	}
	_ = f.Check()
	stop, done := make(chan struct{}), make(chan struct{})
	f.stop, f.done = stop, done
	go func() {
		defer close(done)
		t := time.NewTicker(f.interval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				_ = f.Check()
			}
		}
	}()
}

// Stop ends the sampling goroutine and waits for it. It leaves the flag where it
// was: stopping the watcher is not evidence that the disk recovered, and a
// shutdown path that silently re-opened the gate would be a lie told at the
// worst moment.
//
// Idempotent, and safe on a fuse that was never started.
func (f *Fuse) Stop() {
	f.mu.Lock()
	stop, done := f.stop, f.done
	f.stop, f.done = nil, nil
	f.mu.Unlock()
	if stop == nil {
		return
	}
	close(stop)
	<-done
}

func (f *Fuse) logf(format string, args ...any) {
	if f.Logf != nil {
		f.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

// errUnsupported is what the non-unix build of statfsAvail returns. It is a
// sampling failure like any other, so per Check the fuse keeps its state and
// says so once per interval rather than refusing every write on a platform this
// server does not run on anyway.
var errUnsupported = errors.New("headroom: free-space sampling is not implemented on this platform")
