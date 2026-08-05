// Envelope framing VERSION 2 — a BENCHMARK INSTRUMENT, not a product path.
//
// Read this whole comment before using anything in this file.
//
// # What it is for
//
// Phase 2 ships plaintext. [PlaintextSealer] frames, compresses and pads, and
// [PlaintextSealer.Open] is a gunzip plus a byte-compare — there is no crypto in
// it at all. So an honest end-to-end measurement of the Phase 2 app proves
// nothing whatsoever about Phase 3's cost, which is the trap the Phase 2 plan
// spends a page attacking. This file exists so the Task 1 benchmark can be run
// against a corpus in the SEALED shape Phase 3 will actually store.
//
// Nothing here is wired into the ingest pipeline, the sync API or the client.
// The only callers are cmd/gen-phase2-corpus (build-tagged) and
// cmd/ledgerd load-corpus (admin-only, refuses a multi-user database). If you
// find this being used to seal a real user's blobs, that is a bug: Phase 3's
// swap point is [Sealer], and the design question below has to be settled first.
//
// # The format, and the Phase 3 gap it surfaces
//
// v1, frozen and shipped:
//
//	[1B version=1][2B BE aadLen][aad][12B nonce][ sealed region ][16B tag]
//
// v2, this file:
//
//	[1B version=2][2B BE aadLen][aad][32B enc][12B nonce][ sealed region ][16B tag]
//
// The ONLY addition is `enc`, the per-record ephemeral X25519 public key, and
// it goes after the embedded AAD and before the nonce. The v1 frame has no slot
// for it — [overhead] accounts for version, aadLen, aad, nonce, payloadLen and
// tag and nothing else — so Phase 3 must either bump the framing version (this
// branch) or adopt a per-user static ephemeral (fallback F4's territory). THAT
// IS AN OPEN PHASE 3 DESIGN QUESTION. It is recorded in
// docs/superpowers/NEEDS-SALEH.md and in the Task 1 gate document; this file
// picks the version-bump branch for the benchmark only, because it is the shape
// a drop-in replacement for [PlaintextSealer.Open] would have.
//
// A second open question, recorded in the same places: blob.go's package doc,
// point 3, argues Phase 3's AEAD should bind the WHOLE cleartext header
// (b[:start-NonceSize]) rather than the AAD alone. The Phase 2 plan specifies
// the embedded AAD bytes, because that makes a native open reproduce
// [PlaintextSealer.Open]'s byte-compare cryptographically. This file follows the
// plan; the two choices cost exactly the same and the decision is Phase 3's.
//
// # Why one layout helper and not three version branches
//
// Four functions derive offsets from the frame, and they derive them
// INDEPENDENTLY:
//
//   - the sealed region's start
//   - the embedded AAD's slice (which ends at start-NonceSize, so moving start
//     without moving the end reads the 32 bytes of enc as part of the AAD)
//   - the framing overhead (which decides the size bucket, so under-counting by
//     32 silently overruns a record sitting near a boundary)
//   - [Envelope.ValidateFrame]'s "does the framing fit the smallest bucket"
//     check
//
// Branch each of them separately and the predictable outcome is that three
// agree and the fourth does not — and the AAD one is worse than a crash,
// because a generator making the same mistake symmetrically produces a corpus
// that round-trips and is wrong. So every offset in this file comes from
// [FrameLayoutFor], and encv2_test.go checks the v1 path through it against
// blob.go's shipped, independently written v1 functions.
//
// # The construction, stated precisely so Swift and TypeScript can reproduce it
//
// This is HPKE-SHAPED, not RFC 9180. It is DHKEM(X25519, HKDF-SHA256) followed
// by AES-256-GCM, hand-assembled the same way spike/phase0/blobgen assembled it,
// because CryptoKit's HPKE API and Go's HPKE are not available to all three
// executors — and because what the benchmark measures is the COST of one X25519
// scalar multiplication, one HKDF-Extract/Expand and one AES-GCM open per
// record, which is identical either way. Do not read a v2 blob as an RFC 9180
// artifact.
//
//	enc, esk := X25519 keypair, FRESH PER RECORD
//	shared   := X25519(esk, recipientPub)          // sender
//	         =  X25519(recipientPriv, enc)         // receiver
//	salt     := enc ‖ recipientPub                 // 64 bytes
//	key      := HKDF-SHA256(ikm=shared, salt=salt, info=EncInfo, L=32)
//	nonce    := 12 random bytes, FRESH PER RECORD
//	ct‖tag   := AES-256-GCM(key, nonce, plaintext=sealed region, aad=embedded AAD)
//
// The sealed region's plaintext is exactly v1's: [4B BE payloadLen][gzip
// payload][zero padding]. AES-GCM's ciphertext is the same length as its
// plaintext, so it lands in [start,end) exactly and the 16-byte tag lands in the
// reserved tag slot. No offset moves relative to v1 except by the 32 bytes of
// enc.
package blob

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"fmt"
	"io"

	"golang.org/x/crypto/curve25519"
)

