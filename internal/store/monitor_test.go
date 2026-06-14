package store

import (
	"fmt"
	"testing"
	"time"
)

func TestSelectDriftStats_EmptyDB(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	stats, err := st.SelectDriftStats(time.Now().Add(-7*24*time.Hour), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 0 {
		t.Errorf("got %d stats, want 0", len(stats))
	}
}

func TestSelectDriftStats_ComputesRate(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now()
	statuses := []string{"parsed", "parsed", "parsed", "unparsed"}
	for i, status := range statuses {
		if _, err := st.InsertIngest(IngestRecord{
			MessageUID:  fmt.Sprintf("uid-%d", i),
			FromAddr:    "alerts@bank.com",
			Subject:     "txn",
			ParseStatus: status,
			RawBody:     []byte("body"),
			CreatedAt:   now,
		}); err != nil {
			t.Fatal(err)
		}
	}

	stats, err := st.SelectDriftStats(now.Add(-time.Hour), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 {
		t.Fatalf("got %d stats, want 1", len(stats))
	}
	if stats[0].FromAddr != "alerts@bank.com" {
		t.Errorf("from_addr = %q, want alerts@bank.com", stats[0].FromAddr)
	}
	if stats[0].Total != 4 {
		t.Errorf("total = %d, want 4", stats[0].Total)
	}
	if stats[0].Parsed != 3 {
		t.Errorf("parsed = %d, want 3", stats[0].Parsed)
	}
	if got := stats[0].SuccessRate(); got < 0.74 || got > 0.76 {
		t.Errorf("success rate = %.2f, want 0.75", got)
	}
}

func TestSelectDriftStats_FiltersMinVolume(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now()
	// Only 1 email — below minVolume of 2
	if _, err := st.InsertIngest(IngestRecord{
		MessageUID: "uid-1", FromAddr: "rare@bank.com",
		Subject: "txn", ParseStatus: "unparsed",
		RawBody: []byte("body"), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	stats, err := st.SelectDriftStats(now.Add(-time.Hour), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 0 {
		t.Errorf("got %d stats with minVolume=2, want 0", len(stats))
	}
}
