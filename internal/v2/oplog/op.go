// Package oplog defines the operation wire model: what a single mutation of a
// user's ledger looks like once it is encoded, and what the two blob kinds
// carry.
//
// # A frozen contract, mirrored in TypeScript
//
// These shapes are ported verbatim to the client. Two independent executors —
// this one and the TypeScript one — must fold the same log into the same state,
// so anything ambiguous across the two languages is a defect here, not there.
// That is why:
//
//   - Money and counters are JSON STRINGS holding decimal integers. A JS
//     JSON.parse of a number silently produces a float64; "25000" cannot be
//     rounded by accident, and money is int64 minor units everywhere.
//   - writer_checkpoint.heads is a sorted ARRAY, not a map, so its canonical
//     encoding is unambiguous in both languages ([EncodeCheckpointPayload]).
//   - AuthoredAt is normalised to UTC and truncated to milliseconds on encode
//     AND on decode, so a writer in either language cannot introduce precision
//     the other cannot represent.
//
// What is deliberately NOT claimed is byte-identical JSON across the two
// languages. Go trims trailing zeros from a timestamp ("…:00.5Z") where
// JavaScript's toISOString always pads to three digits ("…:00.500Z"), and
// encoding/json escapes <, > and & as \uXXXX where JSON.stringify emits them
// literally. Nothing here depends on closing that gap: each blob is encoded
// exactly once, by its author, and blob.Hash chains the bytes as stored, so the
// two encoders never have to agree byte-for-byte. What they must agree on is the
// parsed value, which is what the millisecond rule guarantees.
//
// # That safety rests on a usage property, not on this code
//
// "Encoded exactly once, by its author" is true of the system as designed, not
// enforced by anything here. THE MOMENT ANYTHING RE-ENCODES AN OP IT DID NOT
// AUTHOR — log compaction, a snapshot rewrite, a migration that re-serializes —
// byte-inequality stops being cosmetic and becomes a chain break, and which
// executor did the rewriting decides whose chain survives. Compaction is
// deferred (spec §3.3), and undeferring it means first making op encoding
// byte-canonical across both languages, or re-chaining deliberately from the
// rewrite point. Reprocess appends a new supersede op rather than rewriting one,
// which is what keeps this true today.
//
// # Ordering: seq folds, authored_at only breaks ties
//
// The server assigns a per-user total order (seq) at append time. Replay folds
// by seq. [Op.AuthoredAt] is a client clock and is used for ONE thing: breaking
// a fork between two ops claiming the same parent version. Nothing else may
// read it, and in particular FX resolution never does (spec §3.7).
//
// # Parent-free ops
//
// rate_set, rate_unset and home_currency_set are append-only facts, not
// versioned entities: they name no entity and carry no parent_version, so they
// can never fork and never need author-timestamp resolution. Modelling rates as
// versioned entities imports fork resolution into FX, and the two readings
// produce different numbers across the two mandated executors — which is why
// this is enforced by [Op.Validate] rather than left to convention. A
// writer_checkpoint is likewise a standalone attestation.
//
// # Unknown newer versions hard-stop; unopenable blobs do not
//
// [ErrUnknownNewerVersion] is a HARD STOP: a client that meets an op it cannot
// interpret must stop syncing and demand an upgrade rather than fold a
// half-understood log into money (spec §3.3:68). That is deliberately narrower
// than "something went wrong" — a blob that will not open is set aside with a
// warning (blob.ErrSetAside), because one bad blob must not strand a device.
//
// # Cold blobs are not op blobs
//
// The cold stream carries [RawBody] records — raw email — and nothing that
// mutates state. That is what makes a hot-only sync a COMPLETE materialization,
// and it is asserted as invariant I16 rather than trusted as a convention:
// [DecodeBlob] refuses a raw-body blob and [DecodeRawBody] refuses an op blob.
package oplog

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

