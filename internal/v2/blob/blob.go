// Package blob defines the on-the-wire envelope every v2 op-log row is stored
// in: the framing, the size-bucket padding, the associated data that binds a
// blob to its position, and the per-writer chain hash.
//
// # This package is the Phase 3 swap point
//
// Phase 1 stores plaintext. Phase 3 turns on end-to-end encryption. The whole
// point of this package is that the second event changes ONE thing:
// [Sealer] gets a real implementation. Nothing else may move — not the header,
// not the reserved nonce and tag slots, not the bucket ladder, not the AAD
// field set, not the bytes [Hash] chains over. Every one of those is already
// baked into stored rows, client mirrors and the TypeScript port by the time
// Phase 3 lands, so a change to any of them is a data migration rather than a
// code change.
//
// # The wire format
//
//	[1B version=1][2B BE aadLen][aad][12B nonce][ sealed region ][16B tag]
//	total length == size bucket, exactly
//
// where the sealed region is
//
//	[4B BE payloadLen][payload][zero padding]
//
// and payload = gzip(plaintext) — compress THEN seal, so Phase 3's ciphertext
// is incompressible by construction and the compression ratio of a body is not
// observable from its stored size.
//
// Three details are load-bearing:
//
//  1. Padding lives INSIDE the sealed region, and so does payloadLen. Phase 3
//     encrypts exactly [start,end) as reported by [SealedRegion], so a stolen
//     blob reveals its bucket and nothing finer. A cleartext length field —
//     the obvious layout, and the one this design started with — would make
//     bucket padding purely cosmetic: an observer would read the exact
//     compressed size off the wire and the 1/4/16/… ladder would hide nothing.
//     Spec §2 lists padding as a required metadata mitigation, not a decoration.
//
//  2. The nonce and tag slots are reserved now, as zeros. If Phase 3 added
//     them instead, every blob whose payload sits within 28 bytes of a bucket
//     boundary would grow past its bucket on the day sealing turned on, silently
//     re-bucketing (and so re-fingerprinting) part of the corpus.
//     len(Sealed.Bytes) is identical before and after.
//
//  3. [PlaintextSealer.Open] recomputes the AAD from the caller's [Envelope]
//     and rejects a mismatch. That is the replay protection Phase 3's AEAD will
//     provide cryptographically and Phase 1 provides structurally: a blob
//     cannot be moved to another position, stream, writer or user without the
//     move being detected.
//
// # What Phase 1 does NOT claim
//
// Nothing here is confidential or authentic. The payload is readable, the
// AAD comparison is a structural check against a caller-supplied envelope, and
// the zero tag authenticates nothing. Phase 1 blobs are plaintext on purpose
// (see the phase plan's Global Constraints); code that "helpfully" seals them
// early breaks the corpus-shape measurements Phase 2 depends on.
//
// # Errors are set-aside, never hard stops
//
// Every failure [PlaintextSealer.Open] can return wraps [ErrSetAside]. Spec
// §3.3:68 reserves hard-stopping sync for chain breaks and unknown-newer op
// schema versions; a blob that will not open is set aside with a visible
// warning instead, because one bad blob must not strand a device. The op-side
// hard stop is oplog.ErrUnknownNewerVersion, and the two must not be conflated.
//
// # spike/phase0 is not a precedent
//
// The Phase 0 replay spike (spike/phase0/blobgen) writes a zero-nonce, no-AAD
// blob. That is a benchmark artifact built to measure decode throughput and it
// must not be reused, copied or treated as the format.
package blob

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// Frozen layout constants. Offsets are derived from these and never hardcoded
// anywhere else in the tree.
const (
	// Version is the envelope version byte. It versions the FRAMING, not the
	// ops inside — see oplog.SchemaVersion for that.
	Version = 1

	versionSize    = 1
	aadLenSize     = 2
	payloadLenSize = 4

	// NonceSize is 96 bits, the size AES-GCM uses (spec §3.4). Reserved and
	// zero in Phase 1.
	NonceSize = 12
	// TagSize is the AES-GCM authentication tag. Reserved and zero in Phase 1.
	TagSize = 16

	// MaxPlaintext bounds the plaintext on BOTH sides: Seal refuses to frame
	// more, Open refuses to decompress more. The Open side is what stops a gzip
	// bomb — inbound mail is attacker-influenced and 4 MB of one byte fits the
	// 4 KB bucket, so the framing alone cannot bound the allocation — and the
	// Seal side is what keeps the two in agreement, so nothing that was
	// successfully stored can ever fail to open.
	//
	// The plan specified 1 MB, matching the 1 MB SMTP DATA cap (spec §3.2), but
	// a cold-stream plaintext is an oplog.RawBody record with the mail
	// base64-encoded inside it: a legal 1 MiB message becomes ~1.37 MB of
	// plaintext, compresses well under a bucket, and would then be permanently
	// unopenable under a 1 MB cap. Chunking it instead was rejected in Decision
	// 7 (a size-driven split count leaks more than a bigger bucket does), so the
	// cap is 2 MiB: still a hard, absolute bound on what a decode allocates,
	// with room for base64 expansion of a max-size message.
	MaxPlaintext = 2 << 20

	// aadSeparator joins the AAD fields. Fields may not contain it.
	aadSeparator = "|"
)

