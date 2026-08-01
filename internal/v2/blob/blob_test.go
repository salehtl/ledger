package blob

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"math/rand"
	"testing"

	"github.com/google/uuid"
)

func env() Envelope {
	return Envelope{UserID: uuid.MustParse("11111111-1111-1111-1111-111111111111"),
		Stream: "hot", WriterID: "dev-a", WriterCounter: 7}
}

// The wire layout, restated here in the test's own words on purpose. The
// production code must agree with this description, not the other way round:
// if someone moves a field, exactly one of the two changes and the tests fail.
const (
	wireVersionOff = 0
	wireAADLenOff  = 1
	wireAADOff     = 3
	wireNonceSize  = 12
	wireTagSize    = 16
)

// sealedBounds derives the half-open range Phase 3 will encrypt, using only the
// frozen layout above — never the package's own helper.
func sealedBounds(b []byte) (start, end int) {
	aadLen := int(binary.BigEndian.Uint16(b[wireAADLenOff : wireAADLenOff+2]))
	return wireAADOff + aadLen + wireNonceSize, len(b) - wireTagSize
}

// incompressible returns n bytes gzip cannot shrink, so a test can control the
// on-wire payload size instead of guessing at deflate.
func incompressible(n int) []byte {
	b := make([]byte, n)
	rand.New(rand.NewSource(1)).Read(b)
	return b
}

func TestSealRoundTripsAndPadsToBucket(t *testing.T) {
	s := PlaintextSealer{}
	msg := []byte(`{"type":"txn_ingested"}`)
	sealed, err := s.Seal(env(), msg)
	if err != nil {
		t.Fatal(err)
	}
	if sealed.SizeBucket != 1<<10 || len(sealed.Bytes) != 1<<10 {
		t.Fatalf("want 1KB bucket, got bucket=%d len=%d", sealed.SizeBucket, len(sealed.Bytes))
	}
	got, err := s.Open(env(), sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatalf("round trip lost data: %q", got)
	}
}