// SchemaVersion is the op schema this build understands. It versions the OPS;
// blob.Version versions the framing around them.
const SchemaVersion = 2

// Blob kinds. KindOf reports which one a decoded blob claims to be.
const (
	KindOps     = "ops"
	KindRawBody = "raw_body"
)

// ErrUnknownNewerVersion is the sync hard stop: the log contains an op schema
// version this build does not understand, so replay must not continue.
var ErrUnknownNewerVersion = errors.New("op schema version newer than supported")

// OpType is the operation discriminator. The set is closed at a given
// SchemaVersion — a new type arrives with a version bump, which is what makes
// ErrUnknownNewerVersion a sufficient forward-compatibility mechanism.
type OpType string

const (
	OpTxnIngested             OpType = "txn_ingested"
	OpTxnSuperseded           OpType = "txn_superseded"
	OpTxnCategorized          OpType = "txn_categorized"
	OpTxnSplit                OpType = "txn_split"
	OpTxnEdited               OpType = "txn_edited"
	OpTxnDuplicateDisposition OpType = "txn_duplicate_disposition"
	OpRuleAdded               OpType = "rule_added"
	OpRateSet                 OpType = "rate_set"
	OpRateUnset               OpType = "rate_unset"
	OpHomeCurrencySet         OpType = "home_currency_set"
	OpWriterCheckpoint        OpType = "writer_checkpoint"
)

// Types lists every op type at SchemaVersion, in wire order.
var Types = []OpType{
	OpTxnIngested, OpTxnSuperseded, OpTxnCategorized, OpTxnSplit, OpTxnEdited, OpTxnDuplicateDisposition,
	OpRuleAdded, OpRateSet, OpRateUnset, OpHomeCurrencySet, OpWriterCheckpoint,
}

// Valid reports whether t is a type this schema version defines.
func (t OpType) Valid() bool { return slices.Contains(Types, t) }

func (t OpType) minVersion() int {
	if t == OpTxnDuplicateDisposition {
		return 2
	}
	return 1
}

// ParentFree reports whether t is an append-only fact rather than a mutation of
// a versioned entity. Parent-free ops name no entity, carry no parent_version,
// and are folded purely by position — see the package doc on FX determinism.
func (t OpType) ParentFree() bool {
	switch t {
	case OpRateSet, OpRateUnset, OpHomeCurrencySet, OpWriterCheckpoint:
		return true
	default:
		return false
	}
}

// EntityRef names the versioned entity a causal op mutates.
type EntityRef struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// Op is a single operation. Its position within a blob is its intra-blob index;
// the blob's own position is carried by blob.Envelope, never in here.
type Op struct {
	V             int             `json:"v"`
	Type          OpType          `json:"type"`
	OpID          string          `json:"op_id"`               // ULID, author-assigned
	AuthoredAt    time.Time       `json:"authored_at"`         // RFC3339 UTC; fork tiebreak ONLY
	Entity        *EntityRef      `json:"entity,omitempty"`    // nil on a parent-free op
	ParentVersion *int64          `json:"parent_version"`      // nil = create, or parent-free op
	IngestID      string          `json:"ingest_id,omitempty"` // hex sha256 of the raw body
	Payload       json.RawMessage `json:"payload"`
}

// UnmarshalJSON decodes an op, routing authored_at through [parseWireTime] so
// that the two mandated executors accept exactly the same set of timestamps.
// Without it, time.Time's lenient unmarshaller and JavaScript's Date.parse
// disagree in three different directions — see parseWireTime.
func (o *Op) UnmarshalJSON(b []byte) error {
	type alias Op // sheds this method, so the rest of the op decodes normally
	var raw struct {
		*alias
		// Shadows the embedded field. Outer fields sit at depth 0 and win over
		// embedded ones at depth 1, so authored_at arrives here as its literal
		// string and never reaches time.Time's unmarshaller at all.
		AuthoredAt string `json:"authored_at"`
	}
	raw.alias = (*alias)(o)
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	t, err := parseWireTime(raw.AuthoredAt)
	if err != nil {
		return fmt.Errorf("authored_at: %w", err)
	}
	o.AuthoredAt = t
	return nil
}

