//go:build phase2corpus

package main

// opfixture.go — the Task 1b op-log fixture.
//
// Task 1 measures crypto. Task 1b measures the FOLD, which nobody has ever run
// on any device, on an engine (Hermes) whose BigInt is markedly slower than the
// JSC and V8 the code has only ever run on. `client/src` is bigint throughout in
// ten non-test modules.
//
// A corpus of transaction records alone is not a fixture for that: it carries no
// home_currency_set and no rate_set, so §3.7's snapshot-and-backfill path is
// never entered and a currency-correct check against it is unsatisfiable. So the
// same generator emits both, from the same source rows.
//
// # What the mix is, and why each part is there
//
//   - N txn_ingested in seq order — the bulk.
//   - one home_currency_set at the very top — one-shot and immutable.
//   - a dozen rate_set ops spread through the log — the fold's parent-free path,
//     folded purely by position.
//   - ~5% txn_categorized against REAL parent versions — the causal path,
//     entity-head tracking, and the version contiguity check. A categorization
//     with a made-up parent_version would be refused as an anomaly and would
//     measure the refusal instead of the apply.
//   - ~1% txn_superseded keyed by ingest_id — supersede/retire, and §3.7:129's
//     recompute-at-its-own-position.
//   - foreign-currency rows already present in the source — the snapshot path.
//
// # One distinct rate per currency, deliberately
//
// Every rate_set for a given currency carries the SAME rate_micro. GBP's first
// one appears mid-log so that earlier GBP rows snapshot null and are backfilled,
// which is the §3.7 path worth exercising; the rest are re-affirmations. The
// consequence is that head_rate(ccy, P) is the same value at every position,
// which is what lets manifest.go compute the expected home totals by direct
// arithmetic instead of by folding — so the check is independent of the thing it
// checks.

import (
	"fmt"
	"sort"
)

// OpFixtureShape is the histogram the manifest publishes so the on-device
// fixture builder can assert it produced the same log rather than a different
// one that happens to be the same length.
type OpFixtureShape struct {
	Total      int            `json:"total"`
	ByType     map[string]int `json:"by_type"`
	Currencies map[string]int `json:"currencies"`
	Seed       uint64         `json:"seed"`
}

type fixtureEntry struct {
	Seq      string `json:"seq"`
	WriterID string `json:"writer_id"`
	Stream   string `json:"stream"`
	Op       any    `json:"op"`
}

type opFixture struct {
	HomeCurrency string            `json:"home_currency"`
	Rates        map[string]int64  `json:"-"`
	RatesOut     map[string]string `json:"rates"`
	Shape        OpFixtureShape    `json:"shape"`
	Entries      []fixtureEntry    `json:"entries"`
}

// fixtureRates is the whole rate schedule, fixed rather than random: the numbers
// have to be stable across regenerations or every committed digest changes.
var fixtureRates = map[string]int64{
	"USD": 3_672_500,
	"EUR": 3_980_000,
	"GBP": 4_650_000,
}

const fixtureHomeCurrency = "AED"

