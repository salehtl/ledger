# Slow-Network Load Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PWA load in a reasonable time on a phone over a slow network by cutting bytes on the critical path (compression, smaller bundle, trimmed service-worker precache) and making repeat loads near-free (cache headers).

**Architecture:** All fixes stay inside the existing single-binary model: a gzip middleware and cache headers in `internal/server`, a slimmer precache manifest in the Vite PWA config, and removal of the recharts dependency (its only production use is a 19-line bar chart; `DonutChart` is dead code). A committed measurement script provides before/after evidence.

**Tech Stack:** Go stdlib (`compress/gzip`, `net/http`), Vite + vite-plugin-pwa (workbox `generateSW`), React 18 + Tailwind v4, vitest, bash + curl for measurement.

## Global Constraints

- Single binary, single process; the server **never runs Node** at runtime — no CDN or external assets (CLAUDE.md).
- Frontend must be built **before** `go build`; `internal/web/dist/` is a **committed** build artifact (CLAUDE.md).
- Parallel sessions run on `main` — re-check `main` and rebuild the combined dist before finishing/deploying (CLAUDE.md).
- Do **not** change the vitest single-fork settings in `vite.config.ts` (`fileParallelism: false`, `singleFork: true`) — the sandbox requires them.
- Money is integer minor units — irrelevant here, but never touch it.
- Frontend convention: extract decision logic into pure `lib/` functions with co-located `*.test.ts`.
- Production runs on this same box (`dinosaur`) as systemd unit `ledger` listening on `127.0.0.1:8080` — **never** bind test servers to 8080; use `127.0.0.1:8099`.

## Diagnosis (measured 2026-07-03, current committed dist)

What a first visit downloads today, and why it is slow:

| Cause | Bytes today | Fix |
|---|---|---|
| No compression anywhere (Go server serves identity; only SSE sets any header) | 595 KB JS + 35 KB CSS + 1.5 KB HTML travel uncompressed | Task 2: gzip middleware (~4× smaller for JS/CSS/JSON) |
| No `Cache-Control` headers; `embed.FS` files have no modtime → no validators → every non-SW fetch is a full re-download | whole bundle again on SW-miss reloads | Task 3: immutable caching for hashed `/assets/*` |
| SW precaches everything matching `**/*.{js,css,html,png,jpg,svg,woff2}`: marketing images (`open-graph.jpg` 125 KB, `twitter-card.png` 83 KB, `manifest-icon-512.jpg` 205 KB, `logo-square.svg` 110 KB, `favicon.svg` 110 KB…) and all 15 font-subset files (~354 KB) incl. cyrillic/greek/vietnamese the app never renders | ~1.6 MB total first-visit download | Task 4: precache only js/css/html + latin woff2 |
| Single 595 KB JS bundle; recharts (+ d3 deps) is bundled but its only production use is `TrendBars` (19 lines, one `BarChart`); `DonutChart` is imported **only by its own test** | ~200+ KB minified of dead/overkill dependency | Task 5: replace TrendBars with pure divs/CSS, delete DonutChart, drop recharts |

At 1 Mbit/s, ~1.6 MB ≈ **13+ seconds** before the app is fully cached. Post-plan first visit should be roughly: gzipped JS ~100 KB + gzipped CSS ~8 KB + HTML ~1 KB + latin fonts ~81 KB (woff2 is pre-compressed) ≈ **~190 KB ≈ under 2 s at 1 Mbit/s**, and repeat visits served from the SW cache with only a tiny `sw.js` revalidation.

Out of scope (deliberately): HTTP/2 tuning (tailscale serve already fronts HTTPS), ETag generation for `embed.FS` (index.html + sw.js are ~4 KB combined after gzip; revalidation savings are negligible), image re-encoding (after Task 4 the big images are no longer on any load path — link unfurlers fetch them server-side).

---

### Task 1: Measurement script + committed baseline

Everything after this task is judged against this baseline. The script has two sections: a static analysis of `internal/web/dist` (no server needed — used by Tasks 4/5) and an on-the-wire section against a running server (used by Tasks 2/6).

**Files:**
- Create: `scripts/perf-report.sh`
- Create: `docs/perf/2026-07-03-baseline.txt`

