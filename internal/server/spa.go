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
