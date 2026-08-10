package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/tmpl"
)

// fakeFuse is a Headroom with every answer injected. The real fuse measures a
// filesystem, and a test that measured the machine it runs on would pass or fail
// depending on how much space that machine happened to have — which is the same
// as not being a test.
type fakeFuse struct {
	path    string
	floor   uint64
	free    uint64
	freeErr error
	tripped bool
}

func (f *fakeFuse) Path() string  { return f.path }
func (f *fakeFuse) Floor() uint64 { return f.floor }
func (f *fakeFuse) Tripped() bool { return f.tripped }
func (f *fakeFuse) Free() (uint64, error) {
	if f.freeErr != nil {
		return 0, f.freeErr
	}
	return f.free, nil
}

// consoleWith builds a token-guarded console over a fuse and nothing else. None
// of the status route touches a pool, so this runs without Postgres.
func consoleWith(t *testing.T, fuse Headroom) http.Handler {
	t.Helper()
	h := &Handler{
		Templates: &tmpl.Store{},
		Diag:      &diag.Diag{},
		Waitlist:  &Waitlist{},
		Headroom:  fuse,
		Token:     testToken,
		Logf:      func(string, ...any) {},
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		t.Fatalf("Routes: %v", err)
	}
	return mux
}

func readStatus(t *testing.T, h http.Handler) headroomStatus {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/admin/status", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /admin/status: %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Headroom headroomStatus `json:"headroom"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode status: %v (%s)", err, rec.Body.String())
	}
	return body.Headroom
}

// A tripped fuse reports HOW FAR below the floor the box is.
//
// This is the requirement in one test: an operator who sees "writes paused" must
// be able to size the problem — a megabyte or thirty gigabytes — without opening
// a shell. A status that carried only the boolean would pass every other test in
// this file.
func TestATrippedFuseSaysHowFarBelowTheFloorTheBoxIs(t *testing.T) {
	const gib = 1 << 30
	h := consoleWith(t, &fakeFuse{
		path: "/var/lib/ledger", floor: 8 * gib, free: 2 * gib, tripped: true,
	})
	got := readStatus(t, h)
	if !got.Tripped {
		t.Fatal("the console reports a tripped fuse as running normally")
	}
	if got.FreeBytes == nil || *got.FreeBytes != 2*gib {
		t.Fatalf("free_bytes = %v, want %d", got.FreeBytes, int64(2*gib))
	}
	if got.FloorBytes != 8*gib {
		t.Fatalf("floor_bytes = %d, want %d", got.FloorBytes, int64(8*gib))
	}
	if got.DeficitBytes != 6*gib {
		t.Fatalf("deficit_bytes = %d, want %d: 2 GiB free under an 8 GiB floor is 6 GiB short",
			got.DeficitBytes, int64(6*gib))
	}
	if got.Path != "/var/lib/ledger" {
		t.Fatalf("path = %q: an operator with three volumes cannot act on a shortfall with no filesystem",
			got.Path)
	}
}

// Above the floor there is no deficit, and the fuse is not tripped.
//
// The mirror of the case above, and the one that catches a subtraction with the
// sign the wrong way round: a healthy box must not report a shortfall.
func TestAnOpenFuseReportsNoDeficit(t *testing.T) {
	const gib = 1 << 30
	got := readStatus(t, consoleWith(t, &fakeFuse{
		path: "/var/lib/ledger", floor: 8 * gib, free: 40 * gib,
	}))
	if got.Tripped {
		t.Fatal("a box with 40 GiB free under an 8 GiB floor reads as tripped")
	}
	if got.DeficitBytes != 0 {
		t.Fatalf("deficit_bytes = %d on a healthy box", got.DeficitBytes)
	}
	if got.FreeBytes == nil || *got.FreeBytes != 40*gib {
		t.Fatalf("free_bytes = %v, want %d", got.FreeBytes, int64(40*gib))
	}
}

// The ENFORCED flag is the fuse's, never recomputed from the console's own
// sample.
//
// The two readings are independent — the fuse samples on a timer, the console
// samples when asked — so they legitimately disagree for up to one interval. The
// flag is what actually refuses writes. A console that derived "tripped" from
// its own fresher number would tell an operator writes were flowing at the exact
// moment every one of them was being refused.
func TestTheReportedFlagIsTheFuseAndNotTheFresherSample(t *testing.T) {
	const gib = 1 << 30
	got := readStatus(t, consoleWith(t, &fakeFuse{
		path: "/data", floor: 8 * gib, free: 40 * gib, tripped: true,
	}))
	if !got.Tripped {
		t.Fatal("the console cleared the fuse because its own sample looked healthy; " +
			"writes are still being refused and the page says they are not")
	}
	if got.DeficitBytes != 0 {
		t.Fatalf("deficit_bytes = %d: the box is above the floor, it is the FLAG that lags",
			got.DeficitBytes)
	}
}