const (
	// EncVersion is the framing version this file implements: v1 plus a 32-byte
	// ephemeral public key after the embedded AAD (Phase 2 plan, Decision 12).
	EncVersion = 2

	// EncSize is the X25519 ephemeral public key carried by a v2 frame.
	EncSize = 32

	// EncInfo is the HKDF info string. It is versioned by name so a future
	// change to the derivation cannot silently produce keys that agree.
	EncInfo = "ledger-phase2-encv2"
)

// FrameLayout is everything about a frame that depends on its version byte.
// Today that is one field; the type exists so adding a second cannot be done in
// three places independently.
type FrameLayout struct {
	// EncSize is the width of the ephemeral-public-key field between the
	// embedded AAD and the nonce. Zero for v1.
	EncSize int
}

// FrameLayoutFor is the single version branch in the whole format. Every offset
// in this file is derived from its result, and blob.go's v1 functions are the
// independent implementation encv2_test.go checks it against.
func FrameLayoutFor(version byte) (FrameLayout, error) {
	switch version {
	case Version:
		return FrameLayout{EncSize: 0}, nil
	case EncVersion:
		return FrameLayout{EncSize: EncSize}, nil
	default:
		return FrameLayout{}, fmt.Errorf("%w: %d", ErrUnsupportedVersion, version)
	}
}

// Overhead is every framed byte that is not payload or padding, at this layout.
// It is the versioned twin of blob.go's overhead, and the number BucketFor is
// given — under-count it and a record near a bucket boundary overruns its
// bucket at seal time and is unopenable forever.
func (l FrameLayout) Overhead(aadLen int) int {
	return versionSize + aadLenSize + aadLen + l.EncSize + NonceSize + payloadLenSize + TagSize
}

// EncOffset is where the ephemeral public key starts, given the AAD length.
func (l FrameLayout) EncOffset(aadLen int) int { return versionSize + aadLenSize + aadLen }

// NonceOffset is where the nonce starts, given the AAD length.
func (l FrameLayout) NonceOffset(aadLen int) int { return l.EncOffset(aadLen) + l.EncSize }

// SealedRegionV is the versioned twin of [SealedRegion]: the half-open byte
// range an AEAD encrypts, which is the payload length, the payload and the
// padding. It reads the version out of the frame, so a caller never has to know
// which one it holds.
func SealedRegionV(b []byte) (start, end int, err error) {
	if len(b) < versionSize+aadLenSize {
		return 0, 0, fmt.Errorf("%w: %d bytes is shorter than the header", ErrMalformed, len(b))
	}
	l, err := FrameLayoutFor(b[0])
	if err != nil {
		return 0, 0, err
	}
	aadLen := int(binary.BigEndian.Uint16(b[versionSize : versionSize+aadLenSize]))
	start = l.NonceOffset(aadLen) + NonceSize
	end = len(b) - TagSize
	if end < start+payloadLenSize {
		return 0, 0, fmt.Errorf("%w: aadLen %d leaves no room for a payload", ErrMalformed, aadLen)
	}
	return start, end, nil
}

// EmbeddedAADV is the versioned twin of [EmbeddedAAD].
//
// It derives BOTH ends of the slice from the layout. Deriving only the start —
// the shape blob.go uses, where the end is start-NonceSize — is the specific bug
// Decision 12 calls out: at v2 the start has moved by 32 and the end has not, so
// the reader returns the AAD with the ephemeral key glued onto it.
func EmbeddedAADV(b []byte) ([]byte, error) {
	if len(b) < versionSize+aadLenSize {
		return nil, fmt.Errorf("%w: %d bytes is shorter than the header", ErrMalformed, len(b))
	}
	l, err := FrameLayoutFor(b[0])
	if err != nil {
		return nil, err
	}
	aadLen := int(binary.BigEndian.Uint16(b[versionSize : versionSize+aadLenSize]))
	// SealedRegionV bounds-checks the whole frame including this slice.
	if _, _, err := SealedRegionV(b); err != nil {
		return nil, err
	}
	return b[versionSize+aadLenSize : l.EncOffset(aadLen)], nil
}

