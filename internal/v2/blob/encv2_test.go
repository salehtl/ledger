package blob

import (
	"bytes"
	"crypto/rand"
	"errors"
	mrand "math/rand/v2"
	"testing"

	"github.com/google/uuid"
)

// benchEnvelope is the shape every corpus record occupies: the ingest writer on
// the hot stream, which is what makes the AAD length representative.
func benchEnvelope(counter int64) Envelope {
	return Envelope{
		UserID:        uuid.MustParse("6f9619ff-8b86-d011-b42d-00cf4fc964ff"),
		Stream:        StreamHot,
		WriterID:      "ingest",
		WriterCounter: counter,
	}
}

func newTestEncSealer(t *testing.T) EncSealer {
	t.Helper()
	s, err := NewEncSealer(nil)
	if err != nil {
		t.Fatalf("NewEncSealer: %v", err)
	}
	return s
}

// --- The unification the whole decision rests on -----------------------------
//
// Decision 12: three (now four) functions take the version branch, and the risk
// is that two agree and the third does not. These tests check each one against
// the SHIPPED v1 implementation rather than against each other, so a layout
// helper that is uniformly wrong is still caught.

func TestFrameLayoutKnowsExactlyTwoVersions(t *testing.T) {
	l1, err := FrameLayoutFor(Version)
	if err != nil {
		t.Fatalf("FrameLayoutFor(1): %v", err)
	}
	if l1.EncSize != 0 {
		t.Fatalf("v1 EncSize = %d, want 0", l1.EncSize)
	}
	l2, err := FrameLayoutFor(EncVersion)
	if err != nil {
		t.Fatalf("FrameLayoutFor(2): %v", err)
	}
	if l2.EncSize != EncSize {
		t.Fatalf("v2 EncSize = %d, want %d", l2.EncSize, EncSize)
	}
	for _, v := range []byte{0, 3, 255} {
		if _, err := FrameLayoutFor(v); !errors.Is(err, ErrUnsupportedVersion) {
			t.Fatalf("FrameLayoutFor(%d) = %v, want ErrUnsupportedVersion", v, err)
		}
	}
}

// The v1 path through the versioned helpers must reproduce the shipped v1
// functions byte for byte. blob.go's overhead/SealedRegion/EmbeddedAAD are
// INDEPENDENT implementations that predate this file, so agreeing with them is
// a real measurement and not a restatement.
func TestVersionedHelpersAgreeWithShippedV1(t *testing.T) {
	for _, aadLen := range []int{1, 52, 100, 900} {
		l1, _ := FrameLayoutFor(Version)
		if got, want := l1.Overhead(aadLen), overhead(aadLen); got != want {
			t.Fatalf("aadLen %d: layout overhead %d, shipped overhead %d", aadLen, got, want)
		}
		l2, _ := FrameLayoutFor(EncVersion)
		if got, want := l2.Overhead(aadLen), overhead(aadLen)+EncSize; got != want {
			t.Fatalf("aadLen %d: v2 overhead %d, want v1+%d = %d", aadLen, got, EncSize, want)
		}
	}

	e := benchEnvelope(7)
	sealed, err := PlaintextSealer{}.Seal(e, []byte(`{"hello":"world"}`))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	wantStart, wantEnd, err := SealedRegion(sealed.Bytes)
	if err != nil {
		t.Fatalf("SealedRegion: %v", err)
	}
	gotStart, gotEnd, err := SealedRegionV(sealed.Bytes)
	if err != nil {
		t.Fatalf("SealedRegionV: %v", err)
	}
	if gotStart != wantStart || gotEnd != wantEnd {
		t.Fatalf("SealedRegionV on a v1 blob = (%d,%d), shipped SealedRegion = (%d,%d)", gotStart, gotEnd, wantStart, wantEnd)
	}
	wantAAD, err := EmbeddedAAD(sealed.Bytes)
	if err != nil {
		t.Fatalf("EmbeddedAAD: %v", err)
	}
	gotAAD, err := EmbeddedAADV(sealed.Bytes)
	if err != nil {
		t.Fatalf("EmbeddedAADV: %v", err)
	}
	if !bytes.Equal(gotAAD, wantAAD) {
		t.Fatalf("EmbeddedAADV on a v1 blob = %q, shipped EmbeddedAAD = %q", gotAAD, wantAAD)
	}
}

