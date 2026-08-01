package oplog

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func ingestID() string { return strings.Repeat("a", 64) }

func txnOp() Op {
	return Op{
		V:          SchemaVersion,
		Type:       OpTxnIngested,
		OpID:       "01J000000000000000000000A1",
		AuthoredAt: time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC),
		Entity:     &EntityRef{Kind: "txn", ID: "01J000000000000000000000T1"},
		IngestID:   ingestID(),
		Payload: json.RawMessage(`{"amount_minor":"25000","currency":"AED","direction":"debit",` +
			`"posted_at":"2026-06-05T00:00:00Z","merchant_raw":"CARREFOUR","last4":"3701",` +
			`"is_transfer":false,"tier":"template","needs_review":false,"unparsed":false,` +
			`"template_id":"dib.card.v1","template_version":1,"normalizer_version":1}`),
	}
}

func rateOp() Op {
	return Op{
		V:          SchemaVersion,
		Type:       OpRateSet,
		OpID:       "01J000000000000000000000R1",
		AuthoredAt: time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC),
		Payload:    json.RawMessage(`{"currency":"USD","rate_micro":"3672500"}`),
	}
}

func TestDecodeBlobRejectsUnknownNewerVersion(t *testing.T) {
	_, err := DecodeBlob([]byte(`{"v":2,"kind":"ops","ops":[]}`))
	if !errors.Is(err, ErrUnknownNewerVersion) {
		t.Fatalf("want ErrUnknownNewerVersion, got %v", err)
	}
}

func TestDecodeBlobRejectsANewerOpInsideAKnownBlob(t *testing.T) {
	// The hard stop has to reach the op, not just the envelope: a v1 blob may
	// carry an op the client cannot interpret, and guessing is worse than
	// stopping (spec §3.3:68).
	b := []byte(`{"v":1,"kind":"ops","ops":[{"v":2,"type":"txn_ingested","op_id":"x",` +
		`"authored_at":"2026-06-05T10:00:00Z","parent_version":null,"payload":{}}]}`)
	if _, err := DecodeBlob(b); !errors.Is(err, ErrUnknownNewerVersion) {
		t.Fatalf("want ErrUnknownNewerVersion, got %v", err)
	}
}

func TestRateOpsAreParentFree(t *testing.T) {
	for _, ty := range []OpType{OpRateSet, OpRateUnset, OpHomeCurrencySet, OpWriterCheckpoint} {
		if !ty.ParentFree() {
			t.Fatalf("%s must be parent-free (spec §3.7)", ty)
		}
	}
	for _, ty := range []OpType{OpTxnIngested, OpTxnSuperseded, OpTxnCategorized, OpTxnSplit, OpTxnEdited, OpRuleAdded} {
		if ty.ParentFree() {
			t.Fatalf("%s must participate in causality", ty)
		}
	}
}

func TestValidateRejectsParentOnParentFreeOp(t *testing.T) {
	p := int64(3)
	o := rateOp()
	o.ParentVersion = &p
	if err := o.Validate(); err == nil {
		t.Fatal("rate_set with a parent_version must be rejected: rates are append-only, never versioned entities")
	}
	o = rateOp()
	o.Entity = &EntityRef{Kind: "rate", ID: "USD"}
	if err := o.Validate(); err == nil {
		t.Fatal("rate_set naming an entity must be rejected: rates are not entities")
	}
}

func TestValidateRequiresEntityOnCausalOps(t *testing.T) {
	o := txnOp()
	o.Entity = nil
	if err := o.Validate(); err == nil {
		t.Fatal("a causal op with no entity must be rejected")
	}
	o = txnOp()
	o.Entity = &EntityRef{Kind: "txn"}
	if err := o.Validate(); err == nil {
		t.Fatal("an entity with no id must be rejected")
	}
}

