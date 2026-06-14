package ingest

import (
	"context"
	"errors"
	"io"
	"log"
	"testing"
	"time"

	"ledger/internal/store"
)

// fakeMailbox is a scripted, in-memory Mailbox.
type fakeMailbox struct {
	uidValidity uint32
	messages    map[uint32]Message
	uids        []uint32
	fetchErr    error
	closed      bool
}

func (f *fakeMailbox) Examine(ctx context.Context) (uint32, error) { return f.uidValidity, nil }
func (f *fakeMailbox) ListUIDs(ctx context.Context) ([]uint32, error) {
	return append([]uint32(nil), f.uids...), nil
}
func (f *fakeMailbox) Fetch(ctx context.Context, uid uint32) (Message, error) {
	if f.fetchErr != nil {
		return Message{}, f.fetchErr
	}
	return f.messages[uid], nil
}
func (f *fakeMailbox) Close() error { f.closed = true; return nil }

// fakeDialer hands out a fixed mailbox.
type fakeDialer struct {
	mb      *fakeMailbox
	dialErr error
}

func (d *fakeDialer) Dial(ctx context.Context) (Mailbox, error) {
	if d.dialErr != nil {
		return nil, d.dialErr
	}
	return d.mb, nil
}

func msg(uid uint32, from string) Message {
	return Message{
		UID:        uid,
		From:       from,
		Subject:    "Alert",
		ReceivedAt: time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC),
		Raw:        []byte("raw body for uid"),
	}
}

func mailboxWith(uidValidity uint32, msgs ...Message) *fakeMailbox {
	mb := &fakeMailbox{uidValidity: uidValidity, messages: map[uint32]Message{}}
	for _, m := range msgs {
		mb.messages[m.UID] = m
		mb.uids = append(mb.uids, m.UID)
	}
	return mb
}

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func quietLogger() *log.Logger { return log.New(io.Discard, "", 0) }

func TestSyncOnceInsertsAllMessages(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"), msg(101, "b@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, time.Minute, quietLogger())

	n, err := w.syncOnce(context.Background())
	if err != nil {
		t.Fatalf("syncOnce: %v", err)
	}
	if n != 2 {
		t.Errorf("inserted = %d, want 2", n)
	}
	count, _ := st.CountIngest()
	if count != 2 {
		t.Errorf("CountIngest = %d, want 2", count)
	}
	if !mb.closed {
		t.Error("expected mailbox to be closed after syncOnce")
	}
	known, _ := st.KnownUIDs()
	if _, ok := known["42-100"]; !ok {
		t.Errorf("expected key 42-100 in %v", known)
	}
}

func TestSyncOnceIsIdempotent(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"), msg(101, "b@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, time.Minute, quietLogger())

	if _, err := w.syncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	n, err := w.syncOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("second sync inserted = %d, want 0", n)
	}
}

func TestSyncOnceInsertsOnlyNew(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, time.Minute, quietLogger())
	if _, err := w.syncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	mb.messages[101] = msg(101, "c@bank.com")
	mb.uids = append(mb.uids, 101)
	n, err := w.syncOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("inserted = %d, want 1 (only the new message)", n)
	}
}

func TestSyncOnceFetchErrorPropagates(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"))
	mb.fetchErr = errors.New("boom")
	w := New(&fakeDialer{mb: mb}, st, time.Minute, quietLogger())
	if _, err := w.syncOnce(context.Background()); err == nil {
		t.Fatal("expected fetch error to propagate")
	}
}

func TestSyncOnceDialErrorPropagates(t *testing.T) {
	st := newTestStore(t)
	w := New(&fakeDialer{dialErr: errors.New("no net")}, st, time.Minute, quietLogger())
	if _, err := w.syncOnce(context.Background()); err == nil {
		t.Fatal("expected dial error to propagate")
	}
}
