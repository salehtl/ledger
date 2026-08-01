package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/dict"
	"ledger/internal/v2/pgtest"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/tmpl"
)

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// templateJSON is a minimal but REAL definition: it passes the whole publish
// gate, including the 29-rule dialect. amountPattern is the one thing the tests
// vary, because a regression is a version that stops extracting an amount.
func templateJSON(version int, amountPattern string) []byte {
	return []byte(fmt.Sprintf(`{
	  "id": "testbank.card",
	  "version": %d,
	  "bank": "testbank",
	  "normalizer_version": 1,
	  "match": {
	    "sender_domain": ["testbank.test"],
	    "subject_contains": ["Transaction"]
	  },
	  "default_currency": "AED",
	  "date_from": "email",
	  "extract": [
	    {"field": "amount", "type": "amount", "source": "body", "patterns": [%q]},
	    {"field": "merchant", "type": "text", "source": "body", "patterns": ["at (?P<v>[A-Za-z]+) on"]},
	    {"field": "direction", "type": "const", "source": "body", "value": "debit"}
	  ],
	  "required": ["amount", "merchant", "direction"]
	}`, version, amountPattern))
}

const (
	// broadAmount extracts from both sample bodies below.
	broadAmount = `AED (?P<amt>[0-9]+\.[0-9]{2})`
	// narrowAmount extracts only from the "spent" one — the regression.
	narrowAmount = `spent AED (?P<amt>[0-9]+\.[0-9]{2})`
)