// EncOf returns the ephemeral public key a v2 frame carries.
func EncOf(b []byte) ([]byte, error) {
	l, aadLen, err := frameHeader(b)
	if err != nil {
		return nil, err
	}
	if l.EncSize == 0 {
		return nil, fmt.Errorf("%w: version %d has no enc field", ErrUnsupportedVersion, b[0])
	}
	off := l.EncOffset(aadLen)
	return b[off : off+l.EncSize], nil
}

// NonceOf returns the nonce a frame carries. Zero in v1, random in v2.
func NonceOf(b []byte) ([]byte, error) {
	l, aadLen, err := frameHeader(b)
	if err != nil {
		return nil, err
	}
	off := l.NonceOffset(aadLen)
	return b[off : off+NonceSize], nil
}

// TagOf returns the authentication tag slot. Zero in v1.
func TagOf(b []byte) ([]byte, error) {
	if _, _, err := SealedRegionV(b); err != nil {
		return nil, err
	}
	return b[len(b)-TagSize:], nil
}

func frameHeader(b []byte) (FrameLayout, int, error) {
	if _, _, err := SealedRegionV(b); err != nil {
		return FrameLayout{}, 0, err
	}
	l, err := FrameLayoutFor(b[0])
	if err != nil {
		return FrameLayout{}, 0, err
	}
	return l, int(binary.BigEndian.Uint16(b[versionSize : versionSize+aadLenSize])), nil
}

// ValidateFrame is [Envelope.Validate] with the version's framing overhead
// substituted for v1's. An envelope whose AAD is long enough that v1's framing
// fits the smallest bucket and v2's does not is legal in one and not the other,
// and a v2 sealer that used Validate would discover that as a bucket overrun.
func (e Envelope) ValidateFrame(version byte) error {
	l, err := FrameLayoutFor(version)
	if err != nil {
		return err
	}
	if err := e.Validate(); err != nil {
		return err
	}
	if n := l.Overhead(len(e.AAD())); n > Buckets[0] {
		return fmt.Errorf("%w: v%d framing overhead %d does not fit the smallest bucket", ErrInvalidEnvelope, version, n)
	}
	return nil
}

// DeriveEncKey is the KDF half of the construction: HKDF-SHA256 over the X25519
// shared secret, salted with enc‖recipientPub and bound to [EncInfo].
//
// Salting with both public values is what stops one derived key being reused
// across recipients if an ephemeral key were ever repeated, and it is what the
// Swift and TypeScript implementations must reproduce byte for byte — a
// mismatch here fails every arm at once with an opaque "authentication failed",
// so it is pinned by a test rather than left to agreement by inspection.
func DeriveEncKey(shared, enc, recipientPub []byte) []byte {
	return deriveEncKeyWithInfo(shared, enc, recipientPub, EncInfo)
}

func deriveEncKeyWithInfo(shared, enc, recipientPub []byte, info string) []byte {
	salt := make([]byte, 0, len(enc)+len(recipientPub))
	salt = append(salt, enc...)
	salt = append(salt, recipientPub...)
	key, err := hkdf.Key(sha256.New, shared, salt, info, 32)
	if err != nil {
		// hkdf.Key fails only on a zero-length key or an absurd length, both of
		// which are compile-time constants here.
		panic("blob: hkdf: " + err.Error())
	}
	return key
}

// EncSealer is the v2 [Sealer]: DHKEM(X25519, HKDF-SHA256) + AES-256-GCM.
//
// It holds the recipient's PRIVATE key because the benchmark generator and the
// benchmark reader are the same process. Production never would: the server
// seals with the public key alone and only the device can open. That asymmetry
// is why this type is a benchmark instrument and is not the Phase 3 sealer.
type EncSealer struct {
	priv [32]byte
	pub  [32]byte
	// Rand is the entropy source for ephemeral keys and nonces. nil means
	// crypto/rand. A test may substitute a deterministic reader; the corpus
	// generator must not, because every record needs a distinct ephemeral key
	// and a distinct nonce.
	Rand io.Reader
}

var _ Sealer = EncSealer{}

// NewEncSealer mints a fresh recipient keypair from r (nil means crypto/rand).
func NewEncSealer(r io.Reader) (EncSealer, error) {
	if r == nil {
		r = rand.Reader
	}
	priv := make([]byte, 32)
	if _, err := io.ReadFull(r, priv); err != nil {
		return EncSealer{}, fmt.Errorf("blob: enc sealer: read private key: %w", err)
	}
	s, err := NewEncSealerFromKey(priv)
	if err != nil {
		return EncSealer{}, err
	}
	s.Rand = r
	return s, nil
}