func buildOpFixture(rows []txnRow, seed uint64) opFixture {
	fx := opFixture{
		HomeCurrency: fixtureHomeCurrency,
		Rates:        map[string]int64{},
		RatesOut:     map[string]string{},
		Shape:        OpFixtureShape{ByType: map[string]int{}, Currencies: map[string]int{}, Seed: seed},
	}
	// Only publish rates for currencies the corpus actually contains, so the
	// manifest cannot claim a rate that no transaction ever used.
	for _, r := range rows {
		if r.Currency != fixtureHomeCurrency {
			if micro, ok := fixtureRates[r.Currency]; ok {
				fx.Rates[r.Currency] = micro
			}
		}
		fx.Shape.Currencies[r.Currency]++
	}
	for c, m := range fx.Rates {
		fx.RatesOut[c] = fmt.Sprintf("%d", m)
	}

	seq := int64(0)
	next := func() string { seq++; return fmt.Sprintf("%d", seq) }
	add := func(writer, stream string, op map[string]any) {
		fx.Entries = append(fx.Entries, fixtureEntry{Seq: next(), WriterID: writer, Stream: stream, Op: op})
		fx.Shape.ByType[op["type"].(string)]++
		fx.Shape.Total++
	}

	add("dev-a", "hot", map[string]any{
		"v": 1, "type": "home_currency_set", "op_id": opID("home", 0),
		"authored_at": "2026-01-01T00:00:00.000Z", "parent_version": nil,
		"payload": map[string]any{"currency": fixtureHomeCurrency},
	})

	// The rates that exist from the start. GBP is held back; see below.
	early := sortedCurrencies(fx.Rates)
	for _, ccy := range early {
		if ccy == "GBP" {
			continue
		}
		add("dev-a", "hot", map[string]any{
			"v": 1, "type": "rate_set", "op_id": opID("rate", int64(len(fx.Entries))),
			"authored_at": "2026-01-01T00:01:00.000Z", "parent_version": nil,
			"payload": map[string]any{"currency": ccy, "rate_micro": fmt.Sprintf("%d", fx.Rates[ccy])},
		})
	}

	gbpAt := len(rows) / 2
	categorizeEvery := 20 // ~5%
	supersedeEvery := 100 // ~1%
	reaffirmEvery := max(1, len(rows)/10)

	for i, r := range rows {
		id := txnID(i)
		add("ingest", "hot", map[string]any{
			"v": 1, "type": "txn_ingested", "op_id": opID("ing", int64(i)),
			"authored_at": "2026-01-01T00:00:00.000Z", "parent_version": nil,
			"entity":    map[string]any{"kind": "txn", "id": id},
			"ingest_id": r.IID,
			"payload":   txnPayload(r),
		})

		// GBP arrives mid-log: rows before it snapshot null and are backfilled by
		// it, which is the §3.7 path a fixture with all rates up front misses.
		if i == gbpAt {
			if micro, ok := fx.Rates["GBP"]; ok {
				add("dev-a", "hot", map[string]any{
					"v": 1, "type": "rate_set", "op_id": opID("rate-gbp", int64(i)),
					"authored_at": "2026-06-01T00:00:00.000Z", "parent_version": nil,
					"payload": map[string]any{"currency": "GBP", "rate_micro": fmt.Sprintf("%d", micro)},
				})
			}
		}
		// Re-affirmations at the same value: they exercise the parent-free path
		// without moving any head, so the expected totals stay computable.
		if i > 0 && i%reaffirmEvery == 0 && len(early) > 0 {
			ccy := early[i%len(early)]
			if ccy != "GBP" || i > gbpAt {
				add("dev-a", "hot", map[string]any{
					"v": 1, "type": "rate_set", "op_id": opID("rate-again", int64(i)),
					"authored_at": "2026-06-01T00:00:00.000Z", "parent_version": nil,
					"payload": map[string]any{"currency": ccy, "rate_micro": fmt.Sprintf("%d", fx.Rates[ccy])},
				})
			}
		}
		// A categorization against the REAL parent version, which for a
		// freshly-ingested transaction is 1.
		if i%categorizeEvery == 0 {
			add("dev-a", "hot", map[string]any{
				"v": 1, "type": "txn_categorized", "op_id": opID("cat", int64(i)),
				"authored_at": "2026-06-01T00:00:00.000Z", "parent_version": 1,
				"entity":  map[string]any{"kind": "txn", "id": id},
				"payload": map[string]any{"category": bucketName(r.Bucket), "needs_review": false},
			})
		}
		// A supersede keyed by ingest_id: it retires the row above and introduces
		// a fresh one whose FX snapshot is recomputed at THIS position.
		if i%supersedeEvery == supersedeEvery-1 {
			sup := r
			sup.Amount = r.Amount + 1
			add("ingest", "hot", map[string]any{
				"v": 1, "type": "txn_superseded", "op_id": opID("sup", int64(i)),
				"authored_at": "2026-06-01T00:00:00.000Z", "parent_version": nil,
				"entity":    map[string]any{"kind": "txn", "id": txnID(i) + "-r"},
				"ingest_id": r.IID,
				"payload":   txnPayload(sup),
			})
		}
	}
	return fx
}

func txnPayload(r txnRow) map[string]any {
	return map[string]any{
		"amount_minor": fmt.Sprintf("%d", r.Amount),
		"currency":     r.Currency,
		"direction":    r.Direction,
		"posted_at":    r.PostedAt,
		"merchant_raw": r.Merchant,
		"last4":        "",
		"category":     nil,
		"needs_review": r.Status != "confirmed",
		"unparsed":     false,
		"tier":         "template",
		"parse_error":  nil,
	}
}

func txnID(i int) string { return fmt.Sprintf("t%06d", i) }
func opID(kind string, i int64) string {
	// ULID-shaped enough to be legal, deterministic so the fixture is
	// reproducible. op_id is an identity, so it must be unique — the kind prefix
	// is what makes two ops at the same index distinct.
	return fmt.Sprintf("%s-%09d", kind, i)
}

func sortedCurrencies(m map[string]int64) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
