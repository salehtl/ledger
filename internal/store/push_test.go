package store

import (
	"testing"
)

func TestInsertAndSelectPushSub(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	err = st.InsertPushSub(PushSubRow{
		Endpoint: "https://push.example.com/12345",
		P256dh:   "key_p256dh",
		Auth:     "key_auth",
	})
	if err != nil {
		t.Fatalf("InsertPushSub: %v", err)
	}

	subs, err := st.SelectPushSubs()
	if err != nil {
		t.Fatalf("SelectPushSubs: %v", err)
	}
	if len(subs) != 1 {
		t.Fatalf("got %d subs, want 1", len(subs))
	}
	if subs[0].Endpoint != "https://push.example.com/12345" {
		t.Errorf("endpoint = %q", subs[0].Endpoint)
	}
}

func TestInsertPushSub_Idempotent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	sub := PushSubRow{Endpoint: "https://push.example.com/abc", P256dh: "k", Auth: "a"}
	if err := st.InsertPushSub(sub); err != nil {
		t.Fatal(err)
	}
	// INSERT OR REPLACE: second call updates (upsert) — should not error
	if err := st.InsertPushSub(sub); err != nil {
		t.Fatalf("second InsertPushSub: %v", err)
	}
	subs, _ := st.SelectPushSubs()
	if len(subs) != 1 {
		t.Errorf("got %d subs after upsert, want 1", len(subs))
	}
}

func TestDeletePushSub(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	_ = st.InsertPushSub(PushSubRow{Endpoint: "https://push.example.com/del", P256dh: "k", Auth: "a"})
	if err := st.DeletePushSub("https://push.example.com/del"); err != nil {
		t.Fatal(err)
	}
	subs, _ := st.SelectPushSubs()
	if len(subs) != 0 {
		t.Errorf("got %d subs after delete, want 0", len(subs))
	}
}

// A push service that answered 404/410 has killed the endpoint for good. The
// store must remember that, so a client re-sync cannot quietly bring it back.
func TestPrunePushSubRemembersGoneEndpoint(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	const ep = "https://push.example.com/dead"
	if err := st.InsertPushSub(PushSubRow{Endpoint: ep, P256dh: "p", Auth: "a"}); err != nil {
		t.Fatal(err)
	}
	if gone, err := st.PushSubGone(ep); err != nil || gone {
		t.Fatalf("before prune: gone=%v err=%v, want false nil", gone, err)
	}
	if err := st.PrunePushSub(ep); err != nil {
		t.Fatal(err)
	}
	if subs, _ := st.SelectPushSubs(); len(subs) != 0 {
		t.Errorf("prune left %d subs, want 0", len(subs))
	}
	if gone, err := st.PushSubGone(ep); err != nil || !gone {
		t.Errorf("after prune: gone=%v err=%v, want true nil", gone, err)
	}
}

// Tapping Enable is the explicit path: it always registers, and clears the
// gone mark for that endpoint.
func TestInsertPushSubClearsGoneMark(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	const ep = "https://push.example.com/back"
	_ = st.InsertPushSub(PushSubRow{Endpoint: ep, P256dh: "p", Auth: "a"})
	if err := st.PrunePushSub(ep); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertPushSub(PushSubRow{Endpoint: ep, P256dh: "p2", Auth: "a2"}); err != nil {
		t.Fatal(err)
	}
	if gone, _ := st.PushSubGone(ep); gone {
		t.Error("an explicit subscribe must clear the gone mark")
	}
	if subs, _ := st.SelectPushSubs(); len(subs) != 1 {
		t.Errorf("got %d subs, want 1", len(subs))
	}
}