// NewEncSealerFromKey builds a sealer for an existing 32-byte X25519 private key.
func NewEncSealerFromKey(priv []byte) (EncSealer, error) {
	if len(priv) != 32 {
		return EncSealer{}, fmt.Errorf("blob: enc sealer: private key is %d bytes, want 32", len(priv))
	}
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		return EncSealer{}, fmt.Errorf("blob: enc sealer: derive public key: %w", err)
	}
	var s EncSealer
	copy(s.priv[:], priv)
	copy(s.pub[:], pub)
	return s, nil
}

// RecipientPub is the X25519 public key blobs are sealed to.
func (s EncSealer) RecipientPub() []byte { return bytes.Clone(s.pub[:]) }

// RecipientPriv is the X25519 private key. It is written to $W/recipient.key by
// the generator and NEVER committed, printed to a task report, or sent anywhere.
func (s EncSealer) RecipientPriv() []byte { return bytes.Clone(s.priv[:]) }

func (s EncSealer) reader() io.Reader {
	if s.Rand != nil {
		return s.Rand
	}
	return rand.Reader
}

// Seal frames plaintext at version 2 and encrypts the sealed region.
//
// It mirrors [PlaintextSealer.Seal] step for step, including re-deriving the
// offsets from the bytes it just wrote rather than computing them alongside, so
// seal and open cannot drift apart.
func (s EncSealer) Seal(e Envelope, plaintext []byte) (Sealed, error) {
	if err := e.ValidateFrame(EncVersion); err != nil {
		return Sealed{}, err
	}
	if len(plaintext) > MaxPlaintext {
		return Sealed{}, fmt.Errorf("%w: plaintext is %d bytes, cap is %d", ErrTooLarge, len(plaintext), MaxPlaintext)
	}
	l, err := FrameLayoutFor(EncVersion)
	if err != nil {
		return Sealed{}, err
	}
	aad := e.AAD()
	payload, err := compress(plaintext)
	if err != nil {
		return Sealed{}, err
	}
	bucket, err := BucketFor(l.Overhead(len(aad)) + len(payload))
	if err != nil {
		return Sealed{}, err
	}

	out := make([]byte, bucket)
	out[0] = EncVersion
	binary.BigEndian.PutUint16(out[versionSize:versionSize+aadLenSize], uint16(len(aad)))
	copy(out[versionSize+aadLenSize:], aad)

	// A FRESH ephemeral key per record. Hoisting this out of a loop is Task 1
	// Step 5's first trap: it measures fallback F4 (one KEM per epoch) and
	// reports a speedup the production design does not have.
	esk := make([]byte, 32)
	if _, err := io.ReadFull(s.reader(), esk); err != nil {
		return Sealed{}, fmt.Errorf("blob: enc seal: ephemeral key: %w", err)
	}
	enc, err := curve25519.X25519(esk, curve25519.Basepoint)
	if err != nil {
		return Sealed{}, fmt.Errorf("blob: enc seal: ephemeral public key: %w", err)
	}
	shared, err := curve25519.X25519(esk, s.pub[:])
	if err != nil {
		return Sealed{}, fmt.Errorf("blob: enc seal: key agreement: %w", err)
	}
	copy(out[l.EncOffset(len(aad)):], enc)

	nonce := out[l.NonceOffset(len(aad)) : l.NonceOffset(len(aad))+NonceSize]
	if _, err := io.ReadFull(s.reader(), nonce); err != nil {
		return Sealed{}, fmt.Errorf("blob: enc seal: nonce: %w", err)
	}

	start, end, err := SealedRegionV(out)
	if err != nil {
		return Sealed{}, err
	}
	if start+payloadLenSize+len(payload) > end {
		return Sealed{}, fmt.Errorf("%w: framed payload runs past the sealed region", ErrTooLarge)
	}
	binary.BigEndian.PutUint32(out[start:start+payloadLenSize], uint32(len(payload)))
	copy(out[start+payloadLenSize:end], payload)

	aead, err := newGCM(DeriveEncKey(shared, enc, s.pub[:]))
	if err != nil {
		return Sealed{}, err
	}
	// The AEAD's associated data is the EMBEDDED AAD, read back out of the frame
	// rather than reused from `aad` above — same discipline as re-deriving the
	// offsets, and it is what makes a native open reproduce
	// PlaintextSealer.Open's byte-compare cryptographically.
	embedded, err := EmbeddedAADV(out)
	if err != nil {
		return Sealed{}, err
	}
	// Sealed IN PLACE, which is the documented crypto/cipher idiom
	// (`Seal(plaintext[:0], nonce, plaintext, aad)`): dst and plaintext share a
	// base pointer and overlap exactly, so no copy and no second buffer. dst's
	// capacity runs to the end of the frame — end-start+TagSize — so the
	// ciphertext lands in [start,end) and the appended tag lands in the reserved
	// tag slot, with nothing appended past the bucket.
	region := out[start:end]
	dst := out[start:start:len(out)]
	ct := aead.Seal(dst, nonce, region, embedded)
	if len(ct) != end-start+TagSize {
		return Sealed{}, fmt.Errorf("blob: enc seal: ciphertext is %d bytes, want %d", len(ct), end-start+TagSize)
	}
	// A reallocation here would mean the tag was written somewhere other than
	// the frame, and the blob would be silently unopenable. Cheap to assert.
	if &ct[0] != &out[start] {
		return Sealed{}, fmt.Errorf("blob: enc seal: AEAD reallocated instead of sealing in place")
	}

	return Sealed{Bytes: out, SizeBucket: bucket}, nil
}