// Validate enforces the structural rules replay depends on. It deliberately
// does NOT interpret Payload: payload shapes are per-type and belong to the
// executors, but a payload that is not even JSON must never reach them.
func (o Op) Validate() error {
	if o.V > SchemaVersion {
		return fmt.Errorf("%w: op %s is v%d", ErrUnknownNewerVersion, o.OpID, o.V)
	}
	if o.V < 1 {
		return fmt.Errorf("op %s: version %d is not valid", o.OpID, o.V)
	}
	if o.Type == "" {
		return fmt.Errorf("op %s: type is empty", o.OpID)
	}
	if !o.Type.Valid() {
		return fmt.Errorf("op %s: unknown type %q", o.OpID, o.Type)
	}
	if o.V < o.Type.minVersion() {
		return fmt.Errorf("op %s: type %q requires schema v%d", o.OpID, o.Type, o.Type.minVersion())
	}
	if o.OpID == "" {
		return fmt.Errorf("op of type %s: op_id is empty", o.Type)
	}
	if o.AuthoredAt.IsZero() {
		return fmt.Errorf("op %s: authored_at is zero", o.OpID)
	}
	// The ENCODE half of the closure rule (see [canonicalTime]); parseWireTime
	// is the decode half. Without it a Go writer whose clock is past year 9999
	// gets `json: error calling MarshalJSON for type time.Time` out of
	// EncodeBlob — an error naming neither the op nor the field — instead of
	// being told which timestamp the wire cannot carry.
	if _, err := canonicalTime(o.AuthoredAt); err != nil {
		return fmt.Errorf("op %s: authored_at %w", o.OpID, err)
	}

	if o.Type.ParentFree() {
		if o.Entity != nil {
			return fmt.Errorf("op %s: %s is parent-free and must not name an entity", o.OpID, o.Type)
		}
		if o.ParentVersion != nil {
			return fmt.Errorf("op %s: %s is parent-free and must not carry a parent_version", o.OpID, o.Type)
		}
	} else {
		if o.Entity == nil {
			return fmt.Errorf("op %s: %s must name an entity", o.OpID, o.Type)
		}
		if o.Entity.Kind == "" || o.Entity.ID == "" {
			return fmt.Errorf("op %s: entity needs both a kind and an id", o.OpID)
		}
		if o.ParentVersion != nil && *o.ParentVersion < 0 {
			return fmt.Errorf("op %s: parent_version %d is negative", o.OpID, *o.ParentVersion)
		}
	}

	switch o.Type {
	case OpTxnIngested, OpTxnSuperseded:
		// The ingest id joins a hot op to its cold raw body. Without it that
		// join is unrecoverable, since the cold stream is fetched separately.
		if !isSHA256Hex(o.IngestID) {
			return fmt.Errorf("op %s: %s needs a 64-hex-char ingest_id, got %q", o.OpID, o.Type, o.IngestID)
		}
	default:
		// ingest_id is omitempty, so an unchecked value on any other op type is
		// junk riding into a frozen wire model — and a future reader that joins
		// on it would join to nothing.
		if o.IngestID != "" {
			return fmt.Errorf("op %s: %s must not carry an ingest_id, got %q", o.OpID, o.Type, o.IngestID)
		}
	}

	if len(o.Payload) == 0 {
		return fmt.Errorf("op %s: payload is empty", o.OpID)
	}
	if !json.Valid(o.Payload) {
		return fmt.Errorf("op %s: payload is not valid JSON", o.OpID)
	}
	if o.Type == OpTxnDuplicateDisposition {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(o.Payload, &fields); err != nil {
			return fmt.Errorf("op %s: duplicate disposition payload: %w", o.OpID, err)
		}
		if _, ok := fields["disposition"]; !ok {
			return fmt.Errorf("op %s: duplicate disposition needs disposition", o.OpID)
		}
		var p struct {
			OtherTxnID  string  `json:"other_txn_id"`
			Disposition *string `json:"disposition"`
		}
		if err := json.Unmarshal(o.Payload, &p); err != nil {
			return fmt.Errorf("op %s: duplicate disposition payload: %w", o.OpID, err)
		}
		if p.OtherTxnID == "" {
			return fmt.Errorf("op %s: duplicate disposition needs other_txn_id", o.OpID)
		}
		if p.Disposition != nil && *p.Disposition != "same" && *p.Disposition != "different" {
			return fmt.Errorf("op %s: duplicate disposition must be same, different, or null", o.OpID)
		}
	}
	return nil
}