**Interfaces:**
- Produces: `scripts/perf-report.sh [BASE_URL]` — prints critical-path bytes, SW-precache manifest bytes, and (when BASE_URL is given) identity-vs-gzip transfer sizes. Tasks 2, 4, 5, 6 run it verbatim.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# perf-report.sh — what a phone actually downloads to load the app.
#
# Usage: scripts/perf-report.sh [BASE_URL]
#   Static sections read internal/web/dist directly (no server needed).
#   With BASE_URL (e.g. http://127.0.0.1:8099) it also measures on-the-wire
#   transfer sizes with and without gzip.
set -euo pipefail
cd "$(dirname "$0")/.."
DIST=internal/web/dist

secs_at_1mbit() { awk -v b="$1" 'BEGIN { printf "%.1f", b * 8 / 1000000 }'; }

echo "== Critical path (index.html references) =="
total=0
for f in index.html $(grep -oE '/assets/[^"]+\.(js|css)' "$DIST/index.html" | sed 's|^/||') registerSW.js sw.js; do
  size=$(stat -c%s "$DIST/$f")
  printf "%10d  %s\n" "$size" "$f"
  total=$((total + size))
done
printf "%10d  TOTAL uncompressed (~%ss at 1 Mbit/s)\n" "$total" "$(secs_at_1mbit "$total")"

echo
echo "== Service-worker precache manifest =="
total=0
count=0
while read -r url; do
  f="${url%%\?*}"
  [ -f "$DIST/$f" ] || continue
  size=$(stat -c%s "$DIST/$f")
  printf "%10d  %s\n" "$size" "$f"
  total=$((total + size)); count=$((count + 1))
done < <(grep -oE 'url:"[^"]*"' "$DIST/sw.js" | cut -d'"' -f2 | sort)
printf "%10d  TOTAL precache: %d files (~%ss at 1 Mbit/s)\n" "$total" "$count" "$(secs_at_1mbit "$total")"

