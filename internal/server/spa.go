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
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}