// Open reverses Seal. Every failure is an [ErrSetAside] error, exactly as
// [PlaintextSealer.Open]'s are: one blob that will not open must never strand a
// device (spec §3.3:68).
func (s EncSealer) Open(e Envelope, sd Sealed) ([]byte, error) {
	if err := e.ValidateFrame(EncVersion); err != nil {
		return nil, err
	}
	b := sd.Bytes
	if sd.SizeBucket != 0 && sd.SizeBucket != len(b) {
		return nil, fmt.Errorf("%w: %d bytes declared as bucket %d", ErrMalformed, len(b), sd.SizeBucket)
	}
	if !isBucket(len(b)) {
		return nil, fmt.Errorf("%w: %d bytes is not a size bucket", ErrMalformed, len(b))
	}
	if len(b) == 0 || b[0] != EncVersion {
		return nil, fmt.Errorf("%w: %d", ErrUnsupportedVersion, b[0])
	}
	start, end, err := SealedRegionV(b)
	if err != nil {
		return nil, err
	}
	enc, err := EncOf(b)
	if err != nil {
		return nil, err
	}
	nonce, err := NonceOf(b)
	if err != nil {
		return nil, err
	}
	embedded, err := EmbeddedAADV(b)
	if err != nil {
		return nil, err
	}
	// THE POSITION CHECK, and it must come from the caller's envelope.
	//
	// This looked redundant on first writing — the AEAD binds the AAD, so surely
	// a moved blob fails to open? It does not: the AEAD's associated data is
	// read OUT OF THE FRAME, so a blob replayed to another position authenticates
	// perfectly against its own embedded AAD and opens. The test that caught this
	// (TestOpenRejectsAWrongPosition) is the reason the line exists. It is the
	// same compare PlaintextSealer.Open does and the same one openBlob does; the
	// AEAD below is the tamper-evidence, not the position check.
	if subtle.ConstantTimeCompare(embedded, e.AAD()) != 1 {
		return nil, fmt.Errorf("%w: sealed at a different position", ErrAADMismatch)
	}
	shared, err := curve25519.X25519(s.priv[:], enc)
	if err != nil {
		return nil, fmt.Errorf("%w: key agreement: %v", ErrSetAside, err)
	}
	aead, err := newGCM(DeriveEncKey(shared, enc, s.pub[:]))
	if err != nil {
		return nil, err
	}
	// ct‖tag is contiguous: the region followed by the tag slot.
	region, err := aead.Open(nil, nonce, b[start:], embedded)
	if err != nil {
		// Indistinguishable by design from a wrong position: GCM does not say
		// whether the AAD or the ciphertext failed. That is the AAD compare
		// becoming cryptographic, which is the whole point of v2.
		return nil, fmt.Errorf("%w: aead open: %v", ErrAADMismatch, err)
	}
	if len(region) != end-start {
		return nil, fmt.Errorf("%w: opened region is %d bytes, want %d", ErrMalformed, len(region), end-start)
	}
	n := int(binary.BigEndian.Uint32(region[:payloadLenSize]))
	if n > len(region)-payloadLenSize {
		return nil, fmt.Errorf("%w: payload length %d runs past the sealed region", ErrMalformed, n)
	}
	return decompress(region[payloadLenSize : payloadLenSize+n])
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("blob: enc: aes: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("blob: enc: gcm: %w", err)
	}
	return aead, nil
}