// canonicalTime puts a timestamp in the one form both executors read
// identically: UTC, truncated to milliseconds — and refuses one whose canonical
// form is not itself a wire timestamp.
//
// The truncation is not cosmetic. Fork resolution compares authored_at and
// falls through to writer_id only on an exact tie, and JavaScript's Date
// carries milliseconds — so a Go writer emitting microseconds would produce two
// ops that Go orders and TypeScript calls tied, i.e. two executors materialising
// different money from the same log. Rounding to what both can represent removes
// the disagreement at the source rather than asking the TS port to compensate.
//
// # Why canonicalisation has to be CLOSED over the wire grammar
//
// [rfc3339Shape] admits a four-digit year with a UTC offset of up to ±23:59, so
// "9999-12-31T23:59:59-23:59" is a wire-legal timestamp whose UTC value lands in
// year 10000 — and "0000-01-01T00:00:00+00:01" is its mirror, landing in year
// −1. Neither year can be written back in the four-digit grammar both executors
// enforce, and the two languages do not even SPELL the overflow the same way:
//
//	                             Go Format(RFC3339Nano)   JS toISOString
//	9999-12-31T23:59:59-23:59    10000-01-01T23:58:59Z    +010000-01-01T23:58:59.000Z
//	0000-01-01T00:00:00+00:01    -0001-12-31T23:59:00Z    -000001-12-31T23:59:00.000Z
//
// Measured, not assumed. On the JSON path Go cannot even emit its spelling:
// time.Time.MarshalJSON refuses a year outside [0,9999] outright, so the whole
// blob fails to encode. What that left was an ACCEPTANCE divergence, which is
// the worse half — this decoder read both strings happily while the TypeScript
// one set the blob aside, so an op could be in one executor's log and in
// neither device's, with nothing in the build able to see it.
//
// The rule is therefore that a canonical form must be re-readable as a wire
// timestamp, and the check is that round trip rather than a year-range test, so
// it cannot drift from whatever the renderer actually produces. Both executors
// apply it in the same place, and both refuse the same two boundary strings —
// pinned in conformance/op/manifest.json's authored_at_rejects.
func canonicalTime(t time.Time) (time.Time, error) {
	c := t.UTC().Truncate(time.Millisecond)
	if s := c.Format(time.RFC3339Nano); !rfc3339Shape.MatchString(s) {
		return time.Time{}, fmt.Errorf("canonicalises to %q, which is outside the four-digit-year range this wire format carries", s)
	}
	return c, nil
}

// CanonicalWireTime is [canonicalTime]'s string half: the one rendering of an
// instant that every v2 Go writer must use for a timestamp it puts on the wire.
//
// It is exported so there is ONE renderer rather than one per package. The
// ingest pipeline had its own (`t.UTC().Truncate(time.Millisecond).
// Format(time.RFC3339Nano)`, for a transaction's posted_at) which was the same
// expression without the closure check, and would therefore have written the
// five-digit spelling above into a payload where the TypeScript executor writes
// the expanded-year one. A second renderer is a second spelling.
func CanonicalWireTime(t time.Time) (string, error) {
	c, err := canonicalTime(t)
	if err != nil {
		return "", fmt.Errorf("oplog: timestamp %s: %w", t.UTC().Format(time.RFC3339Nano), err)
	}
	return c.Format(time.RFC3339Nano), nil
}

