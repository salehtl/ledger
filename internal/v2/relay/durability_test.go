package relay

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The durability protocol is the property this whole package exists for, and
// until this file existed none of it was asserted: dropping the directory
// fsync, dropping the file fsync and REVERSING the body/commit-record write
// order all left the suite green (adversarial review 2026-08-01, C3). The first
// two are invisible from userspace without a power cut; the third is not an
// fsync detail at all but a behavioural inversion, and it is the one that
// decides whether a crash costs a message.
//
// The two seams below (writeSpoolFile, syncSpoolDir) exist for exactly this
// file. See their declarations in relay.go.

// swapDurableWrites substitutes the two durable-write seams for one test.
func swapDurableWrites(t *testing.T, write func(string, []byte) error, sync func(string) error) {
	t.Helper()
	oldWrite, oldSync := writeSpoolFile, syncSpoolDir
	writeSpoolFile, syncSpoolDir = write, sync
	t.Cleanup(func() { writeSpoolFile, syncSpoolDir = oldWrite, oldSync })
}

// The order IS the protocol. The body lands first, the commit record second,
// and the directory entry naming both is fsynced last — so the only file a
// crash can leave behind alone is a BODY, which is an orphan the sender still
// holds. Write the commit record first and the same crash leaves a commit
// record with no body: a message the sender was told 250 for, which the drain
// can only set aside in rejected/ for ever.
func TestDeliverWritesTheBodyThenTheCommitRecordThenFsyncsTheDirectory(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")

	var steps []string
	swapDurableWrites(t,
		func(path string, data []byte) error {
			steps = append(steps, "write"+filepath.Ext(path))
			return writeSynced(path, data)
		},
		func(dir string) error {
			steps = append(steps, "fsyncdir")
			return syncDir(dir)
		})

	if err := f.deliver(rcpt, "Subject: order\r\n\r\nbody\r\n"); err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	want := []string{"write" + emlSuffix, "write" + metaSuffix, "fsyncdir"}
	if strings.Join(steps, ",") != strings.Join(want, ",") {
		t.Fatalf("Deliver performed %v, want %v.\n"+
			"The body must be durable BEFORE the commit record that promises it exists, and the "+
			"directory entry must be fsynced before Deliver returns — an SMTP 250 is a promise "+
			"about a power cut.", steps, want)
	}
}

// Every step of the protocol is load-bearing: if any of the three fails,
// Deliver must fail, because smtpd turns that into a temporary SMTP error and
// the sending MTA keeps the message. A step whose error was swallowed would be
// a 250 for a message that is not on disk.
func TestEveryDurabilityStepThatFailsRefusesTheMessage(t *testing.T) {
	for _, failAt := range []struct {
		name string
		step int
	}{
		{"the body", 0},
		{"the commit record", 1},
		{"the directory fsync", 2},
	} {
		t.Run(failAt.name, func(t *testing.T) {
			f := newFixture(t)
			rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")

			n := 0
			fail := func() bool {
				defer func() { n++ }()
				return n == failAt.step
			}
			swapDurableWrites(t,
				func(path string, data []byte) error {
					if fail() {
						return os.ErrInvalid
					}
					return writeSynced(path, data)
				},
				func(dir string) error {
					if fail() {
						return os.ErrInvalid
					}
					return syncDir(dir)
				})

			if err := f.deliver(rcpt, "Subject: x\r\n\r\nx\r\n"); err == nil {
				t.Fatal("Deliver returned nil though a durability step failed: " +
					"the 250 it produces would be a lie")
			}
		})
	}
}

