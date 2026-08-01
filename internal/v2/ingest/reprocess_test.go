package ingest

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/tmpl"
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// reprocessBody carries TWO amount-shaped lines, which is what makes a template
// FIX expressible: v1 of the template reads the wrong one (a foreign-currency
// authorization) and v2 reads the line the account was actually charged. That
// is the real shape of the bug reprocessing exists for — spec §3.5 — and it
// changes the currency as well as the number, which is the case §3.7:129 cares
// about.
const reprocessBody = "Purchase alert\n" +
	"Amount USD 250.00\n" +
	"Charged to your account AED 918.13\n" +
	"Date 05-06-2026\n" +
	"Merchant:CARREFOUR HYPERMARKET\n" +
	"Card 3701\n"

const (
	// authPattern reads the authorization line: USD 250.00.
	authPattern = `Amount (?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})`
	// chargedPattern reads the line the account was charged: AED 918.13.
	chargedPattern = `Charged to your account (?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})`
)

// amountTemplate is bankTemplate with the amount pattern and version as
// parameters, so a test can publish a correction of the template that produced
// a transaction rather than a second, unrelated template.
func amountTemplate(version int, amountPattern string) tmpl.Definition {
	d, err := tmpl.ParseDefinition([]byte(fmt.Sprintf(`{
	  "id": "bank.card.v1",
	  "version": %d,
	  "bank": "bank",
	  "normalizer_version": 1,
	  "match": {"sender_domain": ["bank.example"], "body_contains": ["Purchase alert"]},
	  "default_currency": "AED",
	  "date_from": "body",
	  "extract": [
	    {"field":"amount","type":"amount","source":"body","patterns":[%s]},
	    {"field":"date","type":"date","source":"body","layouts":["DD-MM-YYYY"],
	     "patterns":["Date (?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})"]},
	    {"field":"merchant","type":"text","source":"body","patterns":["Merchant:(?P<v>[^\\n]*)"]},
	    {"field":"last4","type":"last4","source":"body","patterns":["Card (?P<v>[0-9]{4})"]},
	    {"field":"direction","type":"const","source":"body","value":"debit"}
	  ],
	  "required": ["amount","direction","date"]
	}`, version, jsonString(amountPattern))))
	if err != nil {
		panic(err)
	}
	return d
}

// jsonString renders a Go string as a JSON string literal. %q is not enough:
// its escaping is Go's, and the two dialects differ on non-ASCII.
func jsonString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Harness additions
// ---------------------------------------------------------------------------

// reprocess runs a reprocess and advances the clock, so its diagnostics row
// sorts after the arrival row it re-examines.
func (r *rig) reprocess(ids ...[]byte) Report {
	r.t.Helper()
	r.now = r.now.Add(time.Second)
	rep, err := r.p.Reprocess(bg, r.user, ids)
	if err != nil {
		r.t.Fatalf("reprocess: %v", err)
	}
	return rep
}

// payloadOf decodes one op's transaction payload.
func payloadOf(t *testing.T, o oplog.Op) payload {
	t.Helper()
	var p payload
	if err := json.Unmarshal(o.Payload, &p); err != nil {
		t.Fatalf("decode payload of %s: %v", o.OpID, err)
	}
	return p
}

// replayLiveEntities mirrors the ONE rule the replay engine keys transactions
// on — `liveByIngestID` in client/src/replay/replay.ts's createTxn — and
// returns the entity id left live for each ingest id.
//
// It is a mirror, not the executor: the real fold is TypeScript and this
// package cannot call it. What it pins is the property the fold depends on —
// that the Go writer emits at most one live create per ingest id, each
// supersede naming a NEW entity and the SAME ingest id — because a writer that
// emitted a second txn_ingested, or reused the entity id, would materialize
// either a duplicate transaction or a silent in-place mutation. The end-to-end
// assertion over the real executor is the plan's integration script (Task 37).
func replayLiveEntities(t *testing.T, ops []oplog.Op) map[string]string {
	t.Helper()
	live := map[string]string{}
	for _, o := range ops {
		switch o.Type {
		case oplog.OpTxnIngested:
			if prev, ok := live[o.IngestID]; ok {
				t.Fatalf("a second txn_ingested for ingest id %s… would fold to a duplicate_ingest anomaly (live as %s)",
					o.IngestID[:12], prev)
			}
			live[o.IngestID] = o.Entity.ID
		case oplog.OpTxnSuperseded:
			prev, ok := live[o.IngestID]
			if !ok {
				t.Fatalf("txn_superseded %s has no live predecessor: replay would raise supersede_without_origin", o.OpID)
			}
			if prev == o.Entity.ID {
				t.Fatalf("supersede %s reuses the entity id it supersedes; a supersede is a NEW row", o.OpID)
			}
			live[o.IngestID] = o.Entity.ID
		}
	}
	return live
}