// The trap Decision 12 names explicitly: if embeddedAAD is left unbranched, the
// slice end does not move with `start` and the reader reads the 32 bytes of
// `enc` as part of the AAD. Compared against e.AAD(), computed independently of
// anything the sealer wrote, so a sealer making the SAME mistake does not
// rescue it.
func TestEmbeddedAADOfV2BlobEqualsTheEnvelopeAAD(t *testing.T) {
	s := newTestEncSealer(t)
	e := benchEnvelope(3683)
	sealed, err := s.Seal(e, []byte(`{"amount":"1234","merchant":"x"}`))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	got, err := EmbeddedAADV(sealed.Bytes)
	if err != nil {
		t.Fatalf("EmbeddedAADV: %v", err)
	}
	want := e.AAD()
	if !bytes.Equal(got, want) {
		t.Fatalf("embedded AAD = %q (%d bytes), envelope AAD = %q (%d bytes)", got, len(got), want, len(want))
	}
	// And the enc field really is present and really is between the AAD and the
	// nonce — otherwise the length agreement above could hold for a v1 frame.
	start, _, err := SealedRegionV(sealed.Bytes)
	if err != nil {
		t.Fatalf("SealedRegionV: %v", err)
	}
	encAt := versionSize + aadLenSize + len(want)
	if start != encAt+EncSize+NonceSize {
		t.Fatalf("sealed region starts at %d, want %d (aad end %d + enc %d + nonce %d)", start, encAt+EncSize+NonceSize, encAt, EncSize, NonceSize)
	}
	if bytes.Equal(sealed.Bytes[encAt:encAt+EncSize], make([]byte, EncSize)) {
		t.Fatal("the enc slot is all zero: no ephemeral public key was written")
	}
}

// Every record carries a DISTINCT ephemeral key. Reusing one measures fallback
// F4 (one KEM per epoch) and reports a speedup the production design does not
// have — Task 1 Step 5's first trap.
func TestEveryRecordGetsADistinctEphemeralKey(t *testing.T) {
	s := newTestEncSealer(t)
	seen := make(map[string]bool)
	for i := int64(1); i <= 64; i++ {
		sealed, err := s.Seal(benchEnvelope(i), []byte(`{"i":1}`))
		if err != nil {
			t.Fatalf("Seal %d: %v", i, err)
		}
		enc, err := EncOf(sealed.Bytes)
		if err != nil {
			t.Fatalf("EncOf %d: %v", i, err)
		}
		if seen[string(enc)] {
			t.Fatalf("record %d reuses an ephemeral public key", i)
		}
		seen[string(enc)] = true
	}
	if len(seen) != 64 {
		t.Fatalf("%d distinct ephemeral keys over 64 records", len(seen))
	}
}

// Nonces are random per record too. A repeated (key, nonce) pair under AES-GCM
// is a catastrophic break, and the frame reserves the slot precisely so Phase 3
// can fill it.
func TestEveryRecordGetsADistinctNonce(t *testing.T) {
	s := newTestEncSealer(t)
	seen := make(map[string]bool)
	for i := int64(1); i <= 64; i++ {
		sealed, err := s.Seal(benchEnvelope(i), []byte(`{"i":1}`))
		if err != nil {
			t.Fatalf("Seal %d: %v", i, err)
		}
		n, err := NonceOf(sealed.Bytes)
		if err != nil {
			t.Fatalf("NonceOf %d: %v", i, err)
		}
		if bytes.Equal(n, make([]byte, NonceSize)) {
			t.Fatalf("record %d has a zero nonce; v2 must fill the reserved slot", i)
		}
		seen[string(n)] = true
	}
	if len(seen) != 64 {
		t.Fatalf("%d distinct nonces over 64 records", len(seen))
	}
}