func rawMail(body string) []byte {
	return []byte("From: alerts@testbank.test\r\n" +
		"Subject: Transaction Alert\r\n" +
		"Date: Thu, 01 Jan 2026 10:00:00 +0400\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"\r\n" + body + "\r\n")
}

var (
	sampleSpent    = rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026")
	samplePurchase = rawMail("Purchase of AED 75.50 at CARREFOUR on 02/01/2026")
)

// fakeSamples stands in for Task 31's donated-sample store. The console is
// built against the interface rather than the package because Task 31 has not
// landed; see the SampleSource doc.
type fakeSamples struct {
	byDomain map[string][]Sample
	err      error
}

func (f *fakeSamples) ForSender(_ context.Context, domain string) ([]Sample, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.byDomain[domain], nil
}

// fakeReprocessor stands in for Task 30's Pipeline.Reprocess.
type fakeReprocessor struct {
	calls  []reprocessCall
	report Report
	err    error
}

type reprocessCall struct {
	user uuid.UUID
	ids  int
}

func (f *fakeReprocessor) Reprocess(_ context.Context, user uuid.UUID, ids [][]byte) (Report, error) {
	f.calls = append(f.calls, reprocessCall{user: user, ids: len(ids)})
	if f.err != nil {
		return Report{}, f.err
	}
	return f.report, nil
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type console struct {
	t         *testing.T
	pool      *pgxpool.Pool
	h         http.Handler
	templates *tmpl.Store
	diag      *diag.Diag
	waitlist  *Waitlist
	samples   *fakeSamples
	reproc    *fakeReprocessor
	now       time.Time
}

func newConsole(t *testing.T) *console {
	t.Helper()
	pool := pgtest.New(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	key, err := dict.ParseKey(testKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	c := &console{
		t:         t,
		pool:      pool,
		templates: &tmpl.Store{Pool: pool, Now: func() time.Time { return now }},
		diag:      &diag.Diag{Pool: pool, Now: func() time.Time { return now }},
		waitlist:  &Waitlist{Pool: pool, Now: func() time.Time { return now }},
		samples:   &fakeSamples{byDomain: map[string][]Sample{}},
		reproc:    &fakeReprocessor{},
		now:       now,
	}
	h := &Handler{
		Templates:   c.templates,
		Diag:        c.diag,
		Quarantine:  &quarantine.Store{Pool: pool, TTL: quarantine.DefaultTTL, WarnBefore: quarantine.DefaultWarnBefore},
		Waitlist:    c.waitlist,
		Dict:        &dict.Dict{Pool: pool, HMACKey: key},
		Samples:     c.samples,
		Reprocessor: c.reproc,
		Token:       testToken,
		Logf:        func(string, ...any) {},
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		t.Fatalf("Routes: %v", err)
	}
	c.h = mux
	return c
}

func (c *console) do(method, path, token string, body any) *httptest.ResponseRecorder {
	c.t.Helper()
	var r *http.Request
	switch b := body.(type) {
	case nil:
		r = httptest.NewRequest(method, path, nil)
	case []byte:
		r = httptest.NewRequest(method, path, bytes.NewReader(b))
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			c.t.Fatal(err)
		}
		r = httptest.NewRequest(method, path, bytes.NewReader(raw))
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, r)
	return rec
}

func (c *console) ok(method, path string, body any) map[string]any {
	c.t.Helper()
	rec := c.do(method, path, testToken, body)
	if rec.Code/100 != 2 {
		c.t.Fatalf("%s %s = %d: %s", method, path, rec.Code, rec.Body.String())
	}
	if rec.Body.Len() == 0 {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		c.t.Fatalf("%s %s: %v (%s)", method, path, err, rec.Body.String())
	}
	return out
}

func (c *console) donate(domain string, raws ...[]byte) {
	c.t.Helper()
	for _, raw := range raws {
		c.samples.byDomain[domain] = append(c.samples.byDomain[domain], Sample{
			ID:           uuid.New(),
			UserID:       uuid.New(),
			SenderDomain: domain,
			Raw:          raw,
			ReceivedAt:   c.now,
		})
	}
}

func (c *console) publishV1(pattern string) {
	c.t.Helper()
	d, err := tmpl.ParseDefinition(templateJSON(1, pattern))
	if err != nil {
		c.t.Fatalf("parse: %v", err)
	}
	if err := c.templates.Publish(bg, d); err != nil {
		c.t.Fatalf("Publish: %v", err)
	}
}

// adminRoutes is every path the console mounts, with a method and a body that
// would otherwise succeed. It is the list the auth tests sweep, so a route
// added without an entry here is a route nothing checks the guard on.
func adminRoutes() []struct {
	method, path string
	body         any
} {
	u := uuid.New().String()
	return []struct {
		method, path string
		body         any
	}{
		{"GET", "/admin/templates", nil},
		{"POST", "/admin/templates", map[string]any{"definition": json.RawMessage(templateJSON(1, broadAmount))}},
		{"POST", "/admin/templates/testbank.card/1/validate", nil},
		{"POST", "/admin/templates/testbank.card/1/publish", nil},
		{"POST", "/admin/templates/testbank.card/1/reprocess", nil},
		{"GET", "/admin/diagnostics", nil},
		{"GET", "/admin/accounting", nil},
		{"GET", "/admin/quarantine?user=" + u, nil},
		{"GET", "/admin/waitlist", nil},
		{"POST", "/admin/waitlist", map[string]any{"bank": "Mashreq"}},
		{"GET", "/admin/dictionary", nil},
		{"POST", "/admin/dictionary/moderate", map[string]any{"pattern": "x", "category": "y", "approved": true}},
		{"POST", "/admin/dictionary/approve-seed", map[string]any{}},
	}
}

// ---------------------------------------------------------------------------
// the guard
// ---------------------------------------------------------------------------

func TestAdminRequiresTheBearerToken(t *testing.T) {
	c := newConsole(t)

	if rec := c.do("GET", "/admin/templates", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token = %d, want 401", rec.Code)
	}
	if rec := c.do("GET", "/admin/templates", "wrong-token", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d, want 401", rec.Code)
	}
	if rec := c.do("GET", "/admin/templates", testToken, nil); rec.Code != http.StatusOK {
		t.Fatalf("right token = %d, want 200: %s", rec.Code, rec.Body.String())
	}
}

// EVERY route, not just the first one. A guard applied per-route is a guard
// somebody forgets on the route they add next.
func TestEveryAdminRouteRefusesAnUnauthenticatedCaller(t *testing.T) {
	c := newConsole(t)
	for _, r := range adminRoutes() {
		if rec := c.do(r.method, r.path, "", r.body); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s with no token = %d, want 401 (%s)", r.method, r.path, rec.Code, rec.Body.String())
		}
		if rec := c.do(r.method, r.path, testToken+"x", r.body); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s with a wrong token = %d, want 401", r.method, r.path, rec.Code)
		}
	}
}

// THE separation the spec asks for: a session token is a USER credential, and
// the admin console does not know what a session is. This uses the real
// auth.Sessions, so it fails if anyone ever wires requireSession in here.
func TestAUserSessionCannotReachAnAdminRoute(t *testing.T) {
	c := newConsole(t)
	sessions := &auth.Sessions{Pool: c.pool, TTL: time.Hour}
	user, err := auth.UpsertUser(bg, c.pool, auth.Identity{IdP: auth.IdPApple, Subject: "sub-" + uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	token, err := sessions.Issue(bg, user)
	if err != nil {
		t.Fatal(err)
	}
	// The token is genuinely valid — this is not a test of an expired session.
	if got, err := sessions.Resolve(bg, token); err != nil || got != user {
		t.Fatalf("the session under test is not valid: %v", err)
	}
	for _, r := range adminRoutes() {
		if rec := c.do(r.method, r.path, token, r.body); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s accepted a USER SESSION as an admin credential: %d %s",
				r.method, r.path, rec.Code, rec.Body.String())
		}
	}
}

// Every rejection is byte-identical. "wrong token" and "no token" told apart is
// an oracle, and so is a 404 that reveals which routes exist to a caller who
// cannot use any of them.
func TestEveryRefusalIsTheSameResponse(t *testing.T) {
	c := newConsole(t)
	var first *httptest.ResponseRecorder
	for _, r := range adminRoutes() {
		for _, tok := range []string{"", "wrong", testToken[:len(testToken)-1], testToken + "extra", "Basic zzz"} {
			rec := c.do(r.method, r.path, tok, r.body)
			if first == nil {
				first = rec
				continue
			}
			if rec.Code != first.Code || rec.Body.String() != first.Body.String() {
				t.Fatalf("%s %s with %q: %d %q, want %d %q",
					r.method, r.path, tok, rec.Code, rec.Body.String(), first.Code, first.Body.String())
			}
		}
	}
}

func TestTheConsoleRoutesRefuseToMountWithoutAToken(t *testing.T) {
	pool := pgtest.New(t)
	h := &Handler{Templates: &tmpl.Store{Pool: pool}, Diag: &diag.Diag{Pool: pool}}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err == nil {
		t.Fatal("Routes mounted an unauthenticated admin console")
	}
	// And nothing was mounted on the way to that error, including the
	// dictionary console this handler is responsible for mounting.
	for _, p := range []string{"/admin/templates", "/admin/dictionary", "/admin/waitlist"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s was mounted despite the refusal: %d", p, rec.Code)
		}
	}
}

