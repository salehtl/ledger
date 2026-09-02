package store

import "testing"

func openFXTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestConvertToAEDFils(t *testing.T) {
	cases := []struct{ amount, rate, want int64 }{
		{1009, 3672500, 3706},  // USD 10.09 @ peg -> AED 37.06
		{100, 1000000, 100},    // identity rate
		{1, 3672500, 4},        // rounds half-up: 3.6725 -> 4
		{2412, 4300000, 10372}, // EUR 24.12 @ 4.30 -> AED 103.72 (103.716 rounds up)
	}
	for _, c := range cases {
		if got := ConvertToAEDFils(c.amount, c.rate); got != c.want {
			t.Errorf("ConvertToAEDFils(%d, %d) = %d, want %d", c.amount, c.rate, got, c.want)
		}
	}
}

func TestFXRateCRUDAndSeed(t *testing.T) {
	s := openFXTestStore(t)

	// USD peg is seeded on Open.
	rate, ok, err := s.RateMicroFor("USD")
	if err != nil || !ok || rate != 3672500 {
		t.Fatalf("seeded USD rate = %d, ok=%v, err=%v; want 3672500", rate, ok, err)
	}
	// AED is always identity without a table row.
	rate, ok, err = s.RateMicroFor("AED")
	if err != nil || !ok || rate != 1000000 {
		t.Fatalf("AED rate = %d, ok=%v, err=%v; want identity 1000000", rate, ok, err)
	}
	// Unknown currency: ok=false.
	if _, ok, _ := s.RateMicroFor("EUR"); ok {
		t.Fatal("EUR should have no rate yet")
	}

	if err := s.UpsertFXRate("EUR", 4300000); err != nil {
		t.Fatalf("UpsertFXRate: %v", err)
	}
	rates, err := s.SelectFXRates()
	if err != nil || len(rates) != 2 {
		t.Fatalf("SelectFXRates = %v, err=%v; want 2 rows", rates, err)
	}
	// Upsert overwrites.
	if err := s.UpsertFXRate("EUR", 4310000); err != nil {
		t.Fatalf("UpsertFXRate overwrite: %v", err)
	}
	rate, _, _ = s.RateMicroFor("EUR")
	if rate != 4310000 {
		t.Fatalf("EUR after overwrite = %d, want 4310000", rate)
	}
	if err := s.DeleteFXRate("EUR"); err != nil {
		t.Fatalf("DeleteFXRate: %v", err)
	}
	if _, ok, _ := s.RateMicroFor("EUR"); ok {
		t.Fatal("EUR should be gone after delete")
	}
}

func TestConvertUnconvertedBackfill(t *testing.T) {
	s := openFXTestStore(t)
	// Insert rows bypassing InsertTransaction so amount_aed stays NULL
	// (simulates pre-migration data).
	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := s.DB.Exec(q, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	const ins = `INSERT INTO transactions
	  (posted_at, amount, currency, direction, merchant_raw, status, fingerprint, source, created_at, updated_at)
	  VALUES (?, ?, ?, 'debit', 'm', 'confirmed', ?, 'email', '2026-07-01', '2026-07-01')`
	mustExec(ins, "2026-07-01T00:00:00Z", 5000, "AED", "fp-aed")
	mustExec(ins, "2026-07-01T00:00:00Z", 1009, "USD", "fp-usd")
	mustExec(ins, "2026-07-01T00:00:00Z", 2412, "EUR", "fp-eur")

	n, err := s.ConvertUnconverted()
	if err != nil {
		t.Fatalf("ConvertUnconverted: %v", err)
	}
	if n != 2 { // AED identity + USD via seeded peg; EUR has no rate
		t.Fatalf("converted %d rows, want 2", n)
	}
	var aed, usd int64
	var eur *int64
	row := func(fp string, dst any) {
		t.Helper()
		if err := s.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE fingerprint=?`, fp).Scan(dst); err != nil {
			t.Fatalf("select %s: %v", fp, err)
		}
	}
	row("fp-aed", &aed)
	row("fp-usd", &usd)
	row("fp-eur", &eur)
	if aed != 5000 || usd != 3706 || eur != nil {
		t.Fatalf("aed=%d usd=%d eur=%v; want 5000, 3706, nil", aed, usd, eur)
	}

	missing, err := s.UnconvertedCurrencies()
	if err != nil || len(missing) != 1 || missing[0] != "EUR" {
		t.Fatalf("UnconvertedCurrencies = %v, err=%v; want [EUR]", missing, err)
	}

	// Adding the missing rate then re-running backfills EUR.
	if err := s.UpsertFXRate("EUR", 4300000); err != nil {
		t.Fatalf("UpsertFXRate: %v", err)
	}
	if n, err := s.ConvertUnconverted(); err != nil || n != 1 {
		t.Fatalf("second ConvertUnconverted = %d, %v; want 1", n, err)
	}
	row("fp-eur", &eur)
	if eur == nil || *eur != 10372 {
		t.Fatalf("eur = %v, want 10372", eur)
	}
}

// A rate correction must reach the rows converted with the old rate. The
// snapshot is not dated (one rate per currency, no history), so "the rate
// was wrong" can only mean every row in that currency is wrong.
func TestReconvertCurrencyRewritesSnapshots(t *testing.T) {
	s := openFXTestStore(t)
	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := s.DB.Exec(q, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	const ins = `INSERT INTO transactions
	  (posted_at, amount, amount_aed, currency, direction, merchant_raw, status, fingerprint, source, created_at, updated_at)
	  VALUES (?, ?, ?, ?, 'debit', 'm', 'confirmed', ?, 'email', '2026-07-01', '2026-07-01')`
	// ZAR 30,000.00 snapshotted at a wrong rate (2.0 AED per ZAR).
	mustExec(ins, "2026-08-20T00:00:00Z", 3_000_000, 6_000_000, "ZAR", "fp-zar-1")
	mustExec(ins, "2026-08-21T00:00:00Z", 1_000, nil, "ZAR", "fp-zar-2") // never converted
	mustExec(ins, "2026-08-21T00:00:00Z", 1_009, 3_706, "USD", "fp-usd") // other currency: untouched

	// Correct rate: 0.2 AED per ZAR.
	if err := s.UpsertFXRate("ZAR", 200_000); err != nil {
		t.Fatalf("UpsertFXRate: %v", err)
	}
	n, err := s.ReconvertCurrency("ZAR", 200_000)
	if err != nil {
		t.Fatalf("ReconvertCurrency: %v", err)
	}
	if n != 2 {
		t.Fatalf("reconverted %d rows, want 2", n)
	}
	got := func(fp string) int64 {
		t.Helper()
		var v int64
		if err := s.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE fingerprint=?`, fp).Scan(&v); err != nil {
			t.Fatalf("select %s: %v", fp, err)
		}
		return v
	}
	if v := got("fp-zar-1"); v != 600_000 {
		t.Fatalf("zar-1 amount_aed = %d, want 600000 (AED 6,000.00)", v)
	}
	if v := got("fp-zar-2"); v != 200 {
		t.Fatalf("zar-2 amount_aed = %d, want 200", v)
	}
	if v := got("fp-usd"); v != 3_706 {
		t.Fatalf("usd amount_aed = %d, want 3706 (untouched)", v)
	}
}
