package store

import "testing"

func TestAISuggestionRoundTrip(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	var catID int64
	var catName string
	if err := st.DB.QueryRow(`SELECT id, name FROM categories LIMIT 1`).Scan(&catID, &catName); err != nil {
		t.Fatal(err) // seeded by Open
	}
	if _, _, ok, err := st.GetAISuggestion("some cafe llc"); err != nil || ok {
		t.Fatalf("empty memo must miss: ok=%v err=%v", ok, err)
	}
	if err := st.PutAISuggestion("some cafe llc", catID, 0.7); err != nil {
		t.Fatal(err)
	}
	name, conf, ok, err := st.GetAISuggestion("some cafe llc")
	if err != nil || !ok || name != catName || conf != 0.7 {
		t.Fatalf("got %q %v %v %v, want %q 0.7 true nil", name, conf, ok, err, catName)
	}
	// Upsert overwrites.
	if err := st.PutAISuggestion("some cafe llc", catID, 0.9); err != nil {
		t.Fatal(err)
	}
	if _, conf, _, _ := st.GetAISuggestion("some cafe llc"); conf != 0.9 {
		t.Fatalf("upsert did not overwrite, conf=%v", conf)
	}
}
