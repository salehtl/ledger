package api

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/config"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type fakeVerifier struct {
	mu       sync.Mutex
	calls    int
	lastOpts auth.VerifyOpts
	identity auth.Identity
	err      error
}

func (f *fakeVerifier) Verify(_ context.Context, idToken string, opts auth.VerifyOpts) (auth.Identity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.lastOpts = opts
	if f.err != nil {
		return auth.Identity{}, f.err
	}
	id := f.identity
	if id.Subject == "" {
		id.Subject = "sub-" + idToken
	}
	if id.IdP == "" {
		id.IdP = auth.IdPApple
	}
	if id.IssuedAt.IsZero() {
		// A real verifier ALWAYS reports iat — VerifyOpts.MaxAge refuses a
		// token that will not say when it was minted — so a fake that left it
		// zero would make every freshness-checking endpoint (account deletion,
		// address rotation) untestable except in its refusal path. A test that
		// wants a stale token sets identity.IssuedAt itself.
		id.IssuedAt = time.Now()
	}
	return id, nil
}

func (f *fakeVerifier) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type harness struct {
	t     *testing.T
	pool  *pgxpool.Pool
	srv   *Server
	h     http.Handler
	apple *fakeVerifier
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	pool := pgtest.New(t)
	apple := &fakeVerifier{}
	srv := &Server{
		Pool:      pool,
		Sessions:  &auth.Sessions{Pool: pool, TTL: time.Hour},
		Writers:   &auth.Writers{Pool: pool},
		Appender:  &oplog.Appender{Pool: pool},
		Verifiers: map[string]auth.Verifier{auth.IdPApple: apple},
		Logf:      func(string, ...any) {},
	}
	return &harness{t: t, pool: pool, srv: srv, h: srv.Handler(), apple: apple}
}

func (h *harness) user(sub string) uuid.UUID {
	h.t.Helper()
	u, err := auth.UpsertUser(bg, h.pool, auth.Identity{IdP: auth.IdPApple, Subject: sub})
	if err != nil {
		h.t.Fatal(err)
	}
	return u
}

func (h *harness) session(u uuid.UUID) string {
	h.t.Helper()
	tok, err := h.srv.Sessions.Issue(bg, u)
	if err != nil {
		h.t.Fatal(err)
	}
	return tok
}

// writer enrolls a device writer through the real capability path (challenge +
// signature), because a roster row planted by hand would not prove the upload
// handler consults the roster the same way the rest of the system does.
func (h *harness) writer(u uuid.UUID, id string) ed25519.PrivateKey {
	h.t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		h.t.Fatal(err)
	}
	nonce, err := h.srv.Writers.Challenge(bg, u)
	if err != nil {
		h.t.Fatal(err)
	}
	sig := ed25519.Sign(priv, auth.RegistrationMessage(nonce, id, pub))
	if err := h.srv.Writers.Register(bg, u, id, pub, nonce, sig); err != nil {
		h.t.Fatalf("register writer %s: %v", id, err)
	}
	return priv
}

func (h *harness) req(method, path, token string, body any) *httptest.ResponseRecorder {
	h.t.Helper()
	var r *http.Request
	switch b := body.(type) {
	case nil:
		r = httptest.NewRequest(method, path, nil)
	case []byte:
		r = httptest.NewRequest(method, path, bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			h.t.Fatal(err)
		}
		r = httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.h.ServeHTTP(w, r)
	return w
}

func decodeJSON[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
	return out
}

func wantStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status %d, want %d (body %s)", w.Code, want, w.Body.String())
	}
}

// seedIngest appends n messages, each one hot blob plus one cold blob, so the
// two streams interleave in the single per-user seq space.
func (h *harness) seedIngest(u uuid.UUID, n int) {
	h.t.Helper()
	for i := 0; i < n; i++ {
		if _, err := h.srv.Appender.AppendIngest(bg, u, []oplog.IngestBlob{
			{Stream: blob.StreamHot, Plaintext: []byte(fmt.Sprintf(`{"hot":%d}`, i))},
			{Stream: blob.StreamCold, Plaintext: []byte(fmt.Sprintf(`{"cold":%d}`, i))},
		}); err != nil {
			h.t.Fatal(err)
		}
	}
}