if [ $# -ge 1 ]; then
  BASE="$1"
  echo
  echo "== On-the-wire transfer ($BASE) =="
  printf "%10s %10s  %s\n" "identity" "gzip" "path"
  paths=(/ $(grep -oE '/assets/[^"]+\.(js|css)' "$DIST/index.html") /api/summary /api/transactions)
  for p in "${paths[@]}"; do
    id=$(curl -so /dev/null -H 'Accept-Encoding: identity' -w '%{size_download}' "$BASE$p")
    gz=$(curl -so /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download}' "$BASE$p")
    printf "%10d %10d  %s\n" "$id" "$gz" "$p"
  done
fi
```

Then: `chmod +x scripts/perf-report.sh`

Note: the `url:"..."` grep matches workbox's minified `generateSW` output (unquoted keys, e.g. `{revision:"…",url:"index.html"}`) — verified against the current committed `sw.js`.

- [ ] **Step 2: Start a throwaway server against the current binary**

The committed dist is current (rebuilt with the last multi-currency commit), so build the binary as-is and run it with a temp data dir. Use the session scratchpad for config/data:

```bash
cd /root/Coding/ledger
CGO_ENABLED=0 go build -o /tmp/claude-0/-root-Coding-ledger/df8de0ff-8c6e-4bfa-b6f0-cc5a45d399d2/scratchpad/ledger-perf ./cmd/ledger
mkdir -p /tmp/claude-0/-root-Coding-ledger/df8de0ff-8c6e-4bfa-b6f0-cc5a45d399d2/scratchpad/perf-data
cat > /tmp/claude-0/-root-Coding-ledger/df8de0ff-8c6e-4bfa-b6f0-cc5a45d399d2/scratchpad/perf-config.toml <<'EOF'
[server]
listen = "127.0.0.1:8099"
data_dir = "/tmp/claude-0/-root-Coding-ledger/df8de0ff-8c6e-4bfa-b6f0-cc5a45d399d2/scratchpad/perf-data"
EOF
/tmp/claude-0/-root-Coding-ledger/df8de0ff-8c6e-4bfa-b6f0-cc5a45d399d2/scratchpad/ledger-perf -config /tmp/claude-0/-root-Coding-ledger/df8de0ff-8c6e-4bfa-b6f0-cc5a45d399d2/scratchpad/perf-config.toml &
sleep 1 && curl -s http://127.0.0.1:8099/api/health
```

Expected: health JSON. (IMAP is unconfigured → ingest idles; that's fine, we only measure asset transfer.)

- [ ] **Step 3: Record the baseline**

```bash
scripts/perf-report.sh http://127.0.0.1:8099 | tee docs/perf/2026-07-03-baseline.txt
```

Expected (approximate — record actual): critical path ≈ 634,000 bytes; precache ≈ 1,590,000 bytes across ~25 files; on-the-wire `identity` == `gzip` for every path (no compression yet — that equality **is** the baseline finding).

- [ ] **Step 4: Stop the throwaway server**

```bash
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add scripts/perf-report.sh docs/perf/2026-07-03-baseline.txt
git commit -m "chore(perf): add load-weight report script and record baseline"
```

---

### Task 2: gzip middleware in the Go server

Biggest single win: the 595 KB JS becomes ~170 KB on the wire, CSS ~7 KB, and all `/api/*` JSON shrinks ~4×. Decision is made at `WriteHeader` time from the final `Content-Type` (the file server sets it from the extension; every JSON handler sets it explicitly — verified). SSE and Range requests are excluded.

**Files:**
- Create: `internal/server/gzip.go`
- Create: `internal/server/gzip_test.go`
- Modify: `internal/server/server.go:76-105,196-199` (add `handler` field, wrap mux, serve through it)

**Interfaces:**
- Consumes: `Server.mux` (`*http.ServeMux`), existing `New(store HealthChecker, webFS fs.FS) *Server`, test fixture `fstest()` from `spa_test.go`.
- Produces: `withGzip(next http.Handler) http.Handler` (package-private). `Server.ServeHTTP` behavior gains `Content-Encoding: gzip` + `Vary: Accept-Encoding` on compressible 200s.

- [ ] **Step 1: Write the failing tests**

Create `internal/server/gzip_test.go`:

```go
package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func gzGet(t *testing.T, h http.Handler, path string, acceptGzip bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if acceptGzip {
		req.Header.Set("Accept-Encoding", "gzip")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGzipCompressesAssetThroughServer(t *testing.T) {
	srv := New(nil, fstest())
	rec := gzGet(t, srv, "/assets/app.js", true)
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", rec.Header().Get("Vary"))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil || string(body) != "console.log('app')" {
		t.Fatalf("round-trip = %q, %v", body, err)
	}
}

func TestGzipSkippedWithoutAcceptEncoding(t *testing.T) {
	srv := New(nil, fstest())
	rec := gzGet(t, srv, "/assets/app.js", false)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want none", got)
	}
	if rec.Body.String() != "console.log('app')" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestGzipSkipsEventStreamPath(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("data: hello\n\n"))
	})
	rec := gzGet(t, withGzip(inner), "/api/events", true)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("SSE Content-Encoding = %q, want none", got)
	}
	if rec.Body.String() != "data: hello\n\n" {
		t.Fatalf("SSE body = %q", rec.Body.String())
	}
}

func TestGzipCompressesJSON(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	rec := gzGet(t, withGzip(inner), "/api/anything", true)
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
}

func TestGzipSkipsAlreadyCompressedTypes(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "font/woff2")
		w.Write([]byte("binaryfontbytes"))
	})
	rec := gzGet(t, withGzip(inner), "/assets/font.woff2", true)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("woff2 Content-Encoding = %q, want none", got)
	}
}

func TestGzipSkipsRangeRequests(t *testing.T) {
	srv := New(nil, fstest())
	req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Range", "bytes=0-4")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("ranged Content-Encoding = %q, want none", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/ -run TestGzip -v`
Expected: FAIL — `undefined: withGzip` (compile error).

- [ ] **Step 3: Implement the middleware**

Create `internal/server/gzip.go`:

```go
package server

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

var gzipPool = sync.Pool{New: func() any { return gzip.NewWriter(nil) }}

// compressibleTypes are Content-Type prefixes worth gzipping. Fonts (woff2)
// and images (jpg/png) are already compressed and are deliberately absent.
var compressibleTypes = []string{
	"text/html",
	"text/css",
	"text/plain",
	"text/javascript",
	"application/javascript",
	"application/json",
	"application/manifest+json",
	"image/svg+xml",
}

func compressible(contentType string) bool {
	for _, t := range compressibleTypes {
		if strings.HasPrefix(contentType, t) {
			return true
		}
	}
	return false
}

// gzipResponseWriter defers the compress/don't-compress decision to
// WriteHeader, where the handler's final Content-Type is visible.
type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
}

func (w *gzipResponseWriter) WriteHeader(code int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	h := w.Header()
	if code == http.StatusOK && h.Get("Content-Encoding") == "" && compressible(h.Get("Content-Type")) {
		h.Del("Content-Length")
		h.Set("Content-Encoding", "gzip")
		gz := gzipPool.Get().(*gzip.Writer)
		gz.Reset(w.ResponseWriter)
		w.gz = gz
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.gz != nil {
		return w.gz.Write(b)
	}
	return w.ResponseWriter.Write(b)
}

func (w *gzipResponseWriter) Flush() {
	if w.gz != nil {
		w.gz.Flush()
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *gzipResponseWriter) close() {
	if w.gz != nil {
		w.gz.Close()
		gzipPool.Put(w.gz)
		w.gz = nil
	}
}

// withGzip compresses responses for clients that accept it. /api/events is
// excluded (compressing SSE would buffer the stream), as are Range requests
// (byte offsets must refer to the identity representation).
func withGzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			r.URL.Path == "/api/events" || r.Header.Get("Range") != "" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Accept-Encoding")
		gw := &gzipResponseWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}
```

Modify `internal/server/server.go` — add the field, wrap once in `New`, serve through it:

```go
// in the Server struct (after `mux *http.ServeMux`):
	handler         http.Handler        // mux wrapped in middleware (gzip)
```

```go
// in New, after s.routes(webFS):
	s.handler = withGzip(s.mux)
```

```go
// ServeHTTP makes Server an http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/server/ -v`
Expected: all PASS, including the pre-existing SSE tests in `events_test.go` (they go through `Server.ServeHTTP` — this confirms the `/api/events` exclusion keeps streaming un-buffered).

- [ ] **Step 5: Full test sweep + race**

Run: `go test ./... -race`
Expected: PASS everywhere. (Known env quirk: `internal/config TestAIConfigEnabledRequiresAPIKey` fails if `LEDGER_AI_API_KEY` is set in the sandbox — not caused by this change; verify with `env -u LEDGER_AI_API_KEY go test ./internal/config/` if it appears.)

- [ ] **Step 6: Commit**

```bash
git add internal/server/gzip.go internal/server/gzip_test.go internal/server/server.go
git commit -m "feat(server): gzip static assets and API JSON for slow networks"
```

---

### Task 3: Cache-Control headers for the embedded bundle

Hashed `/assets/*` files are immutable by construction → cache forever. Entry points (`index.html`, `sw.js`, `registerSW.js`, `manifest.webmanifest`) must revalidate every load so deploys and SW updates propagate. `embed.FS` provides no modtime/ETag, so "revalidate" means a full 200 — acceptable: those four files total ~4 KB gzipped.

**Files:**
- Modify: `internal/server/spa.go`
- Test: `internal/server/spa_test.go` (append)

**Interfaces:**
- Consumes: `spaHandler(webFS fs.FS) http.HandlerFunc` (existing), test fixture `fstest()`.
- Produces: `cacheControl(name string) string` (package-private); `Cache-Control` set on every SPA response.

- [ ] **Step 1: Write the failing test**

Append to `internal/server/spa_test.go`:

```go
func TestSPACacheHeaders(t *testing.T) {
	srv := New(nil, fstest())
	cases := []struct{ path, want string }{
		{"/assets/app.js", "public, max-age=31536000, immutable"},
		{"/", "no-cache"},
		{"/index.html", "no-cache"},
		{"/review", "no-cache"}, // SPA fallback serves index.html
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.path, nil))
		if got := rec.Header().Get("Cache-Control"); got != c.want {
			t.Errorf("%s: Cache-Control = %q, want %q", c.path, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run TestSPACacheHeaders -v`
Expected: FAIL — `Cache-Control = ""` for every case.

- [ ] **Step 3: Implement**

Replace the body of `internal/server/spa.go` with:

```go
package server

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spaHandler serves files from the embedded bundle, falling back to index.html
// for any path that isn't a real file (client-side routes). /api/* never reaches
// here because those routes are registered first on the mux.
func spaHandler(webFS fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(webFS))
	return func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if clean == "" {
			clean = "index.html"
		}
		if _, err := fs.Stat(webFS, clean); err != nil {
			w.Header().Set("Cache-Control", cacheControl("index.html"))
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}
		w.Header().Set("Cache-Control", cacheControl(clean))
		fileServer.ServeHTTP(w, r)
	}
}

// cacheControl picks a caching policy for a served file. Files under assets/
// carry a content hash in their name, so they may be cached forever. Entry
// points must revalidate every load so deploys and SW updates propagate
// (embed.FS has no modtime, so revalidation is a full 200 — they are tiny).
func cacheControl(name string) string {
	if strings.HasPrefix(name, "assets/") {
		return "public, max-age=31536000, immutable"
	}
	switch name {
	case "index.html", "sw.js", "registerSW.js", "manifest.webmanifest":
		return "no-cache"
	}
	// Unhashed root files (favicons, touch icons): cache for a day.
	return "public, max-age=86400"
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/server/ -v`
Expected: all PASS (existing SPA tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add internal/server/spa.go internal/server/spa_test.go
git commit -m "feat(server): cache headers — immutable hashed assets, no-cache entry points"
```

---

### Task 4: Trim the service-worker precache

Stop precaching marketing/link-preview images (~633 KB: open-graph, twitter-card, logo-square, favicon, apple-touch + manifest icons — none needed offline; OS launchers copy install icons, unfurlers fetch server-side) and non-latin font subsets (~273 KB the app never renders — `unicode-range` in the fontsource CSS means the browser never fetches them at runtime either).

**Files:**
- Modify: `frontend/vite.config.ts:33-36` (workbox block)
- Modify (regenerated): `internal/web/dist/**`

**Interfaces:**
- Consumes: nothing from other tasks (independent of Tasks 2/3).
- Produces: a `sw.js` precache manifest containing only js/css/html + latin woff2; verified via `scripts/perf-report.sh` static section (Task 1).

- [ ] **Step 1: Update the workbox config**

In `frontend/vite.config.ts`, replace:

```ts
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,png,jpg,svg,woff2}"],
      },
```

with:

```ts
      workbox: {
        navigateFallback: "/index.html",
        // Precache only what a cold offline start needs: app code + latin
        // fonts. Marketing/link-preview images and non-latin font subsets
        // (never fetched at runtime thanks to unicode-range) stay
        // network-served with cache headers.
        globPatterns: ["**/*.{js,css,html,woff2}"],
        globIgnores: [
          "assets/*-cyrillic*",
          "assets/*-greek*",
          "assets/*-vietnamese*",
          "assets/*-latin-ext-*",
        ],
      },
