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

// TestDecodeTruncatesAuthoredAtToMilliseconds covers the half of the rule that
// matters most: the encoder is not the only writer. Task 10's writer is
// TypeScript, and a blob from anywhere can carry sub-millisecond precision that
// a JS Date cannot represent — Go would read 1500ns where JS reads 0ms, the two
// executors would disagree about whether two ops are an exact tie, and fork
// resolution would hand the same log to different winners. Enforcing it on the
// READ side is the only place it holds against a writer we do not control.
func TestDecodeTruncatesAuthoredAtToMilliseconds(t *testing.T) {
	for _, tc := range []struct {
		wire string
		want time.Time
	}{
		{"2026-06-05T10:00:00.0000015Z", time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC)},
		{"2026-06-05T10:00:00.0015Z", time.Date(2026, 6, 5, 10, 0, 0, 1e6, time.UTC)},
		{"2026-06-05T14:00:00.5+04:00", time.Date(2026, 6, 5, 10, 0, 0, 5e8, time.UTC)},
	} {
		b := []byte(`{"v":1,"kind":"ops","ops":[{"v":1,"type":"rate_set","op_id":"r",` +
			`"authored_at":"` + tc.wire + `","parent_version":null,"payload":{}}]}`)
		ops, err := DecodeBlob(b)
		if err != nil {
			t.Fatalf("%s: %v", tc.wire, err)
		}
		got := ops[0].AuthoredAt
		if !got.Equal(tc.want) {
			// tc.want is exactly what Date.parse(wire) yields, to the millisecond.
			t.Fatalf("decoded %s as %v, want %v — Go and JS must read the same instant",
				tc.wire, got, tc.want)
		}
		if got.Nanosecond()%int(time.Millisecond) != 0 {
			t.Fatalf("decoded %s with sub-millisecond precision a JS Date cannot hold: %v", tc.wire, got)
		}
	}
}

// TestGoldenOpBytes pins the literal wire encoding. TestEncodeDecodeRoundTrip
// cannot: it passes through the same encoder in both directions, so a field
// rename, an added omitempty, or parent_version moving between present-null and
// absent would round-trip perfectly and silently break Task 10's mirror.
func TestGoldenOpBytes(t *testing.T) {
	// The op set lives in conformance_test.go's goldenOps, because these exact
	// three ops are also the plaintext of the hot conformance fixture the
	// TypeScript executor reads. One literal, or the fixture and the golden can
	// drift apart while both keep passing.
	got, err := EncodeBlob(goldenOps())
	if err != nil {
		t.Fatal(err)
	}
	want := `{"v":1,"kind":"ops","ops":[` +
		`{"v":1,"type":"txn_ingested","op_id":"01J000000000000000000000I1",` +
		`"authored_at":"2026-06-05T10:00:00Z","entity":{"kind":"txn","id":"T1"},` +
		`"parent_version":null,"ingest_id":"` + strings.Repeat("a", 64) + `",` +
		`"payload":{"amount_minor":"25000","currency":"AED"}},` +
		`{"v":1,"type":"txn_categorized","op_id":"01J000000000000000000000A1",` +
		`"authored_at":"2026-06-05T10:00:00Z","entity":{"kind":"txn","id":"T1"},` +
		`"parent_version":3,"payload":{"category":"groceries"}},` +
		`{"v":1,"type":"rate_set","op_id":"01J000000000000000000000R1",` +
		`"authored_at":"2026-06-05T10:00:00Z","parent_version":null,` +
		`"payload":{"currency":"USD","rate_micro":"3672500"}}]}`
	if string(got) != want {
		t.Fatalf("op wire encoding changed — Task 10's TypeScript mirror is written against these bytes:\n got %s\nwant %s", got, want)
	}

	// entity is omitted entirely on a parent-free op, but parent_version is
	// PRESENT and null on both: a create and a parent-free op are distinguished
	// by the type, never by the field's absence.
	if strings.Count(string(got), `"parent_version"`) != 3 {
		t.Fatalf("parent_version must be present on every op, null included: %s", got)
	}
	if strings.Count(string(got), `"ingest_id"`) != 1 {
		t.Fatalf("ingest_id must appear on the ingest op and be omitted when empty: %s", got)
	}
}

