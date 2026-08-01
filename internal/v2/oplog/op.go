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
//     encoding is byte-identical in both languages ([EncodeCheckpointPayload]).
//   - AuthoredAt is normalised to RFC3339 UTC on encode.
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
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// SchemaVersion is the op schema this build understands. It versions the OPS;
// blob.Version versions the framing around them.
const SchemaVersion = 1

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
	OpTxnIngested      OpType = "txn_ingested"
	OpTxnSuperseded    OpType = "txn_superseded"
	OpTxnCategorized   OpType = "txn_categorized"
	OpTxnSplit         OpType = "txn_split"
	OpTxnEdited        OpType = "txn_edited"
	OpRuleAdded        OpType = "rule_added"
	OpRateSet          OpType = "rate_set"
	OpRateUnset        OpType = "rate_unset"
	OpHomeCurrencySet  OpType = "home_currency_set"
	OpWriterCheckpoint OpType = "writer_checkpoint"
)

// Types lists every op type at SchemaVersion, in wire order.
var Types = []OpType{
	OpTxnIngested, OpTxnSuperseded, OpTxnCategorized, OpTxnSplit, OpTxnEdited,
	OpRuleAdded, OpRateSet, OpRateUnset, OpHomeCurrencySet, OpWriterCheckpoint,
}

// Valid reports whether t is a type this schema version defines.
func (t OpType) Valid() bool { return slices.Contains(Types, t) }

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
	Entity        *EntityRef      `json:"entity,omitempty"`    //
	ParentVersion *int64          `json:"parent_version"`      // nil = create, or parent-free op
	IngestID      string          `json:"ingest_id,omitempty"` // hex sha256 of the raw body
	Payload       json.RawMessage `json:"payload"`
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
	if o.OpID == "" {
		return fmt.Errorf("op of type %s: op_id is empty", o.Type)
	}
	if o.AuthoredAt.IsZero() {
		return fmt.Errorf("op %s: authored_at is zero", o.OpID)
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
	}

	if len(o.Payload) == 0 {
		return fmt.Errorf("op %s: payload is empty", o.OpID)
	}
	if !json.Valid(o.Payload) {
		return fmt.Errorf("op %s: payload is not valid JSON", o.OpID)
	}
	return nil
}

// canonicalTime puts a timestamp in the one form both executors read
// identically: UTC, truncated to milliseconds.
//
// The truncation is not cosmetic. Fork resolution compares authored_at and
// falls through to writer_id only on an exact tie, and JavaScript's Date
// carries milliseconds — so a Go writer emitting microseconds would produce two
// ops that Go orders and TypeScript calls tied, i.e. two executors materialising
// different money from the same log. Rounding to what both can represent removes
// the disagreement at the source rather than asking the TS port to compensate.
func canonicalTime(t time.Time) time.Time {
	return t.UTC().Truncate(time.Millisecond)
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
	out := make([]Op, len(ops))
	for i, o := range ops {
		if err := o.Validate(); err != nil {
			return nil, fmt.Errorf("oplog: op %d: %w", i, err)
		}
		o.AuthoredAt = canonicalTime(o.AuthoredAt)
		out[i] = o
	}
	return json.Marshal(opBlob{V: SchemaVersion, Kind: KindOps, Ops: out})
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

// EncodeRawBody encodes a cold-stream record.
func EncodeRawBody(r RawBody) ([]byte, error) {
	if r.V == 0 {
		r.V = SchemaVersion
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
	r.ReceivedAt = canonicalTime(r.ReceivedAt)
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
