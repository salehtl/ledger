package store

import "testing"

func TestAccountsCRUDAndOwnLast4s(t *testing.T) {
	st := newTestStore(t)

	id1, err := st.InsertAccount("DIB Current", "DIB", "1234")
	if err != nil {
		t.Fatalf("insert 1: %v", err)
	}
	if _, err := st.InsertAccount("ENBD Savings", "ENBD", "5678"); err != nil {
		t.Fatalf("insert 2: %v", err)
	}

	accs, err := st.SelectAccounts()
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(accs) != 2 {
		t.Fatalf("len(accounts) = %d, want 2", len(accs))
	}
	if accs[0].Name != "DIB Current" || accs[0].Last4 != "1234" || accs[0].Bank != "DIB" {
		t.Errorf("first account = %+v", accs[0])
	}

	own, err := st.OwnAccountLast4s()
	if err != nil {
		t.Fatalf("own last4s: %v", err)
	}
	if !own["1234"] || !own["5678"] || len(own) != 2 {
		t.Errorf("own set = %v, want {1234,5678}", own)
	}

	if err := st.DeleteAccount(id1); err != nil {
		t.Fatalf("delete: %v", err)
	}
	accs, _ = st.SelectAccounts()
	if len(accs) != 1 || accs[0].Last4 != "5678" {
		t.Errorf("after delete accounts = %+v, want only 5678", accs)
	}
}

func TestOwnAccountLast4sEmptyRegistry(t *testing.T) {
	st := newTestStore(t)
	own, err := st.OwnAccountLast4s()
	if err != nil {
		t.Fatalf("own last4s: %v", err)
	}
	if len(own) != 0 {
		t.Errorf("own set = %v, want empty", own)
	}
}