```

- [ ] **Step 2: Rebuild and inspect the manifest**

```bash
cd frontend && bun run build && cd ..
grep -oE 'url:"[^"]*"' internal/web/dist/sw.js | cut -d'"' -f2 | sort
```

Expected: only `index.html`, `registerSW.js`, `assets/index-*.js`, `assets/index-*.css`, `assets/inter-latin-wght-normal-*.woff2`, `assets/roboto-mono-latin-wght-normal-*.woff2`. No `.jpg`, `.png`, `.svg`, no `cyrillic/greek/vietnamese/latin-ext` entries.

- [ ] **Step 3: Measure**

Run: `scripts/perf-report.sh`
Expected: precache TOTAL drops from ~1,590,000 to ~715,000 bytes (~595 KB JS + 35 KB CSS + 81 KB latin fonts + html/sw). Record the actual number for Task 6's comparison.

- [ ] **Step 4: Frontend tests still pass**

Run: `cd frontend && bun run test`
Expected: PASS (config change only).

- [ ] **Step 5: Commit (including regenerated dist)**

```bash
git add frontend/vite.config.ts internal/web/dist
git commit -m "perf(pwa): precache only app code and latin fonts"
```

---

### Task 5: Replace recharts with a pure-CSS bar chart

`DonutChart.tsx` is referenced only by `DonutChart.test.tsx` — dead code. The single production recharts use is `TrendBars` (a plain bar chart, no tooltips, no animation). Replace it with divs + flexbox, extract the height math into `lib/` per repo convention, delete the dead donut, and drop the dependency. Expect the main JS bundle to shrink by ≥200 KB minified.

**Files:**
- Create: `frontend/src/lib/trendBars.ts`
- Create: `frontend/src/lib/trendBars.test.ts`
- Create: `frontend/src/components/charts/TrendBars.test.tsx`
- Modify: `frontend/src/components/charts/TrendBars.tsx` (full rewrite)
- Delete: `frontend/src/components/charts/DonutChart.tsx`, `frontend/src/components/charts/DonutChart.test.tsx`
- Modify: `frontend/package.json` (remove recharts)
- Modify (regenerated): `internal/web/dist/**`

**Interfaces:**
- Consumes: `TrendPoint` from `frontend/src/lib/insights.ts:49` — `{ period: string; label: string; spent: number; income: number }`.
- Produces: `TrendBars({ points, activePeriod }: { points: TrendPoint[]; activePeriod?: string })` — **signature unchanged**, so `screens/Home.tsx:9` and `screens/Insights.tsx:9` need no edits. Also `barHeightPct(value: number, max: number): number` in `lib/trendBars.ts`.

- [ ] **Step 1: Write the failing lib test**

Create `frontend/src/lib/trendBars.test.ts`:

```ts
import { barHeightPct } from "./trendBars";

describe("barHeightPct", () => {
  it("scales value against max as a percentage", () => {
    expect(barHeightPct(50, 100)).toBe(50);
    expect(barHeightPct(100, 100)).toBe(100);
  });

  it("returns 0 for zero or negative values", () => {
    expect(barHeightPct(0, 100)).toBe(0);
    expect(barHeightPct(-5, 100)).toBe(0);
  });

  it("returns 0 (not NaN) when max is 0", () => {
    expect(barHeightPct(10, 0)).toBe(0);
  });

  it("clamps to 100", () => {
    expect(barHeightPct(150, 100)).toBe(100);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/trendBars.test.ts`
Expected: FAIL — cannot resolve `./trendBars`.

- [ ] **Step 3: Implement the helper**

Create `frontend/src/lib/trendBars.ts`:

```ts
/** Bar height as a 0-100 percentage of the tallest bar; 0 when there is no data. */
export function barHeightPct(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}
```

Run: `cd frontend && bunx vitest run src/lib/trendBars.test.ts` — expected PASS.

- [ ] **Step 4: Write the failing component test**

Create `frontend/src/components/charts/TrendBars.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { TrendBars } from "./TrendBars";
import type { TrendPoint } from "../../lib/insights";