// Buckets is the size ladder every blob is padded up to, in bytes. Spec §2
// specified 1/4/16/64 KB; the ladder is extended to 1 MB because the measured
// corpus's largest compressed body is ~314 KB and a body that does not fit any
// bucket cannot be stored at all. The 512 KB rung exists so that ~314 KB does
// not have to round up to a whole megabyte.
//
// Padding is what makes the ladder worth having: a 300-byte op and a 900-byte
// op are the same size on the wire, so a server or a backup thief learns the
// bucket and nothing finer.
var Buckets = []int{1 << 10, 4 << 10, 16 << 10, 64 << 10, 256 << 10, 512 << 10, 1024 << 10}

// MaxBucket is the largest blob this format can carry. It is a constant rather
// than the tail of Buckets so that callers that must reject oversize input
// before parsing anything — the append handler's 413, the SMTP path — can use
// it in a size check; a test keeps it in step with the ladder.
const MaxBucket = 1 << 20

var (
	// ErrSetAside is wrapped by every error Open returns. A blob that will not
	// open is set aside with a warning; it never hard-stops sync (spec §3.3:68).
	ErrSetAside = errors.New("blob cannot be opened")
	// ErrUnsupportedVersion means the envelope version byte is not one this
	// build understands.
	ErrUnsupportedVersion = fmt.Errorf("%w: unsupported envelope version", ErrSetAside)
	// ErrAADMismatch means the blob was sealed at a different position, stream,
	// writer or user than the caller claims — i.e. a replay.
	ErrAADMismatch = fmt.Errorf("%w: associated data mismatch", ErrSetAside)
	// ErrMalformed means the framing itself is unreadable.
	ErrMalformed = fmt.Errorf("%w: malformed envelope", ErrSetAside)

	// ErrTooLarge means the framed blob would exceed the largest bucket. This
	// is a Seal-side (and BucketFor-side) error, not a set-aside condition.
	ErrTooLarge = errors.New("blob exceeds the largest size bucket")
	// ErrInvalidEnvelope means the caller passed an unusable Envelope. It is a
	// programming error on both Seal and Open, not a property of stored bytes.
	ErrInvalidEnvelope = errors.New("invalid blob envelope")
)

// BucketFor returns the smallest bucket that can hold n bytes, where n is the
// TOTAL framed length — header, AAD, nonce, sealed region and tag together.
// Sizing on the payload alone would let the header push a blob past its bucket.
func BucketFor(n int) (int, error) {
	if n < 0 {
		return 0, fmt.Errorf("%w: negative length %d", ErrMalformed, n)
	}
	for _, b := range Buckets {
		if n <= b {
			return b, nil
		}
	}
	return 0, fmt.Errorf("%w: %d bytes exceeds %d", ErrTooLarge, n, MaxBucket)
}

// Envelope is the position a blob occupies. Its four fields are exactly the
// associated data spec §3.4 binds, and the set is frozen: adding a field
// invalidates every stored blob, removing one reopens a replay path.
type Envelope struct {
	UserID        uuid.UUID
	Stream        string // "hot" | "cold"
	WriterID      string
	WriterCounter int64 // 1-based position within (writer_id, stream); chains are per-stream
}