// --- Round trip, and the AAD binding that makes it worth anything ------------

func TestEncSealerRoundTrips(t *testing.T) {
	s := newTestEncSealer(t)
	for _, plain := range [][]byte{
		[]byte(`{}`),
		[]byte(`{"iid":"a","posted_at":"2026-06-01T00:00:00Z","amount":123456,"currency":"AED"}`),
		bytes.Repeat([]byte("compressible "), 60),
	} {
		e := benchEnvelope(11)
		sealed, err := s.Seal(e, plain)
		if err != nil {
			t.Fatalf("Seal: %v", err)
		}
		if sealed.Bytes[0] != EncVersion {
			t.Fatalf("version byte = %d, want %d", sealed.Bytes[0], EncVersion)
		}
		got, err := s.Open(e, sealed)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		if !bytes.Equal(got, plain) {
			t.Fatalf("round trip: got %q, want %q", got, plain)
		}
	}
}

// The whole point of moving the AAD compare into the AEAD: a blob replayed to
// another position must fail CRYPTOGRAPHICALLY, not structurally.
func TestOpenRejectsAWrongPosition(t *testing.T) {
	s := newTestEncSealer(t)
	sealed, err := s.Seal(benchEnvelope(5), []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	for _, wrong := range []Envelope{
		benchEnvelope(6),
		{UserID: uuid.MustParse("00000000-0000-0000-0000-000000000001"), Stream: StreamHot, WriterID: "ingest", WriterCounter: 5},
		{UserID: benchEnvelope(5).UserID, Stream: StreamCold, WriterID: "ingest", WriterCounter: 5},
		{UserID: benchEnvelope(5).UserID, Stream: StreamHot, WriterID: "device-1", WriterCounter: 5},
	} {
		if _, err := s.Open(wrong, sealed); err == nil {
			t.Fatalf("Open at %v succeeded; a replayed blob must not open", wrong)
		} else if !errors.Is(err, ErrSetAside) {
			t.Fatalf("Open at %v: %v, want a set-aside error", wrong, err)
		}
	}
}

// A one-bit flip anywhere inside the sealed region or the tag must fail. Under
// v1 that region is cleartext and a flip is invisible; under v2 it is the AEAD
// doing its job, which is the property Phase 3 buys.
func TestOpenRejectsTampering(t *testing.T) {
	s := newTestEncSealer(t)
	e := benchEnvelope(9)
	sealed, err := s.Seal(e, []byte(`{"amount":"999900"}`))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	start, end, err := SealedRegionV(sealed.Bytes)
	if err != nil {
		t.Fatalf("SealedRegionV: %v", err)
	}
	for _, at := range []int{start, start + 3, end - 1, end, len(sealed.Bytes) - 1} {
		bad := Sealed{Bytes: bytes.Clone(sealed.Bytes), SizeBucket: sealed.SizeBucket}
		bad.Bytes[at] ^= 0x01
		if _, err := s.Open(e, bad); err == nil {
			t.Fatalf("a flipped bit at offset %d still opened", at)
		}
	}
	// And a flip in the cleartext header (the enc field) too.
	bad := Sealed{Bytes: bytes.Clone(sealed.Bytes), SizeBucket: sealed.SizeBucket}
	bad.Bytes[versionSize+aadLenSize+len(e.AAD())] ^= 0x01
	if _, err := s.Open(e, bad); err == nil {
		t.Fatal("a flipped bit in the enc field still opened")
	}
}

// --- The bucket-boundary test Decision 12 mandates ---------------------------

// findPlaintextForFramedLength searches for an incompressible plaintext whose
// framed v2 length is exactly `target`. Incompressible so that gzip's output
// grows monotonically with input, which makes the search terminate.
func findPlaintextForFramedLength(t *testing.T, e Envelope, target int) []byte {
	t.Helper()
	l, err := FrameLayoutFor(EncVersion)
	if err != nil {
		t.Fatalf("FrameLayoutFor: %v", err)
	}
	base := l.Overhead(len(e.AAD()))
	r := mrand.New(mrand.NewPCG(20260802, 1))
	for n := 1; n < 4096; n++ {
		p := make([]byte, n)
		for i := range p {
			p[i] = byte(r.UintN(256))
		}
		payload, err := compress(p)
		if err != nil {
			t.Fatalf("compress: %v", err)
		}
		if base+len(payload) == target {
			return p
		}
	}
	t.Fatalf("no plaintext produced a framed length of exactly %d", target)
	return nil
}

func TestV2BlobOneByteUnderTheBucketBoundaryOpens(t *testing.T) {
	s := newTestEncSealer(t)
	e := benchEnvelope(1)
	// Exactly at 1024, which is the last framed length the 1 KB bucket holds.
	plain := findPlaintextForFramedLength(t, e, 1<<10)
	sealed, err := s.Seal(e, plain)
	if err != nil {
		t.Fatalf("Seal at the boundary: %v", err)
	}
	if sealed.SizeBucket != 1<<10 || len(sealed.Bytes) != 1<<10 {
		t.Fatalf("bucket %d / len %d, want 1024 for a framed length of exactly 1024", sealed.SizeBucket, len(sealed.Bytes))
	}
	got, err := s.Open(e, sealed)
	if err != nil {
		t.Fatalf("Open at the boundary: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatal("boundary blob opened to the wrong plaintext")
	}
}

// The mirror: one byte MORE must move up a rung. An unbranched overhead()
// under-counts by 32, so this is the record that would silently overrun.
func TestV2BlobOneByteOverTheBucketBoundaryMovesUpARung(t *testing.T) {
	s := newTestEncSealer(t)
	e := benchEnvelope(1)
	plain := findPlaintextForFramedLength(t, e, (1<<10)+1)
	sealed, err := s.Seal(e, plain)
	if err != nil {
		t.Fatalf("Seal one byte over: %v", err)
	}
	if sealed.SizeBucket != 4<<10 {
		t.Fatalf("bucket %d, want 4096: a framed length of 1025 does not fit 1024", sealed.SizeBucket)
	}
	if _, err := s.Open(e, sealed); err != nil {
		t.Fatalf("Open: %v", err)
	}
}

// An unbranched overhead() would also let BucketFor pick a bucket 32 bytes too
// small. Rather than trusting the two boundary cases above to catch every
// arrangement, sweep every plaintext length in the interesting window and
// assert the framed blob always opens.
func TestEveryPlaintextLengthNearTheBoundaryRoundTrips(t *testing.T) {
	s := newTestEncSealer(t)
	e := benchEnvelope(1234)
	r := mrand.New(mrand.NewPCG(20260802, 2))
	for n := 850; n <= 1000; n++ {
		p := make([]byte, n)
		for i := range p {
			p[i] = byte(r.UintN(256))
		}
		sealed, err := s.Seal(e, p)
		if err != nil {
			t.Fatalf("Seal %d bytes: %v", n, err)
		}
		if !isBucket(len(sealed.Bytes)) {
			t.Fatalf("Seal %d bytes produced %d bytes, not a bucket", n, len(sealed.Bytes))
		}
		got, err := s.Open(e, sealed)
		if err != nil {
			t.Fatalf("Open %d bytes: %v", n, err)
		}
		if !bytes.Equal(got, p) {
			t.Fatalf("round trip lost bytes at length %d", n)
		}
	}
}

// --- Version isolation -------------------------------------------------------

// Decision 12's versioning claim: today's v1 reader must REFUSE a v2 blob, and
// refuse it by version rather than by some accident of length.
func TestShippedV1OpenRejectsAV2Blob(t *testing.T) {
	s := newTestEncSealer(t)
	e := benchEnvelope(2)
	sealed, err := s.Seal(e, []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	_, err = PlaintextSealer{}.Open(e, sealed)
	if !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("v1 Open of a v2 blob = %v, want ErrUnsupportedVersion", err)
	}
}

// And the reverse: the v2 sealer must not silently open a v1 (plaintext) blob
// as though it had been encrypted.
func TestEncOpenRejectsAV1Blob(t *testing.T) {
	s := newTestEncSealer(t)
	e := benchEnvelope(2)
	sealed, err := PlaintextSealer{}.Seal(e, []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if _, err := s.Open(e, sealed); !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("v2 Open of a v1 blob = %v, want ErrUnsupportedVersion", err)
	}
}

// --- The envelope's own overhead check must follow the version ---------------

func TestValidateFrameAccountsForTheEncField(t *testing.T) {
	// An AAD long enough that v1's framing fits the smallest bucket and v2's
	// does not. v1 overhead = 35 + aadLen; v2 = 67 + aadLen.
	long := make([]byte, 0)
	_ = long
	e := Envelope{
		UserID:        uuid.MustParse("6f9619ff-8b86-d011-b42d-00cf4fc964ff"),
		Stream:        StreamHot,
		WriterID:      string(bytes.Repeat([]byte("w"), 1024-35-1-len("6f9619ff-8b86-d011-b42d-00cf4fc964ff|hot|")-1)),
		WriterCounter: 1,
	}
	if err := e.Validate(); err != nil {
		t.Fatalf("this envelope is meant to be legal at v1: %v", err)
	}
	if err := e.ValidateFrame(Version); err != nil {
		t.Fatalf("ValidateFrame(1) = %v, want nil (it must agree with Validate)", err)
	}
	if err := e.ValidateFrame(EncVersion); err == nil {
		t.Fatal("ValidateFrame(2) accepted an envelope whose v2 framing does not fit the smallest bucket")
	}
}

func TestValidateFrameAgreesWithValidateOnEveryV1Envelope(t *testing.T) {
	for _, e := range []Envelope{
		benchEnvelope(1),
		{Stream: StreamHot, WriterID: "ingest", WriterCounter: 1},                                   // zero user
		{UserID: benchEnvelope(1).UserID, Stream: "hott", WriterID: "ingest", WriterCounter: 1},     // bad stream
		{UserID: benchEnvelope(1).UserID, Stream: StreamHot, WriterID: "", WriterCounter: 1},        // empty writer
		{UserID: benchEnvelope(1).UserID, Stream: StreamHot, WriterID: "a|b", WriterCounter: 1},     // separator
		{UserID: benchEnvelope(1).UserID, Stream: StreamHot, WriterID: "ingest", WriterCounter: 0},  // zero counter
		{UserID: benchEnvelope(1).UserID, Stream: StreamHot, WriterID: "ingest", WriterCounter: -1}, // negative
	} {
		want := e.Validate() == nil
		got := e.ValidateFrame(Version) == nil
		if got != want {
			t.Fatalf("ValidateFrame(1) ok=%v but Validate ok=%v for %+v", got, want, e)
		}
	}
}

// --- The key derivation, pinned so Swift and TypeScript can reproduce it -----

// The derivation is a fixed function of (shared, enc, recipientPub). If it ever
// changes, the Swift module and the @noble arm silently stop agreeing with the
// generator and every arm fails at once with no clue why — so it is pinned
// against a hard-coded vector rather than against itself.
func TestDeriveEncKeyIsPinned(t *testing.T) {
	shared := bytes.Repeat([]byte{0x01}, 32)
	enc := bytes.Repeat([]byte{0x02}, 32)
	pub := bytes.Repeat([]byte{0x03}, 32)
	got := DeriveEncKey(shared, enc, pub)
	if len(got) != 32 {
		t.Fatalf("key is %d bytes, want 32", len(got))
	}
	// Recomputing with a different info string must give a different key —
	// otherwise the info is not actually in the derivation.
	if bytes.Equal(got, deriveEncKeyWithInfo(shared, enc, pub, "not-"+EncInfo)) {
		t.Fatal("the info string is not bound into the derived key")
	}
	// And each input must matter.
	if bytes.Equal(got, DeriveEncKey(bytes.Repeat([]byte{0x09}, 32), enc, pub)) {
		t.Fatal("the shared secret is not bound into the derived key")
	}
	if bytes.Equal(got, DeriveEncKey(shared, bytes.Repeat([]byte{0x09}, 32), pub)) {
		t.Fatal("enc is not bound into the derived key")
	}
	if bytes.Equal(got, DeriveEncKey(shared, enc, bytes.Repeat([]byte{0x09}, 32))) {
		t.Fatal("the recipient public key is not bound into the derived key")
	}
}

// A sealer built for one recipient must not open under another's key.
func TestOpenNeedsTheRightRecipientKey(t *testing.T) {
	a := newTestEncSealer(t)
	b := newTestEncSealer(t)
	e := benchEnvelope(4)
	sealed, err := a.Seal(e, []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if _, err := b.Open(e, sealed); err == nil {
		t.Fatal("a blob sealed to recipient A opened under recipient B's key")
	}
	if _, err := a.Open(e, sealed); err != nil {
		t.Fatalf("Open under the right key: %v", err)
	}
}

func TestNewEncSealerFromKeyReproducesThePublicKey(t *testing.T) {
	priv := make([]byte, 32)
	if _, err := rand.Read(priv); err != nil {
		t.Fatalf("rand: %v", err)
	}
	s1, err := NewEncSealerFromKey(priv)
	if err != nil {
		t.Fatalf("NewEncSealerFromKey: %v", err)
	}
	s2, err := NewEncSealerFromKey(priv)
	if err != nil {
		t.Fatalf("NewEncSealerFromKey: %v", err)
	}
	if !bytes.Equal(s1.RecipientPub(), s2.RecipientPub()) {
		t.Fatal("the same private key produced two different public keys")
	}
	if _, err := NewEncSealerFromKey(priv[:31]); err == nil {
		t.Fatal("a 31-byte private key was accepted")
	}
}

// The low-order-point hazard, at the place it actually bites: a frame carrying
// an all-zero `enc` makes X25519 produce an all-zero shared secret, which
// curve25519 reports as an error rather than deriving a key everyone can
// compute. Asserted here because a hand-rolled DHKEM is exactly where this gets
// dropped, and a corpus loader takes its records from a file.
func TestOpenRejectsALowOrderEncPoint(t *testing.T) {
	s := newTestEncSealer(t)
	e := benchEnvelope(8)
	sealed, err := s.Seal(e, []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	l, _ := FrameLayoutFor(EncVersion)
	off := l.EncOffset(len(e.AAD()))
	bad := Sealed{Bytes: bytes.Clone(sealed.Bytes), SizeBucket: sealed.SizeBucket}
	for i := range EncSize {
		bad.Bytes[off+i] = 0
	}
	if _, err := s.Open(e, bad); err == nil {
		t.Fatal("a frame with an all-zero ephemeral key opened")
	}
}

// A sanity check on the arithmetic the corpus generator asserts: an ingest hot
// record at a four-digit counter has 119 bytes of v2 framing overhead, leaving
// 905 bytes of gzip payload inside the 1 KB bucket.
func TestIngestRecordOverheadLeavesRoomInTheKilobyteBucket(t *testing.T) {
	l, _ := FrameLayoutFor(EncVersion)
	e := benchEnvelope(3683)
	got := l.Overhead(len(e.AAD()))
	if got != 119 {
		t.Fatalf("v2 overhead for an ingest hot record at counter 3683 = %d, want 119", got)
	}
	if room := (1 << 10) - got; room != 905 {
		t.Fatalf("payload room = %d, want 905", room)
	}
}

// The boundary tests above are only meaningful if the search that constructs
// their input is reproducible; otherwise a failure cannot be re-run.
func TestSearchHelperIsDeterministic(t *testing.T) {
	e := benchEnvelope(1)
	a := findPlaintextForFramedLength(t, e, 1<<10)
	b := findPlaintextForFramedLength(t, e, 1<<10)
	if !bytes.Equal(a, b) {
		t.Fatal("the seeded search is not deterministic")
	}
	if len(a) == 0 {
		t.Fatal("empty plaintext")
	}
}
