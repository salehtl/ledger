package api

import (
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/dict"
)

const dictTestKey = "0011223344556677889900aabbccddeeff112233445566778899aabbccddeeff"

type dictHarness struct {
	*harness
	d *dict.Dict
}

func newDictHarness(t *testing.T) *dictHarness {
	t.Helper()
	h := newHarness(t)
	key, err := dict.ParseKey(dictTestKey)
	if err != nil {
		t.Fatal(err)
	}
	d := &dict.Dict{Pool: h.pool, HMACKey: key}
	h.srv.Dict = d
	h.h = h.srv.Handler()
	return &dictHarness{harness: h, d: d}
}

// publish drives an entry all the way through BOTH gates using the real calls,
// because an entry planted straight into the table would not prove the handler
// consults the same publication rule the rest of the system does.
func (h *dictHarness) publish(t *testing.T, pattern, category string) {
	t.Helper()
	for i := 0; i < dict.K; i++ {
		u := uuid.NewSHA1(uuid.NameSpaceOID, []byte(pattern+"/submitter/"+strconv.Itoa(i)))
		if err := h.d.Submit(bg, u, pattern, category); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	if err := h.d.Moderate(bg, pattern, category, true, ""); err != nil {
		t.Fatalf("Moderate: %v", err)
	}
}

func TestDictionaryRequiresASession(t *testing.T) {
	h := newDictHarness(t)
	h.publish(t, "CARREFOUR", "Groceries")
	rec := h.req(http.MethodGet, "/api/v1/dictionary", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET /api/v1/dictionary: %d, want 401", rec.Code)
	}
}

// The endpoint's whole privacy job: a pattern below k, or above k but
// unmoderated, must not appear in the response in any field.
func TestDictionaryServesOnlyEntriesThatPassedBothGates(t *testing.T) {
	h := newDictHarness(t)
	session := h.session(h.user("alice"))
	h.publish(t, "CARREFOUR", "Groceries")

	// Below k: one submitter, approved.
	if err := h.d.Submit(bg, uuid.New(), "DR ALIA FERTILITY CLINIC", "Healthcare"); err != nil {
		t.Fatal(err)
	}
	if err := h.d.Moderate(bg, "DR ALIA FERTILITY CLINIC", "Healthcare", true, ""); err != nil {
		t.Fatal(err)
	}
	// Above k, never moderated.
	for i := 0; i < dict.K; i++ {
		u := uuid.NewSHA1(uuid.NameSpaceOID, []byte("poison/"+strconv.Itoa(i)))
		if err := h.d.Submit(bg, u, "AMAZON", "Charity"); err != nil {
			t.Fatal(err)
		}
	}

	rec := h.req(http.MethodGet, "/api/v1/dictionary", session, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/dictionary: %d %s", rec.Code, rec.Body.String())
	}
	body := strings.ToLower(rec.Body.String())
	for _, forbidden := range []string{"alia", "amazon", "charity", "healthcare"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("the response names %q, which passed only one of the two gates: %s",
				forbidden, rec.Body.String())
		}
	}
	got := decodeJSON[DictionaryResponse](t, rec)
	if len(got.Entries) != 1 || got.Entries[0].Pattern != "carrefour" {
		t.Fatalf("entries = %+v, want just carrefour", got.Entries)
	}
	if got.Entries[0].Match != dict.MatchContains {
		t.Fatalf("match = %q, want %q", got.Entries[0].Match, dict.MatchContains)
	}
	if got.Version == "" || got.Version == "0" {
		t.Fatalf("version = %q, want a real cursor", got.Version)
	}
	// The cursor is an int64 in Go, so it travels as a decimal STRING — the
	// same rule seq follows, because JSON.parse would make a number a float64.
	if !strings.Contains(rec.Body.String(), `"version":"`) {
		t.Fatalf("version is not a decimal string on the wire: %s", rec.Body.String())
	}
}

// A resumed pull carries only what changed, and both list fields are always
// arrays — a client that has to tell `null` from `[]` will eventually get it
// wrong on the device.
func TestDictionaryDeltaIsIncrementalAndNeverNull(t *testing.T) {
	h := newDictHarness(t)
	session := h.session(h.user("alice"))
	h.publish(t, "CARREFOUR", "Groceries")

	first := decodeJSON[DictionaryResponse](t, h.req(http.MethodGet, "/api/v1/dictionary", session, nil))
	if len(first.Entries) != 1 {
		t.Fatalf("first pull: %+v", first)
	}
	raw := h.req(http.MethodGet, "/api/v1/dictionary?since="+first.Version, session, nil)
	if !strings.Contains(raw.Body.String(), `"entries":[]`) ||
		!strings.Contains(raw.Body.String(), `"removed":[]`) {
		t.Fatalf("an empty delta must be empty arrays, not null: %s", raw.Body.String())
	}
	next := decodeJSON[DictionaryResponse](t, raw)
	if len(next.Entries) != 0 || next.Version != first.Version {
		t.Fatalf("a resumed pull re-sent data: %+v", next)
	}

	h.publish(t, "TALABAT", "Dining")
	third := decodeJSON[DictionaryResponse](t,
		h.req(http.MethodGet, "/api/v1/dictionary?since="+first.Version, session, nil))
	if len(third.Entries) != 1 || third.Entries[0].Pattern != "talabat" {
		t.Fatalf("delta = %+v, want only talabat", third.Entries)
	}
}

func TestDictionaryRefusesAMalformedCursor(t *testing.T) {
	h := newDictHarness(t)
	session := h.session(h.user("alice"))
	for _, since := range []string{"-1", "abc", "1.5"} {
		rec := h.req(http.MethodGet, "/api/v1/dictionary?since="+since, session, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("?since=%s: %d, want 400 (a bad cursor silently serving the whole "+
				"dictionary hides the client's broken bookkeeping)", since, rec.Code)
		}
	}
}

// The public listener must expose no way to approve anything: moderation is the
// poisoning gate, and it belongs to the tailnet-bound admin listener alone.
func TestThePublicAPIExposesNoModerationRoute(t *testing.T) {
	h := newDictHarness(t)
	session := h.session(h.user("alice"))
	for _, path := range []string{
		"/api/v1/dictionary/moderate",
		"/api/v1/dictionary/approve-seed",
		"/admin/dictionary",
		"/admin/dictionary/moderate",
	} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			rec := h.req(method, path, session, map[string]any{})
			if rec.Code != http.StatusNotFound {
				t.Errorf("%s %s answered %d; the public API must not reach moderation",
					method, path, rec.Code)
			}
		}
	}
}