// The dictionary console (Task 33) has been unmountable since it was written.
// Mounting it is half of this task, so it gets its own assertion rather than
// resting on the sweep above.
func TestTheDictionaryConsoleIsMounted(t *testing.T) {
	c := newConsole(t)
	got := c.ok("GET", "/admin/dictionary", nil)
	if _, ok := got["entries"]; !ok {
		t.Fatalf("GET /admin/dictionary did not answer the moderation queue: %v", got)
	}
}

// An unrouted /admin/ path must not fall through to anything.
func TestUnknownAdminPathsAre404(t *testing.T) {
	c := newConsole(t)
	rec := c.do("GET", "/admin/nope", testToken, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /admin/nope = %d, want 404", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

// The gate is at the API, not only in the store. A console that let an invalid
// pattern through to a "the store will catch it" path would report a 500 for a
// mistake the operator could fix in a second.
func TestPostTemplateRefusesAnInvalidPatternAtTheAPI(t *testing.T) {
	c := newConsole(t)
	// \s is banned by the dialect: Go's and JavaScript's differ, so the two
	// executors would read different text out of one stored template.
	body := map[string]any{"definition": json.RawMessage(templateJSON(1, `AED\s+(?P<amt>[0-9]+\.[0-9]{2})`))}
	rec := c.do("POST", "/admin/templates", testToken, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("= %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(tmpl.ReasonEscapePerlSpace)) {
		t.Fatalf("the refusal must name the dialect reason: %s", rec.Body.String())
	}
	all, err := c.templates.All(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 0 {
		t.Fatalf("%d rows written by a rejected authoring call", len(all))
	}
}

func TestPostTemplateStoresADraftAndPublishesNothing(t *testing.T) {
	c := newConsole(t)
	body := map[string]any{"definition": json.RawMessage(templateJSON(1, broadAmount))}
	rec := c.do("POST", "/admin/templates", testToken, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("= %d, want 201: %s", rec.Code, rec.Body.String())
	}
	live, err := c.templates.Published(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 0 {
		t.Fatalf("authoring published %d templates", len(live))
	}
	got := c.ok("GET", "/admin/templates", nil)
	rows, _ := got["templates"].([]any)
	if len(rows) != 1 {
		t.Fatalf("GET /admin/templates returned %d rows", len(rows))
	}
	row := rows[0].(map[string]any)
	if row["status"] != tmpl.StatusDraft {
		t.Fatalf("status = %v, want draft", row["status"])
	}
}

// GET is the console's inventory: every version in every status, including the
// retired one a rollback would target.
func TestGetTemplatesShowsEveryVersionAndStatus(t *testing.T) {
	c := newConsole(t)
	c.publishV1(broadAmount)
	c.ok("POST", "/admin/templates", map[string]any{"definition": json.RawMessage(templateJSON(2, narrowAmount))})

	got := c.ok("GET", "/admin/templates", nil)
	rows, _ := got["templates"].([]any)
	if len(rows) != 2 {
		t.Fatalf("%d rows, want 2", len(rows))
	}
	statuses := map[string]string{}
	for _, r := range rows {
		m := r.(map[string]any)
		statuses[fmt.Sprint(m["version"])] = fmt.Sprint(m["status"])
	}
	if statuses["1"] != tmpl.StatusPublished || statuses["2"] != tmpl.StatusDraft {
		t.Fatalf("statuses = %v", statuses)
	}
}

// ---------------------------------------------------------------------------
// validate / publish
// ---------------------------------------------------------------------------

func TestValidateReplaysEveryDonatedSampleForTheSender(t *testing.T) {
	c := newConsole(t)
	c.donate("testbank.test", sampleSpent, samplePurchase)
	c.ok("POST", "/admin/templates", map[string]any{"definition": json.RawMessage(templateJSON(1, broadAmount))})

	got := c.ok("POST", "/admin/templates/testbank.card/1/validate", nil)
	if got["samples"] != float64(2) || got["matched"] != float64(2) {
		t.Fatalf("validate = %v, want 2 samples / 2 matched", got)
	}
	results, _ := got["results"].([]any)
	if len(results) != 2 {
		t.Fatalf("%d per-sample results", len(results))
	}
	for _, r := range results {
		m := r.(map[string]any)
		if m["matched"] != true {
			t.Fatalf("sample did not match under a template that should parse it: %v", m)
		}
	}

	// The narrow version parses only one of the two.
	c.ok("POST", "/admin/templates", map[string]any{"definition": json.RawMessage(templateJSON(2, narrowAmount))})
	got = c.ok("POST", "/admin/templates/testbank.card/2/validate", nil)
	if got["matched"] != float64(1) {
		t.Fatalf("narrow template matched %v samples, want 1", got["matched"])
	}
}

func TestPublishRefusesWhenAValidationSampleRegresses(t *testing.T) {
	c := newConsole(t)
	c.donate("testbank.test", sampleSpent, samplePurchase)
	c.publishV1(broadAmount) // both samples parse under v1
	c.ok("POST", "/admin/templates", map[string]any{"definition": json.RawMessage(templateJSON(2, narrowAmount))})

	rec := c.do("POST", "/admin/templates/testbank.card/2/publish", testToken, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("publish = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	regs, _ := body["regressions"].([]any)
	if len(regs) != 1 {
		t.Fatalf("regressions = %v, want exactly the one sample that broke", body)
	}

	// v1 is STILL live and v2 is still a draft: a refused publish changes
	// nothing at all.
	live, err := c.templates.Published(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 1 || live[0].Version != 1 {
		t.Fatalf("live set after a refused publish = %+v", live)
	}
	r2, err := c.templates.Get(bg, "testbank.card", 2)
	if err != nil {
		t.Fatal(err)
	}
	if r2.Status != tmpl.StatusDraft {
		t.Fatalf("the refused candidate is now %q", r2.Status)
	}
}

func TestPublishSucceedsWhenNoSampleRegresses(t *testing.T) {
	c := newConsole(t)
	c.donate("testbank.test", sampleSpent, samplePurchase)
	c.publishV1(narrowAmount) // v1 parses only the "spent" sample
	c.ok("POST", "/admin/templates", map[string]any{"definition": json.RawMessage(templateJSON(2, broadAmount))})

	got := c.ok("POST", "/admin/templates/testbank.card/2/publish", nil)
	if got["status"] != tmpl.StatusPublished {
		t.Fatalf("publish = %v", got)
	}
	live, err := c.templates.Published(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 1 || live[0].Version != 2 {
		t.Fatalf("live set = %+v", live)
	}
}

// A bank whose first template is being written has no donated samples and no
// live version. Refusing that would make the first parser for every new bank
// unpublishable.
func TestPublishSucceedsWithNoSamplesAndNoLiveVersion(t *testing.T) {
	c := newConsole(t)
	c.ok("POST", "/admin/templates", map[string]any{"definition": json.RawMessage(templateJSON(1, broadAmount))})
	got := c.ok("POST", "/admin/templates/testbank.card/1/publish", nil)
	if got["samples"] != float64(0) || got["status"] != tmpl.StatusPublished {
		t.Fatalf("publish = %v", got)
	}
}

// A sample store that is unreachable must NOT publish. Treating a failed replay
// as "no regressions found" is how a gate silently stops being one.
func TestPublishRefusesWhenTheSampleStoreFails(t *testing.T) {
	c := newConsole(t)
	c.publishV1(broadAmount)
	c.ok("POST", "/admin/templates", map[string]any{"definition": json.RawMessage(templateJSON(2, narrowAmount))})
	c.samples.err = fmt.Errorf("donated-sample store is down")

	rec := c.do("POST", "/admin/templates/testbank.card/2/publish", testToken, nil)
	if rec.Code/100 == 2 {
		t.Fatalf("publish succeeded with an unreadable sample corpus: %d %s", rec.Code, rec.Body.String())
	}
	live, err := c.templates.Published(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 1 || live[0].Version != 1 {
		t.Fatalf("live set changed: %+v", live)
	}
}

func TestPublishAndValidateAreNotFoundForAnUnknownVersion(t *testing.T) {
	c := newConsole(t)
	for _, p := range []string{
		"/admin/templates/testbank.card/9/validate",
		"/admin/templates/testbank.card/9/publish",
		"/admin/templates/testbank.card/9/reprocess",
	} {
		if rec := c.do("POST", p, testToken, nil); rec.Code != http.StatusNotFound {
			t.Errorf("POST %s = %d, want 404", p, rec.Code)
		}
	}
}

// ---------------------------------------------------------------------------
// reprocess
// ---------------------------------------------------------------------------

func TestRepublishCanTriggerReprocess(t *testing.T) {
	c := newConsole(t)
	c.publishV1(broadAmount)

	user := insertUser(t, c.pool)
	// Three messages this template touched, one from another bank that it did
	// not, so the target set is a set and not "everything".
	for i, r := range []diag.Record{
		diagRow(user, c.now, 0x01, func(r *diag.Record) { r.TemplateID = "testbank.card"; r.TemplateVersion = 1 }),
		diagRow(user, c.now, 0x02, func(r *diag.Record) { r.TemplateID = "testbank.card"; r.TemplateVersion = 1 }),
		diagRow(user, c.now, 0x03, func(r *diag.Record) {
			r.TemplateID = ""
			r.TemplateVersion = 0
			r.Matched = false
			r.Tier = diag.TierNone
			r.InnerOriginDomain = ""
			r.SenderDomain = "testbank.test"
		}),
		diagRow(user, c.now, 0x04, func(r *diag.Record) { r.TemplateID = "other.bank"; r.TemplateVersion = 1 }),
	} {
		if err := c.diag.Record(bg, r); err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
	}
	c.reproc.report = Report{Examined: 3, Superseded: 1, Unchanged: 2}

	got := c.ok("POST", "/admin/templates/testbank.card/1/reprocess", nil)
	if got["examined"] != float64(3) || got["superseded"] != float64(1) || got["unchanged"] != float64(2) {
		t.Fatalf("reprocess report = %v", got)
	}
	if len(c.reproc.calls) != 1 {
		t.Fatalf("%d Reprocess calls, want one per affected user", len(c.reproc.calls))
	}
	if c.reproc.calls[0].user != user || c.reproc.calls[0].ids != 3 {
		t.Fatalf("Reprocess called with %+v, want %s and 3 ids", c.reproc.calls[0], user)
	}
}

// Task 30 has not landed. The route must say so plainly rather than 500 or
// pretend it reprocessed nothing.
func TestReprocessIsUnavailableWithoutAReprocessor(t *testing.T) {
	c := newConsole(t)
	c.publishV1(broadAmount)
	h := &Handler{
		Templates: c.templates, Diag: c.diag, Waitlist: c.waitlist,
		Token: testToken, Logf: func(string, ...any) {},
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		t.Fatal(err)
	}
	c.h = mux
	rec := c.do("POST", "/admin/templates/testbank.card/1/reprocess", testToken, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("= %d, want 503: %s", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// diagnostics, accounting, quarantine, waitlist
// ---------------------------------------------------------------------------

func TestDiagnosticsIsFilteredAndPaged(t *testing.T) {
	c := newConsole(t)
	alice := insertUser(t, c.pool)
	bob := insertUser(t, c.pool)
	for i := 0; i < 3; i++ {
		if err := c.diag.Record(bg, diagRow(alice, c.now.Add(time.Duration(i)*time.Minute), byte(0x10+i), nil)); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.diag.Record(bg, diagRow(bob, c.now, 0x20, nil)); err != nil {
		t.Fatal(err)
	}

	got := c.ok("GET", "/admin/diagnostics", nil)
	rows, _ := got["rows"].([]any)
	if len(rows) != 4 {
		t.Fatalf("%d rows, want 4", len(rows))
	}
	got = c.ok("GET", "/admin/diagnostics?user="+alice.String(), nil)
	rows, _ = got["rows"].([]any)
	if len(rows) != 3 {
		t.Fatalf("user filter returned %d rows, want 3", len(rows))
	}
	got = c.ok("GET", "/admin/diagnostics?limit=2", nil)
	rows, _ = got["rows"].([]any)
	if len(rows) != 2 || got["complete"] != false {
		t.Fatalf("paged read = %v", got)
	}
	if got["next"] == nil {
		t.Fatal("an incomplete page must carry a cursor")
	}
}

func TestDiagnosticsRefusesAnOutcomeOutsideTheClosedSet(t *testing.T) {
	c := newConsole(t)
	rec := c.do("GET", "/admin/diagnostics?outcome=STARBUCKS%20DUBAI", testToken, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("= %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

func TestAccountingIsTheEveryEmailAccountedForReport(t *testing.T) {
	c := newConsole(t)
	u := insertUser(t, c.pool)
	if err := c.diag.Record(bg, diagRow(u, c.now, 0x30, nil)); err != nil {
		t.Fatal(err)
	}
	got := c.ok("GET", fmt.Sprintf("/admin/accounting?from=%s&to=%s",
		c.now.Add(-time.Hour).Format(time.RFC3339), c.now.Add(time.Hour).Format(time.RFC3339)), nil)
	if got["inbound_total"] != float64(1) {
		t.Fatalf("accounting = %v", got)
	}
}

// The operator's quarantine view is the one that carries the raw message —
// that is how the Gmail forwarding-verification link gets read during
// onboarding. It is opt-in per request.
func TestQuarantineIsTheOperatorsViewIncludingTheBlob(t *testing.T) {
	c := newConsole(t)
	u := insertUser(t, c.pool)
	q := &quarantine.Store{Pool: c.pool, TTL: quarantine.DefaultTTL, WarnBefore: quarantine.DefaultWarnBefore}
	raw := []byte("From: forwarding-noreply@google.com\r\nSubject: Gmail Forwarding Confirmation\r\n\r\ncode 123456\r\n")
	if err := q.Hold(bg, quarantine.Item{
		UserID: u, IngestID: ingest32(0x40), ReceivedAt: c.now,
		OuterDomain: "google.com", DKIM: diag.ResultPass, ARC: diag.ResultNone, Blob: raw,
	}); err != nil {
		t.Fatalf("Hold: %v", err)
	}

	got := c.ok("GET", "/admin/quarantine?user="+u.String(), nil)
	items, _ := got["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("%d items", len(items))
	}
	if b, ok := items[0].(map[string]any)["blob"]; ok && b != nil {
		t.Fatalf("the blob was returned without include_blob=1")
	}

	got = c.ok("GET", "/admin/quarantine?user="+u.String()+"&include_blob=1", nil)
	items, _ = got["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("%d items", len(items))
	}
	if items[0].(map[string]any)["blob"] == nil {
		t.Fatal("include_blob=1 did not return the message")
	}
}

func TestQuarantineRequiresAUser(t *testing.T) {
	c := newConsole(t)
	for _, p := range []string{"/admin/quarantine", "/admin/quarantine?user=not-a-uuid"} {
		if rec := c.do("GET", p, testToken, nil); rec.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d, want 400", p, rec.Code)
		}
	}
}

func TestWaitlistRoundTrip(t *testing.T) {
	c := newConsole(t)
	for i := 0; i < 2; i++ {
		if rec := c.do("POST", "/admin/waitlist", testToken, map[string]any{"bank": "Mashreq"}); rec.Code != http.StatusNoContent {
			t.Fatalf("POST = %d: %s", rec.Code, rec.Body.String())
		}
	}
	if rec := c.do("POST", "/admin/waitlist", testToken, map[string]any{"bank": "AED 25.00 STARBUCKS"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("free text accepted as a bank: %d", rec.Code)
	}
	got := c.ok("GET", "/admin/waitlist", nil)
	banks, _ := got["banks"].([]any)
	if len(banks) != 1 {
		t.Fatalf("%d banks: %v", len(banks), got)
	}
	b := banks[0].(map[string]any)
	if b["bank"] != "mashreq" || b["count"] != float64(2) {
		t.Fatalf("entry = %v", b)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func insertUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	u, err := auth.UpsertUser(bg, pool, auth.Identity{IdP: auth.IdPApple, Subject: "sub-" + uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func ingest32(b byte) []byte {
	id := make([]byte, 32)
	for i := range id {
		id[i] = b
	}
	return id
}

func diagRow(u uuid.UUID, at time.Time, id byte, mutate func(*diag.Record)) diag.Record {
	r := diag.Record{
		UserID:            uuid.NullUUID{UUID: u, Valid: true},
		Event:             diag.EventArrival,
		IngestID:          ingest32(id),
		ReceivedAt:        at,
		SenderDomain:      "gmail.com",
		DKIMResult:        diag.ResultPass,
		ARCResult:         diag.ResultPass,
		InnerOriginDomain: "testbank.test",
		TemplateID:        "testbank.card",
		TemplateVersion:   1,
		NormalizerVersion: 1,
		Matched:           true,
		Tier:              diag.TierTemplate,
		Outcome:           diag.OutcomeAppended,
	}
	if mutate != nil {
		mutate(&r)
	}
	return r
}
