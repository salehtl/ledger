package ingest

import (
	"context"
	"os"
	"testing"

	"ledger/internal/config"
)

// TestIMAPDialerLive exercises the real adapter against a real mailbox. It is
// skipped unless LEDGER_TEST_IMAP_HOST / _USERNAME / _APP_PASSWORD are set, so
// `go test ./...` stays hermetic in CI. Run on dinosaur to validate the adapter:
//
//	LEDGER_TEST_IMAP_HOST=imap.gmail.com \
//	LEDGER_TEST_IMAP_USERNAME=bankmail@gmail.com \
//	LEDGER_TEST_IMAP_APP_PASSWORD=xxxxxxxxxxxxxxxx \
//	go test ./internal/ingest/ -run TestIMAPDialerLive -v
func TestIMAPDialerLive(t *testing.T) {
	host := os.Getenv("LEDGER_TEST_IMAP_HOST")
	if host == "" {
		t.Skip("set LEDGER_TEST_IMAP_* to run the live IMAP adapter test")
	}
	cfg := config.IMAPConfig{
		Host:        host,
		Port:        993,
		Username:    os.Getenv("LEDGER_TEST_IMAP_USERNAME"),
		Auth:        "app_password",
		Folder:      "INBOX",
		ReadOnly:    true,
		AppPassword: os.Getenv("LEDGER_TEST_IMAP_APP_PASSWORD"),
	}
	d := NewIMAPDialer(cfg)
	mb, err := d.Dial(context.Background())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer mb.Close()

	if _, err := mb.Examine(context.Background()); err != nil {
		t.Fatalf("Examine: %v", err)
	}
	uids, err := mb.ListUIDs(context.Background())
	if err != nil {
		t.Fatalf("ListUIDs: %v", err)
	}
	t.Logf("mailbox has %d messages", len(uids))
	if len(uids) > 0 {
		m, err := mb.Fetch(context.Background(), uids[0])
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if len(m.Raw) == 0 {
			t.Error("fetched message has empty raw body")
		}
		t.Logf("first message: from=%q subject=%q bytes=%d", m.From, m.Subject, len(m.Raw))
	}
}