func TestOpenRejectsAADMismatch(t *testing.T) {
	s := PlaintextSealer{}
	sealed, err := s.Seal(env(), []byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	wrong := env()
	wrong.WriterCounter = 8
	if _, err := s.Open(wrong, sealed); err == nil {
		t.Fatal("expected AAD mismatch to be rejected (blob replayed across positions)")
	}
	wrong = env()
	wrong.Stream = "cold"
	if _, err := s.Open(wrong, sealed); err == nil {
		t.Fatal("expected AAD mismatch to be rejected (blob replayed across streams)")
	}
	wrong = env()
	wrong.UserID = uuid.MustParse("22222222-2222-2222-2222-222222222222")
	if _, err := s.Open(wrong, sealed); err == nil {
		t.Fatal("expected AAD mismatch to be rejected (blob replayed across users)")
	}
	wrong = env()
	wrong.WriterID = "dev-b"
	if _, err := s.Open(wrong, sealed); err == nil {
		t.Fatal("expected AAD mismatch to be rejected (blob replayed across writers)")
	}
}

func TestBucketLadder(t *testing.T) {
	for _, tc := range []struct{ in, want int }{
		{1, 1 << 10}, {1024, 1 << 10}, {1025, 4 << 10}, {70000, 256 << 10},
		{300000, 512 << 10}, {600000, 1 << 20}, {1 << 20, 1 << 20},
	} {
		got, err := BucketFor(tc.in)
		if err != nil || got != tc.want {
			t.Fatalf("BucketFor(%d) = %d, %v; want %d", tc.in, got, err, tc.want)
		}
	}
	if _, err := BucketFor((1 << 20) + 1); err == nil {
		t.Fatal("expected oversize to error")
	}
	if MaxBucket != Buckets[len(Buckets)-1] {
		t.Fatalf("MaxBucket = %d but the ladder tops out at %d", MaxBucket, Buckets[len(Buckets)-1])
	}
	if len(Buckets) != 7 {
		t.Fatalf("the ladder is frozen at seven rungs (Decision 7), got %v", Buckets)
	}
	for i := 1; i < len(Buckets); i++ {
		if Buckets[i] <= Buckets[i-1] {
			t.Fatalf("Buckets must ascend: %v", Buckets)
		}
	}
}

func TestNonceAndTagSlotsAreReservedAndZeroInPhase1(t *testing.T) {
	// Phase 3 fills these. If they are not reserved NOW, every blob near a
	// bucket boundary silently re-buckets the day sealing turns on.
	s := PlaintextSealer{}
	sealed, err := s.Seal(env(), []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	aadLen := int(sealed.Bytes[1])<<8 | int(sealed.Bytes[2])
	nonce := sealed.Bytes[3+aadLen : 3+aadLen+12]
	tag := sealed.Bytes[len(sealed.Bytes)-16:]
	if !bytes.Equal(nonce, make([]byte, 12)) {
		t.Fatal("nonce slot is not reserved")
	}
	if !bytes.Equal(tag, make([]byte, 16)) {
		t.Fatal("tag slot is not reserved")
	}
}

func TestPhase1PayloadIsReadableInTheClear(t *testing.T) {
	// This is the migration tripwire, and it works because it asserts something
	// Phase 3 makes FALSE. (The earlier version of this test asserted the AAD
	// was readable — but the AAD stays cleartext in Phase 3 by definition, so it
	// passed with encryption fully on and defended nothing.)
	s := PlaintextSealer{}
	sealed, err := s.Seal(env(), []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(sealed.Bytes, []byte{0x1f, 0x8b}) {
		t.Fatal("expected the gzip payload to be readable in the clear in Phase 1; " +
			"if this fails, someone turned sealing on early — see Global Constraints")
	}
}

// TestPayloadLengthPrefixesTheSealedRegion pins the one offset the whole design
// turns on: the 4-byte length lives at the START of the region Phase 3 encrypts,
// not in the cleartext header.
func TestPayloadLengthPrefixesTheSealedRegion(t *testing.T) {
	s := PlaintextSealer{}
	sealed, err := s.Seal(env(), []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	start, end := sealedBounds(sealed.Bytes)
	n := int(binary.BigEndian.Uint32(sealed.Bytes[start : start+4]))
	if n <= 0 || start+4+n > end {
		t.Fatalf("payloadLen %d at offset %d does not fit the sealed region [%d,%d)", n, start, start, end)
	}
	if got := sealed.Bytes[start+4 : start+6]; !bytes.Equal(got, []byte{0x1f, 0x8b}) {
		t.Fatalf("payload must start immediately after the length field; got % x", got)
	}
	if !bytes.Equal(sealed.Bytes[start+4+n:end], make([]byte, end-(start+4+n))) {
		t.Fatal("padding must be zero and must live inside the sealed region")
	}
	// And nothing in the cleartext header may encode the payload size.
	if bytes.Contains(sealed.Bytes[:start], sealed.Bytes[start:start+4]) {
		t.Fatal("the length field appears outside the sealed region: padding would be cosmetic")
	}
}

// TestSameBucketBlobsAreIndistinguishableOnceSealed is the anti-regression test
// the whole task exists for. Two ops of very different sizes that land in the
// same bucket must, once the sealed region is opaque, be byte-identical. Move
// the length field (or any size-dependent byte) out of the sealed region and
// this fails — which is exactly what a cleartext payloadLen would do to Phase
// 3's padding.
func TestSameBucketBlobsAreIndistinguishableOnceSealed(t *testing.T) {
	s := PlaintextSealer{}
	small, err := s.Seal(env(), []byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	big, err := s.Seal(env(), incompressible(700))
	if err != nil {
		t.Fatal(err)
	}
	if small.SizeBucket != big.SizeBucket {
		t.Fatalf("test needs both blobs in one bucket, got %d and %d", small.SizeBucket, big.SizeBucket)
	}

	// Simulate Phase 3: replace the sealed region with opaque bytes of the same
	// length (AES-GCM is length-preserving, and the nonce/tag slots are already
	// reserved), leaving the cleartext header exactly as it is today.
	opaque := func(b []byte) []byte {
		out := append([]byte(nil), b...)
		start, end := sealedBounds(out)
		for i := start; i < end; i++ {
			out[i] = 0xAA
		}
		return out
	}
	a, b := opaque(small.Bytes), opaque(big.Bytes)
	if !bytes.Equal(a, b) {
		for i := range a {
			if a[i] != b[i] {
				t.Fatalf("size information leaks outside the sealed region at offset %d "+
					"(%#x vs %#x): a 1-byte op is distinguishable from a 700-byte one, "+
					"so Phase 3's bucket padding would be cosmetic", i, a[i], b[i])
			}
		}
		t.Fatal("blobs differ in length outside the sealed region")
	}
}

func TestOpenRejectsHostileInput(t *testing.T) {
	s := PlaintextSealer{}
	good, err := s.Seal(env(), []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	mutate := func(f func([]byte)) Sealed {
		b := append([]byte(nil), good.Bytes...)
		f(b)
		return Sealed{Bytes: b, SizeBucket: len(b)}
	}

	cases := []struct {
		name string
		in   Sealed
	}{
		{"unknown version", mutate(func(b []byte) { b[0] = 2 })},
		{"aadLen past the blob", mutate(func(b []byte) { binary.BigEndian.PutUint16(b[1:3], 60000) })},
		{"payloadLen past the sealed region", mutate(func(b []byte) {
			start, _ := sealedBounds(b)
			binary.BigEndian.PutUint32(b[start:start+4], 1<<20)
		})},
		{"payload is not gzip", mutate(func(b []byte) {
			start, _ := sealedBounds(b)
			b[start+4] = 0x00
		})},
		{"truncated to a non-bucket length", Sealed{Bytes: good.Bytes[:511], SizeBucket: 511}},
		{"empty", Sealed{Bytes: nil}},
	}
	for _, tc := range cases {
		if _, err := s.Open(env(), tc.in); err == nil {
			t.Fatalf("%s: expected an error", tc.name)
		} else if !errors.Is(err, ErrSetAside) {
			t.Fatalf("%s: every Open failure must be set-aside, not a hard stop: %v", tc.name, err)
		}
	}
}

// frame builds a blob the way the frozen layout says to, without going through
// Seal — hostile bytes do not come from our own encoder, and re-deriving the
// offsets here is a second, independent statement of the format.
func frame(t *testing.T, e Envelope, payload []byte) Sealed {
	t.Helper()
	aad := e.AAD()
	total := wireAADOff + len(aad) + wireNonceSize + 4 + len(payload) + wireTagSize
	bucket, err := BucketFor(total)
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, bucket)
	b[wireVersionOff] = Version
	binary.BigEndian.PutUint16(b[wireAADLenOff:wireAADLenOff+2], uint16(len(aad)))
	copy(b[wireAADOff:], aad)
	start := wireAADOff + len(aad) + wireNonceSize
	binary.BigEndian.PutUint32(b[start:start+4], uint32(len(payload)))
	copy(b[start+4:], payload)
	return Sealed{Bytes: b, SizeBucket: bucket}
}

func TestOpenRejectsGzipBomb(t *testing.T) {
	// A blob arriving from the inbound path is attacker-influenced. 8 MB of one
	// byte compresses into the 16 KB bucket, so the framing alone cannot bound
	// what Open allocates — the decompressed-size cap has to do it.
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if _, err := zw.Write(bytes.Repeat([]byte("A"), 8<<20)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	bomb := frame(t, env(), buf.Bytes())

	if _, err := (PlaintextSealer{}).Open(env(), bomb); err == nil {
		t.Fatal("expected an over-cap decompressed payload to be refused on Open")
	} else if !errors.Is(err, ErrSetAside) {
		t.Fatalf("gzip-bomb rejection must be set-aside, not a hard stop: %v", err)
	}
}

// TestSealAndOpenAgreeOnTheSizeCap pins the property that matters more than the
// cap's exact value: nothing Seal accepts may fail to Open. A cap that bound
// only Open would let a legal max-size email be stored and then be permanently
// unreadable.
func TestSealAndOpenAgreeOnTheSizeCap(t *testing.T) {
	s := PlaintextSealer{}
	big := bytes.Repeat([]byte("A"), MaxPlaintext)
	sealed, err := s.Seal(env(), big)
	if err != nil {
		t.Fatalf("a plaintext at exactly the cap must seal: %v", err)
	}
	got, err := s.Open(env(), sealed)
	if err != nil {
		t.Fatalf("a plaintext at exactly the cap must open: %v", err)
	}
	if len(got) != len(big) {
		t.Fatalf("round trip returned %d bytes, want %d", len(got), len(big))
	}
	if _, err := s.Seal(env(), append(big, 'A')); err == nil {
		t.Fatal("a plaintext past the cap must be refused by Seal, not discovered at Open")
	}

	// A cold record base64s a max-size (1 MiB) email inside a JSON object, so
	// the cap has to clear that or ingest stores blobs it can never read back.
	const maxMail = 1 << 20
	if want := maxMail*4/3 + 1024; MaxPlaintext < want {
		t.Fatalf("MaxPlaintext = %d is under the %d bytes a base64'd max-size email needs", MaxPlaintext, want)
	}
}

func TestHashChainsOverTheFramedBytes(t *testing.T) {
	s := PlaintextSealer{}
	a, err := s.Seal(env(), []byte("one"))
	if err != nil {
		t.Fatal(err)
	}
	e2 := env()
	e2.WriterCounter = 8
	b, err := s.Seal(e2, []byte("two"))
	if err != nil {
		t.Fatal(err)
	}

	h1 := Hash(ZeroHash, a)
	h2 := Hash(h1, b)
	if h1 == ZeroHash || h2 == h1 {
		t.Fatal("chain hashes must advance")
	}
	if Hash(ZeroHash, a) != h1 {
		t.Fatal("Hash must be deterministic")
	}
	if Hash(h1, a) == h2 {
		t.Fatal("chain hash must depend on the blob, not only on prev")
	}
	if Hash(ZeroHash, b) == h2 {
		t.Fatal("chain hash must depend on prev, not only on the blob")
	}
}

func TestSealRejectsEnvelopesThatWouldForgeAnAAD(t *testing.T) {
	// The AAD is "|"-joined, so a separator inside a field would let two
	// different positions produce identical associated data.
	s := PlaintextSealer{}
	for _, e := range []Envelope{
		{UserID: env().UserID, Stream: "hot|dev-a", WriterID: "", WriterCounter: 7},
		{UserID: env().UserID, Stream: "hot", WriterID: "dev|a", WriterCounter: 7},
		{UserID: env().UserID, Stream: "", WriterID: "dev-a", WriterCounter: 7},
		{UserID: env().UserID, Stream: "hot", WriterID: "dev-a", WriterCounter: -1},
	} {
		if _, err := s.Seal(e, []byte("x")); err == nil {
			t.Fatalf("expected %+v to be rejected", e)
		}
	}
}

func TestAADIsTheFrozenFieldSet(t *testing.T) {
	got := string(env().AAD())
	want := "11111111-1111-1111-1111-111111111111|hot|dev-a|7"
	if got != want {
		t.Fatalf("AAD = %q, want %q (spec §3.4 binds exactly these four fields)", got, want)
	}
}

func TestLargeBodyRoundTripsInAHigherBucket(t *testing.T) {
	// The corpus's largest compressed body is ~314 KB, which is why the ladder
	// goes past 64 KB (Decision 7).
	s := PlaintextSealer{}
	msg := incompressible(300 << 10)
	sealed, err := s.Seal(env(), msg)
	if err != nil {
		t.Fatal(err)
	}
	if sealed.SizeBucket != 512<<10 {
		t.Fatalf("SizeBucket = %d, want 512KB", sealed.SizeBucket)
	}
	got, err := s.Open(env(), sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatal("large round trip lost data")
	}
}
