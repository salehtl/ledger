package ingest

import (
	"context"
	"errors"
	"io"
	"log"
	"sync"
	"testing"
	"time"

	"ledger/internal/store"
)

// fakeMailbox is a scripted, in-memory Mailbox.
type fakeMailbox struct {
	mu          sync.Mutex
	uidValidity uint32
	messages    map[uint32]Message
	uids        []uint32
	fetchErr    error
	closed      bool
}

func (f *fakeMailbox) Examine(ctx context.Context) (uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.uidValidity, nil
}
func (f *fakeMailbox) ListUIDs(ctx context.Context) ([]uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]uint32(nil), f.uids...), nil
}
func (f *fakeMailbox) Fetch(ctx context.Context, uid uint32) (Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fetchErr != nil {
		return Message{}, f.fetchErr
	}
	return f.messages[uid], nil
}
func (f *fakeMailbox) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	return nil
}

func (f *fakeMailbox) addMessage(m Message) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages[m.UID] = m
	f.uids = append(f.uids, m.UID)
}

func (f *fakeMailbox) setFetchErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fetchErr = err
}

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
	mb.addMessage(msg(101, "c@bank.com"))
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

func TestRunStopsOnContextCancel(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, 10*time.Millisecond, quietLogger())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		w.Run(ctx)
		close(done)
	}()
	cancel()

	select {
	case <-done:
		// Run returned promptly after cancel.
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return within 2s of context cancel")
	}
}

func TestRunIngestsThenKeepsRunningOnError(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(42, msg(100, "a@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, 5*time.Millisecond, quietLogger())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)

	deadline := time.After(2 * time.Second)
	for {
		n, _ := st.CountIngest()
		if n >= 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("message was not ingested within 2s")
		case <-time.After(5 * time.Millisecond):
		}
	}
	mb.setFetchErr(errors.New("transient"))
	mb.addMessage(msg(101, "b@bank.com"))
	time.Sleep(30 * time.Millisecond)
	cancel()
}