// The crash this order is chosen for, played out. A power cut between the two
// writes leaves a body with no commit record — and that is a message the sender
// was NEVER told 250 for, so it still holds it. The relay neither forwards it
// (nothing says who it was for) nor deletes it nor rejects it: it is counted as
// Uncommitted and left alone.
//
// The converse — a commit record with no body — is what the REVERSED order
// would produce, and it is unrecoverable: the promise exists and the message
// does not, so the drain can only set it aside. Asserting both lanes is what
// makes the write order observable.
func TestACrashBetweenTheTwoWritesLeavesARecoverableOrphanNotARejection(t *testing.T) {
	t.Run("a body with no commit record is an untouched orphan", func(t *testing.T) {
		f := newFixture(t)
		rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")

		// Crash immediately after the body: the commit record never lands.
		n := 0
		swapDurableWrites(t,
			func(path string, data []byte) error {
				n++
				if n == 2 {
					return os.ErrInvalid
				}
				return writeSynced(path, data)
			}, syncDir)
		if err := f.deliver(rcpt, "Subject: crash\r\n\r\nhalf written\r\n"); err == nil {
			t.Fatal("Deliver returned nil after the commit record failed")
		}

		st, err := f.r.Stats()
		if err != nil {
			t.Fatal(err)
		}
		if st.Uncommitted != 1 || st.Spooled != 0 {
			t.Fatalf("Stats = %+v, want exactly one uncommitted body and nothing spooled", st)
		}
		sent, failed, err := f.r.Drain(bg)
		if sent != 0 || failed != 0 || err != nil {
			t.Fatalf("Drain over an orphan = (%d,%d,%v), want (0,0,nil)", sent, failed, err)
		}
		if got := f.names(rejectedDir); len(got) != 0 {
			t.Fatalf("an uncommitted orphan was rejected: %v. The sender still holds this "+
				"message; rejecting it would file a message nobody lost.", got)
		}
		if got := f.names("."); len(got) != 2 { // the replica and the orphan body
			t.Fatalf("spool holds %v, want the replica and the orphan body kept", got)
		}
		if !f.logged("no commit record") {
			t.Fatal("an uncommitted body was not reported to the operator")
		}
	})

	t.Run("a commit record with no body can only be set aside", func(t *testing.T) {
		f := newFixture(t)
		rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
		if err := f.deliver(rcpt, "Subject: gone\r\n\r\nbody\r\n"); err != nil {
			t.Fatal(err)
		}
		metas := f.spooled()
		if len(metas) != 1 {
			t.Fatalf("spooled = %v", metas)
		}
		id := strings.TrimSuffix(metas[0], metaSuffix)
		if err := os.Remove(filepath.Join(f.dir, id+emlSuffix)); err != nil {
			t.Fatal(err)
		}

		sent, failed, err := f.r.Drain(bg)
		if sent != 0 || failed != 1 || err != nil {
			t.Fatalf("Drain over a bodyless commit record = (%d,%d,%v), want (0,1,nil)",
				sent, failed, err)
		}
		if got := len(f.spooled()); got != 0 {
			t.Fatalf("%d still in the live spool: a commit record whose body is gone can never "+
				"be delivered and must not be retried for ever", got)
		}
		names := f.names(rejectedDir)
		if len(names) == 0 {
			t.Fatal("nothing in rejected/: the record was neither kept nor accounted for")
		}
		// And it is VISIBLE: a rejection with no body must still be counted, or
		// the alarm the operator watches under-reports the lane.
		st, err := f.r.Stats()
		if err != nil {
			t.Fatal(err)
		}
		if st.Rejected != 1 {
			t.Fatalf("Stats().Rejected = %d, want 1 — a message set aside BECAUSE its body was "+
				"unreadable is exactly the one an .eml-only count cannot see", st.Rejected)
		}
	})
}

// writeSynced's fsync is not decoration: it is the line between "the kernel has
// the bytes" and "the disk has them", and its failure is what stops an SMTP 250
// from being issued for a message that is not durable. Nothing exercised the
// error path, so removing f.Sync() entirely left the suite green.
//
// /dev/null is a character device: fsync(2) on it returns EINVAL on Linux,
// which is a deterministic way to make the real f.Sync() fail without a
// filesystem trick or a fault injector.
func TestWriteSyncedFailsWhenTheDataCannotBeFsynced(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("fsync on a character device is only known to be EINVAL on Linux")
	}
	err := writeSynced("/dev/null", []byte("bytes that will never be durable"))
	if err == nil {
		t.Fatal("writeSynced reported success for a write it could not fsync. " +
			"Deliver would then answer 250 for a message that is not durable.")
	}
	if !strings.Contains(err.Error(), "fsync") {
		t.Fatalf("writeSynced error = %v, want it to name the fsync that failed", err)
	}
}

// The zero value of outcome is documented as outcomeRetry precisely so that a
// path which forgets to set one KEEPS the message. Reordering the iota block
// would silently make "forgot to decide" mean "delivered" or "rejected".
func TestTheDefaultOutcomeKeepsTheMessage(t *testing.T) {
	var zero outcome
	if zero != outcomeRetry {
		t.Fatalf("the zero outcome is %v, want outcomeRetry: a path that forgets to set an "+
			"outcome must keep the message, never lose it", zero)
	}
}