// AAD is the canonical associated data: user_id|stream|writer_id|writer_counter,
// with the counter in decimal. Callers must Validate the envelope first — the
// separator is not escaped, so a field containing "|" would make two different
// positions produce identical associated data.
func (e Envelope) AAD() []byte {
	return []byte(strings.Join([]string{
		e.UserID.String(),
		e.Stream,
		e.WriterID,
		strconv.FormatInt(e.WriterCounter, 10),
	}, aadSeparator))
}

// Validate rejects envelopes whose AAD would be ambiguous or nonsensical.
func (e Envelope) Validate() error {
	switch {
	case e.UserID == uuid.Nil:
		return fmt.Errorf("%w: user_id is zero", ErrInvalidEnvelope)
	case e.Stream == "":
		return fmt.Errorf("%w: stream is empty", ErrInvalidEnvelope)
	case e.WriterID == "":
		return fmt.Errorf("%w: writer_id is empty", ErrInvalidEnvelope)
	case e.WriterCounter < 0:
		return fmt.Errorf("%w: writer_counter %d is negative", ErrInvalidEnvelope, e.WriterCounter)
	case strings.Contains(e.Stream, aadSeparator) || strings.Contains(e.WriterID, aadSeparator):
		return fmt.Errorf("%w: stream and writer_id may not contain %q", ErrInvalidEnvelope, aadSeparator)
	}
	if n := versionSize + aadLenSize + len(e.AAD()) + NonceSize + payloadLenSize + TagSize; n > Buckets[0] {
		return fmt.Errorf("%w: framing overhead %d does not fit the smallest bucket", ErrInvalidEnvelope, n)
	}
	return nil
}

// Sealed is a framed blob, padded to exactly SizeBucket bytes.
type Sealed struct {
	Bytes      []byte
	SizeBucket int
}

// Sealer is the ONE interface Phase 3 replaces. Its implementation changes from
// [PlaintextSealer] to an HPKE/AES-GCM sealer; the byte offsets it produces do
// not change at all.
type Sealer interface {
	Seal(e Envelope, plaintext []byte) (Sealed, error)
	Open(e Envelope, s Sealed) ([]byte, error)
}

// PlaintextSealer is the Phase 1 implementation: it frames, compresses and pads
// but does not encrypt. It leaves the nonce and tag slots zero.
type PlaintextSealer struct{}

var _ Sealer = PlaintextSealer{}

// overhead is every framed byte that is not payload or padding.
func overhead(aadLen int) int {
	return versionSize + aadLenSize + aadLen + NonceSize + payloadLenSize + TagSize
}

// SealedRegion reports the half-open byte range of a framed blob that Phase 3
// encrypts: everything after the nonce and before the tag, which is the
// payload length, the payload and the padding. Callers outside this package use
// it to reason about the format without re-deriving offsets.
func SealedRegion(b []byte) (start, end int, err error) {
	if len(b) < versionSize+aadLenSize {
		return 0, 0, fmt.Errorf("%w: %d bytes is shorter than the header", ErrMalformed, len(b))
	}
	aadLen := int(binary.BigEndian.Uint16(b[versionSize : versionSize+aadLenSize]))
	start = versionSize + aadLenSize + aadLen + NonceSize
	end = len(b) - TagSize
	if end < start+payloadLenSize {
		return 0, 0, fmt.Errorf("%w: aadLen %d leaves no room for a payload", ErrMalformed, aadLen)
	}
	return start, end, nil
}