const points: TrendPoint[] = [
  { period: "2026-05", label: "May", spent: 5000, income: 0 },
  { period: "2026-06", label: "Jun", spent: 10000, income: 0 },
];

describe("TrendBars", () => {
  it("renders a bar per point, scaled to the tallest month", () => {
    render(<TrendBars points={points} />);
    expect(screen.getByTestId("trend-bar-2026-05").style.height).toBe("50%");
    expect(screen.getByTestId("trend-bar-2026-06").style.height).toBe("100%");
    expect(screen.getByText("May")).toBeInTheDocument();
    expect(screen.getByText("Jun")).toBeInTheDocument();
  });

  it("highlights only the active period", () => {
    render(<TrendBars points={points} activePeriod="2026-06" />);
    expect(screen.getByTestId("trend-bar-2026-06").className).toContain("--color-accent");
    expect(screen.getByTestId("trend-bar-2026-05").className).toContain("--color-surface-2");
  });

  it("renders flat (0%) bars when every month is zero", () => {
    render(
      <TrendBars points={[{ period: "2026-05", label: "May", spent: 0, income: 0 }]} />,
    );
    expect(screen.getByTestId("trend-bar-2026-05").style.height).toBe("0%");
  });

  it("keeps the accessible chart role", () => {
    render(<TrendBars points={points} />);
    expect(screen.getByRole("img", { name: "Monthly spending trend" })).toBeInTheDocument();
  });
});
```

Run: `cd frontend && bunx vitest run src/components/charts/TrendBars.test.tsx`
Expected: FAIL — no `data-testid` bars in the recharts version (and recharts renders nothing measurable in jsdom).

- [ ] **Step 5: Rewrite the component**

Replace `frontend/src/components/charts/TrendBars.tsx` entirely with:

```tsx
import type { TrendPoint } from "../../lib/insights";
import { barHeightPct } from "../../lib/trendBars";