func TestGoldenRawBodyBytes(t *testing.T) {
	got, err := EncodeRawBody(RawBody{
		IngestID:   strings.Repeat("a", 64),
		ReceivedAt: time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC),
		RawBase64:  "aGk=",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"v":1,"kind":"raw_body","ingest_id":"` + strings.Repeat("a", 64) +
		`","received_at":"2026-06-05T10:00:00Z","raw_base64":"aGk="}`
	if string(got) != want {
		t.Fatalf("raw body wire encoding changed:\n got %s\nwant %s", got, want)
	}
}

func TestValidateRejectsIngestIDOnNonIngestOps(t *testing.T) {
	// ingest_id is omitempty, so an unchecked value rides into a frozen wire
	// model and joins to nothing.
	o := rateOp()
	o.IngestID = "junk"
	if err := o.Validate(); err == nil {
		t.Fatal("rate_set carrying an ingest_id must be rejected")
	}
	o = txnOp()
	o.Type = OpTxnCategorized
	o.Payload = json.RawMessage(`{"category":"groceries"}`)
	if err := o.Validate(); err == nil {
		t.Fatal("txn_categorized carrying an ingest_id must be rejected")
	}
	o.IngestID = ""
	if err := o.Validate(); err != nil {
		t.Fatalf("txn_categorized without an ingest_id must validate: %v", err)
	}
}

func TestDecodeRawBodyRejectsBadVersions(t *testing.T) {
	for _, v := range []string{"0", "-5", "2"} {
		b := []byte(`{"v":` + v + `,"kind":"raw_body","ingest_id":"` + ingestID() +
			`","received_at":"2026-06-05T10:00:00Z","raw_base64":"aGk="}`)
		if _, err := DecodeRawBody(b); err == nil {
			t.Fatalf("raw body v%s must be rejected", v)
		}
	}
	b := []byte(`{"v":2,"kind":"raw_body","ingest_id":"` + ingestID() +
		`","received_at":"2026-06-05T10:00:00Z","raw_base64":"aGk="}`)
	if _, err := DecodeRawBody(b); !errors.Is(err, ErrUnknownNewerVersion) {
		t.Fatalf("a newer raw body must hard-stop like a newer op blob, got %v", err)
	}
}

func TestKindOfRejectsNonBlobs(t *testing.T) {
	for _, in := range []string{``, `[]`, `{"v":1}`, `not json`} {
		if _, err := KindOf([]byte(in)); err == nil {
			t.Fatalf("KindOf(%q) must fail", in)
		}
	}
}

// TestWireTimeAcceptsExactlyWhatTypeScriptAccepts pins the timestamp grammar
// against the table of disagreements that motivated it. Every row here was
// MEASURED against both runtimes, not assumed: time.Time's unmarshaller and
// JavaScript's Date.parse are lenient in different directions, and a timestamp
// either executor reads differently is a blob that lands in one log and not the
// other. Since authored_at is the fork tiebreak, that is two devices
// materialising different money.
func TestWireTimeAcceptsExactlyWhatTypeScriptAccepts(t *testing.T) {
	// Rejected here AND by the TypeScript parseInstantMs. The first two are the
	// ones stock Go already refused and Date.parse silently ROLLED OVER —
	// 2026-02-30 became March 2nd, an instant no legal reading produces.
	for _, s := range []string{
		"2026-06-05T24:00:00Z",      // hour 24: Date.parse rolls to the next day
		"2026-02-30T10:00:00Z",      // Date.parse rolls to March 2nd
		"2026-02-29T00:00:00Z",      // 2026 is not a leap year
		"2026-13-05T10:00:00Z",      // month 13
		"2026-06-05T10:60:00Z",      // minute 60
		"2026-06-05T10:00:60Z",      // second 60 (no leap seconds)
		"2026-06-05T10:00:00+24:00", // stock Go ACCEPTED this; Date.parse refuses it
		"2026-06-05T10:00:00+24:60", // stock Go read this as -25h
		"2026-06-05T10:00:00+00:60", // stock Go read this as -1h
		"2026-06-05t10:00:00z",      // lowercase: Date.parse accepts, RFC3339 layout does not
		"2026-06-05 10:00:00Z",      // space separator
		"2026-06-05T10:00:00",       // no zone
		"2026-06-05T10:00:00.Z",     // empty fraction
		"2026-06-05",
		"June 5 2026",
		"",
	} {
		if _, err := parseWireTime(s); err == nil {
			t.Errorf("parseWireTime(%q) must be refused: the TypeScript executor refuses it", s)
		}
	}

	// Accepted by both, and at the same instant.
	for _, tc := range []struct {
		wire string
		want time.Time
	}{
		{"2026-06-05T10:00:00Z", time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC)},
		{"2026-06-05T10:00:00.5Z", time.Date(2026, 6, 5, 10, 0, 0, 5e8, time.UTC)},
		{"2026-06-05T14:00:00.5+04:00", time.Date(2026, 6, 5, 10, 0, 0, 5e8, time.UTC)},
		{"2026-06-05T10:00:00-00:00", time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC)},
		{"2026-06-05T10:00:00+23:59", time.Date(2026, 6, 4, 10, 1, 0, 0, time.UTC)},
		{"2024-02-29T00:00:00Z", time.Date(2024, 2, 29, 0, 0, 0, 0, time.UTC)},
		{"2000-02-29T00:00:00Z", time.Date(2000, 2, 29, 0, 0, 0, 0, time.UTC)}, // divisible by 400
	} {
		got, err := parseWireTime(tc.wire)
		if err != nil {
			t.Errorf("parseWireTime(%q): %v", tc.wire, err)
			continue
		}
		if !got.Equal(tc.want) {
			t.Errorf("parseWireTime(%q) = %v, want %v", tc.wire, got.UTC(), tc.want)
		}
	}
}