// rewriteColdBody replaces the raw message inside the cold blob for ingestID,
// keeping the blob's position, its ingest id and its chain hash intact.
//
// It exists for one assertion: that the raw body a reprocess parses comes from
// the COLD STREAM and from nowhere else. Nothing in production does this — it
// is a stand-in for the only real way a stored body's parse can change without
// the template changing, which is a normalizer fix.
//
// The rewritten row must be the LAST cold row, or its successor's prev_hash
// would no longer link.
func (r *rig) rewriteColdBody(ingestID []byte, raw []byte) {
	r.t.Helper()
	want := hex.EncodeToString(ingestID)
	for _, row := range r.rows() {
		if row.Stream != blob.StreamCold {
			continue
		}
		rb, err := oplog.DecodeRawBody(r.open(row))
		if err != nil {
			r.t.Fatal(err)
		}
		if rb.IngestID != want {
			continue
		}
		rb.RawBase64 = base64.StdEncoding.EncodeToString(raw)
		pt, err := oplog.EncodeRawBody(rb)
		if err != nil {
			r.t.Fatal(err)
		}
		sealed, err := blob.PlaintextSealer{}.Seal(blob.Envelope{
			UserID: r.user, Stream: row.Stream, WriterID: row.WriterID, WriterCounter: row.WriterCounter,
		}, pt)
		if err != nil {
			r.t.Fatal(err)
		}
		var prev []byte
		if err := r.pool.QueryRow(bg,
			`SELECT prev_hash FROM op_log WHERE user_id = $1 AND seq = $2`, r.user, row.Seq).Scan(&prev); err != nil {
			r.t.Fatal(err)
		}
		var p32 [32]byte
		copy(p32[:], prev)
		h := blob.Hash(p32, sealed)
		if _, err := r.pool.Exec(bg,
			`UPDATE op_log SET blob = $3, size_bucket = $4, blob_hash = $5 WHERE user_id = $1 AND seq = $2`,
			r.user, row.Seq, sealed.Bytes, sealed.SizeBucket, h[:]); err != nil {
			r.t.Fatal(err)
		}
		return
	}
	r.t.Fatalf("no cold blob carries ingest id %s", want)
}