// Seal compresses plaintext, frames it and pads the result to a size bucket.
func (PlaintextSealer) Seal(e Envelope, plaintext []byte) (Sealed, error) {
	if err := e.Validate(); err != nil {
		return Sealed{}, err
	}
	if len(plaintext) > MaxPlaintext {
		return Sealed{}, fmt.Errorf("%w: plaintext is %d bytes, cap is %d", ErrTooLarge, len(plaintext), MaxPlaintext)
	}
	aad := e.AAD()

	payload, err := compress(plaintext)
	if err != nil {
		return Sealed{}, err
	}
	bucket, err := BucketFor(overhead(len(aad)) + len(payload))
	if err != nil {
		return Sealed{}, err
	}

	out := make([]byte, bucket)
	out[0] = Version
	binary.BigEndian.PutUint16(out[versionSize:versionSize+aadLenSize], uint16(len(aad)))
	copy(out[versionSize+aadLenSize:], aad)
	// out[.. +NonceSize] stays zero: the nonce slot, reserved for Phase 3.

	// Deliberately re-derived from the bytes just written rather than computed
	// alongside them: Seal and Open then get their offsets from one function, so
	// they cannot drift apart.
	start, end, err := SealedRegion(out)
	if err != nil {
		return Sealed{}, err
	}
	region := out[start:end]
	binary.BigEndian.PutUint32(region[:payloadLenSize], uint32(len(payload)))
	copy(region[payloadLenSize:], payload)
	// The rest of region stays zero: padding, INSIDE the sealed region.
	// out[end:] stays zero: the tag slot, reserved for Phase 3.

	return Sealed{Bytes: out, SizeBucket: bucket}, nil
}

// Open reverses Seal. It rejects a blob whose embedded AAD does not match the
// envelope the caller expects it at, which is what stops a server replaying a
// blob into another position, stream or user.
func (PlaintextSealer) Open(e Envelope, s Sealed) ([]byte, error) {
	if err := e.Validate(); err != nil {
		return nil, err
	}
	b := s.Bytes
	if s.SizeBucket != 0 && s.SizeBucket != len(b) {
		return nil, fmt.Errorf("%w: %d bytes declared as bucket %d", ErrMalformed, len(b), s.SizeBucket)
	}
	if !isBucket(len(b)) {
		return nil, fmt.Errorf("%w: %d bytes is not a size bucket", ErrMalformed, len(b))
	}
	if b[0] != Version {
		return nil, fmt.Errorf("%w: %d", ErrUnsupportedVersion, b[0])
	}

	start, end, err := SealedRegion(b)
	if err != nil {
		return nil, err
	}
	// SealedRegion has already checked that the AAD, nonce, length and tag all
	// fit, so this slice is in bounds for any blob it accepted.
	aad := b[versionSize+aadLenSize : start-NonceSize]
	// Phase 3 hands this comparison to the AEAD. Until then it is a constant-time
	// compare so the check has the same shape as the one that replaces it.
	if subtle.ConstantTimeCompare(aad, e.AAD()) != 1 {
		return nil, fmt.Errorf("%w: sealed at a different position", ErrAADMismatch)
	}

	region := b[start:end]
	n := int(binary.BigEndian.Uint32(region[:payloadLenSize]))
	if n < 0 || n > len(region)-payloadLenSize {
		return nil, fmt.Errorf("%w: payload length %d runs past the sealed region", ErrMalformed, n)
	}
	return decompress(region[payloadLenSize : payloadLenSize+n])
}

func isBucket(n int) bool {
	for _, b := range Buckets {
		if n == b {
			return true
		}
	}
	return false
}

func compress(plaintext []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, fmt.Errorf("blob: gzip: %w", err)
	}
	if _, err := zw.Write(plaintext); err != nil {
		return nil, fmt.Errorf("blob: gzip: %w", err)
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("blob: gzip: %w", err)
	}
	return buf.Bytes(), nil
}

func decompress(payload []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	defer zr.Close()
	// Read one byte past the cap so an over-cap body is detected rather than
	// silently truncated.
	out, err := io.ReadAll(io.LimitReader(zr, MaxPlaintext+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if len(out) > MaxPlaintext {
		return nil, fmt.Errorf("%w: decompressed payload exceeds %d bytes", ErrMalformed, MaxPlaintext)
	}
	return out, nil
}

// ZeroHash is the genesis of every chain: the prev-hash of writer_counter 1.
var ZeroHash [32]byte

// Hash advances a writer's chain: SHA256(prev || s.Bytes). It hashes the FRAMED
// bytes, not the plaintext, so the chain covers the padding and the header too
// and can be recomputed by anyone holding the stored blob — including a server
// that cannot read it (spec §3.3, Decision 13: chains are per (writer_id, stream)).
func Hash(prev [32]byte, s Sealed) [32]byte {
	h := sha256.New()
	h.Write(prev[:])
	h.Write(s.Bytes)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}