// sealUpload builds one wire blob for the upload endpoint, sealed at exactly
// the position it declares.
func sealUpload(t *testing.T, u uuid.UUID, writerID, stream string, counter int64, prev [32]byte, body string) (UploadBlob, [32]byte) {
	t.Helper()
	sealed, err := blob.PlaintextSealer{}.Seal(blob.Envelope{
		UserID: u, Stream: stream, WriterID: writerID, WriterCounter: counter,
	}, []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	h := blob.Hash(prev, sealed)
	return UploadBlob{
		WriterCounter: strconv.FormatInt(counter, 10),
		PrevHash:      hex.EncodeToString(prev[:]),
		BlobHash:      hex.EncodeToString(h[:]),
		TypeFlag:      oplog.TypeFlagEdit,
		SizeBucket:    sealed.SizeBucket,
		Blob:          base64.StdEncoding.EncodeToString(sealed.Bytes),
	}, h
}

func uploadChain(t *testing.T, u uuid.UUID, writerID string, start int64, prev [32]byte, n int) ([]UploadBlob, [32]byte) {
	t.Helper()
	out := make([]UploadBlob, 0, n)
	for i := 0; i < n; i++ {
		b, h := sealUpload(t, u, writerID, blob.StreamHot, start+int64(i), prev, fmt.Sprintf(`{"op":%d}`, start+int64(i)))
		out = append(out, b)
		prev = h
	}
	return out, prev
}

func countRows(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM op_log WHERE user_id = $1`, u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

func TestSyncReturnsOnlyTheCallersRows(t *testing.T) {
	h := newHarness(t)
	a, b := h.user("a"), h.user("b")
	h.seedIngest(a, 2)
	h.seedIngest(b, 3)

	got := decodeJSON[PullResponse](t, h.req("GET", "/api/v1/sync?stream=hot", h.session(a), nil))
	if len(got.Rows) != 2 {
		t.Fatalf("user a pulled %d hot rows, want 2", len(got.Rows))
	}
	bRows := decodeJSON[PullResponse](t, h.req("GET", "/api/v1/sync?stream=hot", h.session(b), nil))
	for _, ra := range got.Rows {
		for _, rb := range bRows.Rows {
			if ra.Seq == rb.Seq && ra.BlobHash == rb.BlobHash {
				t.Fatal("user a and user b were served the same row")
			}
		}
	}
}

func TestSyncIgnoresAUserIDSuppliedByTheCaller(t *testing.T) {
	h := newHarness(t)
	a, b := h.user("a"), h.user("b")
	h.seedIngest(b, 4)

	// Every query is scoped by the RESOLVED session user. A user_id in the
	// request must be inert, not authoritative.
	got := decodeJSON[PullResponse](t, h.req("GET", "/api/v1/sync?stream=hot&user_id="+b.String(), h.session(a), nil))
	if len(got.Rows) != 0 {
		t.Fatalf("a user_id query parameter pulled %d of another user's rows", len(got.Rows))
	}
}

func TestHotOnlyPullIsCompleteForItsStream(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	h.seedIngest(u, 10)

	got := decodeJSON[PullResponse](t, h.req("GET", "/api/v1/sync?stream=hot&limit=100", h.session(u), nil))
	if len(got.Rows) != 10 {
		t.Fatalf("pulled %d hot rows, want 10", len(got.Rows))
	}
	if !got.Complete {
		t.Fatal("a pull that returned the whole stream reported complete=false")
	}
	rows := make([]oplog.Row, len(got.Rows))
	var last int64
	sparse := false
	for i, r := range got.Rows {
		seq := mustInt(t, r.Seq)
		if seq <= last {
			t.Fatalf("row %d seq %d does not follow %d", i, seq, last)
		}
		if last != 0 && seq != last+1 {
			sparse = true
		}
		last = seq
		if r.Stream != blob.StreamHot {
			t.Fatalf("row %d is on stream %q", i, r.Stream)
		}
		if got := mustInt(t, r.WriterCounter); got != int64(i+1) {
			t.Fatalf("row %d has hot writer_counter %d, want %d", i, got, i+1)
		}
		rows[i] = wireToRow(t, r)
	}
	if !sparse {
		t.Fatal("hot seqs came back contiguous; the interleaved fixture did not take")
	}
	// Sparse in the global seq space, contiguous and self-verifying in its own
	// chain: that is the property a per-stream cursor rests on.
	if err := oplog.VerifyChain(rows, 0, blob.ZeroHash); err != nil {
		t.Fatalf("the hot rows must verify as one chain from genesis: %v", err)
	}
	if got.Next != got.Rows[len(got.Rows)-1].Seq {
		t.Fatalf("next is %q, want the last seq %q", got.Next, got.Rows[len(got.Rows)-1].Seq)
	}
}

func TestSyncCursorPagesWithoutGapsWithinAStream(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	h.seedIngest(u, 250)

	var counters []int64
	after := "0"
	pages := 0
	for {
		got := decodeJSON[PullResponse](t, h.req("GET", "/api/v1/sync?stream=hot&limit=100&after="+after, tok, nil))
		pages++
		for _, r := range got.Rows {
			counters = append(counters, mustInt(t, r.WriterCounter))
		}
		if got.Complete {
			break
		}
		if len(got.Rows) == 0 {
			t.Fatal("an incomplete page returned no rows: the cursor cannot advance")
		}
		after = got.Next
		if pages > 10 {
			t.Fatal("paging did not terminate")
		}
	}
	if len(counters) != 250 {
		t.Fatalf("paged %d rows, want 250", len(counters))
	}
	for i, c := range counters {
		if c != int64(i+1) {
			t.Fatalf("counter %d is %d, want %d — the pages do not concatenate", i, c, i+1)
		}
	}
}

func TestHashListCoversEveryColdBlobAndMatchesTheStoredHashes(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	h.seedIngest(u, 8)

	rows := decodeJSON[PullResponse](t, h.req("GET", "/api/v1/sync?stream=cold&limit=100", tok, nil))
	hashes := decodeJSON[HashesResponse](t, h.req("GET", "/api/v1/sync/hashes?stream=cold&limit=100", tok, nil))
	if len(hashes.Hashes) != len(rows.Rows) {
		t.Fatalf("%d cold hashes for %d cold rows", len(hashes.Hashes), len(rows.Rows))
	}
	prev := hex.EncodeToString(blob.ZeroHash[:])
	for i, e := range hashes.Hashes {
		if e.Seq != rows.Rows[i].Seq || e.BlobHash != rows.Rows[i].BlobHash {
			t.Fatalf("hash %d does not match the stored row", i)
		}
		if e.PrevHash != prev {
			t.Fatalf("hash %d links to %s, but the list is at %s", i, e.PrevHash, prev)
		}
		if e.WriterCounter != strconv.Itoa(i+1) {
			t.Fatalf("hash %d has counter %s, want %d", i, e.WriterCounter, i+1)
		}
		prev = e.BlobHash
	}
	if !hashes.Complete {
		t.Fatal("a hash list covering the whole stream reported complete=false")
	}
}

func TestAPullTruncatedByTheByteBudgetIsNotComplete(t *testing.T) {
	// This is the case `complete` exists for and the one a page-size heuristic
	// gets wrong: the page ends early because of BYTES, not because the row
	// limit was reached or the stream ran out. A client told "complete" here
	// stops syncing with rows outstanding.
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	h.seedIngest(u, 5)
	h.srv.PullByteBudget = 2 * 1024 // two smallest-bucket blobs
	h.h = h.srv.Handler()

	first := decodeJSON[PullResponse](t, h.req("GET", "/api/v1/sync?stream=hot&limit=100", tok, nil))
	if len(first.Rows) != 2 {
		t.Fatalf("a 2 KiB budget returned %d rows, want 2", len(first.Rows))
	}
	if first.Complete {
		t.Fatal("a page truncated by the byte budget reported complete=true; " +
			"the client would stop syncing with 3 rows outstanding")
	}

	// And the cursor still walks the whole stream.
	seen := len(first.Rows)
	next := first.Next
	for i := 0; i < 10; i++ {
		page := decodeJSON[PullResponse](t, h.req("GET", "/api/v1/sync?stream=hot&limit=100&after="+next, tok, nil))
		seen += len(page.Rows)
		next = page.Next
		if page.Complete {
			break
		}
	}
	if seen != 5 {
		t.Fatalf("paging under a byte budget saw %d rows, want 5", seen)
	}
}

func TestPullRejectsAnUnknownStream(t *testing.T) {
	h := newHarness(t)
	tok := h.session(h.user("u"))
	wantStatus(t, h.req("GET", "/api/v1/sync?stream=warm", tok, nil), http.StatusBadRequest)
	wantStatus(t, h.req("GET", "/api/v1/sync", tok, nil), http.StatusBadRequest)
	wantStatus(t, h.req("GET", "/api/v1/sync/hashes?stream=", tok, nil), http.StatusBadRequest)
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

func TestUploadAppendsAndIsIdempotentOnResend(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	h.writer(u, "dev-a")

	blobs, _ := uploadChain(t, u, "dev-a", 1, blob.ZeroHash, 3)
	body := UploadRequest{WriterID: "dev-a", Stream: blob.StreamHot, Blobs: blobs}
	w := h.req("POST", "/api/v1/sync", tok, body)
	wantStatus(t, w, http.StatusOK)
	first := decodeJSON[UploadResponse](t, w)
	if len(first.Seqs) != 3 {
		t.Fatalf("upload returned %d seqs, want 3", len(first.Seqs))
	}

	again := decodeJSON[UploadResponse](t, h.req("POST", "/api/v1/sync", tok, body))
	if fmt.Sprint(again.Seqs) != fmt.Sprint(first.Seqs) {
		t.Fatalf("a byte-identical resend returned %v, want the original %v", again.Seqs, first.Seqs)
	}
	if n := countRows(t, h.pool, u); n != 3 {
		t.Fatalf("op_log holds %d rows after a resend, want 3", n)
	}
}

func TestUploadRejectsAWriterIDTheCallerDoesNotOwn(t *testing.T) {
	h := newHarness(t)
	a, b := h.user("a"), h.user("b")
	h.writer(b, "dev-b")
	blobs, _ := uploadChain(t, a, "dev-b", 1, blob.ZeroHash, 1)

	w := h.req("POST", "/api/v1/sync", h.session(a), UploadRequest{
		WriterID: "dev-b", Stream: blob.StreamHot, Blobs: blobs,
	})
	wantStatus(t, w, http.StatusForbidden)
	if n := countRows(t, h.pool, a); n != 0 {
		t.Fatalf("%d rows were appended for a writer the caller does not own", n)
	}
	if n := countRows(t, h.pool, b); n != 0 {
		t.Fatalf("%d rows were appended into the OTHER user's log", n)
	}
}

func TestUploadCannotWriteIntoAnotherUsersLog(t *testing.T) {
	h := newHarness(t)
	a, b := h.user("a"), h.user("b")
	h.writer(a, "dev-a")
	h.writer(b, "dev-a") // same writer id, different account

	// Blobs sealed for user b's AAD, submitted on user a's session. There is no
	// user field on the wire, so the only way to aim at b is through the AAD —
	// and the position check must refuse it.
	blobs, _ := uploadChain(t, b, "dev-a", 1, blob.ZeroHash, 1)
	w := h.req("POST", "/api/v1/sync", h.session(a), UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: blobs,
	})
	wantStatus(t, w, http.StatusBadRequest)
	if n := countRows(t, h.pool, b); n != 0 {
		t.Fatalf("%d rows landed in the other user's log", n)
	}
	if n := countRows(t, h.pool, a); n != 0 {
		t.Fatalf("%d rows landed under the caller with someone else's AAD", n)
	}
}

func TestUploadRejectsIngestWriterID(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	h.writer(u, "dev-a")
	// The ingest writer must be ON the roster, and the user must own a device
	// writer too. Without both, a 403 proves nothing: an empty roster makes
	// writerIsLive answer "no such writer" with the same status, so deleting
	// the ingest check entirely would still look green. The status is therefore
	// checked together with the detail that only the ingest check produces.
	if _, err := h.srv.Writers.EnsureIngestWriter(bg, u); err != nil {
		t.Fatal(err)
	}
	blobs, _ := uploadChain(t, u, oplog.IngestWriterID, 1, blob.ZeroHash, 1)
	w := h.req("POST", "/api/v1/sync", h.session(u), UploadRequest{
		WriterID: oplog.IngestWriterID, Stream: blob.StreamHot, Blobs: blobs,
	})
	wantStatus(t, w, http.StatusForbidden)
	if !bytes.Contains(w.Body.Bytes(), []byte("the ingest writer is the server's own")) {
		t.Fatalf("the rejection did not come from the ingest check: %s", w.Body.String())
	}
	if n := countRows(t, h.pool, u); n != 0 {
		t.Fatalf("%d rows were appended under the server's own writer", n)
	}
}

func TestUploadRejectsARevokedWriter(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	priv := h.writer(u, "dev-a")

	// A device retiring itself is the ordinary revocation flow: the target's
	// own live key may authorize it.
	nonce, err := h.srv.Writers.Challenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.srv.Writers.Revoke(bg, u, "dev-a", nonce, ed25519.Sign(priv, auth.RevocationMessage(nonce, "dev-a"))); err != nil {
		t.Fatal(err)
	}
	blobs, _ := uploadChain(t, u, "dev-a", 1, blob.ZeroHash, 1)
	w := h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: blobs,
	})
	wantStatus(t, w, http.StatusForbidden)
	if n := countRows(t, h.pool, u); n != 0 {
		t.Fatalf("%d rows were appended by a revoked writer", n)
	}
}

func TestUploadRejectsBlobWhoseAADDoesNotMatchTheRow(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	h.writer(u, "dev-a")

	// Sealed for counter 5, submitted as counter 1. The bytes are well formed
	// and the chain arithmetic is honest; only the position is a lie.
	b, _ := sealUpload(t, u, "dev-a", blob.StreamHot, 5, blob.ZeroHash, `{"moved":true}`)
	b.WriterCounter = "1"
	w := h.req("POST", "/api/v1/sync", h.session(u), UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: []UploadBlob{b},
	})
	wantStatus(t, w, http.StatusBadRequest)
	if n := countRows(t, h.pool, u); n != 0 {
		t.Fatalf("%d rows were stored at a position they were not sealed for", n)
	}
}

func TestUploadRejectsOversizeAndBadBucket(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	h.writer(u, "dev-a")

	good, _ := sealUpload(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, `{"op":1}`)

	mismatched := good
	mismatched.SizeBucket = good.SizeBucket * 2
	wantStatus(t, h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: []UploadBlob{mismatched},
	}), http.StatusBadRequest)

	notABucket := good
	raw, _ := base64.StdEncoding.DecodeString(good.Blob)
	notABucket.Blob = base64.StdEncoding.EncodeToString(raw[:len(raw)-1])
	notABucket.SizeBucket = len(raw) - 1
	wantStatus(t, h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: []UploadBlob{notABucket},
	}), http.StatusBadRequest)

	oversize := good
	big := make([]byte, blob.MaxBucket+1)
	oversize.Blob = base64.StdEncoding.EncodeToString(big)
	oversize.SizeBucket = len(big)
	wantStatus(t, h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: []UploadBlob{oversize},
	}), http.StatusRequestEntityTooLarge)

	// The framing version is frozen (blob's package doc: "Nothing else may
	// move"), so a blob declaring another one is unopenable by every client
	// that will ever read it. Storing it is permanent, silent loss — the log is
	// append-only — so it is refused at the door rather than set aside later.
	// An empty blob must be a clean 400, not a panic on raw[0].
	empty := good
	empty.Blob, empty.SizeBucket = "", 0
	wantStatus(t, h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: []UploadBlob{empty},
	}), http.StatusBadRequest)

	badVersion := good
	raw2, _ := base64.StdEncoding.DecodeString(good.Blob)
	raw2 = append([]byte(nil), raw2...)
	raw2[0] = blob.Version + 1
	badVersion.Blob = base64.StdEncoding.EncodeToString(raw2)
	wantStatus(t, h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: []UploadBlob{badVersion},
	}), http.StatusBadRequest)

	if n := countRows(t, h.pool, u); n != 0 {
		t.Fatalf("%d malformed rows were stored", n)
	}
}

func TestUploadRejectsColdStreamFromAClient(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	h.writer(u, "dev-a")
	b, _ := sealUpload(t, u, "dev-a", blob.StreamCold, 1, blob.ZeroHash, `{"raw":true}`)
	w := h.req("POST", "/api/v1/sync", h.session(u), UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamCold, Blobs: []UploadBlob{b},
	})
	wantStatus(t, w, http.StatusBadRequest)
	if n := countRows(t, h.pool, u); n != 0 {
		t.Fatalf("%d client-authored cold rows were stored (invariant I16)", n)
	}
}

func TestUploadReportsAChainBreakAsAConflict(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	h.writer(u, "dev-a")

	blobs, _ := uploadChain(t, u, "dev-a", 1, blob.ZeroHash, 3)
	// Skip counter 1: the batch starts above the stored head.
	w := h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: blobs[1:],
	})
	wantStatus(t, w, http.StatusConflict)
	if n := countRows(t, h.pool, u); n != 0 {
		t.Fatalf("%d rows were appended past a chain break", n)
	}
}

func TestABatchThatDoesNotChainToItselfIsAClientErrorNotATamperSignal(t *testing.T) {
	// oplog.AppendClient verifies the batch's internal links BEFORE it touches
	// the database, so an inconsistency there is provably the client's own
	// arithmetic — nothing the server did could have caused it. Answering it
	// with the chain-break signal would raise spec §3.3:68's non-dismissable
	// "your server may have tampered with your data" warning over a client bug.
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	h.writer(u, "dev-a")

	// Row 2's blob_hash is not SHA256(prev || bytes): purely a local mistake.
	blobs, _ := uploadChain(t, u, "dev-a", 1, blob.ZeroHash, 2)
	bad := blobs[1]
	bad.BlobHash = hex.EncodeToString(make([]byte, 32))
	w := h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: []UploadBlob{blobs[0], bad},
	})
	wantStatus(t, w, http.StatusBadRequest)
	if bytes.Contains(w.Body.Bytes(), []byte("chain_break")) {
		t.Fatalf("a client-side batch error raised the tamper hard stop: %s", w.Body.String())
	}

	// A batch whose rows do not link to each other is the same class.
	blobs2, _ := uploadChain(t, u, "dev-a", 1, blob.ZeroHash, 2)
	unlinked := blobs2[1]
	unlinked.PrevHash = hex.EncodeToString(bytes.Repeat([]byte{7}, 32))
	wantStatus(t, h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: []UploadBlob{blobs2[0], unlinked},
	}), http.StatusBadRequest)

	if n := countRows(t, h.pool, u); n != 0 {
		t.Fatalf("%d rows were stored from an inconsistent batch", n)
	}

	// The head-relative case is still the hard stop: whether the client skipped
	// or the server lost rows is genuinely ambiguous, and that is the one this
	// signal is for.
	good, _ := uploadChain(t, u, "dev-a", 1, blob.ZeroHash, 3)
	conflict := h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: good[1:],
	})
	wantStatus(t, conflict, http.StatusConflict)
	if !bytes.Contains(conflict.Body.Bytes(), []byte("chain_break")) {
		t.Fatalf("a head mismatch must still be a chain break: %s", conflict.Body.String())
	}
}

func TestUploadTellsAPartialResendToResendAboveTheHead(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	h.writer(u, "dev-a")

	blobs, _ := uploadChain(t, u, "dev-a", 1, blob.ZeroHash, 3)
	wantStatus(t, h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: blobs[:2],
	}), http.StatusOK)

	// Counters 1..2 are applied; resending 2..3 straddles the head. The server
	// refuses rather than trimming, and must say what the client should do.
	w := h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: blobs[1:],
	})
	wantStatus(t, w, http.StatusConflict)
	if !bytes.Contains(w.Body.Bytes(), []byte("read the chain head and resend only the rows above it")) {
		t.Fatalf("a straddling resend must quote the client contract verbatim, got %s", w.Body.String())
	}
	// And the documented remedy must work.
	wantStatus(t, h.req("POST", "/api/v1/sync", tok, UploadRequest{
		WriterID: "dev-a", Stream: blob.StreamHot, Blobs: blobs[2:],
	}), http.StatusOK)
}

func TestConcurrentUploadsFromOneWriterProduceOneWinner(t *testing.T) {
	// pgxpool connects lazily, so an unwarmed race staggers its own racers and
	// passes under implementations that do not actually serialise.
	pool := pgtest.New(t)
	warmPool(t, pool, 4)
	apple := &fakeVerifier{}
	srv := &Server{
		Pool:      pool,
		Sessions:  &auth.Sessions{Pool: pool, TTL: time.Hour},
		Writers:   &auth.Writers{Pool: pool},
		Appender:  &oplog.Appender{Pool: pool},
		Verifiers: map[string]auth.Verifier{auth.IdPApple: apple},
		Logf:      func(string, ...any) {},
	}
	h := &harness{t: t, pool: pool, srv: srv, h: srv.Handler(), apple: apple}

	for round := 0; round < 5; round++ {
		u := h.user(fmt.Sprintf("race-%d", round))
		tok := h.session(u)
		h.writer(u, "dev-a")
		one, _ := uploadChain(t, u, "dev-a", 1, blob.ZeroHash, 1)
		two, _ := sealUpload(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, `{"other":true}`)

		var wg sync.WaitGroup
		codes := make([]int, 2)
		start := make(chan struct{})
		for i, body := range []UploadRequest{
			{WriterID: "dev-a", Stream: blob.StreamHot, Blobs: one},
			{WriterID: "dev-a", Stream: blob.StreamHot, Blobs: []UploadBlob{two}},
		} {
			wg.Add(1)
			go func(i int, body UploadRequest) {
				defer wg.Done()
				<-start
				codes[i] = h.req("POST", "/api/v1/sync", tok, body).Code
			}(i, body)
		}
		close(start)
		wg.Wait()

		ok, conflict := 0, 0
		for _, c := range codes {
			switch c {
			case http.StatusOK:
				ok++
			case http.StatusConflict:
				conflict++
			default:
				t.Fatalf("round %d: unexpected status %d", round, c)
			}
		}
		if ok != 1 || conflict != 1 {
			t.Fatalf("round %d: %d ok / %d conflict, want exactly one of each (codes %v)", round, ok, conflict, codes)
		}
		if n := countRows(t, h.pool, u); n != 1 {
			t.Fatalf("round %d: %d rows stored, want 1", round, n)
		}
	}
}

func warmPool(t *testing.T, pool *pgxpool.Pool, n int) {
	t.Helper()
	conns := make([]*pgxpool.Conn, 0, n)
	for i := 0; i < n; i++ {
		c, err := pool.Acquire(bg)
		if err != nil {
			t.Fatalf("warm pool: %v", err)
		}
		if err := c.Ping(bg); err != nil {
			t.Fatalf("warm pool ping: %v", err)
		}
		conns = append(conns, c)
	}
	for _, c := range conns {
		c.Release()
	}
}

// ---------------------------------------------------------------------------
// Authentication and authorization
// ---------------------------------------------------------------------------

func TestEveryEndpointRefusesAnAbsentSession(t *testing.T) {
	h := newHarness(t)
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/v1/sync?stream=hot"},
		{"GET", "/api/v1/sync/hashes?stream=hot"},
		{"POST", "/api/v1/sync"},
		{"GET", "/api/v1/writers"},
		{"POST", "/api/v1/writers/challenge"},
		{"POST", "/api/v1/writers/register"},
	} {
		w := h.req(c.method, c.path, "", nil)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without a session returned %d, want 401", c.method, c.path, w.Code)
		}
	}
}

func TestUnknownExpiredAndRevokedSessionsAreIndistinguishable(t *testing.T) {
	pool := pgtest.New(t)
	now := time.Now()
	clock := func() time.Time { return now }
	srv := &Server{
		Pool:      pool,
		Sessions:  &auth.Sessions{Pool: pool, TTL: time.Hour, Now: clock},
		Writers:   &auth.Writers{Pool: pool, Now: clock},
		Appender:  &oplog.Appender{Pool: pool},
		Verifiers: map[string]auth.Verifier{},
		Logf:      func(string, ...any) {},
	}
	h := &harness{t: t, pool: pool, srv: srv, h: srv.Handler()}
	u := h.user("u")

	expired := h.session(u)
	revoked := h.session(u)
	if err := srv.Sessions.Revoke(bg, revoked); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Hour) // kills `expired`; `revoked` is already dead
	unknown := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

	type answer struct {
		code    int
		body    string
		headers string
	}
	var got []answer
	for _, tok := range []string{unknown, expired, revoked, "not-base64-at-all", ""} {
		w := h.req("GET", "/api/v1/sync?stream=hot", tok, nil)
		got = append(got, answer{w.Code, w.Body.String(), fmt.Sprint(w.Header())})
	}
	for i, a := range got {
		if a.code != http.StatusUnauthorized {
			t.Fatalf("case %d returned %d, want 401", i, a.code)
		}
		if a != got[0] {
			t.Fatalf("case %d answered %+v; case 0 answered %+v — the difference is an oracle", i, a, got[0])
		}
	}
}

func TestABearerTokenAloneCannotRegisterAWriter(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	nonce := decodeJSON[ChallengeResponse](t, h.req("POST", "/api/v1/writers/challenge", tok, nil))

	// A session buys a nonce and nothing else: without a signature from a key
	// that may authorize the enrollment, registration must fail (spec §3.4).
	w := h.req("POST", "/api/v1/writers/register", tok, RegisterRequest{
		WriterID: "dev-a",
		PubKey:   base64.StdEncoding.EncodeToString(pub),
		Nonce:    nonce.Nonce,
		Sig:      base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize)),
	})
	wantStatus(t, w, http.StatusForbidden)
	// Device writers, not all of them: every account carries the server's own
	// `ingest` writer from its first sign-in, and counting it here would turn
	// "a session enrolled nothing" into an off-by-one nobody could read.
	roster := decodeJSON[WritersResponse](t, h.req("GET", "/api/v1/writers", tok, nil))
	var devices int
	for _, wr := range roster.Writers {
		if wr.Kind == auth.KindDevice {
			devices++
		}
	}
	if devices != 0 {
		t.Fatalf("a bare session enrolled %d writers", devices)
	}
}

func TestWriterRegistrationFailuresDoNotDiscloseWhatExists(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	tok := h.session(u)
	priv := h.writer(u, "dev-a")
	pubA := priv.Public().(ed25519.PublicKey)
	pubNew, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	register := func(writerID string, pub ed25519.PublicKey, signer ed25519.PrivateKey) *httptest.ResponseRecorder {
		n := decodeJSON[ChallengeResponse](t, h.req("POST", "/api/v1/writers/challenge", tok, nil))
		raw, err := base64.StdEncoding.DecodeString(n.Nonce)
		if err != nil {
			t.Fatal(err)
		}
		sig := ed25519.Sign(signer, auth.RegistrationMessage(raw, writerID, pub))
		return h.req("POST", "/api/v1/writers/register", tok, RegisterRequest{
			WriterID: writerID,
			PubKey:   base64.StdEncoding.EncodeToString(pub),
			Nonce:    n.Nonce,
			Sig:      base64.StdEncoding.EncodeToString(sig),
		})
	}

	// Three distinct server-side reasons: the writer id is taken, the key is
	// already enrolled, and nothing authorized the request. The caller must not
	// be able to tell them apart.
	taken := register("dev-a", pubNew, priv)                 // auth.ErrWriterExists
	keyTaken := register("dev-c", pubA, priv)                // auth.ErrKeyAlreadyEnrolled
	unauthorized := register("dev-d", pubNew, mustNewKey(t)) // auth.ErrNotAuthorized

	for i, w := range []*httptest.ResponseRecorder{taken, keyTaken, unauthorized} {
		if w.Code != taken.Code || w.Body.String() != taken.Body.String() {
			t.Fatalf("rejection %d answered %d %s; the first answered %d %s — the difference discloses which fact is true",
				i, w.Code, w.Body.String(), taken.Code, taken.Body.String())
		}
	}
	if taken.Code != http.StatusForbidden {
		t.Fatalf("a rejected registration returned %d, want 403", taken.Code)
	}
}

func mustNewKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return priv
}

func TestRosterIsScopedToTheCaller(t *testing.T) {
	h := newHarness(t)
	a, b := h.user("a"), h.user("b")
	h.writer(a, "dev-a")
	h.writer(b, "dev-b")

	// Two entries: this account's device, and this account's OWN server-side
	// writer. `ingest` is per-account rather than global — a shared one would
	// mean a single chain across users, which is neither what the schema stores
	// nor what a checkpoint could ever attest — so the scoping claim covers it
	// exactly as it covers dev-a.
	roster := decodeJSON[WritersResponse](t, h.req("GET", "/api/v1/writers", h.session(a), nil))
	byID := map[string]WriterEntry{}
	for _, wr := range roster.Writers {
		byID[wr.WriterID] = wr
	}
	if len(roster.Writers) != 2 || byID["dev-a"].WriterID == "" || byID["ingest"].WriterID == "" {
		t.Fatalf("roster for user a is %+v, want dev-a and ingest", roster.Writers)
	}
	if _, leaked := byID["dev-b"]; leaked {
		t.Fatalf("user b's writer leaked into user a's roster: %+v", roster.Writers)
	}
	if byID["dev-a"].PubKey == "" || byID["dev-a"].Kind != auth.KindDevice {
		t.Fatalf("roster entry is missing its key material or kind: %+v", byID["dev-a"])
	}
	if byID["dev-a"].RevokedAt != nil {
		t.Fatal("a live writer came back with a revoked_at")
	}
	// The server's writer holds no key, and the wire must say so rather than
	// serving an empty string that reads as "we forgot".
	if byID["ingest"].Kind != auth.KindIngest || byID["ingest"].PubKey != "" {
		t.Fatalf("ingest roster entry = %+v", byID["ingest"])
	}
}

// ---------------------------------------------------------------------------
// Sign-in exchange
// ---------------------------------------------------------------------------

func TestExchangeIssuesASessionForAVerifiedIdentity(t *testing.T) {
	h := newHarness(t)
	h.apple.identity = auth.Identity{IdP: auth.IdPApple, Subject: "sub-1"}
	// Creating an account needs an invite code (Phase 2, Decision 8); signing
	// in to one that exists does not. See invite_test.go.
	w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: auth.IdPApple, IDToken: "tok", InviteCode: h.invite("exchange test"),
	})
	wantStatus(t, w, http.StatusOK)
	got := decodeJSON[ExchangeResponse](t, w)
	if got.SessionToken == "" || got.UserID == "" {
		t.Fatalf("exchange returned %+v", got)
	}
	// The issued token must actually work.
	wantStatus(t, h.req("GET", "/api/v1/sync?stream=hot", got.SessionToken, nil), http.StatusOK)
}

func TestExchangeRejectsEveryBadTokenWithOneIdentical401(t *testing.T) {
	h := newHarness(t)
	var answers []string
	for _, err := range []error{auth.ErrSignature, auth.ErrExpired, auth.ErrAudience, auth.ErrIssuer, auth.ErrNoSubject} {
		h.apple.err = err
		w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{IdP: auth.IdPApple, IDToken: "tok"})
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%v returned %d, want 401", err, w.Code)
		}
		answers = append(answers, w.Body.String())
	}
	for i, a := range answers {
		if a != answers[0] {
			t.Fatalf("rejection %d answered %q, the first answered %q", i, a, answers[0])
		}
	}
}

func TestUnavailableIdPKeySetIsA503NotA401(t *testing.T) {
	// A good token must never be reported as invalid because Apple is down:
	// that sends the user to re-authenticate against a provider that will hand
	// back another token we still cannot verify.
	h := newHarness(t)
	h.apple.err = fmt.Errorf("%w: apple", auth.ErrKeySetUnavailable)
	w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{IdP: auth.IdPApple, IDToken: "tok"})
	wantStatus(t, w, http.StatusServiceUnavailable)
}

func TestAMisconfiguredVerifierIsNotReportedAsABadToken(t *testing.T) {
	// auth.ErrNotConfigured means the SERVER has no client ids for this
	// provider, so no token can be recognized as ours. It wraps ErrTokenRejected
	// (so the failure mode of a bad config is "nobody can sign in", never
	// "anybody can"), but reporting it as 401 is the same confusion the 503 on
	// ErrKeySetUnavailable exists to remove: it tells a user with a perfectly
	// good token to go and get another one.
	h := newHarness(t)
	h.apple.err = auth.ErrNotConfigured
	w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{IdP: auth.IdPApple, IDToken: "tok"})
	wantStatus(t, w, http.StatusServiceUnavailable)
}

func TestResponsesAreNotCacheable(t *testing.T) {
	// The exchange response is the one that carries a session bearer token; the
	// pull response carries the user's op log. Neither may be written to a
	// shared cache, a proxy, or a client's disk cache.
	h := newHarness(t)
	w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: auth.IdPApple, IDToken: "tok", InviteCode: h.invite(""),
	})
	wantStatus(t, w, http.StatusOK)
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("the response carrying a session token has Cache-Control %q, want no-store", got)
	}
	tok := decodeJSON[ExchangeResponse](t, w).SessionToken
	pull := h.req("GET", "/api/v1/sync?stream=hot", tok, nil)
	if got := pull.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("a pull of the op log has Cache-Control %q, want no-store", got)
	}
}

func TestUploadSizeCapsAgree(t *testing.T) {
	// A batch that satisfies maxUploadBlobs must fit maxUploadBytes, or a
	// conforming client hits the generic body-cap 413 instead of the per-blob
	// answer that says which blob is wrong and why. Pure arithmetic, asserted
	// so the two constants cannot drift apart.
	worst := base64.StdEncoding.EncodedLen(blob.MaxBucket)*maxUploadBlobs + 1024
	if worst > maxUploadBytes {
		t.Fatalf("%d max-size blobs base64-encode to %d bytes, over the %d-byte body cap: "+
			"lower maxUploadBlobs or raise maxUploadBytes", maxUploadBlobs, worst, maxUploadBytes)
	}
}

func TestExchangeRejectsAnUnknownIdP(t *testing.T) {
	h := newHarness(t)
	wantStatus(t, h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{IdP: "myspace", IDToken: "tok"}), http.StatusBadRequest)
	if h.apple.count() != 0 {
		t.Fatal("an unknown idp reached a verifier")
	}
}

func TestIdPVerifiersAreReusedAcrossRequests(t *testing.T) {
	// The JWKS fetch bound and the herd control that protects it are per
	// verifier INSTANCE (auth.cachingKeySet). A handler that built its own
	// verifier would silently restore the unauthenticated outbound amplifier
	// auth already fixed, and this fake — which the server can only reach
	// through the map built once at construction — would never be called.
	h := newHarness(t)
	for i := 0; i < 5; i++ {
		h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{IdP: auth.IdPApple, IDToken: fmt.Sprintf("tok-%d", i)})
	}
	if got := h.apple.count(); got != 5 {
		t.Fatalf("the process-wide apple verifier saw %d of 5 exchanges", got)
	}
}

func TestNewServerBuildsOneVerifierPerProviderAtConstruction(t *testing.T) {
	pool := pgtest.New(t)
	srv, err := NewServer(config.Config{Auth: config.AuthConfig{
		AppleClientIDs:  []string{"com.example.app"},
		GoogleClientIDs: []string{"123.apps.googleusercontent.com"},
		SessionTTL:      time.Hour,
	}}, pool)
	if err != nil {
		t.Fatal(err)
	}
	apple, google := srv.Verifiers[auth.IdPApple], srv.Verifiers[auth.IdPGoogle]
	if apple == nil || google == nil {
		t.Fatalf("NewServer left a provider without a verifier: %+v", srv.Verifiers)
	}
	// Building the router (or serving) must not replace them: the JWKS cache,
	// the attempt limit and the herd control all live on the instance.
	srv.Handler()
	srv.Handler()
	if srv.Verifiers[auth.IdPApple] != apple || srv.Verifiers[auth.IdPGoogle] != google {
		t.Fatal("a verifier was rebuilt after construction")
	}
}

func TestPhase1DoesNotBindANonce(t *testing.T) {
	// Recorded rather than implemented: the nonce claim is plaintext inside the
	// token, so binding it only defeats replay when the expected value comes
	// from server-side state created BEFORE the token existed. Phase 1 has no
	// such store on the sign-in path, and a half-wired binding would look like
	// a defence while being none.
	h := newHarness(t)
	h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{IdP: auth.IdPApple, IDToken: "tok"})
	h.apple.mu.Lock()
	defer h.apple.mu.Unlock()
	if h.apple.lastOpts.Nonce != "" {
		t.Fatalf("the exchange bound nonce %q; a client-supplied nonce is theatre", h.apple.lastOpts.Nonce)
	}
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

func TestSignInIsRateLimitedPerClient(t *testing.T) {
	h := newHarness(t)
	// A RETURNING user, so what is measured is the rate limit and not the
	// invite gate: the fake verifier maps id_token "tok" to subject "sub-tok".
	h.user("sub-tok")
	// No refill during the test: the burst is the whole budget.
	h.srv.SignInPerIP = NewLimiter(0, 3, 128, time.Now)
	h.h = h.srv.Handler()

	allowed := 0
	for i := 0; i < 20; i++ {
		w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{IdP: auth.IdPApple, IDToken: "tok"})
		switch w.Code {
		case http.StatusOK:
			allowed++
		case http.StatusTooManyRequests:
		default:
			t.Fatalf("request %d returned %d", i, w.Code)
		}
	}
	if allowed != 3 {
		t.Fatalf("%d of 20 sign-ins were served, want exactly the burst of 3", allowed)
	}
	if h.apple.count() != 3 {
		t.Fatalf("the verifier ran %d times; a rate-limited request must not reach the provider path", h.apple.count())
	}
}

func TestOneClientCannotSpendEveryoneElsesSignInBudget(t *testing.T) {
	// The global limiter is a backstop against a caller spread across
	// addresses. If it is consulted FIRST it is spent by requests the per-IP
	// limiter would have refused anyway, so one host sustaining traffic holds
	// every other client at 429 — an amplification nuisance traded for a total
	// sign-in outage, which is exactly what ratelimit.go says it refuses to do.
	h := newHarness(t)
	// A returning user, for the reason above: this measures the limiters.
	h.user("sub-tok")
	frozen := time.Now()
	clock := func() time.Time { return frozen }
	h.srv.SignInPerIP = NewLimiter(0, 3, 128, clock)
	h.srv.SignInGlobal = NewLimiter(0, 8, 1, clock)
	h.h = h.srv.Handler()

	body, err := json.Marshal(ExchangeRequest{IdP: auth.IdPApple, IDToken: "tok"})
	if err != nil {
		t.Fatal(err)
	}
	exchangeFrom := func(addr string) int {
		r := httptest.NewRequest("POST", "/api/v1/auth/exchange", bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.RemoteAddr = addr
		w := httptest.NewRecorder()
		h.h.ServeHTTP(w, r)
		return w.Code
	}

	noisy := 0
	for i := 0; i < 40; i++ {
		if exchangeFrom("198.51.100.7:5000") == http.StatusOK {
			noisy++
		}
	}
	if noisy != 3 {
		t.Fatalf("the noisy host was served %d times, want its per-ip burst of 3", noisy)
	}
	// It made 40 attempts but may only have spent 3 global tokens: a rejected
	// request must not consume the shared budget. A fresh client's own burst of
	// 3 must therefore still be served out of the 8 global tokens.
	for i := 0; i < 3; i++ {
		if code := exchangeFrom("203.0.113.9:5000"); code != http.StatusOK {
			t.Fatalf("a fresh client was answered %d after another host's flood — "+
				"the global bucket was spent by requests the per-ip limiter refused", code)
		}
	}
}

func TestRegistrationAttemptsAreRateLimited(t *testing.T) {
	// The challenge cap bounds SUCCESSFUL registrations only. A failed attempt
	// — a replayed nonce, say — consumes no challenge budget and still costs
	// two database round trips inside consumeChallenge before any signature
	// work happens.
	h := newHarness(t)
	h.srv.RegisterPerUser = NewLimiter(0, 3, 128, time.Now)
	h.h = h.srv.Handler()
	u := h.user("u")
	tok := h.session(u)
	other := h.session(h.user("other"))

	body := RegisterRequest{
		WriterID: "dev-a",
		PubKey:   base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize)),
		Nonce:    base64.StdEncoding.EncodeToString(make([]byte, auth.ChallengeNonceBytes)),
		Sig:      base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize)),
	}
	attempted, limited := 0, 0
	for i := 0; i < 30; i++ {
		switch h.req("POST", "/api/v1/writers/register", tok, body).Code {
		case http.StatusTooManyRequests:
			limited++
		default:
			attempted++
		}
	}
	if attempted != 3 {
		t.Fatalf("%d registration attempts reached the signature path, want the cap of 3", attempted)
	}
	if limited == 0 {
		t.Fatal("no attempt was rate limited")
	}
	// Per user, not global.
	if code := h.req("POST", "/api/v1/writers/register", other, body).Code; code == http.StatusTooManyRequests {
		t.Fatal("one account's failed attempts rate-limited another account")
	}
}

func TestChallengeMintingIsCappedPerUser(t *testing.T) {
	h := newHarness(t)
	h.srv.ChallengePerUser = NewLimiter(0, 4, 128, time.Now)
	h.h = h.srv.Handler()
	a, b := h.user("a"), h.user("b")
	tokA, tokB := h.session(a), h.session(b)

	allowed := 0
	for i := 0; i < 30; i++ {
		switch h.req("POST", "/api/v1/writers/challenge", tokA, nil).Code {
		case http.StatusOK:
			allowed++
		case http.StatusTooManyRequests:
		default:
			t.Fatalf("challenge %d returned an unexpected status", i)
		}
	}
	if allowed != 4 {
		t.Fatalf("one session minted %d challenges, want the cap of 4", allowed)
	}
	var stored int
	if err := h.pool.QueryRow(bg, `SELECT count(*) FROM writer_challenges WHERE user_id = $1`, a).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 4 {
		t.Fatalf("%d challenge rows were written despite the cap", stored)
	}
	// The cap is per user, not global: one account cannot lock another out.
	wantStatus(t, h.req("POST", "/api/v1/writers/challenge", tokB, nil), http.StatusOK)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

func TestUnknownAPIPathIs404JSON(t *testing.T) {
	h := newHarness(t)
	w := h.req("GET", "/api/v1/nope", h.session(h.user("u")), nil)
	wantStatus(t, w, http.StatusNotFound)
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type %q, want application/json", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("404 body is not JSON: %s", w.Body.String())
	}
}

func TestWrongMethodIsNotSilentlyRouted(t *testing.T) {
	h := newHarness(t)
	tok := h.session(h.user("u"))
	if w := h.req("DELETE", "/api/v1/sync", tok, nil); w.Code == http.StatusOK {
		t.Fatal("DELETE /api/v1/sync was served")
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func mustInt(t *testing.T, s string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatalf("%q is not a decimal integer: %v", s, err)
	}
	return n
}

func wireToRow(t *testing.T, r Row) oplog.Row {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(r.Blob)
	if err != nil {
		t.Fatal(err)
	}
	bh, err := hex.DecodeString(r.BlobHash)
	if err != nil {
		t.Fatal(err)
	}
	ph, err := hex.DecodeString(r.PrevHash)
	if err != nil {
		t.Fatal(err)
	}
	return oplog.Row{
		Seq:           mustInt(t, r.Seq),
		Stream:        r.Stream,
		WriterID:      r.WriterID,
		WriterCounter: mustInt(t, r.WriterCounter),
		TypeFlag:      r.TypeFlag,
		Blob:          raw,
		SizeBucket:    r.SizeBucket,
		BlobHash:      bh,
		PrevHash:      ph,
	}
}

// ---------------------------------------------------------------------------
// --dev-auth (Task 14)
// ---------------------------------------------------------------------------

// With cfg.DevAuth set, NewServer installs the dev verifier for BOTH providers
// and neither real one. That is the safe direction: a deployment that left the
// flag on cannot sign anybody in with a genuine Apple or Google token, so the
// mistake is loud rather than invisible.
func TestNewServerWithDevAuthReplacesEveryVerifier(t *testing.T) {
	pool := pgtest.New(t)
	cfg := config.Config{
		Mail:   config.MailConfig{Domain: "example.test"},
		Server: config.ServerConfig{HTTPListen: "127.0.0.1:8091"},
		Auth:   config.AuthConfig{SessionTTL: time.Hour, AppleClientIDs: []string{"com.example.app"}},
	}
	if err := cfg.EnableTestOnly(true, ""); err != nil {
		t.Fatal(err)
	}
	srv, err := NewServer(cfg, pool)
	if err != nil {
		t.Fatal(err)
	}
	for _, idp := range []string{auth.IdPApple, auth.IdPGoogle} {
		v, ok := srv.Verifiers[idp]
		if !ok {
			t.Fatalf("no verifier for %q", idp)
		}
		id, err := v.Verify(bg, "dev:alice", auth.VerifyOpts{})
		if err != nil {
			t.Fatalf("%s dev verifier rejected dev:alice: %v", idp, err)
		}
		if id.Subject != "alice" {
			t.Fatalf("%s dev verifier gave subject %q", idp, id.Subject)
		}
		if _, err := v.Verify(bg, "eyJhbGciOiJSUzI1NiJ9.e30.sig", auth.VerifyOpts{}); err == nil {
			t.Fatalf("%s dev verifier accepted a JWT-shaped token", idp)
		}
	}
}

// Without the flag, nothing changes: a dev token is just a token that fails.
func TestNewServerWithoutDevAuthInstallsTheRealVerifiers(t *testing.T) {
	pool := pgtest.New(t)
	cfg := config.Config{
		Mail:   config.MailConfig{Domain: "example.test"},
		Server: config.ServerConfig{HTTPListen: "127.0.0.1:8091"},
		Auth:   config.AuthConfig{SessionTTL: time.Hour},
	}
	srv, err := NewServer(cfg, pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := srv.Verifiers[auth.IdPApple].Verify(bg, "dev:alice", auth.VerifyOpts{}); err == nil {
		t.Fatal("the production Apple verifier accepted a dev token")
	}
}

// The end-to-end shape the CLI's `login` drives: a dev token exchanges for a
// session, and that session resolves to a real account.
func TestDevAuthExchangeIssuesAWorkingSession(t *testing.T) {
	pool := pgtest.New(t)
	srv := &Server{
		Pool:      pool,
		Sessions:  &auth.Sessions{Pool: pool, TTL: time.Hour},
		Writers:   &auth.Writers{Pool: pool},
		Appender:  &oplog.Appender{Pool: pool},
		Verifiers: map[string]auth.Verifier{auth.IdPApple: auth.NewDevVerifier(auth.IdPApple)},
		Logf:      func(string, ...any) {},
	}
	h := srv.Handler()

	code, err := auth.MintInvite(bg, pool, "dev-auth test", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(ExchangeRequest{IdP: auth.IdPApple, IDToken: "dev:alice", InviteCode: code})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/exchange", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("exchange = %d %s", rec.Code, rec.Body.String())
	}
	var out ExchangeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.SessionToken == "" || out.UserID == "" {
		t.Fatalf("exchange returned %+v", out)
	}

	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/writers", nil)
	req.Header.Set("Authorization", "Bearer "+out.SessionToken)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("roster with a dev session = %d %s", rec.Code, rec.Body.String())
	}

	// The same dev subject is the same account, twice.
	rec = httptest.NewRecorder()
	body2, _ := json.Marshal(ExchangeRequest{IdP: auth.IdPApple, IDToken: "dev:alice"})
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/exchange", bytes.NewReader(body2)))
	var again ExchangeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &again); err != nil {
		t.Fatal(err)
	}
	if again.UserID != out.UserID {
		t.Fatalf("dev:alice resolved to %s and then %s", out.UserID, again.UserID)
	}
}