func TestValidateRequiresIngestIDOnIngestOps(t *testing.T) {
	o := txnOp()
	o.Type = OpTxnSuperseded
	v := int64(1)
	o.ParentVersion = &v
	o.IngestID = ""
	if err := o.Validate(); err == nil {
		t.Fatal("txn_superseded without ingest_id must be rejected")
	}
	o.IngestID = "not-hex"
	if err := o.Validate(); err == nil {
		t.Fatal("a non-sha256 ingest_id must be rejected")
	}
	o.IngestID = ingestID()
	if err := o.Validate(); err != nil {
		t.Fatalf("valid txn_superseded rejected: %v", err)
	}
}

func TestValidateRejectsMalformedOps(t *testing.T) {
	for name, mut := range map[string]func(*Op){
		"no version":      func(o *Op) { o.V = 0 },
		"newer version":   func(o *Op) { o.V = SchemaVersion + 1 },
		"no op id":        func(o *Op) { o.OpID = "" },
		"no type":         func(o *Op) { o.Type = "" },
		"unknown type":    func(o *Op) { o.Type = "txn_teleported" },
		"zero authored":   func(o *Op) { o.AuthoredAt = time.Time{} },
		"empty payload":   func(o *Op) { o.Payload = nil },
		"invalid payload": func(o *Op) { o.Payload = json.RawMessage(`{`) },
	} {
		o := txnOp()
		mut(&o)
		if err := o.Validate(); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	in := []Op{txnOp(), rateOp()}
	b, err := EncodeBlob(in)
	if err != nil {
		t.Fatal(err)
	}
	if k, err := KindOf(b); err != nil || k != KindOps {
		t.Fatalf("KindOf = %q, %v", k, err)
	}
	out, err := DecodeBlob(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != len(in) {
		t.Fatalf("got %d ops, want %d", len(out), len(in))
	}
	for i := range in {
		if out[i].Type != in[i].Type || out[i].OpID != in[i].OpID ||
			!out[i].AuthoredAt.Equal(in[i].AuthoredAt) ||
			string(out[i].Payload) != string(in[i].Payload) {
			t.Fatalf("op %d changed across the wire:\n got %+v\nwant %+v", i, out[i], in[i])
		}
	}
	if out[0].Entity == nil || *out[0].Entity != *in[0].Entity {
		t.Fatalf("entity lost: %+v", out[0].Entity)
	}
	if out[1].Entity != nil || out[1].ParentVersion != nil {
		t.Fatalf("parent-free op grew a parent: %+v", out[1])
	}
}

func TestEncodeCanonicalisesAuthoredAtToUTC(t *testing.T) {
	o := txnOp()
	o.AuthoredAt = o.AuthoredAt.In(time.FixedZone("GST", 4*3600))
	b, err := EncodeBlob([]Op{o})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"authored_at":"2026-06-05T10:00:00Z"`) {
		t.Fatalf("authored_at must be canonical RFC3339 UTC on the wire: %s", b)
	}
}

func TestEncodeTruncatesAuthoredAtToMilliseconds(t *testing.T) {
	// Fork resolution compares authored_at and only then falls through to
	// writer_id. A JS Date holds milliseconds, so anything finer would let the
	// Go and TypeScript executors disagree about which of two ops is a tie.
	o := txnOp()
	o.AuthoredAt = o.AuthoredAt.Add(1500 * time.Microsecond)
	b, err := EncodeBlob([]Op{o})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"authored_at":"2026-06-05T10:00:00.001Z"`) {
		t.Fatalf("authored_at must be truncated to milliseconds: %s", b)
	}
	out, err := DecodeBlob(b)
	if err != nil {
		t.Fatal(err)
	}
	if got := out[0].AuthoredAt; got.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("decoded authored_at %v is finer than a millisecond", got)
	}
}

func TestEncodeBlobRejectsInvalidOps(t *testing.T) {
	o := txnOp()
	o.IngestID = ""
	if _, err := EncodeBlob([]Op{o}); err == nil {
		t.Fatal("EncodeBlob must not emit an op that Validate rejects")
	}
}