// A failed sample loses the number and keeps the flag.
//
// statfs can fail while the fuse's last flag is perfectly valid. Reporting zero
// free bytes would render a healthy box as catastrophically full, and hiding the
// failure would leave "0" and "unknown" looking identical.
func TestAFailedSampleReportsNoFreeSpaceAndKeepsTheFlag(t *testing.T) {
	const gib = 1 << 30
	got := readStatus(t, consoleWith(t, &fakeFuse{
		path: "/data", floor: 8 * gib, freeErr: errors.New("statfs /data: permission denied"), tripped: true,
	}))
	if got.FreeBytes != nil {
		t.Fatalf("free_bytes = %d after a failed sample: an unmeasured disk is not a measured one",
			*got.FreeBytes)
	}
	if got.DeficitBytes != 0 {
		t.Fatalf("deficit_bytes = %d computed from a sample that never happened", got.DeficitBytes)
	}
	if !got.Tripped {
		t.Fatal("a failed sample cleared the fuse flag; the flag is the fuse's, not the sampler's")
	}
	if !strings.Contains(got.SampleError, "permission denied") {
		t.Fatalf("sample_error = %q, want the statfs failure", got.SampleError)
	}
}

// A process with no fuse says so, rather than looking healthy.
//
// "No fuse is running" and "the fuse is fine" are opposite facts, and a route
// that omitted the field, or a route that was not mounted at all, renders them
// identically on the page.
func TestAConsoleWithNoFuseSaysSoRatherThanLookingHealthy(t *testing.T) {
	got := readStatus(t, consoleWith(t, nil))
	if got.Configured {
		t.Fatal("a console with no fuse reports one")
	}
	if got.Tripped || got.DeficitBytes != 0 || got.FreeBytes != nil {
		t.Fatalf("an absent fuse invented state: %+v", got)
	}
}

// The status route is behind the token like every other, and it is a READ: there
// is no method here that changes the fuse.
func TestTheStatusRouteIsGuardedAndReadOnly(t *testing.T) {
	h := consoleWith(t, &fakeFuse{path: "/data", floor: 1, free: 2})
	if rec := get(t, h, "/admin/status"); rec.Code != http.StatusUnauthorized {
		t.Errorf("GET /admin/status without a token answered %d, want 401", rec.Code)
	}
	for _, m := range []string{http.MethodPost, http.MethodDelete, http.MethodPut} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(m, "/admin/status", nil)
		req.Header.Set("Authorization", "Bearer "+testToken)
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusOK {
			t.Errorf("%s /admin/status answered 200: this surface is read-only", m)
		}
	}
}

// The panel actually DRAWS the fuse, above the tabs, on every render.
//
// There is no browser here, so this is what can be checked: the element exists
// in the markup, the script fills it from the status route, and render() calls
// it — so the strip is not a section of one tab. A page that fetched the state
// and never painted it would satisfy every other test in this file.
func TestThePanelDrawsTheFuseAboveEveryTab(t *testing.T) {
	if !strings.Contains(string(uiIndexHTML), `id="headroom"`) {
		t.Error("index.html has no #headroom element, so there is nowhere for the fuse to be shown")
	}
	// Comments are stripped first, exactly as TestThePanelTalksOnlyToTheAdminConsole
	// strips them, and for a reason this test found the hard way: commenting the
	// call out left every string it looks for present in the file, so the check
	// passed over a panel that no longer drew anything.
	var body strings.Builder
	for _, line := range strings.Split(string(uiConsoleJS), "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		body.WriteString(line + "\n")
	}
	js := body.String()
	for _, want := range []string{
		`$("#headroom")`,         // it paints the element
		"/admin/status",          // from the console's own route
		"deficit_bytes",          // and it says how far below the floor the box is
		"await renderHeadroom()", // on every render, not per tab
	} {
		if !strings.Contains(js, want) {
			t.Errorf("console.js does not contain %q: the fuse is not shown loudly on every section", want)
		}
	}
}