// reprocessDiags returns only the event='reprocess' diagnostics rows.
func (r *rig) reprocessDiags() []diagRow {
	r.t.Helper()
	var out []diagRow
	for _, d := range r.diags() {
		if d.Event == diag.EventReprocess {
			out = append(out, d)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// The supersede
// ---------------------------------------------------------------------------

// TestReprocessEmitsASupersedeKeyedByIngestID is spec §3.3:67: reprocessing the
// same email emits a supersede keyed by the SAME ingest id, so replay keeps at
// most one live transaction however many times the template is fixed.
func TestReprocessEmitsASupersedeKeyedByIngestID(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")

	first := r.hotOps()
	if len(first) != 1 || first[0].Type != oplog.OpTxnIngested {
		t.Fatalf("want one txn_ingested to start from, got %+v", first)
	}
	if p := payloadOf(t, first[0]); p.AmountMinor != "25000" || p.Currency != "USD" {
		t.Fatalf("the wrong template produced %s %s, want 25000 USD", p.AmountMinor, p.Currency)
	}

	// The fix: v2 reads the charged line instead of the authorization line.
	r.publish(amountTemplate(2, chargedPattern))
	rep := r.reprocess(idOf(raw))
	if want := (Report{Examined: 1, Superseded: 1}); rep != want {
		t.Fatalf("report = %+v, want %+v", rep, want)
	}

	ops := r.hotOps()
	if len(ops) != 2 {
		t.Fatalf("want 2 hot ops (the ingest and its supersede), got %d", len(ops))
	}
	// Hot only. The raw body is already in the cold stream under this ingest
	// id; a second copy per republish would grow it without adding anything.
	var cold int
	for _, row := range r.rows() {
		if row.Stream == blob.StreamCold {
			cold++
		}
	}
	if cold != 1 {
		t.Fatalf("the cold stream has %d rows after a supersede, want the original 1", cold)
	}
	sup := ops[1]
	switch {
	case sup.Type != oplog.OpTxnSuperseded:
		t.Fatalf("op 2 is %s, want %s", sup.Type, oplog.OpTxnSuperseded)
	case sup.IngestID != first[0].IngestID:
		t.Fatalf("supersede keyed by %s, want the original ingest id %s", sup.IngestID, first[0].IngestID)
	case sup.Entity.ID == first[0].Entity.ID:
		t.Fatal("the supersede reuses the entity id: a supersede is a new row, not an edit")
	case sup.ParentVersion != nil:
		t.Fatalf("supersede carries parent_version %d; it is a CREATE", *sup.ParentVersion)
	}
	p := payloadOf(t, sup)
	if p.AmountMinor != "91813" || p.Currency != "AED" {
		t.Fatalf("supersede payload = %s %s, want 91813 AED", p.AmountMinor, p.Currency)
	}
	if p.TemplateID != "bank.card.v1" || p.TemplateVersion != 2 {
		t.Fatalf("supersede provenance = %s v%d, want bank.card.v1 v2", p.TemplateID, p.TemplateVersion)
	}
	if p.NeedsReview || p.Unparsed {
		t.Fatalf("a template-tier supersede must be trusted: %+v", p)
	}

	// Exactly one live transaction for this ingest id, which is what replay's
	// liveByIngestID leaves behind.
	live := replayLiveEntities(t, ops)
	if len(live) != 1 {
		t.Fatalf("replay would leave %d live transactions, want 1", len(live))
	}
	if live[sup.IngestID] != sup.Entity.ID {
		t.Fatalf("the live transaction is %s, want the superseding one %s", live[sup.IngestID], sup.Entity.ID)
	}

	d := r.reprocessDiags()
	if len(d) != 1 || d[0].Outcome != diag.OutcomeSuperseded {
		t.Fatalf("reprocess diagnostics = %+v, want one superseded row", d)
	}
	if d[0].Tier != diag.TierTemplate || !d[0].Matched || d[0].TemplateVersion == nil || *d[0].TemplateVersion != 2 {
		t.Fatalf("reprocess diagnostics do not record the template that produced it: %+v", d[0])
	}
}

// TestReprocessAppendsNothingWhenTheResultIsIdentical is the other half of the
// contract. Re-running a template that produces the same eight fields must not
// churn the log: a supersede retires the row the user may have categorized, and
// replay raises edit_of_superseded when it does.
func TestReprocessAppendsNothingWhenTheResultIsIdentical(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")
	before := len(r.rows())

	rep := r.reprocess(idOf(raw))
	if want := (Report{Examined: 1, Unchanged: 1}); rep != want {
		t.Fatalf("report = %+v, want %+v", rep, want)
	}
	if after := len(r.rows()); after != before {
		t.Fatalf("op_log grew from %d to %d rows for an unchanged reprocess", before, after)
	}
	d := r.reprocessDiags()
	if len(d) != 1 || d[0].Outcome != diag.OutcomeUnchanged {
		t.Fatalf("reprocess diagnostics = %+v, want one unchanged row", d)
	}
}

// TestReprocessDoesNotSupersedeOnAProvenanceOnlyChange pins WHICH fields are
// compared. A republish that produces identical values under a new version
// number is a new provenance and the same transaction; superseding on it would
// retire every user's row on every template republish and lose the categories
// attached to them.
func TestReprocessDoesNotSupersedeOnAProvenanceOnlyChange(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")
	before := len(r.rows())

	// Same extraction, new version. Only template_version moves.
	r.publish(amountTemplate(2, authPattern))
	rep := r.reprocess(idOf(raw))
	if want := (Report{Examined: 1, Unchanged: 1}); rep != want {
		t.Fatalf("report = %+v, want %+v", rep, want)
	}
	if after := len(r.rows()); after != before {
		t.Fatalf("op_log grew from %d to %d rows for a provenance-only republish", before, after)
	}
	d := r.reprocessDiags()
	if len(d) != 1 || d[0].TemplateVersion == nil || *d[0].TemplateVersion != 2 {
		t.Fatalf("the reprocess row should still record the version that ran: %+v", d)
	}
}

// TestReprocessTwiceIsIdempotent: the second run compares against the
// SUPERSEDE, not against the original ingest, so a template fix applied twice
// produces one supersede and not a chain of them.
func TestReprocessTwiceIsIdempotent(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")
	r.publish(amountTemplate(2, chargedPattern))

	if rep := r.reprocess(idOf(raw)); rep.Superseded != 1 {
		t.Fatalf("first run = %+v, want one supersede", rep)
	}
	if rep := r.reprocess(idOf(raw)); rep != (Report{Examined: 1, Unchanged: 1}) {
		t.Fatalf("second run = %+v, want one unchanged", rep)
	}
	ops := r.hotOps()
	if len(ops) != 2 {
		t.Fatalf("want 2 hot ops after two reprocesses, got %d", len(ops))
	}
	if live := replayLiveEntities(t, ops); len(live) != 1 {
		t.Fatalf("replay would leave %d live transactions, want 1", len(live))
	}
}

// TestReprocessSupersedeRecomputesFXAtItsOwnPosition is spec §3.7:129. The
// snapshot is NEVER inherited: the supersede is a create at a later log
// position, in a currency the fix corrected, and its payload carries no
// amount_home_minor at all — there is nothing on the wire for it to inherit,
// so the client's fold must compute it against the rate head live at the
// supersede's own position.
//
// The fold itself is the TypeScript executor's, pinned by
// client/src/replay/fx.test.ts ("a supersede recomputes at its own position and
// never inherits", and the currency-correction case beside it). What is
// asserted here is that the Go writer emits exactly the op that test consumes.
func TestReprocessSupersedeRecomputesFXAtItsOwnPosition(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")
	r.publish(amountTemplate(2, chargedPattern))
	r.reprocess(idOf(raw))

	ops := r.hotOps()
	if len(ops) != 2 {
		t.Fatalf("want 2 hot ops, got %d", len(ops))
	}
	before, sup := payloadOf(t, ops[0]), payloadOf(t, ops[1])

	// The currency correction, which is the case that makes inheritance wrong
	// rather than merely stale.
	if before.Currency != "USD" || sup.Currency != "AED" {
		t.Fatalf("want a USD -> AED correction, got %s -> %s", before.Currency, sup.Currency)
	}

	// Nothing derived travels on the wire. amount_home_minor is not a field of
	// the payload at all, so a supersede cannot carry a predecessor's snapshot
	// even by accident.
	var raw2 map[string]json.RawMessage
	if err := json.Unmarshal(ops[1].Payload, &raw2); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw2["amount_home_minor"]; ok {
		t.Fatal("the supersede payload carries amount_home_minor: a snapshot must be recomputed, never shipped")
	}
	allowed := map[string]bool{
		"amount_minor": true, "currency": true, "direction": true, "posted_at": true,
		"merchant_raw": true, "last4": true, "is_transfer": true, "tier": true,
		"needs_review": true, "unparsed": true, "template_id": true,
		"template_version": true, "normalizer_version": true,
	}
	for k := range raw2 {
		if !allowed[k] {
			t.Fatalf("supersede payload carries an unexpected field %q", k)
		}
	}

	// "Its own position" is a LATER position: the fold reaches the supersede
	// after every rate op sequenced between the two.
	rows := r.rows()
	var ingestSeq, supSeq int64
	for _, row := range rows {
		if row.Stream != blob.StreamHot {
			continue
		}
		decoded, err := oplog.DecodeBlob(r.open(row))
		if err != nil {
			t.Fatal(err)
		}
		switch decoded[0].Type {
		case oplog.OpTxnIngested:
			ingestSeq = row.Seq
		case oplog.OpTxnSuperseded:
			supSeq = row.Seq
		}
	}
	if !(supSeq > ingestSeq) || ingestSeq == 0 {
		t.Fatalf("supersede is at seq %d, the ingest at %d; a supersede must occupy a later position", supSeq, ingestSeq)
	}
}

// TestReprocessSupersedesAHeuristicResultWithATemplateOne is the case a real
// operator hits: mail arrived before its bank had a template, was parsed by the
// always-needs-review heuristic tier, and a template is published later.
func TestReprocessSupersedesAHeuristicResultWithATemplateOne(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example") // no template published yet
	if p := r.onlyPayload(); p.Tier != diag.TierHeuristic || !p.NeedsReview {
		t.Fatalf("want a heuristic, review-flagged predecessor, got %+v", p)
	}

	r.publish(amountTemplate(1, chargedPattern))
	if rep := r.reprocess(idOf(raw)); rep != (Report{Examined: 1, Superseded: 1}) {
		t.Fatalf("report = %+v, want one supersede", rep)
	}
	ops := r.hotOps()
	p := payloadOf(t, ops[len(ops)-1])
	if p.Tier != diag.TierTemplate || p.NeedsReview {
		t.Fatalf("the supersede is still untrusted: %+v", p)
	}
	if p.MerchantRaw != "CARREFOUR HYPERMARKET" || p.AmountMinor != "91813" {
		t.Fatalf("supersede = %+v, want the template's reading", p)
	}
}

// TestChangedFieldsComparesTheEightTransactionFieldsAndNoOthers walks the
// payload field by field. Eight of them are the transaction and must trigger a
// supersede; the five that describe which CODE produced it must not, because a
// supersede is a new entity and takes the user's category and splits off the
// row (replay's edit_of_superseded).
func TestChangedFieldsComparesTheEightTransactionFieldsAndNoOthers(t *testing.T) {
	base := txnPayload{
		AmountMinor: "25000", Currency: "AED", Direction: "debit",
		PostedAt: "2026-06-05T00:00:00Z", MerchantRaw: "CARREFOUR", Last4: "3701",
		IsTransfer: false, Tier: "template", NeedsReview: false, Unparsed: false,
		TemplateID: "bank.card.v1", TemplateVersion: 1, NormalizerVersion: 1,
	}
	if got := changedFields(base, base); len(got) != 0 {
		t.Fatalf("identical payloads differ in %v", got)
	}

	compared := map[string]func(*txnPayload){
		"amount_minor": func(p *txnPayload) { p.AmountMinor = "25001" },
		"currency":     func(p *txnPayload) { p.Currency = "USD" },
		"direction":    func(p *txnPayload) { p.Direction = "credit" },
		"posted_at":    func(p *txnPayload) { p.PostedAt = "2026-06-06T00:00:00Z" },
		"merchant_raw": func(p *txnPayload) { p.MerchantRaw = "SPINNEYS" },
		"last4":        func(p *txnPayload) { p.Last4 = "1234" },
		"is_transfer":  func(p *txnPayload) { p.IsTransfer = true },
		"needs_review": func(p *txnPayload) { p.NeedsReview = true },
	}
	if len(compared) != len(comparedFields) {
		t.Fatalf("this test walks %d fields but comparedFields has %d", len(compared), len(comparedFields))
	}
	for name, mutate := range compared {
		next := base
		mutate(&next)
		got := changedFields(base, next)
		if len(got) != 1 || got[0] != name {
			t.Fatalf("changing %s reported %v", name, got)
		}
	}

	provenance := map[string]func(*txnPayload){
		"tier":               func(p *txnPayload) { p.Tier = "heuristic" },
		"unparsed":           func(p *txnPayload) { p.Unparsed = true },
		"template_id":        func(p *txnPayload) { p.TemplateID = "bank.card.v2" },
		"template_version":   func(p *txnPayload) { p.TemplateVersion = 9 },
		"normalizer_version": func(p *txnPayload) { p.NormalizerVersion = 2 },
	}
	for name, mutate := range provenance {
		next := base
		mutate(&next)
		if got := changedFields(base, next); len(got) != 0 {
			t.Fatalf("changing provenance field %s reported %v; a republish is not a new transaction", name, got)
		}
	}
}

// ---------------------------------------------------------------------------
// Where the raw body comes from
// ---------------------------------------------------------------------------

// TestReprocessReadsTheColdStreamNotTheOriginalDelivery makes the Phase 3
// impossibility concrete. The cold blob is the ONLY source of the body: rewrite
// it and the reprocess parses the rewritten message, with no reference to the
// bytes the SMTP session actually delivered.
func TestReprocessReadsTheColdStreamNotTheOriginalDelivery(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")
	if p := r.onlyPayload(); p.MerchantRaw != "CARREFOUR HYPERMARKET" {
		t.Fatalf("merchant = %q", p.MerchantRaw)
	}

	// The cold body now says something the delivered message never did.
	rewritten := r.trusted(strings.Replace(reprocessBody,
		"Merchant:CARREFOUR HYPERMARKET", "Merchant:READ FROM THE COLD STREAM", 1))
	r.rewriteColdBody(idOf(raw), rewritten)

	if rep := r.reprocess(idOf(raw)); rep.Superseded != 1 {
		t.Fatalf("report = %+v, want one supersede", rep)
	}
	ops := r.hotOps()
	if p := payloadOf(t, ops[len(ops)-1]); p.MerchantRaw != "READ FROM THE COLD STREAM" {
		t.Fatalf("merchant = %q; the body did not come from the cold stream", p.MerchantRaw)
	}
}

// TestReprocessSupersedesAPreviouslyUnparsedMessage: the predecessor carries no
// money at all (amount "0", currency ""), and the comparison must handle it
// rather than treat it as a missing field.
//
// The trigger here is artificial — the cold body is rewritten — because a
// TEMPLATE fix cannot in fact rescue an unparsed message: both tiers gate on
// the same two-decimal amount shape, so a body the heuristic found no amount in
// has none for a template either. The real trigger is a NORMALIZER fix, which
// changes what the same bytes normalize to. See the report.
func TestReprocessSupersedesAPreviouslyUnparsedMessage(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted("Dear customer, our branches will be closed on Eid.\n")
	r.mustDeliver(raw, "alerts@bank.example")
	if p := r.onlyPayload(); !p.Unparsed || p.AmountMinor != "0" || p.Currency != "" {
		t.Fatalf("want an unparsed predecessor, got %+v", p)
	}

	r.rewriteColdBody(idOf(raw), r.trusted(reprocessBody))
	if rep := r.reprocess(idOf(raw)); rep.Superseded != 1 {
		t.Fatalf("report = %+v, want one supersede", rep)
	}
	ops := r.hotOps()
	sup := ops[len(ops)-1]
	if sup.Type != oplog.OpTxnSuperseded || sup.IngestID != ops[0].IngestID {
		t.Fatalf("want a supersede on the same ingest id, got %s / %s", sup.Type, sup.IngestID)
	}
	p := payloadOf(t, sup)
	if p.Unparsed || p.AmountMinor != "25000" {
		t.Fatalf("the corrected transaction is %+v", p)
	}
}

// ---------------------------------------------------------------------------
// Confirm -> reprocess: quarantine into the chains
// ---------------------------------------------------------------------------

// TestConfirmThenReprocessMovesQuarantinedMailIntoTheChains is §3.2's
// promotion: held mail enters the integrity chains at the moment it is
// appended, and not one step earlier.
func TestConfirmThenReprocessMovesQuarantinedMailIntoTheChains(t *testing.T) {
	r := newRig(t)
	r.publish(amountTemplate(1, authPattern))
	for i := 0; i < 3; i++ {
		body := strings.Replace(reprocessBody, "CARREFOUR HYPERMARKET", fmt.Sprintf("SHOP %d", i), 1)
		r.mustDeliver(r.trusted(body), "alerts@bank.example")
	}
	if got := len(r.rows()); got != 0 {
		t.Fatalf("op_log has %d rows before the sender is confirmed", got)
	}
	if got := r.heldCount(); got != 3 {
		t.Fatalf("quarantine holds %d, want 3", got)
	}
	pushes := r.push.count()

	ids, err := r.q.Confirm(bg, r.user, "bank.example", origin.ScopeOuter)
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	rep := r.reprocess(ids...)
	if want := (Report{Examined: 3, Appended: 3}); rep != want {
		t.Fatalf("report = %+v, want %+v", rep, want)
	}

	rows := r.rows()
	var hot, cold int
	for _, row := range rows {
		switch row.Stream {
		case blob.StreamHot:
			hot++
		case blob.StreamCold:
			cold++
		}
	}
	if hot != 3 || cold != 3 {
		t.Fatalf("got %d hot and %d cold rows, want 3 and 3", hot, cold)
	}
	if got := r.heldCount(); got != 0 {
		t.Fatalf("quarantine still holds %d promoted messages", got)
	}
	d := r.reprocessDiags()
	if len(d) != 3 {
		t.Fatalf("want 3 reprocess diagnostics rows, got %d", len(d))
	}
	for _, row := range d {
		if row.Outcome != diag.OutcomeAppended {
			t.Fatalf("reprocess outcome = %q, want %q", row.Outcome, diag.OutcomeAppended)
		}
		if row.SenderDomain != "bank.example" {
			t.Fatalf("sender_domain = %q, want the verified domain", row.SenderDomain)
		}
	}
	if got := r.push.count(); got != pushes {
		t.Fatalf("a reprocess pushed %d times; reprocessing is never an arrival", got-pushes)
	}
	// Each promoted message is its own live transaction, keyed by its own
	// ingest id.
	if live := replayLiveEntities(t, r.hotOps()); len(live) != 3 {
		t.Fatalf("replay would leave %d live transactions, want 3", len(live))
	}
}

// TestReprocessNeverPromotesMailFromASenderStillNotTrusted: naming a held
// ingest id must not be a way around the trusted lane. The trust decision is
// re-made against the CURRENT allowlist at reprocess time.
func TestReprocessNeverPromotesMailFromASenderStillNotTrusted(t *testing.T) {
	r := newRig(t)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")

	rep := r.reprocess(idOf(raw))
	if want := (Report{Examined: 1, Failed: 1}); rep != want {
		t.Fatalf("report = %+v, want %+v", rep, want)
	}
	if got := len(r.rows()); got != 0 {
		t.Fatalf("op_log has %d rows for an unconfirmed sender", got)
	}
	if got := r.heldCount(); got != 1 {
		t.Fatalf("quarantine holds %d, want the message still held", got)
	}
	if d := r.reprocessDiags(); len(d) != 0 {
		t.Fatalf("a refused reprocess wrote %d diagnostics rows", len(d))
	}
}

// TestReprocessOfStoredMailReChecksTheAllowlist. The trust decision is re-made
// for mail already in the log too, from the origin this server VERIFIED at
// arrival. A user who withdraws a sender must not find reprocessing running
// that sender's mail through a new template afterwards.
func TestReprocessOfStoredMailReChecksTheAllowlist(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")

	if _, err := r.pool.Exec(bg,
		`DELETE FROM sender_allowlist WHERE user_id = $1 AND domain = $2`, r.user, "bank.example"); err != nil {
		t.Fatal(err)
	}
	r.publish(amountTemplate(2, chargedPattern))

	if rep := r.reprocess(idOf(raw)); rep != (Report{Examined: 1, Failed: 1}) {
		t.Fatalf("report = %+v, want one failure", rep)
	}
	if got := len(r.hotOps()); got != 1 {
		t.Fatalf("the log has %d ops; a withdrawn sender's mail was re-parsed anyway", got)
	}
	if d := r.reprocessDiags(); len(d) != 0 {
		t.Fatalf("a refused reprocess wrote %d diagnostics rows", len(d))
	}
}

// TestReprocessPromotesMailWhoseSigningKeyIsGone. A hold lasts 30 days and DKIM
// selectors rotate inside that window. The verification this server PERFORMED
// at arrival is recorded on the quarantine row; a re-verification that can no
// longer reach the key must not strand mail the user has confirmed.
func TestReprocessPromotesMailWhoseSigningKeyIsGone(t *testing.T) {
	r := newRig(t)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")

	// The bank rotated its selector; the key that signed this message is gone.
	delete(r.keys.recs, "sel._domainkey.bank.example")

	ids, err := r.q.Confirm(bg, r.user, "bank.example", origin.ScopeOuter)
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if rep := r.reprocess(ids...); rep != (Report{Examined: 1, Appended: 1}) {
		t.Fatalf("report = %+v, want one appended", rep)
	}
	if got := len(r.rows()); got != 2 {
		t.Fatalf("got %d rows, want a hot and a cold one", got)
	}
	d := r.reprocessDiags()
	if len(d) != 1 || d[0].SenderDomain != "bank.example" || d[0].Outcome != diag.OutcomeAppended {
		t.Fatalf("reprocess diagnostics = %+v", d)
	}
}

// ---------------------------------------------------------------------------
// Accounting and refusals
// ---------------------------------------------------------------------------

// TestReprocessDoesNotAppendTwiceWhenAPromoteFailedAfterItsAppend. Promote runs
// after the append, so an error between them leaves a quarantine row for a
// message that IS in the log — and the natural response to that error is to run
// the reprocess again. The diagnostics row already records the append, so the
// retry clears the stale row instead of appending a second copy.
func TestReprocessDoesNotAppendTwiceWhenAPromoteFailedAfterItsAppend(t *testing.T) {
	r := newRig(t)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")
	ids, err := r.q.Confirm(bg, r.user, "bank.example", origin.ScopeOuter)
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if rep := r.reprocess(ids...); rep.Appended != 1 {
		t.Fatalf("report = %+v, want one appended", rep)
	}
	before := len(r.rows())

	// Exactly the state a Promote that failed after its append leaves behind.
	if err := r.q.Hold(bg, quarantine.Item{
		UserID: r.user, IngestID: idOf(raw), ReceivedAt: r.now,
		EnvelopeFrom: "alerts@bank.example", OuterDomain: "bank.example",
		DKIM: quarantine.ResultPass, ARC: quarantine.ResultNone, Blob: raw,
	}); err != nil {
		t.Fatal(err)
	}

	if rep := r.reprocess(idOf(raw)); rep != (Report{Examined: 1, Unchanged: 1}) {
		t.Fatalf("report = %+v, want one unchanged", rep)
	}
	if after := len(r.rows()); after != before {
		t.Fatalf("op_log grew from %d to %d rows: the message was appended twice", before, after)
	}
	if got := r.heldCount(); got != 0 {
		t.Fatalf("the stale quarantine row survived (%d held)", got)
	}
}

// TestReprocessAccountsForEveryRequestedID: Examined is the number of distinct
// ids asked about, and it always equals the sum of the outcomes. An id nothing
// can be found for is a Failed, never a silent zero.
func TestReprocessAccountsForEveryRequestedID(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")

	rep := r.reprocess(idOf(raw), idOf([]byte("a message this user never received")), idOf(raw))
	if rep.Examined != 2 {
		t.Fatalf("Examined = %d, want 2 distinct ids", rep.Examined)
	}
	if sum := rep.Appended + rep.Superseded + rep.Unchanged + rep.Failed; sum != rep.Examined {
		t.Fatalf("report does not account for every id: %+v sums to %d", rep, sum)
	}
	if rep.Failed != 1 || rep.Unchanged != 1 {
		t.Fatalf("report = %+v, want one unchanged and one failed", rep)
	}
}

// TestReprocessRefusesAMalformedIngestID: an id that is not a sha256 cannot
// name a message, and answering "0 examined" would look like "nothing to do".
func TestReprocessRefusesAMalformedIngestID(t *testing.T) {
	r := newRig(t)
	if _, err := r.p.Reprocess(bg, r.user, [][]byte{[]byte("short")}); err == nil {
		t.Fatal("a 5-byte ingest id was accepted")
	}
	if _, err := r.p.Reprocess(bg, uuid.Nil, [][]byte{idOf([]byte("x"))}); err == nil {
		t.Fatal("a reprocess with no user was accepted")
	}
	// The bound exists because this call holds one payload per id in memory and,
	// on the held path, raw bodies. The caller that will drive it (an admin
	// republish over every message a template touched) is unbounded, so it
	// chunks — and this refuses rather than trusting it to.
	big := make([][]byte, maxReprocessBatch+1)
	for i := range big {
		big[i] = idOf([]byte(fmt.Sprint(i)))
	}
	if _, err := r.p.Reprocess(bg, r.user, big); err == nil {
		t.Fatalf("a batch of %d ids was accepted", len(big))
	}
}

// TestReprocessAfterARedeliveryStillFindsTheVerifiedOrigin. A redelivery writes
// a SECOND arrival row carrying no origin at all — the pipeline deliberately
// does not re-verify a duplicate — so the origin must be read from the FIRST
// arrival, not the most recent one.
func TestReprocessAfterARedeliveryStillFindsTheVerifiedOrigin(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")
	r.mustDeliver(raw, "alerts@bank.example") // the MTA retried
	if d := r.diags(); len(d) != 2 || d[1].Outcome != diag.OutcomeDuplicate {
		t.Fatalf("want an arrival then a duplicate, got %+v", d)
	}

	r.publish(amountTemplate(2, chargedPattern))
	if rep := r.reprocess(idOf(raw)); rep != (Report{Examined: 1, Superseded: 1}) {
		t.Fatalf("report = %+v, want one supersede", rep)
	}
}

// TestReprocessOfAnotherUsersMessageFindsNothing: the ingest id is a hash of
// bytes and is not a capability. Every read is scoped to the user.
func TestReprocessOfAnotherUsersMessageFindsNothing(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(amountTemplate(1, authPattern))
	raw := r.trusted(reprocessBody)
	r.mustDeliver(raw, "alerts@bank.example")

	other := r.newUser("sub-" + "other-" + fmt.Sprint(time.Now().UnixNano()))
	rep, err := r.p.Reprocess(bg, other, [][]byte{idOf(raw)})
	if err != nil {
		t.Fatalf("reprocess: %v", err)
	}
	if rep != (Report{Examined: 1, Failed: 1}) {
		t.Fatalf("report = %+v; another user's ingest id must resolve to nothing", rep)
	}
	if got := len(r.hotOps()); got != 1 {
		t.Fatalf("the owner's log now has %d ops", got)
	}
}