// TestDecodeRejectsOutOfRangeTimestampsInABlob checks the strictness is wired
// into the DECODE path and not merely available as a helper.
func TestDecodeRejectsOutOfRangeTimestampsInABlob(t *testing.T) {
	for _, wire := range []string{"2026-02-30T10:00:00Z", "2026-06-05T24:00:00Z", "2026-06-05T10:00:00+24:00"} {
		if _, err := DecodeBlob(timeProbeBlob(wire)); err == nil {
			t.Errorf("an op carrying authored_at %q must not decode", wire)
		} else if errors.Is(err, ErrUnknownNewerVersion) {
			// A malformed timestamp is a set-aside, never the sync hard stop.
			t.Errorf("authored_at %q must not be reported as an unknown newer version", wire)
		}
	}
	body := func(receivedAt string) []byte {
		return []byte(`{"v":1,"kind":"raw_body","ingest_id":"` + ingestID() +
			`","received_at":"` + receivedAt + `","raw_base64":"aGk="}`)
	}
	if _, err := DecodeRawBody(body("2026-02-30T10:00:00Z")); err == nil {
		t.Error("a cold record with a rolled-over received_at must not decode")
	}
	if _, err := DecodeRawBody(body("2026-06-05T10:00:00Z")); err != nil {
		t.Errorf("a well-formed cold record must decode: %v", err)
	}
}

// TestDecodeRawBodyValidatesItsPayload covers the gap that let a base64url
// payload cross the executor boundary green: this decoder returned RawBase64 as
// an unexamined string, so records the TypeScript side refused decoded happily
// here — and the conformance fixtures only ever called this function.
func TestDecodeRawBodyValidatesItsPayload(t *testing.T) {
	body := func(raw string) []byte {
		return []byte(`{"v":1,"kind":"raw_body","ingest_id":"` + ingestID() +
			`","received_at":"2026-06-05T10:00:00Z","raw_base64":"` + raw + `"}`)
	}
	for _, raw := range []string{
		"a GK=", // whitespace
		"aGk",   // unpadded standard base64
		"aG!=",  // outside the alphabet
		"-_8=",  // base64URL, which StdEncoding must not accept
		"not b64",
	} {
		if _, err := DecodeRawBody(body(raw)); err == nil {
			t.Errorf("raw_base64 %q must be refused", raw)
		}
	}
	r, err := DecodeRawBody(body("aGk="))
	if err != nil {
		t.Fatal(err)
	}
	if r.RawBase64 != "aGk=" {
		t.Fatalf("raw_base64 round trip lost data: %q", r.RawBase64)
	}
	// received_at is required: it used to be absent-tolerant, so a record with no
	// timestamp at all decoded to the zero time and looked like 0001-01-01.
	if _, err := DecodeRawBody([]byte(`{"v":1,"kind":"raw_body","ingest_id":"` + ingestID() +
		`","raw_base64":"aGk="}`)); err == nil {
		t.Error("a cold record with no received_at must be refused")
	}
	if _, err := DecodeRawBody([]byte(`{"v":1,"kind":"raw_body","ingest_id":"` + ingestID() +
		`","received_at":"0001-01-01T00:00:00Z","raw_base64":"aGk="}`)); err == nil {
		t.Error("a cold record with a zero received_at must be refused")
	}
}