func TestRawBodyIsNotAnOpBlob(t *testing.T) {
	b, err := EncodeRawBody(RawBody{V: 1, Kind: KindRawBody, IngestID: ingestID(),
		ReceivedAt: time.Now().UTC(), RawBase64: "aGk="})
	if err != nil {
		t.Fatal(err)
	}
	if k, _ := KindOf(b); k != "raw_body" {
		t.Fatalf("KindOf = %q", k)
	}
	if _, err := DecodeBlob(b); err == nil {
		t.Fatal("a raw-body blob must not decode as an op list (invariant I16)")
	}
	ops, err := EncodeBlob([]Op{txnOp()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeRawBody(ops); err == nil {
		t.Fatal("an op blob must not decode as a raw body (invariant I16)")
	}
	got, err := DecodeRawBody(b)
	if err != nil {
		t.Fatal(err)
	}
	if got.IngestID != ingestID() || got.RawBase64 != "aGk=" {
		t.Fatalf("raw body round trip lost data: %+v", got)
	}
}

func TestCheckpointHeadsAreSortedAndStreamed(t *testing.T) {
	// canonical encoding of a writer_checkpoint payload sorts by (writer_id, stream)
	// and every entry names a stream — chains are per (writer_id, stream).
	heads := []CheckpointHead{
		{WriterID: "ingest", Stream: "hot", Counter: "9", Hash: strings.Repeat("b", 64)},
		{WriterID: "dev-a", Stream: "hot", Counter: "12", Hash: strings.Repeat("c", 64)},
		{WriterID: "ingest", Stream: "cold", Counter: "9", Hash: strings.Repeat("d", 64)},
	}
	p, err := EncodeCheckpointPayload(heads)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"heads":[` +
		`{"writer_id":"dev-a","stream":"hot","counter":"12","hash":"` + strings.Repeat("c", 64) + `"},` +
		`{"writer_id":"ingest","stream":"cold","counter":"9","hash":"` + strings.Repeat("d", 64) + `"},` +
		`{"writer_id":"ingest","stream":"hot","counter":"9","hash":"` + strings.Repeat("b", 64) + `"}]}`
	if string(p) != want {
		t.Fatalf("canonical checkpoint payload:\n got %s\nwant %s", p, want)
	}
	// The counter is a JSON string, not a number: a JS JSON.parse of a 2^53+
	// counter would be silently lossy.
	if strings.Contains(string(p), `"counter":12`) {
		t.Fatal("counters must be decimal strings on the wire")
	}

	got, err := DecodeCheckpointPayload(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].WriterID != "dev-a" || got[1].Stream != "cold" {
		t.Fatalf("decode lost the canonical order: %+v", got)
	}

	if _, err := EncodeCheckpointPayload([]CheckpointHead{
		{WriterID: "dev-a", Counter: "1", Hash: strings.Repeat("c", 64)},
	}); err == nil {
		t.Fatal("a head with no stream must be rejected: chains are per (writer_id, stream)")
	}
	if _, err := EncodeCheckpointPayload([]CheckpointHead{
		{WriterID: "dev-a", Stream: "hot", Counter: "1", Hash: strings.Repeat("c", 64)},
		{WriterID: "dev-a", Stream: "hot", Counter: "2", Hash: strings.Repeat("c", 64)},
	}); err == nil {
		t.Fatal("two heads for one (writer_id, stream) must be rejected")
	}
	if _, err := DecodeCheckpointPayload(json.RawMessage(`{"heads":[` +
		`{"writer_id":"ingest","stream":"hot","counter":"9","hash":"` + strings.Repeat("b", 64) + `"},` +
		`{"writer_id":"dev-a","stream":"hot","counter":"12","hash":"` + strings.Repeat("c", 64) + `"}]}`)); err == nil {
		t.Fatal("an unsorted heads array must be rejected: its encoding is not canonical")
	}
}

func TestKindOfRejectsNonBlobs(t *testing.T) {
	for _, in := range []string{``, `[]`, `{"v":1}`, `not json`} {
		if _, err := KindOf([]byte(in)); err == nil {
			t.Fatalf("KindOf(%q) must fail", in)
		}
	}
}