// rfc3339Shape is the timestamp grammar BOTH executors accept: 4-digit year,
// mandatory uppercase T and Z (or a numeric offset), an optional non-empty
// fraction.
var rfc3339Shape = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$`)

// parseWireTime parses a timestamp off the wire, accepting exactly what the
// TypeScript executor accepts and nothing else.
//
// # Why this is not just time.Parse(time.RFC3339, s)
//
// time.Time's UnmarshalJSON is documented-lenient (go.dev/issue/47353 tracks
// making it strict) and its leniency is not JavaScript's:
//
//	2026-06-05T24:00:00Z       Go rejects,  Date.parse ACCEPTS as the 6th, 00:00
//	2026-02-30T10:00:00Z       Go rejects,  Date.parse ACCEPTS as MARCH 2nd
//	2026-06-05T10:00:00+24:00  Go ACCEPTS,  Date.parse rejects
//	2026-06-05T10:00:00+24:60  Go ACCEPTS as -25h, Date.parse rejects
//
// Every row is a blob that lands in one executor's log and not the other's, and
// the second is worse than that: it folds at an instant no legal reading of the
// string produces. Since authored_at is the fork tiebreak (see the package doc),
// a disagreement here is two devices materialising different money.
//
// The fix is symmetric strictness rather than either side mirroring the other's
// quirks. Go's date/time components are already range-checked by time.Parse; the
// part it waves through is the ZONE, so that is what this adds. Choosing the
// canonical RFC 3339 reading (offset hours 00-23, minutes 00-59) rather than
// Go's current leniency also means that if the stdlib is tightened later it
// converges on this rule instead of drifting away from it.
//
// Nothing legitimate is refused: both encoders always write UTC "Z", so an
// offset at all can only come from a third implementation, and a timestamp that
// will not parse sets its blob aside rather than hard-stopping sync.
func parseWireTime(s string) (time.Time, error) {
	if !rfc3339Shape.MatchString(s) {
		return time.Time{}, fmt.Errorf("timestamp %q is not RFC3339", s)
	}
	if zone := s[len(s)-6:]; zone[0] == '+' || zone[0] == '-' {
		// Indices are safe: the shape above fixes the zone at exactly ±hh:mm.
		hh, mm := (zone[1]-'0')*10+(zone[2]-'0'), (zone[4]-'0')*10+(zone[5]-'0')
		if hh > 23 || mm > 59 {
			return time.Time{}, fmt.Errorf("timestamp %q has an out-of-range UTC offset", s)
		}
	}
	// time.Parse range-checks month, day (leap years included), hour, minute and
	// second, so 2026-02-30 and 24:00:00 are already refused here.
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("timestamp %q: %w", s, err)
	}
	// Wire-legal is not the same as canonicalisable: the offset can carry a
	// four-digit year out of the four-digit-year grammar in either direction.
	// See [canonicalTime] — this is the acceptance half of that divergence, and
	// refusing here is what makes the two executors set aside the same blobs.
	if _, cerr := canonicalTime(t); cerr != nil {
		return time.Time{}, fmt.Errorf("timestamp %q %w", s, cerr)
	}
	return t, nil
}

func isSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f':
		default:
			return false
		}
	}
	return true
}

// opBlob is the hot-stream blob body: {"v":1,"kind":"ops","ops":[...]}.
type opBlob struct {
	V    int    `json:"v"`
	Kind string `json:"kind"`
	Ops  []Op   `json:"ops"`
}

// blobHeader reads only what decides how to treat a blob, so a version check
// never depends on being able to parse the body.
type blobHeader struct {
	V    int    `json:"v"`
	Kind string `json:"kind"`
}

// EncodeBlob encodes ops as a hot-stream blob body. Every op is validated
// first: an invalid op that reaches the log is permanent, because the log is
// append-only.
func EncodeBlob(ops []Op) ([]byte, error) {
	version := 1
	out := make([]Op, len(ops))
	for i, o := range ops {
		if err := o.Validate(); err != nil {
			return nil, fmt.Errorf("oplog: op %d: %w", i, err)
		}
		ct, err := canonicalTime(o.AuthoredAt)
		if err != nil {
			return nil, fmt.Errorf("oplog: op %d: authored_at %w", i, err)
		}
		o.AuthoredAt = ct
		out[i] = o
		if o.V > version {
			version = o.V
		}
	}
	return json.Marshal(opBlob{V: version, Kind: KindOps, Ops: out})
}

// DecodeBlob decodes a hot-stream blob body. It refuses a raw-body blob
// (invariant I16) and hard-stops on an unknown newer schema version, at the
// blob level or on any op inside it.
//
// Callers must split its errors two ways: errors.Is(err, ErrUnknownNewerVersion)
// means STOP SYNCING, anything else means this one blob is unreadable and gets
// set aside with a warning while the rest of the log proceeds.
func DecodeBlob(b []byte) ([]Op, error) {
	var h blobHeader
	if err := json.Unmarshal(b, &h); err != nil {
		return nil, fmt.Errorf("oplog: decode blob: %w", err)
	}
	if h.V > SchemaVersion {
		return nil, fmt.Errorf("%w: blob is v%d, this build supports v%d", ErrUnknownNewerVersion, h.V, SchemaVersion)
	}
	if h.V < 1 {
		return nil, fmt.Errorf("oplog: blob version %d is not valid", h.V)
	}
	if h.Kind != KindOps {
		return nil, fmt.Errorf("oplog: blob kind is %q, not %q", h.Kind, KindOps)
	}

	var blob opBlob
	if err := json.Unmarshal(b, &blob); err != nil {
		return nil, fmt.Errorf("oplog: decode blob: %w", err)
	}
	for i, o := range blob.Ops {
		if err := o.Validate(); err != nil {
			return nil, fmt.Errorf("oplog: op %d: %w", i, err)
		}
		// Canonicalise on the way IN as well as out. Encode-side truncation
		// alone only holds while every writer is this encoder, and Task 10's
		// writer is TypeScript: a blob carrying "…:00.0000015Z" parses here to
		// 1500ns and in JS to 0ms, so the two executors would disagree about
		// whether two ops are an exact tie and hand the fork to different
		// winners. Truncating on decode converges instead of setting the blob
		// aside, and it makes the guarantee a property of the READER, which is
		// the only place it can be enforced against a writer we do not control.
		//
		// Cannot fail here: Op.UnmarshalJSON routed authored_at through
		// parseWireTime, which already refused anything this would refuse. The
		// error is still handled rather than dropped, because "cannot fail" is a
		// property of the caller and this is the reader half of a dual-executor
		// contract.
		ct, cerr := canonicalTime(o.AuthoredAt)
		if cerr != nil {
			return nil, fmt.Errorf("oplog: op %d: authored_at %w", i, cerr)
		}
		blob.Ops[i].AuthoredAt = ct
	}
	return blob.Ops, nil
}

// RawBody is a cold-stream record: one raw email, joined to its hot op by
// IngestID. Cold blobs are NOT op blobs — they carry no state (invariant I16).
type RawBody struct {
	V          int       `json:"v"`
	Kind       string    `json:"kind"`      // always "raw_body"
	IngestID   string    `json:"ingest_id"` // hex sha256, joins to the hot op
	ReceivedAt time.Time `json:"received_at"`
	RawBase64  string    `json:"raw_base64"`
}

// UnmarshalJSON decodes a cold record, routing received_at through
// [parseWireTime] for the same reason [Op.UnmarshalJSON] does.
func (r *RawBody) UnmarshalJSON(b []byte) error {
	type alias RawBody
	var raw struct {
		*alias
		ReceivedAt string `json:"received_at"`
	}
	raw.alias = (*alias)(r)
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	t, err := parseWireTime(raw.ReceivedAt)
	if err != nil {
		return fmt.Errorf("received_at: %w", err)
	}
	r.ReceivedAt = t
	return nil
}

// EncodeRawBody encodes a cold-stream record.
func EncodeRawBody(r RawBody) ([]byte, error) {
	if r.V == 0 {
		r.V = 1 // raw-body shape did not change with the op-schema v2 addition
	}
	if r.V > SchemaVersion || r.V < 1 {
		return nil, fmt.Errorf("oplog: raw body version %d is not valid", r.V)
	}
	if r.Kind == "" {
		r.Kind = KindRawBody
	}
	if r.Kind != KindRawBody {
		return nil, fmt.Errorf("oplog: raw body kind is %q, not %q", r.Kind, KindRawBody)
	}
	if !isSHA256Hex(r.IngestID) {
		return nil, fmt.Errorf("oplog: raw body needs a 64-hex-char ingest_id, got %q", r.IngestID)
	}
	if r.ReceivedAt.IsZero() {
		return nil, errors.New("oplog: raw body received_at is zero")
	}
	ct, err := canonicalTime(r.ReceivedAt)
	if err != nil {
		return nil, fmt.Errorf("oplog: raw body received_at %w", err)
	}
	r.ReceivedAt = ct
	return json.Marshal(r)
}

// DecodeRawBody decodes a cold-stream record, refusing an op blob.
func DecodeRawBody(b []byte) (RawBody, error) {
	var h blobHeader
	if err := json.Unmarshal(b, &h); err != nil {
		return RawBody{}, fmt.Errorf("oplog: decode raw body: %w", err)
	}
	if h.V > SchemaVersion {
		return RawBody{}, fmt.Errorf("%w: raw body is v%d, this build supports v%d", ErrUnknownNewerVersion, h.V, SchemaVersion)
	}
	if h.V < 1 {
		return RawBody{}, fmt.Errorf("oplog: raw body version %d is not valid", h.V)
	}
	if h.Kind != KindRawBody {
		return RawBody{}, fmt.Errorf("oplog: blob kind is %q, not %q", h.Kind, KindRawBody)
	}
	var r RawBody
	if err := json.Unmarshal(b, &r); err != nil {
		return RawBody{}, fmt.Errorf("oplog: decode raw body: %w", err)
	}
	if !isSHA256Hex(r.IngestID) {
		return RawBody{}, fmt.Errorf("oplog: raw body has no usable ingest_id: %q", r.IngestID)
	}
	// EncodeRawBody refuses a zero received_at, so this decoder must too, or the
	// two halves disagree about what a valid record is — and the TypeScript
	// decoder already refused it (Op.Validate refuses a zero authored_at for the
	// same reason on the hot side).
	if r.ReceivedAt.IsZero() {
		return RawBody{}, errors.New("oplog: raw body received_at is zero")
	}
	// The payload is validated here, not left to the consumer.
	//
	// This decoder used to return RawBase64 as an unexamined string, so a record
	// whose payload was not base64 at all decoded cleanly and failed later,
	// somewhere with no idea which blob it came from. It also meant the cold
	// record's actual CONTENT crossed the executor boundary unchecked: the
	// TypeScript side decodes raw_base64 into bytes, so it refused records this
	// accepted — a base64url payload with no padding sailed through the
	// conformance gate green.
	//
	// StdEncoding, strictly: this is the exact decoder EncodeRawBody's output
	// requires, and accepting a looser dialect here is what let the two sides
	// disagree in the first place.
	if _, err := base64.StdEncoding.DecodeString(r.RawBase64); err != nil {
		return RawBody{}, fmt.Errorf("oplog: raw body payload is not standard base64: %w", err)
	}
	return r, nil
}

// KindOf reports what a blob body claims to be: "ops" or "raw_body". It is how
// invariant I16 checks that a cold blob never carries ops, so it reads only the
// kind field and never the body.
func KindOf(b []byte) (string, error) {
	var h blobHeader
	if err := json.Unmarshal(b, &h); err != nil {
		return "", fmt.Errorf("oplog: read blob kind: %w", err)
	}
	if h.Kind == "" {
		return "", errors.New("oplog: blob has no kind")
	}
	return h.Kind, nil
}

// CheckpointHead is one entry of a writer_checkpoint payload: the head of one
// writer's chain on ONE stream. Chains are per (writer_id, stream), so a head
// that does not name a stream is meaningless (Decision 13).
type CheckpointHead struct {
	WriterID string `json:"writer_id"`
	Stream   string `json:"stream"`
	Counter  string `json:"counter"` // decimal string: a JS number would be lossy past 2^53
	Hash     string `json:"hash"`    // 64 hex chars
}

type checkpointPayload struct {
	Heads []CheckpointHead `json:"heads"`
}

// EncodeCheckpointPayload builds the canonical writer_checkpoint payload: heads
// sorted by (writer_id, stream), so Go and TypeScript produce byte-identical
// bytes for the same roster.
func EncodeCheckpointPayload(heads []CheckpointHead) (json.RawMessage, error) {
	out := slices.Clone(heads)
	for _, h := range out {
		if err := h.validate(); err != nil {
			return nil, err
		}
	}
	slices.SortFunc(out, compareHeads)
	for i := 1; i < len(out); i++ {
		if compareHeads(out[i-1], out[i]) == 0 {
			return nil, fmt.Errorf("oplog: duplicate checkpoint head for (%s, %s)", out[i].WriterID, out[i].Stream)
		}
	}
	return json.Marshal(checkpointPayload{Heads: out})
}

// DecodeCheckpointPayload reads a writer_checkpoint payload and rejects one
// that is not canonically ordered — an unsorted roster would hash differently
// on two devices that agree on its contents.
func DecodeCheckpointPayload(p json.RawMessage) ([]CheckpointHead, error) {
	var cp checkpointPayload
	if err := json.Unmarshal(p, &cp); err != nil {
		return nil, fmt.Errorf("oplog: decode checkpoint: %w", err)
	}
	for _, h := range cp.Heads {
		if err := h.validate(); err != nil {
			return nil, err
		}
	}
	if !slices.IsSortedFunc(cp.Heads, compareHeads) {
		return nil, errors.New("oplog: checkpoint heads are not sorted by (writer_id, stream)")
	}
	for i := 1; i < len(cp.Heads); i++ {
		if compareHeads(cp.Heads[i-1], cp.Heads[i]) == 0 {
			return nil, fmt.Errorf("oplog: duplicate checkpoint head for (%s, %s)", cp.Heads[i].WriterID, cp.Heads[i].Stream)
		}
	}
	return cp.Heads, nil
}

func compareHeads(a, b CheckpointHead) int {
	if c := strings.Compare(a.WriterID, b.WriterID); c != 0 {
		return c
	}
	return strings.Compare(a.Stream, b.Stream)
}

func (h CheckpointHead) validate() error {
	switch {
	case h.WriterID == "":
		return errors.New("oplog: checkpoint head has no writer_id")
	case h.Stream == "":
		return fmt.Errorf("oplog: checkpoint head for %q names no stream", h.WriterID)
	case !isDecimal(h.Counter):
		return fmt.Errorf("oplog: checkpoint head for %q has counter %q, want a decimal string", h.WriterID, h.Counter)
	case !isSHA256Hex(h.Hash):
		return fmt.Errorf("oplog: checkpoint head for %q has hash %q, want 64 hex chars", h.WriterID, h.Hash)
	}
	return nil
}

func isDecimal(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
