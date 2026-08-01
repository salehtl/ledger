package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/dict"
	"ledger/internal/v2/pgtest"
)

var bg = context.Background()

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

const (
	testToken  = "operator-token-for-tests"
	testKeyHex = "0011223344556677889900aabbccddeeff112233445566778899aabbccddeeff"
)

type harness struct {
	t *testing.T
	d *dict.Dict
	h http.Handler
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	key, err := dict.ParseKey(testKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	d := &dict.Dict{Pool: pgtest.New(t), HMACKey: key}
	mux := http.NewServeMux()
	if err := (&DictHandler{Dict: d, Token: testToken, Logf: func(string, ...any) {}}).Routes(mux); err != nil {
		t.Fatalf("Routes: %v", err)
	}
	return &harness{t: t, d: d, h: mux}
}

func (h *harness) req(method, path, token string, body any) *httptest.ResponseRecorder {
	h.t.Helper()
	var r *http.Request
	if body == nil {
		r = httptest.NewRequest(method, path, nil)
	} else {
		raw, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		r = httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.h.ServeHTTP(rec, r)
	return rec
}

func (h *harness) submitK(pattern, category string) {
	h.t.Helper()
	for i := 0; i < dict.K; i++ {
		u := uuid.NewSHA1(uuid.NameSpaceOID, []byte(pattern+"/"+strconv.Itoa(i)))
		if err := h.d.Submit(bg, u, pattern, category); err != nil {
			h.t.Fatalf("Submit: %v", err)
		}
	}
}

// The console cannot be mounted open. A missing token is a startup error, not
// a warning followed by a working approval endpoint.
func TestRoutesRefuseToMountWithoutAToken(t *testing.T) {
	d := &dict.Dict{Pool: pgtest.New(t)}
	mux := http.NewServeMux()
	if err := (&DictHandler{Dict: d}).Routes(mux); err == nil {
		t.Fatal("Routes mounted an unauthenticated approval endpoint")
	}
	// And nothing was mounted on the way to that error.
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/admin/dictionary", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("a route was mounted despite the refusal: %d", rec.Code)
	}
}

func TestEveryRouteRequiresTheOperatorToken(t *testing.T) {
	h := newHarness(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/admin/dictionary"},
		{http.MethodPost, "/admin/dictionary/moderate"},
		{http.MethodPost, "/admin/dictionary/approve-seed"},
	} {
		for _, token := range []string{"", "wrong", testToken + "x"} {
			rec := h.req(tc.method, tc.path, token, map[string]any{})
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("%s %s with token %q: %d, want 401", tc.method, tc.path, token, rec.Code)
			}
		}
	}
}

// Moderation is the gate, and this is the test that it IS a gate: an entry over
// the k threshold publishes only after the operator says so, and stops
// publishing when the operator changes their mind.
func TestModerationGatesAndUngatesPublication(t *testing.T) {
	h := newHarness(t)
	h.submitK("AMAZON", "Charity")

	if got, err := h.d.Published(bg); err != nil || len(got) != 0 {
		t.Fatalf("published before moderation: %v %v", got, err)
	}
	rec := h.req(http.MethodPost, "/admin/dictionary/moderate", testToken,
		moderateRequest{Pattern: "AMAZON", Category: "Charity", Approved: true, Note: "checked"})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("moderate: %d %s", rec.Code, rec.Body.String())
	}
	if got, _ := h.d.Published(bg); len(got) != 1 {
		t.Fatalf("approval did not publish: %v", got)
	}

	rec = h.req(http.MethodPost, "/admin/dictionary/moderate", testToken,
		moderateRequest{Pattern: "AMAZON", Category: "Charity", Approved: false, Note: "poisoned"})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("retract: %d %s", rec.Code, rec.Body.String())
	}
	if got, _ := h.d.Published(bg); len(got) != 0 {
		t.Fatalf("a retracted entry is still published: %v", got)
	}
}

func TestModerateAnswers404ForAnEntryThatDoesNotExist(t *testing.T) {
	h := newHarness(t)
	rec := h.req(http.MethodPost, "/admin/dictionary/moderate", testToken,
		moderateRequest{Pattern: "CARREFOUR", Category: "Groceries", Approved: true})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("moderate on a nonexistent entry: %d, want 404", rec.Code)
	}
}

// The queue must show the operator what the k gate is hiding from clients —
// that is the asymmetry this listener exists for.
func TestTheQueueShowsSuppressedEntriesAndTheirSubmitterCount(t *testing.T) {
	h := newHarness(t)
	if err := h.d.Submit(bg, uuid.New(), "DR ALIA FERTILITY CLINIC", "Healthcare"); err != nil {
		t.Fatal(err)
	}
	rec := h.req(http.MethodGet, "/admin/dictionary", testToken, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var got listResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.K != dict.K {
		t.Fatalf("k = %d, want %d", got.K, dict.K)
	}
	if len(got.Entries) != 1 {
		t.Fatalf("entries = %+v, want the suppressed one", got.Entries)
	}
	e := got.Entries[0]
	if e.Pattern != "dr alia fertility clinic" || e.DistinctSubmitters != 1 {
		t.Fatalf("entry = %+v", e)
	}
	if e.Approved != nil {
		t.Fatalf("approved = %v, want nil: nobody has reviewed this yet, which is not a rejection", *e.Approved)
	}
	if e.Published {
		t.Fatal("a one-submitter entry is reported as published")
	}
}

// The bulk approval exists for the operator's own import and must not be a way
// around the poisoning gate for anything else.
func TestApproveSeedTouchesOnlyOperatorSeededEntries(t *testing.T) {
	h := newHarness(t)
	if err := h.d.SeedFromV1(bg, []dict.Entry{{Pattern: "SPINNEYS", Category: "Groceries"}}); err != nil {
		t.Fatal(err)
	}
	h.submitK("AMAZON", "Charity")

	rec := h.req(http.MethodPost, "/admin/dictionary/approve-seed", testToken,
		approveSeedRequest{Note: "operator's own v1 rules"})
	if rec.Code != http.StatusOK {
		t.Fatalf("approve-seed: %d %s", rec.Code, rec.Body.String())
	}
	var got map[string]int
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["approved"] != 1 {
		t.Fatalf("approved %d entries, want 1", got["approved"])
	}
	pub, err := h.d.Published(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(pub) != 1 || pub[0].Pattern != "spinneys" {
		t.Fatalf("bulk approval reached a crowd submission: %+v", pub)
	}
}

func TestBadRequestsAreRefusedWithoutEchoingAnything(t *testing.T) {
	h := newHarness(t)
	rec := h.req(http.MethodPost, "/admin/dictionary/moderate", testToken,
		map[string]any{"pattern": "CARREFOUR", "category": "Groceries", "surprise": 1})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an unknown field was accepted: %d", rec.Code)
	}
	rec = h.req(http.MethodPost, "/admin/dictionary/moderate", testToken,
		moderateRequest{Pattern: "", Category: "Groceries", Approved: true})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an empty pattern was accepted: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "Groceries") {
		t.Fatalf("the error echoed the submission: %s", rec.Body.String())
	}
}