export function TrendBars({ points, activePeriod }: { points: TrendPoint[]; activePeriod?: string }) {
  const max = Math.max(0, ...points.map((p) => p.spent));
  return (
    <div className="h-32 flex items-stretch gap-1.5 pt-2" role="img" aria-label="Monthly spending trend">
      {points.map((p) => (
        <div key={p.period} className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="relative flex-1">
            <div
              data-testid={`trend-bar-${p.period}`}
              className={`absolute inset-x-0 bottom-0 rounded-t ${
                p.period === activePeriod ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)]"
              }`}
              style={{ height: `${barHeightPct(p.spent, max)}%` }}
            />
          </div>
          <div className="truncate text-center text-[11px] text-[var(--color-muted)]">{p.label}</div>
        </div>
      ))}
    </div>
  );
}
```

(Colors via Tailwind arbitrary-value classes rather than inline styles: same CSS variables the recharts version used, and class assertions are jsdom-reliable where inline `var()` styles are not.)

- [ ] **Step 6: Delete the dead donut and drop recharts**

```bash
rm frontend/src/components/charts/DonutChart.tsx frontend/src/components/charts/DonutChart.test.tsx
cd frontend && bun remove recharts
```

- [ ] **Step 7: Run the whole frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS — including `Home.test.tsx` and `Insights.test`-adjacent suites (TrendBars keeps its exact props signature; a stale comment in `Home.test.tsx:43` mentions DonutChart but the test doesn't import it).

- [ ] **Step 8: Rebuild and measure the bundle**

```bash
cd frontend && bun run build && cd ..
ls -la internal/web/dist/assets/index-*.js
scripts/perf-report.sh
```

Expected: `index-*.js` drops from 595,360 bytes to roughly 300–400 KB (record actual); precache TOTAL drops accordingly. If the drop is under 150 KB, investigate with `cd frontend && bunx vite-bundle-visualizer` before proceeding — something else is holding d3 in the graph.

- [ ] **Step 9: Commit (including regenerated dist)**

```bash
git add -A frontend internal/web/dist
git commit -m "perf(web): replace recharts with pure-CSS TrendBars, delete dead DonutChart"
```

---

### Task 6: End-to-end verification against the baseline

Prove the combined result on the wire, with all changes in one binary, and record the after-snapshot next to the baseline.

**Files:**
- Create: `docs/perf/2026-07-03-after.txt`
- Modify (possibly regenerated): `internal/web/dist/**`

**Interfaces:**
- Consumes: `scripts/perf-report.sh` (Task 1), baseline at `docs/perf/2026-07-03-baseline.txt`.

- [ ] **Step 1: Sync with main (parallel sessions may have landed commits)**

```bash
git pull --rebase 2>/dev/null || true
git log --oneline -5
```

If other sessions landed frontend changes, rebuild the **combined** dist: `cd frontend && bun install && bun run build && cd ..` and commit the dist delta if any.

- [ ] **Step 2: Full test sweep**

```bash
go test ./... && cd frontend && bun run test && cd ..
```

Expected: PASS (modulo the known `LEDGER_AI_API_KEY` config-test env quirk).

- [ ] **Step 3: Build and run the final binary**

```bash
CGO_ENABLED=0 go build -o /tmp/claude-0/-root-Coding-ledger/df8de0ff-8c6e-4bfa-b6f0-cc5a45d399d2/scratchpad/ledger-perf ./cmd/ledger
/tmp/claude-0/-root-Coding-ledger/df8de0ff-8c6e-4bfa-b6f0-cc5a45d399d2/scratchpad/ledger-perf -config /tmp/claude-0/-root-Coding-ledger/df8de0ff-8c6e-4bfa-b6f0-cc5a45d399d2/scratchpad/perf-config.toml &
sleep 1
```

- [ ] **Step 4: Record the after-snapshot and compare**

```bash
scripts/perf-report.sh http://127.0.0.1:8099 | tee docs/perf/2026-07-03-after.txt
diff docs/perf/2026-07-03-baseline.txt docs/perf/2026-07-03-after.txt || true
kill %1
```

Acceptance criteria (all must hold — if any fails, stop and diagnose before committing):
1. On-the-wire `gzip` size for `/assets/index-*.js` ≤ 130,000 bytes (was ~595,360 identity).
2. `gzip` < `identity` for `/`, JS, CSS, and `/api/summary` (compression live on both static and API paths).
3. Precache TOTAL ≤ 750,000 bytes (was ~1,590,000).
4. Critical-path "at 1 Mbit/s" estimate ≤ 2.5 s **using gzip sizes** (the script prints uncompressed; divide the wire numbers by hand and note the result in the snapshot file).
5. Sanity: `curl -s http://127.0.0.1:8099/api/health` returns healthy JSON, and `curl -s --compressed http://127.0.0.1:8099/ | head -3` returns the index HTML intact.

- [ ] **Step 5: Commit**

```bash
git add docs/perf/2026-07-03-after.txt internal/web/dist
git commit -m "chore(perf): record post-optimization load-weight snapshot"
```

---

### Task 7: Deploy to dinosaur (gated — confirm with user first)

The user feels this on their phone only after the production service restarts. **Pause here and confirm with the user before touching systemd** — the prod service is their live app.

**Files:** none (operational).

**Interfaces:**
- Consumes: the final binary from Task 6; runbook `deploy/README.md`.

- [ ] **Step 1: Confirm with the user that now is a good time to restart the service.**

- [ ] **Step 2: Build and install per the runbook**

```bash
cd /root/Coding/ledger
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/ledger ./cmd/ledger
sudo install -m 0755 /tmp/ledger /usr/local/bin/ledger
sudo systemctl restart ledger
```

- [ ] **Step 3: Verify the running binary is the new one, not just that health is green**

```bash
systemctl status ledger --no-pager | head -5
sudo ls -l /proc/$(systemctl show -p MainPID --value ledger)/exe
curl -s http://127.0.0.1:8080/api/health
curl -sI -H 'Accept-Encoding: gzip' http://127.0.0.1:8080/assets/$(curl -s http://127.0.0.1:8080/ | grep -oE 'index-[^"]+\.js' | head -1) | grep -i 'content-encoding\|cache-control'
```

Expected: `content-encoding: gzip` and `cache-control: public, max-age=31536000, immutable` from the live service. Then load the app on the phone over Tailscale and confirm the felt improvement.

---

## Self-Review

- **Spec coverage:** slow-network first load → Tasks 2 (compression), 4 (precache weight), 5 (bundle size); repeat loads → Task 3 (cache headers) + existing SW; "diagnose systematically" → Task 1 baseline + Task 6 acceptance criteria + committed before/after snapshots. Deploy so the user actually feels it → Task 7 (gated).
- **Placeholder scan:** all code blocks complete; the only external reference is `deploy/README.md`, an existing committed runbook.
- **Type consistency:** `withGzip` (Tasks 2/6), `cacheControl` (Task 3), `barHeightPct(value, max)` (Task 5 lib + component), `TrendBars({ points, activePeriod })` unchanged signature vs `Home.tsx:9`/`Insights.tsx:9` — consistent.
- **Known risks called out in-task:** jsdom `var()` inline-style flakiness avoided via classes (Task 5 Step 5); SSE buffering avoided via path exclusion and proven by existing `events_test.go` (Task 2 Step 4); Range+gzip corruption excluded (Task 2); port 8080 collision with prod avoided (Global Constraints).
