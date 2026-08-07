package webui

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// Handler serves the PWA out of files, falling back to index.html for any path
// that is not a real file — those are client-side routes.
//
// Modeled on v1's internal/server/spa.go, with one deliberate addition: this
// handler refuses /api/ itself rather than relying on being mounted second.
//
// # Why the /api/ guard is here and not only in the router
//
// The fallback's whole job is to answer "I don't know this path" with 200 and an
// HTML document. That is exactly the wrong answer for a mistyped API route: a
// sync client would receive a page and try to parse it as JSON, and the failure
// surfaces as a parse error somewhere far away from the typo. api.Server's
// catch-all already answers 404 JSON for unrouted /api/ paths, and the router
// (cmd/ledgerd) mounts the API first — but "first" is a property of a call site
// that a later edit can reorder without any test noticing. So the fallback
// declines the whole prefix outright, and both halves are tested.
func Handler(files fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(files))
	return func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if clean == "" {
			clean = "index.html"
		}
		// Never serve the app shell for an API path. See the doc comment.
		if clean == "api" || strings.HasPrefix(clean, "api/") {
			http.NotFound(w, r)
			return
		}
		if _, err := fs.Stat(files, clean); err != nil {
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
// points must revalidate every load so deploys and service-worker updates
// propagate (embed.FS has no modtime, so a revalidation is a full 200 — they
// are tiny).
func cacheControl(name string) string {
	if strings.HasPrefix(name, "assets/") {
		return "public, max-age=31536000, immutable"
	}
	switch name {
	case "index.html", "sw.js", "registerSW.js", "manifest.webmanifest":
		return "no-cache"
	}
	// Unhashed root files (icons, robots.txt): cache for a day.
	return "public, max-age=86400"
}
